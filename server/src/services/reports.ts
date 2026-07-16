// Reports & dashboard computation.
//
// Two data sources, decided PER COMPANY (demo and real companies coexist):
//  - Demo companies: connecting one installs the prototype's financial series
//    in AppConfig (`demo:fin/plBases/bs:<companyId>`) so every screen matches
//    the design pixel-for-pixel. The P&L/BS math replicates the prototype.
//  - Real companies: statements are QBO's OWN numbers via the Reports API
//    (QboClient.getStatement) — drift-free by construction. Row drill-down
//    fetches the underlying transactions per account (getAccountTransactions);
//    for demo companies drill-down reads the local mirror (Transaction +
//    SplitLine).

import type {
  CustomReportDto,
  DashboardDataDto,
  SavedReportConfig,
  StatementCell,
  StatementDrilldownDto,
  StatementDrilldownRow,
  StatementDto,
  StatementRow,
  TransactionLogDto,
} from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { isMockRealmId, qboFactory } from '../lib/qbo/factory.js';
import type { QboStatement, QboStatementRow } from '../lib/qbo/types.js';

const M_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_M = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** Current year/month drive all labels, subtitles, and column ranges (real and
 * demo mode alike — the demo's stored series keeps its own math, but its
 * "current month" tracks the real calendar). Functions, not module constants,
 * so a long-running server never goes stale. */
function nowYear(): number {
  return new Date().getFullYear();
}
function nowMonth(): number {
  return new Date().getMonth(); // 0-based
}

interface DemoFin {
  months: string[];
  rev: number[]; // thousands
  exp: number[];
  breakdown: [string, number][];
  pl: { income: number; cogs: number; expenses: number };
}
type DemoPlBases = Record<string, number>;
interface DemoBs {
  assets: [string, number, number][];
  liab: [string, number, number][];
  equity: [string, number][];
}

async function demoJson<T>(key: string): Promise<T | null> {
  const row = await prisma.appConfig.findUnique({ where: { key } });
  return row ? (JSON.parse(row.value) as T) : null;
}

function cell(v: number): StatementCell {
  const t = '$' + Math.abs(v).toFixed(1) + 'k';
  return { value: v, text: v < -0.001 ? '(' + t + ')' : t };
}

function head(label: string, n: number): StatementRow {
  return { label, kind: 'head', indent: false, cells: Array.from({ length: n }, () => ({ value: 0, text: '' })) };
}
function line(label: string, vals: number[], kind: StatementRow['kind'] = 'line', indent = kind === 'line'): StatementRow {
  return { label, kind, indent, cells: vals.map(cell) };
}

// ---------- QBO Reports API statements (real mode) ----------

/** 'YYYY-MM-DD' of the last day of a (year, 0-based month). */
function monthEnd(year: number, m: number): string {
  return new Date(Date.UTC(year, m + 1, 0)).toISOString().slice(0, 10);
}
/** First..last day of a (year, 0-based month). */
function monthSpan(year: number, m: number): { start: string; end: string } {
  return { start: `${year}-${String(m + 1).padStart(2, '0')}-01`, end: monthEnd(year, m) };
}

/** 60s in-memory statement cache per (company, kind, params) — QBO rate limits. */
const statementCache = new Map<string, { at: number; stmt: QboStatement }>();
const STATEMENT_CACHE_TTL_MS = 60_000;

async function qboStatement(
  companyId: string,
  kind: 'pl' | 'bs',
  params: { startDate?: string; endDate: string; basis: 'cash' | 'accrual'; summarizeBy?: 'Total' | 'Month' },
): Promise<QboStatement> {
  const key = [companyId, kind, params.startDate ?? '', params.endDate, params.basis, params.summarizeBy ?? ''].join('|');
  const hit = statementCache.get(key);
  if (hit && Date.now() - hit.at < STATEMENT_CACHE_TTL_MS) return hit.stmt;
  const client = await qboFactory.forCompany(companyId);
  const stmt = await client.getStatement(kind, params);
  statementCache.set(key, { at: Date.now(), stmt });
  return stmt;
}

/**
 * Zip N single-column QBO statements into one multi-column row set (compare
 * views). The FIRST statement defines the row skeleton; comparison values are
 * matched by (kind, label) in document order, missing rows read 0.
 */
function mergeStatementColumns(stmts: QboStatement[]): QboStatementRow[] {
  const primary = stmts[0];
  if (!primary) return [];
  if (stmts.length === 1) return primary.rows;
  const queues = stmts.slice(1).map((s) => {
    const byKey = new Map<string, number[][]>();
    for (const r of s.rows) {
      const k = `${r.kind}|${r.label}`;
      const list = byKey.get(k) ?? [];
      list.push(r.values);
      byKey.set(k, list);
    }
    return byKey;
  });
  return primary.rows.map((r) => {
    if (r.kind === 'head') return r;
    const values = [
      r.values[0] ?? 0,
      ...queues.map((q) => {
        const list = q.get(`${r.kind}|${r.label}`);
        const vals = list && list.length > 0 ? list.shift() : undefined;
        return vals?.[0] ?? 0;
      }),
    ];
    return { ...r, values };
  });
}

/**
 * QboStatementRow[] (dollars) → StatementRow[] cells. Values keep the demo's
 * '$X.Xk' text format (cell() takes thousands) for visual consistency — the
 * underlying numbers are QBO's own, only the display is k-formatted.
 */
function toStatementRows(rows: QboStatementRow[], nCols: number): StatementRow[] {
  return rows.map((r) => {
    if (r.kind === 'head') return head(r.label, nCols);
    const vals = Array.from({ length: nCols }, (_, i) => (r.values[i] ?? 0) / 1000);
    const row = line(r.label, vals, r.kind, r.kind === 'line');
    if (r.accountQboId !== undefined) row.accountQboId = r.accountQboId;
    return row;
  });
}

// ---------- P&L ----------

type PlCol = number | 'ytd' | `py${number}`;

async function demoPlRows(companyId: string, cols: PlCol[]): Promise<StatementRow[] | null> {
  const bases = await demoJson<DemoPlBases>(`demo:plBases:${companyId}`);
  if (!bases) return null;
  // Key order in plBases preserves the prototype's account ordering — the sine
  // variation is a function of that index, so ordering by it keeps every number
  // identical to the design prototype.
  const names = Object.keys(bases);
  const idx = (name: string) => names.indexOf(name);
  const dbAccounts = await prisma.qboAccount.findMany({
    where: { companyId, classification: { in: ['Income', 'COGS', 'Expenses'] }, active: true },
  });
  const classOf = new Map(dbAccounts.map((a) => [a.name, a.classification]));
  // Demo line rows still carry the real QBO account id so drill-down works.
  const qboIdOf = new Map(dbAccounts.map((a) => [a.name, a.qboId]));
  const accounts = names.map((name) => ({ name, classification: classOf.get(name) ?? 'Expenses' }));
  const nowM = nowMonth();
  const plVal = (name: string, m: number) =>
    (bases[name] ?? 0) * (1 + 0.12 * Math.sin((m + 1) * 1.7 + idx(name) * 2.3)) * (m === nowM ? 0.55 : 1);
  const cv = (name: string, c: PlCol): number =>
    c === 'ytd'
      ? Array.from({ length: nowM + 1 }, (_, m) => plVal(name, m)).reduce((a, b) => a + b, 0)
      : typeof c === 'string'
        ? plVal(name, Number(c.slice(2))) * 0.86
        : plVal(name, c);

  const grp = (g: string) => accounts.filter((a) => a.classification === g);
  const sum = (list: { name: string }[]) => cols.map((c) => list.reduce((s, a) => s + cv(a.name, c), 0));
  const pushLine = (rows: StatementRow[], name: string) => {
    const r = line(name, cols.map((c) => cv(name, c)));
    const qid = qboIdOf.get(name);
    if (qid !== undefined) r.accountQboId = qid;
    rows.push(r);
  };

  const rows: StatementRow[] = [];
  const totals: number[][] = [];
  for (const [gl, list] of [
    ['Income', grp('Income')],
    ['Cost of goods sold', grp('COGS')],
  ] as const) {
    rows.push(head(gl, cols.length));
    list.forEach((a) => pushLine(rows, a.name));
    const tot = sum(list);
    totals.push(tot);
    rows.push(line('Total ' + gl.toLowerCase(), tot, 'total', false));
  }
  const income = totals[0]!;
  const cogs = totals[1]!;
  const gross = cols.map((_, i) => income[i]! - cogs[i]!);
  rows.push(line('Gross profit', gross, 'grand', false));
  rows.push(head('Expenses', cols.length));
  grp('Expenses').forEach((a) => pushLine(rows, a.name));
  const totE = sum(grp('Expenses'));
  rows.push(line('Total expenses', totE, 'total', false));
  rows.push(line('Net income', cols.map((_, i) => gross[i]! - totE[i]!), 'grand', false));
  return rows;
}

/** The date range one P&L column covers (drill-down window + QBO query range). */
function plColPeriod(c: PlCol, year: number, nowM: number): { start: string; end: string } {
  if (c === 'ytd') return { start: `${year}-01-01`, end: monthEnd(year, nowM) };
  if (typeof c === 'string') return monthSpan(year - 1, Number(c.slice(2)));
  return monthSpan(year, c);
}

export async function profitAndLoss(
  companyId: string,
  opts: { period: string; columns: 'total' | 'months'; compare: 'none' | 'prev' | 'py'; basis: 'cash' | 'accrual' },
): Promise<StatementDto> {
  const year = nowYear();
  const nowM = nowMonth();
  let cols: PlCol[];
  let colLabels: string[];
  let subtitle: string;

  if (opts.columns === 'months') {
    cols = Array.from({ length: nowM + 1 }, (_, m) => m);
    colLabels = cols.map((m) => M_NAMES[m as number]!);
    subtitle = `January – ${FULL_M[nowM]!} ${year}, by month`;
  } else if (opts.period === 'ytd') {
    cols = ['ytd'];
    colLabels = [`Jan–${M_NAMES[nowM]!}`];
    subtitle = `Year to date ${year}`;
  } else {
    const m0 = Number(opts.period);
    cols = opts.compare === 'prev' && m0 > 0 ? [m0, m0 - 1] : opts.compare === 'py' ? [m0, `py${m0}`] : [m0];
    colLabels = cols.map((c) =>
      typeof c === 'string' ? M_NAMES[Number(c.slice(2))]! + ' ' + (year - 1) : M_NAMES[c]! + (c === nowM ? ' (to date)' : ''),
    );
    subtitle =
      M_NAMES[m0]! +
      ` ${year}` +
      (cols.length > 1 ? ' · vs ' + (opts.compare === 'py' ? M_NAMES[m0]! + ' ' + (year - 1) : M_NAMES[m0 - 1]!) : '');
  }

  const basisLabel = (opts.basis === 'cash' ? 'Cash' : 'Accrual') + ' basis';
  // Drill-down window: the whole displayed span for the by-month view,
  // otherwise the PRIMARY column's period (comparison columns drill primary).
  const period =
    opts.columns === 'months' ? { start: `${year}-01-01`, end: monthEnd(year, nowM) } : plColPeriod(cols[0]!, year, nowM);

  const demoRows = await demoPlRows(companyId, cols);
  if (demoRows) {
    return { title: 'Profit & Loss', subtitle, columns: colLabels.map((label) => ({ label })), rows: demoRows, basisLabel, period };
  }

  // Real mode: QBO's own P&L via the Reports API — drift-free by construction.
  if (opts.columns === 'months') {
    const stmt = await qboStatement(companyId, 'pl', {
      startDate: period.start,
      endDate: period.end,
      basis: opts.basis,
      summarizeBy: 'Month',
    });
    // Use QBO's own column set (months + its Total column) verbatim.
    return {
      title: 'Profit & Loss',
      subtitle,
      columns: stmt.columns,
      rows: toStatementRows(stmt.rows, stmt.columns.length),
      basisLabel,
      period,
    };
  }
  const stmts = await Promise.all(
    cols.map((c) => {
      const p = plColPeriod(c, year, nowM);
      return qboStatement(companyId, 'pl', { startDate: p.start, endDate: p.end, basis: opts.basis, summarizeBy: 'Total' });
    }),
  );
  return {
    title: 'Profit & Loss',
    subtitle,
    columns: colLabels.map((label) => ({ label })),
    rows: toStatementRows(mergeStatementColumns(stmts), cols.length),
    basisLabel,
    period,
  };
}

// ---------- Balance sheet ----------

export async function balanceSheet(
  companyId: string,
  opts: { asOf: string; compare: 'none' | 'prev' | 'py'; basis: 'cash' | 'accrual' },
): Promise<StatementDto> {
  const year = nowYear();
  const m0 = Number(opts.asOf);
  const cols: (number | `py${number}`)[] =
    opts.compare === 'prev' && m0 > 0 ? [m0, m0 - 1] : opts.compare === 'py' ? [m0, `py${m0}`] : [m0];
  const colLabels = cols.map((c) => (typeof c === 'string' ? M_NAMES[Number(c.slice(2))]! + ' ' + (year - 1) : M_NAMES[c]!));

  // Drill-down window: year-to-date through the primary as-of month.
  const primaryYear = typeof cols[0] === 'string' ? year - 1 : year;
  const period = { start: `${primaryYear}-01-01`, end: monthEnd(primaryYear, m0) };

  const d = await demoJson<DemoBs>(`demo:bs:${companyId}`);
  let rows: StatementRow[] = [];
  if (d) {
    const bal = (r: [string, number, number], c: number | `py${number}`) =>
      typeof c === 'string' ? (r[1] + r[2] * Number(c.slice(2))) * 0.88 : r[1] + r[2] * c;
    const secTotal = (list: [string, number, number][]) => cols.map((c) => list.reduce((s, r) => s + bal(r, c), 0));
    rows.push(head('Assets', cols.length));
    d.assets.forEach((r) => rows.push(line(r[0], cols.map((c) => bal(r, c)))));
    const ta = secTotal(d.assets);
    rows.push(line('Total assets', ta, 'grand', false));
    rows.push(head('Liabilities', cols.length));
    d.liab.forEach((r) => rows.push(line(r[0], cols.map((c) => bal(r, c)))));
    const tl = secTotal(d.liab);
    rows.push(line('Total liabilities', tl, 'total', false));
    rows.push(head('Equity', cols.length));
    d.equity.forEach((r) => rows.push(line(r[0], cols.map(() => r[1]))));
    const oe = d.equity.reduce((s, r) => s + r[1], 0);
    const ni = cols.map((_, i) => ta[i]! - tl[i]! - oe);
    rows.push(line('Net income', ni));
    rows.push(line('Total equity', ni.map((v) => v + oe), 'total', false));
    rows.push(line('Total liabilities & equity', ta, 'grand', false));
  } else {
    // Real mode: QBO's own balance sheet via the Reports API (one point-in-time
    // statement per column, zipped for compare views).
    const stmts = await Promise.all(
      cols.map((c) => {
        const y = typeof c === 'string' ? year - 1 : year;
        const m = typeof c === 'string' ? Number(c.slice(2)) : c;
        return qboStatement(companyId, 'bs', { endDate: monthEnd(y, m), basis: opts.basis });
      }),
    );
    rows = toStatementRows(mergeStatementColumns(stmts), cols.length);
  }
  return {
    title: 'Balance Sheet',
    subtitle:
      'As of end of ' +
      M_NAMES[m0]! +
      ' ' +
      year +
      (cols.length > 1 ? ' · vs ' + (opts.compare === 'py' ? M_NAMES[m0]! + ' ' + (year - 1) : M_NAMES[m0 - 1]!) : ''),
    columns: colLabels.map((label) => ({ label })),
    rows,
    basisLabel: (opts.basis === 'cash' ? 'Cash' : 'Accrual') + ' basis',
    period,
  };
}

// ---------- Statement row drill-down ----------

/**
 * The transactions behind one statement row (account) within the statement's
 * period. Real companies ask QBO itself (/reports/TransactionList); demo
 * companies read the local mirror — POSTED txns whose category (or split-line
 * category) posts to that account. Demo P&L rows without mirrored txns return
 * [] (expected demo artifact — the synthetic series has no per-txn backing).
 */
export async function statementDrilldown(
  companyId: string,
  args: { accountQboId: string; start: string; end: string },
): Promise<StatementDrilldownDto> {
  const account = await prisma.qboAccount.findUnique({
    where: { companyId_qboId: { companyId, qboId: args.accountQboId } },
  });
  const accountName = account?.name ?? '';

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const isDemoCompany = company !== null && isMockRealmId(company.realmId);

  if (!isDemoCompany) {
    const client = await qboFactory.forCompany(companyId);
    const txns = await client.getAccountTransactions({
      accountQboId: args.accountQboId,
      startDate: args.start,
      endDate: args.end,
    });
    return {
      accountName,
      rows: txns.map((t) => ({
        date: t.date,
        payee: t.payee,
        ...(t.memo !== undefined ? { memo: t.memo } : {}),
        amount: t.amount,
        txnType: t.txnType,
      })),
    };
  }

  // Demo: local mirror. Match by category QBO id, falling back to the account
  // name for rows categorized before ids were tracked.
  const txns = await prisma.transaction.findMany({
    where: {
      companyId,
      status: 'POSTED',
      date: { gte: new Date(`${args.start}T00:00:00.000Z`), lte: new Date(`${args.end}T23:59:59.999Z`) },
    },
    include: { splitLines: true },
    orderBy: { date: 'asc' },
  });
  const matches = (categoryQboId: string | null, category: string | null): boolean =>
    categoryQboId === args.accountQboId || (categoryQboId === null && accountName !== '' && category === accountName);
  const rows: StatementDrilldownRow[] = [];
  for (const t of txns) {
    const amount =
      t.splitLines.length > 0
        ? t.splitLines.reduce((a, l) => (matches(l.categoryQboId, l.category) ? a + Number(l.amount) : a), 0)
        : matches(t.categoryQboId, t.category)
          ? Number(t.amount)
          : 0;
    if (Math.abs(amount) < 0.005) continue;
    rows.push({
      date: t.date.toISOString().slice(0, 10),
      payee: t.payee,
      ...(t.memo !== null ? { memo: t.memo } : {}),
      amount: Math.round(amount * 100) / 100,
      txnType: t.qboType,
    });
  }
  return { accountName, rows };
}

// ---------- Transaction log ----------

/**
 * Whole-company transaction log, read straight from QuickBooks (TransactionList
 * report) so it can never drift from the books. Demo companies serve the same
 * shape from the mock realm store.
 */
export async function transactionLog(
  companyId: string,
  args: { start: string; end: string },
): Promise<TransactionLogDto> {
  const client = await qboFactory.forCompany(companyId);
  const rows = await client.listTransactions({ startDate: args.start, endDate: args.end });
  return { start: args.start, end: args.end, rows };
}

// ---------- Custom & tags ----------

/** Plain-data inputs so computeCustomReport is pure and unit-testable. */
export interface ReportTxnInput {
  id: string;
  date: Date;
  /** signed; + = money in */
  amount: number;
  bankAccount: string;
  category: string | null;
  /** txn-level tag ids (single-category case) */
  tagIds: string[];
  /** split lines in idx order; empty array = not split */
  splits: { amount: number; category: string; tagIds: string[] }[];
}

export interface ReportTagInput {
  id: string;
  name: string;
  color: string;
}

/**
 * Custom report attribution rules:
 *  - Range/flow/account/tag FILTERS apply at the transaction level (a txn
 *    qualifies for a tag filter if ANY of its txn tags or split-line tags
 *    match), but ATTRIBUTION is per piece: a split txn contributes each line's
 *    own amount to that line's own category and that line's own tags.
 *  - Split lines group under their own category — there is no 'Split' bucket.
 *  - By the model, txn-level tags shouldn't coexist with splits; if they do,
 *    the split lines win and txn tags are ignored for attribution.
 *  - 'Untagged' = single-category txns with no tags + split lines with no tags.
 *  - Row `count` = number of contributing pieces (split lines count
 *    individually); the footer `count` stays = number of distinct transactions.
 */
export function computeCustomReport(
  cfg: SavedReportConfig,
  txns: ReportTxnInput[],
  tags: ReportTagInput[],
): CustomReportDto {
  const inRange = (d: Date) => {
    if (cfg.range === 'all') return true;
    const [y, m] = cfg.range.split('-').map(Number);
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m;
  };
  const filtered = txns.filter((t) => {
    if (!inRange(new Date(t.date))) return false;
    if (cfg.flow === 'out' && t.amount >= 0) return false;
    if (cfg.flow === 'in' && t.amount <= 0) return false;
    if (cfg.account !== 'all' && t.bankAccount !== cfg.account) return false;
    if (cfg.tagIds.length) {
      const pool = [...t.tagIds, ...t.splits.flatMap((s) => s.tagIds)];
      if (!pool.some((id) => cfg.tagIds.includes(id))) return false;
    }
    return true;
  });

  // Explode qualifying txns into attribution pieces.
  interface Piece {
    amount: number;
    category: string | null;
    tagIds: string[];
    bankAccount: string;
  }
  const pieces: Piece[] = filtered.flatMap((t) =>
    t.splits.length > 0
      ? t.splits.map((s) => ({
          amount: s.amount,
          category: s.category,
          tagIds: s.tagIds, // split lines win; txn tags ignored for attribution
          bankAccount: t.bankAccount,
        }))
      : [{ amount: t.amount, category: t.category, tagIds: t.tagIds, bankAccount: t.bankAccount }],
  );

  let groups: { name: string; color: string | null; pieces: Piece[] }[] = [];
  if (cfg.groupBy === 'tag') {
    groups = tags.map((tag) => ({
      name: tag.name,
      color: tag.color,
      pieces: pieces.filter((p) => p.tagIds.includes(tag.id)),
    }));
    groups.push({ name: 'Untagged', color: null, pieces: pieces.filter((p) => p.tagIds.length === 0) });
  } else if (cfg.groupBy === 'cat') {
    const key = (p: Piece) => p.category ?? 'Uncategorized';
    const keys = [...new Set(pieces.map(key))];
    groups = keys.map((k) => ({ name: k, color: null, pieces: pieces.filter((p) => key(p) === k) }));
  } else {
    const keys = [...new Set(pieces.map((p) => p.bankAccount))];
    groups = keys.map((k) => ({ name: k, color: null, pieces: pieces.filter((p) => p.bankAccount === k) }));
  }

  const rows = groups
    .map((g) => ({
      name: g.name,
      color: g.color,
      count: g.pieces.length,
      total: g.pieces.reduce((a, p) => a + p.amount, 0),
    }))
    .filter((g) => g.count > 0);

  return {
    rows,
    count: filtered.length, // distinct transactions, not pieces
    total: filtered.reduce((a, t) => a + t.amount, 0),
  };
}

export async function customReport(companyId: string, cfg: SavedReportConfig): Promise<CustomReportDto> {
  const txns = await prisma.transaction.findMany({
    where: { companyId, status: { notIn: ['SUPERSEDED'] } },
    include: { txnTags: true, splitLines: { include: { tags: true }, orderBy: { idx: 'asc' } } },
    orderBy: { date: 'asc' },
  });
  const tags = await prisma.tag.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
  return computeCustomReport(
    cfg,
    txns.map((t) => ({
      id: t.id,
      date: t.date,
      amount: Number(t.amount),
      bankAccount: t.bankAccount,
      category: t.category,
      tagIds: t.txnTags.map((tt) => tt.tagId),
      splits: t.splitLines.map((l) => ({
        amount: Number(l.amount),
        category: l.category,
        tagIds: l.tags.map((lt) => lt.tagId),
      })),
    })),
    tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
  );
}

// ---------- Dashboard ----------

/**
 * Dashboard numbers straight from QBO's month-summarized P&L (last 6 calendar
 * months). Section totals are read from QBO's own summary rows; the expense
 * side is derived as income − net income so it survives any section layout.
 */
async function qboDashboard(companyId: string): Promise<Omit<DashboardDataDto, 'pendingCount' | 'pendingTotal'>> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  const stmt = await qboStatement(companyId, 'pl', {
    startDate: start.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
    basis: 'accrual',
    summarizeBy: 'Month',
  });

  const colCount = stmt.columns.length;
  const hasTotalCol = colCount > 0 && /total/i.test(stmt.columns[colCount - 1]!.label);
  const monthCols = hasTotalCol ? colCount - 1 : colCount;
  const months = stmt.columns.slice(0, monthCols).map((c) => c.label.trim().slice(0, 3));

  const val = (r: QboStatementRow | undefined, i: number): number => r?.values[i] ?? 0;
  const spanTotal = (r: QboStatementRow): number =>
    hasTotalCol ? val(r, colCount - 1) : r.values.reduce((a, b) => a + b, 0);

  const summaries = stmt.rows.filter((r) => r.kind === 'total' || r.kind === 'grand');
  const incomeRow = summaries.find((r) => /^total income$/i.test(r.label));
  const cogsRow = summaries.find((r) => /^total cost of goods sold$/i.test(r.label));
  const grands = stmt.rows.filter((r) => r.kind === 'grand');
  const netRow = grands[grands.length - 1]; // QBO emits Net Income as the last grand row

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rev = Array.from({ length: monthCols }, (_, i) => val(incomeRow, i));
  const exp = Array.from({ length: monthCols }, (_, i) => r2(val(incomeRow, i) - val(netRow, i)));

  const last = monthCols - 1;
  const income = val(incomeRow, last);
  const cogs = val(cogsRow, last);
  const expenses = r2(income - val(netRow, last) - cogs);

  // Top expense categories over the span: leaf rows outside the income sections.
  let section = '';
  const cats: { name: string; amount: number }[] = [];
  for (const r of stmt.rows) {
    if (r.kind === 'head' && !r.indent) section = r.label;
    if (r.kind === 'line' && !/income/i.test(section)) {
      const amount = r2(spanTotal(r));
      if (amount > 0.004) cats.push({ name: r.label, amount });
    }
  }
  const breakdown = cats.sort((a, b) => b.amount - a.amount).slice(0, 5);

  return { months, rev, exp, breakdown, pl: { income, cogs, expenses } };
}

export async function dashboardData(companyId: string): Promise<DashboardDataDto> {
  const pend = await prisma.transaction.findMany({
    where: { companyId, status: { in: ['PENDING', 'ERROR'] } },
    select: { amount: true },
  });
  const pendingCount = pend.length;
  const pendingTotal = pend.reduce((a, t) => a + Math.abs(Number(t.amount)), 0);

  const demo = await demoJson<DemoFin>(`demo:fin:${companyId}`);
  if (demo) {
    return {
      months: demo.months,
      rev: demo.rev.map((v) => v * 1000),
      exp: demo.exp.map((v) => v * 1000),
      breakdown: demo.breakdown.map(([name, amount]) => ({ name, amount: amount * 1000 })),
      pl: { income: demo.pl.income * 1000, cogs: demo.pl.cogs * 1000, expenses: demo.pl.expenses * 1000 },
      pendingCount,
      pendingTotal,
    };
  }

  // Real mode: QBO's own month-summarized P&L — drift-free, and populated even
  // before Recat has processed anything (fresh connections carry full history).
  try {
    return { ...(await qboDashboard(companyId)), pendingCount, pendingTotal };
  } catch {
    // QBO unreachable — fall back to what Recat has posted locally.
  }

  // Fallback: last 6 calendar months from POSTED txns.
  const txns = await prisma.transaction.findMany({
    where: { companyId, status: 'POSTED' },
    include: { splitLines: true },
  });
  const now = new Date();
  const monthKeys: { y: number; m: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    monthKeys.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  }
  const rev = monthKeys.map(() => 0);
  const exp = monthKeys.map(() => 0);
  const catTotals = new Map<string, number>();
  let income = 0;
  let cogs = 0;
  let expenses = 0;
  const cogsNames = new Set(
    (await prisma.qboAccount.findMany({ where: { companyId, classification: 'COGS' } })).map((a) => a.name),
  );
  for (const t of txns) {
    const d = new Date(t.date);
    const idx = monthKeys.findIndex((k) => k.y === d.getUTCFullYear() && k.m === d.getUTCMonth());
    const amt = Number(t.amount);
    // A split txn contributes each line's own amount to that line's category;
    // a single-category txn contributes its whole amount to its category.
    const parts: { category: string | null; amount: number }[] =
      t.splitLines.length > 0
        ? t.splitLines.map((l) => ({ category: l.category, amount: Number(l.amount) }))
        : [{ category: t.category, amount: amt }];
    if (idx >= 0) {
      if (amt > 0) rev[idx] = (rev[idx] ?? 0) + amt;
      else exp[idx] = (exp[idx] ?? 0) + Math.abs(amt);
    }
    const isCurMonth = d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
    if (isCurMonth) {
      if (amt > 0) income += amt;
      else {
        for (const p of parts) {
          if (p.category !== null && cogsNames.has(p.category)) cogs += Math.abs(p.amount);
          else expenses += Math.abs(p.amount);
        }
      }
    }
    if (amt < 0) {
      for (const p of parts) {
        if (p.category !== null) catTotals.set(p.category, (catTotals.get(p.category) ?? 0) + Math.abs(p.amount));
      }
    }
  }
  const breakdown = [...catTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, amount]) => ({ name, amount }));

  return {
    months: monthKeys.map((k) => M_NAMES[k.m]!),
    rev,
    exp,
    breakdown,
    pl: { income, cogs, expenses },
    pendingCount,
    pendingTotal,
  };
}
