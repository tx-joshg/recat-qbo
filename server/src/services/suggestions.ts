// Suggestion pipeline (handoff §3). First hit wins:
//   1. Rule    — payee contains matchText, case-insensitive, lowest priority
//                number first (topmost in the Rules UI; createdAt desc tiebreak)
//   2. History — most frequent category among POSTED/DRY_RUN txns with the same
//                normalized payee (skipped when suggestionSource = 'off')
//   3. AI      — only when suggestionSource = 'ai' and an OpenAI-compatible
//                endpoint is configured. Sends payee/memo/amount + the category
//                name list, NEVER the books. Cached per (companyId, payee).

import { Prisma } from '@prisma/client';
import type { SuggestionDto, SuggestionSetting } from '@recat/shared';
import { prisma } from '../lib/prisma.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Normalize a bank-feed payee for matching: uppercase, treat '#', '*' and '·'
 * as separators, and drop any token containing a digit (store numbers, refs).
 * 'SYSCO FOODS #212' → 'SYSCO FOODS'; 'AMZN MKTP US*2K4' → 'AMZN MKTP US'.
 */
export function normalizePayee(payee: string): string {
  return payee
    .toUpperCase()
    .replace(/[#*·]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !/\d/.test(tok))
    .join(' ');
}

export interface RuleLike {
  id: string;
  matchText: string;
  category: string;
  categoryQboId: string | null;
  /** Match order — lowest number wins when several rules match. */
  priority: number;
  createdAt: Date;
}

export interface HistoryTxnLike {
  payee: string;
  category: string;
  categoryQboId: string | null;
}

/**
 * Lowest-priority-number matching rule wins (createdAt desc as tiebreak).
 * Also reports how many rules matched in total (matchedRules) and the winner's
 * matchText (winnerMatchText) so the queue can surface multi-rule overlaps.
 */
export function ruleSuggestion(payee: string, rules: RuleLike[]): SuggestionDto | null {
  const needle = payee.toLowerCase();
  const sorted = [...rules].sort(
    (a, b) => a.priority - b.priority || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const matching = sorted.filter((rule) => {
    const match = rule.matchText.trim().toLowerCase();
    return match.length > 0 && needle.includes(match);
  });
  const winner = matching[0];
  if (!winner) return null;
  return {
    category: winner.category,
    categoryQboId: winner.categoryQboId ?? undefined,
    source: 'rule',
    ruleId: winner.id,
    matchedRules: matching.length,
    winnerMatchText: winner.matchText,
  };
}

/** Most frequent category among previously posted txns of the same normalized payee. */
export function historySuggestion(payee: string, history: HistoryTxnLike[]): SuggestionDto | null {
  const norm = normalizePayee(payee);
  if (norm.length === 0) return null;
  const counts = new Map<string, { count: number; categoryQboId: string | null }>();
  for (const h of history) {
    if (normalizePayee(h.payee) !== norm) continue;
    const entry = counts.get(h.category) ?? { count: 0, categoryQboId: h.categoryQboId };
    entry.count += 1;
    entry.categoryQboId ??= h.categoryQboId;
    counts.set(h.category, entry);
  }
  let best: { category: string; count: number; categoryQboId: string | null } | null = null;
  for (const [category, { count, categoryQboId }] of counts) {
    if (!best || count > best.count) best = { category, count, categoryQboId };
  }
  if (!best) return null;
  return { category: best.category, categoryQboId: best.categoryQboId ?? undefined, source: 'history' };
}

/** Rule beats history; history only when enabled. (AI is layered on in suggestFor.) */
export function pickSuggestion(
  payee: string,
  rules: RuleLike[],
  history: HistoryTxnLike[],
  historyEnabled: boolean,
): SuggestionDto | null {
  return ruleSuggestion(payee, rules) ?? (historyEnabled ? historySuggestion(payee, history) : null);
}

// ---------------------------------------------------------------------------
// Instance settings (lazy — the module is another agent's; degrade to builtin
// if it is unavailable rather than killing sync)
// ---------------------------------------------------------------------------

interface SuggestionSettings {
  suggestionSource: SuggestionSetting;
  aiEndpoint: string | null;
  aiApiKey: string | null;
}

let warnedSettingsUnavailable = false;

async function loadSettings(): Promise<SuggestionSettings> {
  try {
    const { getInstanceSettings } = await import('./instanceSettings.js');
    const s = await getInstanceSettings();
    return {
      suggestionSource: (s.suggestionSource || 'builtin') as SuggestionSetting,
      aiEndpoint: s.aiEndpoint || null,
      aiApiKey: s.aiApiKey || null,
    };
  } catch {
    if (!warnedSettingsUnavailable) {
      warnedSettingsUnavailable = true;
      console.warn('[suggestions] instance settings unavailable — defaulting to builtin suggestions');
    }
    return { suggestionSource: 'builtin', aiEndpoint: null, aiApiKey: null };
  }
}

// ---------------------------------------------------------------------------
// AI step
// ---------------------------------------------------------------------------

const AI_MODEL = 'gpt-4o-mini';

// Cache per (companyId, normalized payee). Resolved answers (including a valid
// "no idea") are cached; transport errors are not, so a flaky endpoint retries.
const aiCache = new Map<string, SuggestionDto | null>();

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

interface CategoryOption {
  qboId: string;
  name: string;
}

async function categoryOptions(companyId: string): Promise<CategoryOption[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const holdingIds = new Set(jsonStringArray(company?.holdingAccountIds));
  const accounts = await prisma.qboAccount.findMany({
    where: { companyId, active: true, classification: { in: ['Income', 'COGS', 'Expenses'] } },
    orderBy: { fullName: 'asc' },
  });
  return accounts.filter((a) => !holdingIds.has(a.qboId)).map((a) => ({ qboId: a.qboId, name: a.name }));
}

async function aiSuggestion(
  companyId: string,
  txn: { payee: string; memo?: string | null; amount: number },
  settings: SuggestionSettings,
): Promise<SuggestionDto | null> {
  if (!settings.aiEndpoint) return null;
  const cacheKey = `${companyId}|${normalizePayee(txn.payee)}`;
  if (aiCache.has(cacheKey)) return aiCache.get(cacheKey) ?? null;

  const options = await categoryOptions(companyId);
  if (options.length === 0) return null;

  // Minimal context only: one transaction + the category name list. Never the
  // full books.
  const prompt = [
    'You categorize a single bank transaction for a small business.',
    `Payee: ${txn.payee}`,
    `Memo: ${txn.memo ?? '(none)'}`,
    `Amount: ${txn.amount.toFixed(2)} (${txn.amount >= 0 ? 'money in' : 'money out'})`,
    '',
    'Choose the single best category from this exact list and reply with only that category name, nothing else:',
    ...options.map((o) => `- ${o.name}`),
  ].join('\n');

  try {
    const res = await fetch(`${settings.aiEndpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ChatCompletionResponse;
    const answer = body.choices?.[0]?.message?.content?.trim() ?? '';
    // Only accept an exact (case-insensitive) category name — anything else is
    // a hallucination and must not reach the queue.
    const hit = options.find((o) => o.name.toLowerCase() === answer.toLowerCase());
    const result: SuggestionDto | null = hit
      ? { category: hit.name, categoryQboId: hit.qboId, source: 'ai' }
      : null;
    aiCache.set(cacheKey, result);
    return result;
  } catch {
    return null; // endpoint unreachable — no suggestion, no cache
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function loadRules(companyId: string): Promise<RuleLike[]> {
  return prisma.rule.findMany({
    where: { companyId },
    select: { id: true, matchText: true, category: true, categoryQboId: true, priority: true, createdAt: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });
}

async function loadHistory(companyId: string): Promise<HistoryTxnLike[]> {
  const rows = await prisma.transaction.findMany({
    where: { companyId, status: { in: ['POSTED', 'DRY_RUN'] }, category: { not: null } },
    select: { payee: true, category: true, categoryQboId: true },
  });
  return rows.map((r) => ({ payee: r.payee, category: r.category ?? '', categoryQboId: r.categoryQboId }));
}

export async function suggestFor(
  companyId: string,
  txn: { payee: string; memo?: string | null; amount: number },
): Promise<SuggestionDto | null> {
  const settings = await loadSettings();
  const historyEnabled = settings.suggestionSource !== 'off';
  const rules = await loadRules(companyId);
  const history = historyEnabled ? await loadHistory(companyId) : [];
  const picked = pickSuggestion(txn.payee, rules, history, historyEnabled);
  if (picked) return picked;
  if (settings.suggestionSource === 'ai') return aiSuggestion(companyId, txn, settings);
  return null;
}

/**
 * Batch flavor for list rendering: settings/rules/history are loaded ONCE for
 * the whole page instead of per row, and NO AI calls are ever made from here —
 * AI only enriches suggestion snapshots during sync's refreshSuggestions, and
 * the list path falls back to that stored snapshot when rules+history miss.
 * Returns one (possibly null) suggestion per input, in order.
 */
export async function suggestForMany(
  companyId: string,
  txns: { payee: string; memo?: string | null; amount: number }[],
): Promise<(SuggestionDto | null)[]> {
  if (txns.length === 0) return [];
  const settings = await loadSettings();
  const historyEnabled = settings.suggestionSource !== 'off';
  const rules = await loadRules(companyId);
  const history = historyEnabled ? await loadHistory(companyId) : [];
  return txns.map((t) => pickSuggestion(t.payee, rules, history, historyEnabled));
}

/** Recompute the suggestion snapshot for every PENDING txn (called by sync). */
export async function refreshSuggestions(companyId: string): Promise<void> {
  const settings = await loadSettings();
  const historyEnabled = settings.suggestionSource !== 'off';
  const rules = await loadRules(companyId);
  const history = historyEnabled ? await loadHistory(companyId) : [];
  const pending = await prisma.transaction.findMany({ where: { companyId, status: 'PENDING' } });

  for (const t of pending) {
    const input = { payee: t.payee, memo: t.memo, amount: Number(t.amount) };
    let suggestion = pickSuggestion(t.payee, rules, history, historyEnabled);
    if (!suggestion && settings.suggestionSource === 'ai') {
      suggestion = await aiSuggestion(companyId, input, settings);
    }
    const current = JSON.stringify(t.suggestion ?? null);
    const next = JSON.stringify(suggestion);
    if (current === next) continue;
    // A stored history hint stays valid guidance even when the local posting
    // history can't currently reproduce it (e.g. demo seed, pruned data) —
    // only replace it with something better, never with nothing.
    if (suggestion === null) {
      const existing = t.suggestion as { source?: string } | null;
      if (existing && existing.source === 'history') continue;
    }
    await prisma.transaction.update({
      where: { id: t.id },
      data: {
        suggestion: suggestion === null ? Prisma.DbNull : (suggestion as unknown as Prisma.InputJsonValue),
      },
    });
  }
}
