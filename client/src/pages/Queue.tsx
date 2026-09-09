// Queue — the categorization screen. Faithful port of Recat.dc.html
// lines 229–409 (markup) and the interaction logic in visible()/renderVals()/
// onKey()/post()/openSplit()/xferMate()/recordTransfer()/undoPost()/cycleSort().
// All filtering, sorting and row-state transitions happen client-side on the
// locally-held transaction list, exactly like the prototype.

import { createRowStageCoordinator, sameDesired, type DesiredStage, type RowStageView } from './queue/rowStageCoordinator';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  isQboHoldingAccountName,
  type ActiveCategorizationAttemptDto,
  type CategorizationMutationOutcome,
  type CategorizationMutationResult,
  type SplitDto,
  type StageCategorizationBody,
  type TaxCalculation,
  type TransactionDto,
  type TxnStatus,
} from '@recat/shared';
import { useApp } from '../state/AppContext';
import {
  ApiError,
  companies as companiesApi,
  createCategorizationRequestId,
  rules as rulesApi,
  reports as reportsApi,
  transactions as txnApi,
} from '../lib/api';
import { fmtDate, fmtMoney } from '../lib/format';
import { InfoDot, Spinner } from '../components/ui';
import CategoryPicker from '../components/CategoryPicker';
import { Select } from '../components/SelectCombobox';
import TagPicker from '../components/TagPicker';
import SplitEditor from '../components/SplitEditor';
import type { SplitLineDraft } from '../components/SplitEditor';
import BulkBar from '../components/BulkBar';
import RulePrompt from '../components/RulePrompt';
import TaxCodePicker, {
  isUsableTaxCodeForDirection,
  usableTaxCodesForDirection,
} from '../components/TaxCodePicker';
import type { TaxDirection } from '../components/TaxCodePicker';
import { AutopilotQueueStatus } from './settings/AutopilotCard';
import AttachmentPanel from '../components/AttachmentPanel';

// ---------------------------------------------------------------------------
// Prototype-state mapping & small helpers
// ---------------------------------------------------------------------------

/** Server TxnStatus → prototype row state. */
type UiState = 'pending' | 'posting' | 'posted' | 'dry' | 'error' | 'reverted';

const STATE_OF: Partial<Record<TxnStatus, UiState>> = {
  PENDING: 'pending',
  POSTING: 'posting',
  POSTED: 'posted',
  DRY_RUN: 'dry',
  ERROR: 'error',
  REVERTED: 'reverted',
};

/** Search words per state — prototype's statusWords map. */
const STATUS_WORDS: Record<UiState, string> = {
  pending: 'pending',
  posting: 'posting',
  posted: 'posted',
  dry: 'dry run',
  error: 'error failed',
  reverted: 'reverted',
};

type SortKey = 'date' | 'payee' | 'amt' | 'acct' | 'cat' | 'status';

type CompanySyncLock = {
  request: Promise<unknown>;
  listeners: Set<() => void>;
};

const companySyncLocks = new Map<string, CompanySyncLock>();

function releaseCompanySyncLock(companyId: string, request: Promise<unknown>) {
  const lock = companySyncLocks.get(companyId);
  if (!lock || lock.request !== request) return;
  companySyncLocks.delete(companyId);
  for (const listener of lock.listeners) listener();
}

const SORT_KEYS: SortKey[] = ['date', 'payee', 'amt', 'acct', 'cat', 'status'];
const SORT_LABELS: Record<SortKey, string> = {
  date: 'Date',
  payee: 'Payee',
  amt: 'Amount',
  acct: 'Account',
  cat: 'Category',
  status: 'Status',
};

// The date track holds fmtDate's widest output. That is 'May 28, 2024' (~90px at
// --rfs 14.5) now that fmtDate appends the year outside the current year — 80px
// fit the year-less form only and wrapped these onto a second line.
const GRID_COLS = '38px 96px minmax(180px,1fr) 104px 118px minmax(200px,240px) minmax(270px, 290px)';

// Column minima, six gaps, and horizontal row padding.
const GRID_MIN_WIDTH = 38 + 96 + 180 + 104 + 118 + 200 + 270 + 6 * 12 + 2 * 18;

const SHORTCUT_TIP =
  '↑↓ or j/k — move between rows · x — select · t — open tags · Enter — post the active row.';

/** '4 min ago' / 'just now' style relative timestamp. */
function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** Undo is server-rejected past 30 days — hide the button rather than error. */
const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Null postedAt (e.g. dry-run rows) stays undoable — let the server decide. */
function canUndoPosted(postedAt: string | null | undefined): boolean {
  if (!postedAt) return true;
  return Date.now() - new Date(postedAt).getTime() <= UNDO_WINDOW_MS;
}

function errText(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return 'Something went wrong';
}

const stopMouse = (e: ReactMouseEvent) => e.stopPropagation();

/** The post endpoint may flag rule-prompt eligibility on top of the dto. */
type PostResponseDto = TransactionDto & { rulePromptEligible?: boolean };

interface RulePromptState {
  payee: string;
  category: string;
  categoryQboId: string | null;
}

interface TaxMutationState {
  kind: 'commit' | 'undo';
  requestId: string;
  attemptStatus: ActiveCategorizationAttemptDto['status'] | null;
  outcome: CategorizationMutationOutcome | 'PENDING';
  busy: boolean;
  phase: 'idle' | 'writing' | 'reconciling' | 'resolving';
  resolution: 'known' | 'resolving' | 'unresolved';
  reconciled: boolean;
}

interface TaxRowState {
  taxCalculation: TaxCalculation;
  taxCodeQboId: string | null;
  stage: RowStageView;
  mutation: TaxMutationState | null;
}

function initialTaxState(t: TransactionDto): TaxRowState {
  const taxCodeQboId = t.taxCodeQboId ?? null;
  const isSplit = !!(t.splits && t.splits.length);
  return {
    taxCalculation:
      isSplit && (
        t.taxCalculation === 'TaxInclusive' ||
        t.taxCalculation === 'TaxExcluded' ||
        t.taxCalculation === 'NotApplicable'
      )
        ? t.taxCalculation
        : taxCodeQboId === null
        ? 'NotApplicable'
        : t.taxCalculation === 'TaxExcluded'
          ? 'TaxExcluded'
          : 'TaxInclusive',
    taxCodeQboId,
    stage: { status: 'idle', desired: null, staged: null, result: null, error: null },
    mutation: t.activeCategorizationAttempt === null
      ? null
      : {
          kind: t.activeCategorizationAttempt.operation === 'restore' ? 'undo' : 'commit',
          requestId: t.activeCategorizationAttempt.requestId,
          attemptStatus: t.activeCategorizationAttempt.status,
          outcome: t.activeCategorizationAttempt.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'IN_PROGRESS',
          busy: false,
          phase: 'idle',
          resolution: 'known',
          reconciled: false,
        },
  };
}

function exactCents(value: number): number | null {
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000001
    ? cents
    : null;
}

function centsLabel(cents: number): string {
  const sign = cents < 0 ? '−' : cents > 0 ? '+' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------

export default function Queue() {
  const {
    activeCompany,
    activeCompanyId,
    role,
    accounts,
    tags,
    setPendingCount,
    refreshCompanies,
    dryRun,
    tagsRequired,
    taxReadiness,
    toast,
  } = useApp();
  const navigate = useNavigate();

  // ---- local state (mirrors the prototype's single component state) ----
  const [rows, setRows] = useState<TransactionDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [acct, setAcct] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [activeIdx, setActiveIdx] = useState(0);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [tagPicker, setTagPicker] = useState<string | null>(null);
  const tagPickerRootRef = useRef<HTMLSpanElement>(null);
  const [errOpenId, setErrOpenId] = useState<string | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePromptState | null>(null);
  const [splitEditId, setSplitEditId] = useState<string | null>(null);
  const [bulkCat, setBulkCat] = useState<string | null>(null);
  const [attachmentOpenId, setAttachmentOpenId] = useState<string | null>(null);
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({});
  const [taxRows, setTaxRows] = useState<Record<string, TaxRowState>>({});
  const stageCoordinatorsRef = useRef<Record<string, ReturnType<typeof createRowStageCoordinator>>>({});
  const [syncingCompanyId, setSyncingCompanyId] = useState<string | null>(
    () => activeCompanyId && companySyncLocks.has(activeCompanyId) ? activeCompanyId : null,
  );
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 640px)').matches,
  );
  const [, setClock] = useState(0); // re-render for 'last synced …'

  useEffect(() => {
    setAttachmentOpenId(null);
    setAttachmentCounts({});
  }, [activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId) {
      setSyncingCompanyId(null);
      return;
    }
    const lock = companySyncLocks.get(activeCompanyId);
    setSyncingCompanyId(lock ? activeCompanyId : null);
    if (!lock) return;

    const notify = () => {
      setSyncingCompanyId(companySyncLocks.has(activeCompanyId) ? activeCompanyId : null);
    };
    lock.listeners.add(notify);
    return () => {
      lock.listeners.delete(notify);
    };
  }, [activeCompanyId]);

  const taxState = useCallback(
    (t: TransactionDto): TaxRowState => taxRows[t.id] ?? initialTaxState(t),
    [taxRows],
  );

  const updateTaxState = useCallback(
    (t: TransactionDto, updater: (state: TaxRowState) => TaxRowState) => {
      setTaxRows((prev) => {
        const current = prev[t.id] ?? initialTaxState(t);
        return { ...prev, [t.id]: updater(current) };
      });
    },
    [],
  );

  const hasActiveMutation = useCallback(
    (t: TransactionDto): boolean => {
      const mutation = taxState(t).mutation;
      return mutation !== null && (
        mutation.attemptStatus === 'PREPARED' ||
        mutation.attemptStatus === 'COMMITTING' ||
        mutation.attemptStatus === 'UNCERTAIN' ||
        mutation.outcome === 'PENDING' ||
        mutation.outcome === 'IN_PROGRESS' ||
        mutation.outcome === 'UNCERTAIN' ||
        mutation.resolution !== 'known'
      );
    },
    [taxState],
  );

  const aliveRef = useRef(true);
  const activeCompanyIdRef = useRef(activeCompanyId);
  activeCompanyIdRef.current = activeCompanyId;
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // ---- responsive flag ----
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const fn = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  // ---- 'last synced' relative label stays fresh ----
  useEffect(() => {
    const id = window.setInterval(() => setClock((c) => c + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // ---- data fetch (mount; the route remounts on company switch) ----
  const fetchAllTxns = useCallback(async (companyId: string): Promise<TransactionDto[]> => {
    const all: TransactionDto[] = [];
    let cursor: string | undefined;
    do {
      const res = await txnApi.list(companyId, cursor ? { cursor } : {});
      all.push(...res.transactions);
      cursor = res.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }, []);

  useEffect(() => {
    if (!activeCompanyId) return;
    let cancelled = false;
    fetchAllTxns(activeCompanyId)
      .then((all) => {
        if (cancelled) return;
        setRows(all);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) toast(errText(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyId]);

  useEffect(() => {
    setAcct('all');
    setBankAccounts([]);
    if (!activeCompanyId) return;
    const companyId = activeCompanyId;
    let cancelled = false;
    reportsApi.bankAccounts(companyId)
      .then((names) => {
        if (!cancelled && activeCompanyIdRef.current === companyId) setBankAccounts(names);
      })
      .catch((error) => { if (!cancelled) toast(errText(error)); });
    return () => { cancelled = true; };
  }, [activeCompanyId, toast]);

  // ---- pending badge: recompute locally (pending = PENDING + ERROR rows) ----
  useEffect(() => {
    if (!loaded) return;
    setPendingCount(rows.filter((r) => r.status === 'PENDING' || r.status === 'ERROR').length);
  }, [rows, loaded, setPendingCount]);

  // ---- row helpers ----
  const updateRow = useCallback((dto: TransactionDto) => {
    setRows((prev) => prev.map((r) => (r.id === dto.id ? dto : r)));
  }, []);

  const patchRow = useCallback((id: string, patch: Partial<TransactionDto>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const stateOf = (t: TransactionDto): UiState => STATE_OF[t.status] ?? 'pending';

  /** 'Group · Name' via the chart of accounts, like the prototype's fullCat(). */
  const fullCat = useCallback(
    (name: string): string => {
      const hit = accounts.find((a) => a.name === name);
      return hit ? `${hit.classification} · ${hit.name}` : name;
    },
    [accounts],
  );

  const qboIdOf = useCallback(
    (name: string): string | null => accounts.find((a) => a.name === name)?.qboId ?? null,
    [accounts],
  );

  const taxDirectionFor = useCallback(
    (t: TransactionDto): TaxDirection | null =>
      t.qboType === 'Purchase' ? 'purchase' : t.qboType === 'Deposit' ? 'sales' : null,
    [],
  );

  const taxReadyFor = useCallback(
    (t: TransactionDto): boolean => {
      const direction = taxDirectionFor(t);
      return direction === 'purchase'
        ? taxReadiness?.status === 'ready'
        : direction === 'sales'
          ? taxReadiness?.salesStatus === 'ready'
          : false;
    },
    [taxDirectionFor, taxReadiness],
  );

  const taxLabelFor = useCallback(
    (t: TransactionDto): 'Purchase tax' | 'Sales tax' =>
      taxDirectionFor(t) === 'sales' ? 'Sales tax' : 'Purchase tax',
    [taxDirectionFor],
  );

  const taxCodesFor = useCallback(
    (t: TransactionDto) =>
      usableTaxCodesForDirection(taxReadiness, taxDirectionFor(t) ?? 'purchase'),
    [taxDirectionFor, taxReadiness],
  );

  const isTaxCodeUsableFor = useCallback(
    (t: TransactionDto, qboId: string): boolean =>
      isUsableTaxCodeForDirection(taxReadiness, taxDirectionFor(t) ?? 'purchase', qboId),
    [taxDirectionFor, taxReadiness],
  );

  const usesTaxLifecycleFor = useCallback(
    (t: TransactionDto): boolean =>
      taxDirectionFor(t) !== null && (
        taxReadyFor(t) ||
        t.taxCalculation !== null ||
        taxState(t).mutation !== null
      ),
    [taxDirectionFor, taxReadyFor, taxState],
  );

  // Category options: real categories only — no bank/credit-card accounts,
  // never the watched holding accounts, and no catch-all accounts (which are
  // holding accounts by convention even when unwatched). Matches the
  // prototype's chart of accounts.
  const catAccounts = useMemo(() => {
    const holding = new Set((activeCompany?.holdingAccountIds ?? []).map(String));
    return accounts.filter(
      (a) =>
        a.active &&
        ['Income', 'COGS', 'Expenses'].includes(a.classification) &&
        !holding.has(a.qboId) &&
        !holding.has(a.id) &&
        !isQboHoldingAccountName(a.name),
    );
  }, [accounts, activeCompany]);

  /** Prototype xferMate(): pending, uncategorized, counterpart present + pending. */
  const xferMateOf = useCallback(
    (t: TransactionDto): TransactionDto | null => {
      if (t.status !== 'PENDING' || t.category || (t.splits && t.splits.length)) return null;
      if (!t.transferCandidateId) return null;
      const m = rows.find((o) => o.id === t.transferCandidateId);
      return m && m.status === 'PENDING' ? m : null;
    },
    [rows],
  );

  // ---- visible(): search + account filter + 3-way sort ----
  const vis = useMemo(() => {
    const q = search.toLowerCase();
    const list = rows.filter((t) => {
      const state = STATE_OF[t.status];
      if (!state) return false; // SUPERSEDED rows never render
      if (acct !== 'all' && t.bankAccount !== acct) return false;
      if (!q) return true;
      const hay = [
        t.payee,
        t.memo || '',
        t.bankAccount,
        fmtDate(t.date),
        t.category ? fullCat(t.category) : '',
        t.suggestion?.category || '',
        STATUS_WORDS[state],
        fmtMoney(t.amount),
        String(Math.abs(t.amount)),
        Math.abs(t.amount).toFixed(2),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
    if (!sortKey) return list;
    const val = (t: TransactionDto): string | number => {
      if (sortKey === 'date') return new Date(t.date).getTime();
      if (sortKey === 'amt') return t.amount;
      if (sortKey === 'payee') return t.payee.toLowerCase();
      if (sortKey === 'acct') return t.bankAccount.toLowerCase();
      if (sortKey === 'cat')
        return (
          t.splits && t.splits.length ? 'split' : t.category || t.suggestion?.category || ''
        ).toLowerCase();
      return STATE_OF[t.status] ?? '';
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [rows, search, acct, sortKey, sortDir, fullCat]);

  const activeRow = vis.length ? vis[Math.min(activeIdx, vis.length - 1)] : undefined;
  const activeId = activeRow ? activeRow.id : null;

  // ---- header numbers ----
  const pend = useMemo(
    () => rows.filter((t) => t.status === 'PENDING' || t.status === 'ERROR'),
    [rows],
  );
  const pendTotal = pend.reduce((a, t) => a + Math.abs(t.amount), 0);
  const subline = `${pend.length} transactions · $${pendTotal.toLocaleString('en-US', {
    minimumFractionDigits: 2,
  })} waiting · last synced ${relTime(activeCompany?.lastSyncedAt)}`;

  const bankOpts = useMemo(
    () => [...new Set([...bankAccounts, ...rows.map((t) => t.bankAccount)])],
    [bankAccounts, rows],
  );

  // ---- selection ----
  const selIds = useMemo(() => Object.keys(sel).filter((k) => sel[k]), [sel]);
  const selPend = useMemo(
    () => selIds.filter((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      return row?.status === 'PENDING' && !hasActiveMutation(row);
    }),
    [selIds, rows, hasActiveMutation],
  );
  const selReady = useMemo(
    () =>
      selPend.filter((id) => {
        const t = rows.find((r) => r.id === id);
        return (
          !!t &&
          !taxReadyFor(t) &&
          !!t.category &&
          !(tagsRequired && t.tagIds.length === 0)
        );
      }),
    [selPend, rows, tagsRequired, taxReadyFor],
  );

  // ---- actions ----

  const openSplit = useCallback(() => {
    // Draft seeding lives in <SplitEditor/> (mounts fresh).
    setTagPicker(null);
  }, []);

  useEffect(() => {
    if (tagPicker === null) return;
    const dismissTagPicker = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && tagPickerRootRef.current?.contains(target)) return;
      setTagPicker(null);
    };
    document.addEventListener('mousedown', dismissTagPicker);
    return () => document.removeEventListener('mousedown', dismissTagPicker);
  }, [tagPicker]);

  const doOpenSplit = useCallback(
    (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.status !== 'PENDING' || hasActiveMutation(row)) return;
      openSplit();
      setSplitEditId(id);
    },
    [rows, hasActiveMutation, openSplit],
  );

  const stageBodyFor = useCallback(
    (t: TransactionDto, state: TaxRowState): DesiredStage | null => {
      const taxCalculation: TaxCalculation =
        t.splits && t.splits.length > 0
          ? state.taxCalculation
          : state.taxCodeQboId === null
            ? 'NotApplicable'
            : state.taxCalculation === 'TaxExcluded'
              ? 'TaxExcluded'
              : 'TaxInclusive';
      const sourceLines = t.splits && t.splits.length > 0
        ? t.splits.map((split) => ({
            amount: split.amount,
            categoryQboId: split.categoryQboId ?? qboIdOf(split.category),
            taxCodeQboId: split.taxCodeQboId ?? null,
            memo: split.memo,
            tagIds: split.tagIds,
          }))
        : [{
            amount: t.sourceGrossCents === undefined ? t.amount : t.sourceGrossCents / 100,
            categoryQboId: t.categoryQboId ?? (t.category ? qboIdOf(t.category) : null),
            taxCodeQboId: state.taxCodeQboId,
            memo: undefined,
            tagIds: t.tagIds,
          }];

      const lines: StageCategorizationBody['lines'] = [];
      for (const line of sourceLines) {
        const grossCents = exactCents(line.amount);
        if (grossCents === null || !line.categoryQboId) return null;
        if (
          taxCalculation !== 'NotApplicable' &&
          (line.taxCodeQboId === null || !isTaxCodeUsableFor(t, line.taxCodeQboId))
        ) return null;
        lines.push({
          grossCents,
          categoryQboId: line.categoryQboId,
          taxCodeQboId: taxCalculation === 'NotApplicable' ? null : line.taxCodeQboId,
          ...(line.memo ? { memo: line.memo } : {}),
          tagIds: [...line.tagIds],
        });
      }
      return {
        taxCalculation,
        lines,
        tagIds: [...t.tagIds],
      };
    },
    [qboIdOf, isTaxCodeUsableFor],
  );

  const readyStageFor = useCallback((t: TransactionDto, state: TaxRowState) => {
    const desired = stageBodyFor(t, state);
    if (hasActiveMutation(t) || desired === null || state.stage.status !== 'ready' ||
      state.stage.staged === null || state.stage.staged !== state.stage.desired ||
      !sameDesired(state.stage.staged, desired)) return null;
    return state.stage.result;
  }, [hasActiveMutation, stageBodyFor]);

  const requestStage = useCallback(
    (t: TransactionDto, state: TaxRowState) => {
      if (t.status !== 'PENDING' || state.stage.status === 'conflict' || hasActiveMutation(t) || !taxReadyFor(t)) return;
      const desired = stageBodyFor(t, state);
      if (desired === null) return;
      let coordinator = stageCoordinatorsRef.current[t.id];
      if (!coordinator) {
        const companyId = activeCompanyIdRef.current;
        // A revision-only change or a lost response may rebase safely. A different
        // server draft must be shown for review before another local write.
        let acknowledged = stageBodyFor(t, initialTaxState(t));
        let lastSent: DesiredStage | null = null;
        let concurrentEdit = false;
        coordinator = createRowStageCoordinator(t.revision, {
          stage: async (expectedRevision, nextDesired) => {
            lastSent = nextDesired;
            const result = await txnApi.stageCategorization(t.id, { ...nextDesired, expectedRevision });
            acknowledged = nextDesired;
            return result;
          },
          reload: async () => {
            if (!companyId) return null;
            const latestRows = await fetchAllTxns(companyId);
            if (!aliveRef.current || activeCompanyIdRef.current !== companyId) return null;
            const latest = latestRows.find((row) => row.id === t.id) ?? null;
            const latestDesired = latest ? stageBodyFor(latest, initialTaxState(latest)) : null;
            concurrentEdit = latest !== null && latest.status === 'PENDING' && latest.activeCategorizationAttempt === null
              && (latestDesired === null || !(
                (acknowledged !== null && sameDesired(latestDesired, acknowledged))
                || (lastSent !== null && sameDesired(latestDesired, lastSent))
              ));
            if (latest === null) {
              setRows((prev) => prev.filter((row) => row.id !== t.id));
            } else if (latest.status !== 'PENDING' || latest.activeCategorizationAttempt !== null || concurrentEdit) {
              patchRow(t.id, latest);
              setTaxRows((prev) => ({ ...prev, [t.id]: {
                ...initialTaxState(latest), stage: prev[t.id]?.stage ?? initialTaxState(latest).stage,
              } }));
            }
            if (latest && !concurrentEdit) {
              patchRow(t.id, { revision: latest.revision, payee: latest.payee, memo: latest.memo,
                amount: latest.amount, date: latest.date, bankAccount: latest.bankAccount,
                qboId: latest.qboId, qboType: latest.qboType });
            }
            return latest;
          },
          isMutable: (latest) => !concurrentEdit && latest.status === 'PENDING' && (
            latest.activeCategorizationAttempt === null
          ),
        }, (view) => {
          if (!aliveRef.current || activeCompanyIdRef.current !== companyId) return;
          setTaxRows((prev) => ({ ...prev, [t.id]: {
            ...(prev[t.id] ?? initialTaxState(t)), stage: concurrentEdit && view.status === 'conflict'
              ? { ...view, error: 'The transaction changed. Review the refreshed details, then calculate tax again.' } : view,
            ...(view.status === 'ready' ? { mutation: null } : {}),
          } }));
          if (view.status === 'ready' && view.result !== null) {
            patchRow(t.id, { revision: view.result.revision, taxCalculation: view.result.taxCalculation });
          }
        });
        stageCoordinatorsRef.current[t.id] = coordinator;
      }
      coordinator.update(desired);
    },
    [hasActiveMutation, taxReadyFor, stageBodyFor, fetchAllTxns, patchRow],
  );

  useEffect(() => {
    if (activeRow) requestStage(activeRow, taxRows[activeRow.id] ?? initialTaxState(activeRow));
  }, [requestStage, activeRow, taxRows]);

  useEffect(() => {
    const present = new Set(rows.map((row) => row.id));
    for (const [id, coordinator] of Object.entries(stageCoordinatorsRef.current)) {
      if (present.has(id)) continue;
      coordinator.dispose();
      delete stageCoordinatorsRef.current[id];
    }
  }, [rows]);

  useEffect(() => () => {
    for (const coordinator of Object.values(stageCoordinatorsRef.current)) coordinator.dispose();
    stageCoordinatorsRef.current = {};
  }, []);

  /** Assign a category: server merges matching rule tags — use the returned dto. */
  const categorizeTo = useCallback(
    (t: TransactionDto, name: string, categoryQboId: string) => {
      if (hasActiveMutation(t)) return;
      const prev = { category: t.category, categoryQboId: t.categoryQboId };
      patchRow(t.id, { category: name, categoryQboId }); // optimistic
      if (taxReadyFor(t)) {
        requestStage({ ...t, category: name, categoryQboId }, taxState(t));
        return;
      }
      txnApi
        .categorize(t.id, { category: name, categoryQboId, tagIds: t.tagIds })
        .then((dto) => {
          if (aliveRef.current) updateRow(dto);
        })
        .catch((e) => {
          if (aliveRef.current) patchRow(t.id, prev); // roll back the optimistic patch
          toast(errText(e));
        });
    },
    [
      hasActiveMutation,
      patchRow,
      taxReadyFor,
      requestStage,
      taxState,
      updateRow,
      toast,
    ],
  );

  const bulkCategoryOptions = useMemo(
    () => catAccounts.map((account) => ({
      value: account.qboId,
      group: account.classification,
      name: account.name,
      sug: false,
    })),
    [catAccounts],
  );

  const rowCategoryOptions = useMemo(() => {
    const bySuggestion = new Map<string, typeof bulkCategoryOptions>();
    return (t: TransactionDto) => {
      const suggested = t.suggestion?.category;
      if (!suggested) return bulkCategoryOptions;
      const cached = bySuggestion.get(suggested);
      if (cached) return cached;
      const options = bulkCategoryOptions.map((option) => ({ ...option, sug: option.name === suggested }));
      const ordered = [...options.filter((option) => option.sug), ...options.filter((option) => !option.sug)];
      bySuggestion.set(suggested, ordered);
      return ordered;
    };
  }, [bulkCategoryOptions]);

  const pickRowCategory = useCallback(
    (t: TransactionDto, qboId: string) => {
      const account = catAccounts.find((candidate) => candidate.qboId === qboId);
      if (account) categorizeTo(t, account.name, account.qboId);
    },
    [catAccounts, categorizeTo],
  );

  const pickBulkCategory = useCallback(
    (qboId: string) => {
      const account = catAccounts.find((candidate) => candidate.qboId === qboId);
      if (!account) return;
      setBulkCat(account.qboId);
      for (const id of selPend) {
        const t = rows.find((row) => row.id === id);
        if (t) categorizeTo(t, account.name, account.qboId);
      }
    },
    [catAccounts, selPend, rows, categorizeTo],
  );

  const recordTaxMutation = useCallback(
    (
      t: TransactionDto,
      result: CategorizationMutationResult,
      mutation: TaxMutationState,
      reconciled: boolean,
    ) => {
      patchRow(t.id, {
        status: result.status,
        error: result.error ?? null,
      });
      updateTaxState(t, (state) => ({
        ...state,
        mutation: {
          ...mutation,
          attemptStatus:
            result.outcome === 'UNCERTAIN'
              ? 'UNCERTAIN'
              : result.outcome === 'IN_PROGRESS'
                ? 'COMMITTING'
                : null,
          outcome: result.outcome,
          busy: false,
          phase: 'idle',
          resolution: 'known',
          reconciled,
        },
      }));
    },
    [patchRow, updateTaxState],
  );

  const recordTaxMutationFailure = useCallback(
    (
      t: TransactionDto,
      error: unknown,
      mutation: TaxMutationState,
    ) => {
      if (
        error instanceof ApiError &&
        error.mutationResult?.transactionId === t.id &&
        error.mutationResult.requestId === mutation.requestId
      ) {
        recordTaxMutation(t, error.mutationResult, mutation, false);
        return;
      }
      if (error instanceof ApiError && error.code !== undefined) {
        patchRow(t.id, { status: t.status, error: t.error });
        updateTaxState(t, (state) => ({ ...state, mutation: null }));
        toast(error.message);
        return;
      }
      recordTaxMutation(
        t,
        {
          transactionId: t.id,
          requestId: mutation.requestId,
          ok: false,
          status: 'ERROR',
          outcome: 'UNCERTAIN',
        },
        mutation,
        false,
      );
    },
    [patchRow, updateTaxState, recordTaxMutation, toast],
  );

  const commitTax = useCallback(
    (t: TransactionDto) => {
      const current = taxState(t);
      const staged = readyStageFor(t, current);
      if (staged === null || current.mutation?.outcome === 'RETRYABLE' || current.mutation?.outcome === 'UNCHANGED') return;
      const totals = staged.totals;
      if (!window.confirm(
        [
          'Post this categorization to QuickBooks?',
          `Subtotal ${centsLabel(totals.subtotalCents)}`,
          `Tax ${centsLabel(totals.taxCents)}`,
          `Total ${centsLabel(totals.totalCents)}`,
        ].join('\n'),
      )) return;
      const requestId = createCategorizationRequestId();
      const mutation: TaxMutationState = {
        kind: 'commit',
        requestId,
        attemptStatus: null,
        outcome: 'PENDING',
        busy: true,
        phase: 'writing',
        resolution: 'known',
        reconciled: false,
      };
      updateTaxState(t, (state) => ({ ...state, mutation }));
      patchRow(t.id, { status: 'POSTING', error: null });
      txnApi
        .commitCategorization(t.id, staged.revision, requestId)
        .then((result) => {
          if (aliveRef.current) recordTaxMutation(t, result, mutation, false);
        })
        .catch((error) => {
          if (!aliveRef.current) return;
          recordTaxMutationFailure(t, error, mutation);
        });
    },
    [taxState, readyStageFor, updateTaxState, patchRow, recordTaxMutation, recordTaxMutationFailure],
  );

  const reconcileTax = useCallback(
    (t: TransactionDto, retry: boolean) => {
      const current = taxState(t);
      const mutation = current.mutation;
      if (!mutation || mutation.busy) return;
      updateTaxState(t, (state) => ({
        ...state,
        mutation: state.mutation
          ? { ...state.mutation, busy: true, phase: 'reconciling' }
          : null,
      }));
      const request = retry ? txnApi.retryCategorization : txnApi.reconcileCategorization;
      request(t.id, mutation.requestId)
        .then((result) => {
          if (aliveRef.current) recordTaxMutation(t, result, mutation, true);
        })
        .catch(() => {
          if (!aliveRef.current) return;
          updateTaxState(t, (state) => ({
            ...state,
            mutation: state.mutation
              ? { ...state.mutation, busy: false, phase: 'idle' }
              : null,
          }));
          toast('Could not verify the QuickBooks result. Try reconciliation again.');
        });
    },
    [taxState, updateTaxState, recordTaxMutation, toast],
  );

  const resumePreparedTax = useCallback(
    (t: TransactionDto) => {
      const current = taxState(t);
      const mutation = current.mutation;
      if (!mutation || mutation.attemptStatus !== 'PREPARED' || mutation.busy) return;
      const resumed: TaxMutationState = {
        ...mutation,
        busy: true,
        phase: 'writing',
        resolution: 'known',
      };
      updateTaxState(t, (state) => ({ ...state, mutation: resumed }));
      const request = mutation.kind === 'undo'
        ? txnApi.undoCategorization(t.id, mutation.requestId)
        : txnApi.commitCategorization(t.id, t.revision, mutation.requestId);
      request
        .then((result) => {
          if (aliveRef.current) recordTaxMutation(t, result, resumed, false);
        })
        .catch((error) => {
          if (!aliveRef.current) return;
          if (
            error instanceof ApiError &&
            error.code !== undefined &&
            !(
              error.mutationResult?.transactionId === t.id &&
              error.mutationResult.requestId === mutation.requestId
            )
          ) {
            updateTaxState(t, (state) => ({
              ...state,
              mutation:
                state.mutation?.requestId === mutation.requestId
                  ? { ...state.mutation, busy: false, phase: 'idle' }
                  : state.mutation,
            }));
            toast(error.message);
            return;
          }
          if (
            error instanceof ApiError &&
            error.mutationResult?.transactionId === t.id &&
            error.mutationResult.requestId === mutation.requestId
          ) {
            recordTaxMutation(t, error.mutationResult, resumed, false);
            return;
          }
          const companyId = activeCompanyId;
          if (!companyId) {
            updateTaxState(t, (state) => ({
              ...state,
              mutation:
                state.mutation?.requestId === mutation.requestId
                  ? {
                      ...state.mutation,
                      busy: false,
                      phase: 'idle',
                      resolution: 'unresolved',
                    }
                  : state.mutation,
            }));
            return;
          }
          updateTaxState(t, (state) => ({
            ...state,
            mutation:
              state.mutation?.requestId === mutation.requestId
                ? {
                    ...state.mutation,
                    busy: true,
                    phase: 'resolving',
                    resolution: 'resolving',
                  }
                : state.mutation,
          }));
          void (async () => {
            const stillCurrent = () =>
              aliveRef.current && activeCompanyIdRef.current === companyId;
            const markUnresolved = () => {
              if (!stillCurrent()) return;
              updateTaxState(t, (state) => ({
                ...state,
                mutation:
                  state.mutation?.requestId === mutation.requestId
                    ? {
                        ...state.mutation,
                        busy: false,
                        phase: 'idle',
                        resolution: 'unresolved',
                      }
                    : state.mutation,
              }));
            };

            let freshRows: TransactionDto[];
            try {
              freshRows = await fetchAllTxns(companyId);
            } catch {
              markUnresolved();
              return;
            }
            if (!stillCurrent()) return;
            const fresh = freshRows.find((row) => row.id === t.id);
            if (!fresh) {
              markUnresolved();
              return;
            }
            const activeAttempt = fresh.activeCategorizationAttempt;
            if (activeAttempt) {
              const expectedOperation = mutation.kind === 'undo' ? 'restore' : 'recategorize';
              if (
                activeAttempt.requestId !== mutation.requestId ||
                activeAttempt.operation !== expectedOperation
              ) {
                markUnresolved();
                return;
              }
              setRows(freshRows);
              updateTaxState(fresh, (state) => ({
                ...state,
                mutation: {
                  ...mutation,
                  attemptStatus: activeAttempt.status,
                  outcome:
                    activeAttempt.status === 'UNCERTAIN'
                      ? 'UNCERTAIN'
                      : 'IN_PROGRESS',
                  busy: false,
                  phase: 'idle',
                  resolution: 'known',
                  reconciled: false,
                },
              }));
              return;
            }

            setRows(freshRows);
            try {
              const replay = mutation.kind === 'undo'
                ? txnApi.undoCategorization(t.id, mutation.requestId)
                : txnApi.commitCategorization(t.id, t.revision, mutation.requestId);
              const result = await replay;
              if (!stillCurrent()) return;
              recordTaxMutation(fresh, result, {
                ...mutation,
                resolution: 'known',
              }, false);
            } catch (replayError) {
              if (
                stillCurrent() &&
                replayError instanceof ApiError &&
                replayError.mutationResult?.transactionId === fresh.id &&
                replayError.mutationResult.requestId === mutation.requestId
              ) {
                recordTaxMutation(fresh, replayError.mutationResult, {
                  ...mutation,
                  resolution: 'known',
                }, false);
                return;
              }
              markUnresolved();
            }
          })();
        });
    },
    [
      taxState,
      updateTaxState,
      recordTaxMutation,
      activeCompanyId,
      fetchAllTxns,
      toast,
    ],
  );

  const undoTax = useCallback(
    (t: TransactionDto) => {
      if (!window.confirm(
        `Undo this categorization in QuickBooks?\nThis will restore the original ${t.qboType === 'Deposit' ? 'Deposit' : 'Purchase'} exactly.`,
      )) return;
      const requestId = createCategorizationRequestId();
      const mutation: TaxMutationState = {
        kind: 'undo',
        requestId,
        attemptStatus: null,
        outcome: 'PENDING',
        busy: true,
        phase: 'writing',
        resolution: 'known',
        reconciled: false,
      };
      updateTaxState(t, (state) => ({ ...state, mutation }));
      txnApi
        .undoCategorization(t.id, requestId)
        .then((result) => {
          if (aliveRef.current) recordTaxMutation(t, result, mutation, false);
        })
        .catch((error) => {
          if (!aliveRef.current) return;
          recordTaxMutationFailure(t, error, mutation);
        });
    },
    [updateTaxState, recordTaxMutation, recordTaxMutationFailure],
  );

  const doPost = useCallback(
    (id: string) => {
      const t0 = rows.find((t) => t.id === id);
      const hasSplit = !!(t0 && t0.splits && t0.splits.length);
      if (!t0 || hasActiveMutation(t0) || !(t0.category || hasSplit)) return;
      if (taxReadyFor(t0)) {
        commitTax(t0);
        return;
      }
      // Mirror the server guard: split txns need a tag on every split;
      // unsplit txns need at least one row-level tag.
      const effTags = hasSplit
        ? t0.splits!.every((sp) => sp.tagIds.length > 0)
        : t0.tagIds.length > 0;
      if (tagsRequired && !effTags) {
        toast(
          hasSplit
            ? 'Tags are required — add a tag to every split'
            : 'Tags are required — add a tag first',
        );
        return;
      }
      patchRow(id, { status: 'POSTING' });
      txnApi
        .post(id)
        .then((res) => {
          if (!aliveRef.current) return;
          const dto = res as PostResponseDto;
          updateRow(dto);
          setSel((s) => ({ ...s, [id]: false }));
          if (
            dto.rulePromptEligible &&
            (dto.status === 'POSTED' || dto.status === 'DRY_RUN')
          ) {
            setRulePrompt(
              (rp) =>
                rp ?? {
                  payee: dto.payee,
                  category: dto.category ?? '',
                  categoryQboId: dto.categoryQboId,
                },
            );
          }
        })
        .catch((e) => {
          if (!aliveRef.current) return;
          patchRow(id, { status: 'PENDING' });
          toast(errText(e));
        });
    },
    [
      rows,
      hasActiveMutation,
      taxReadyFor,
      commitTax,
      tagsRequired,
      patchRow,
      updateRow,
      toast,
    ],
  );

  const undoPost = useCallback(
    (id: string) => {
      txnApi
        .undo(id)
        .then((dto) => {
          if (!aliveRef.current) return;
          updateRow(dto);
          toast('Reverted — moved back to the queue');
        })
        .catch((e) => toast(errText(e)));
    },
    [updateRow, toast],
  );

  const doRetry = useCallback(
    (id: string) => {
      setErrOpenId(null);
      txnApi
        .retry(id)
        .then((dto) => {
          if (!aliveRef.current) return;
          updateRow(dto);
          toast('Re-fetched from QuickBooks — ready to post again');
        })
        .catch((e) => toast(errText(e)));
    },
    [updateRow, toast],
  );

  const recordTransfer = useCallback(
    (t: TransactionDto) => {
      const mate = xferMateOf(t);
      if (!mate) return;
      txnApi
        .transfer(t.id, mate.id)
        .then((dtos) => {
          if (!aliveRef.current) return;
          setRows((prev) =>
            prev.map((r) => dtos.find((d) => d.id === r.id) ?? r),
          );
          toast(dryRun ? 'Dry run — transfer payload logged' : 'Recorded as a transfer in QuickBooks');
        })
        .catch((e) => toast(errText(e)));
    },
    [xferMateOf, dryRun, toast],
  );

  const toggleTag = useCallback(
    (t: TransactionDto, tagId: string) => {
      if (hasActiveMutation(t)) return;
      const prev = t.tagIds;
      const next = t.tagIds.includes(tagId)
        ? t.tagIds.filter((i) => i !== tagId)
        : [...t.tagIds, tagId];
      patchRow(t.id, { tagIds: next }); // optimistic
      if (taxReadyFor(t)) {
        requestStage({ ...t, tagIds: next }, taxState(t));
        return;
      }
      txnApi
        .categorize(t.id, { tagIds: next })
        .then((dto) => {
          if (aliveRef.current) updateRow(dto);
        })
        .catch((e) => {
          if (aliveRef.current) patchRow(t.id, { tagIds: prev }); // roll back
          toast(errText(e));
        });
    },
    [hasActiveMutation, patchRow, taxReadyFor, requestStage, taxState, updateRow, toast],
  );

  const saveSplit = useCallback(
    (t: TransactionDto, lines: SplitLineDraft[], taxCalculation?: TaxCalculation) => {
      if (hasActiveMutation(t)) return;
      const sign = t.amount < 0 ? -1 : 1;
      const splits: SplitDto[] = lines.map((l) => {
        const amount = Math.round((parseFloat(l.amt) || 0) * 100) / 100;
        const categoryQboId = qboIdOf(l.cat);
        return {
          amount: amount * sign,
          category: l.cat,
          ...(categoryQboId ? { categoryQboId } : {}),
          tagIds: [...l.tags],
          ...(l.memo ? { memo: l.memo } : {}),
          taxCodeQboId: l.taxCodeQboId,
        };
      });
      const prev = { category: t.category, categoryQboId: t.categoryQboId, splits: t.splits };
      setSplitEditId(null);
      patchRow(t.id, { category: null, categoryQboId: null, splits }); // optimistic
      toast('Split saved — ready to post');
      if (taxReadyFor(t)) {
        const nextState = { ...taxState(t), taxCalculation: taxCalculation ?? 'NotApplicable', taxCodeQboId: null };
        updateTaxState(t, () => nextState);
        requestStage({ ...t, category: null, categoryQboId: null, splits }, nextState);
        return;
      }
      txnApi
        .categorize(t.id, { category: null, categoryQboId: null, splits })
        .then((dto) => {
          if (aliveRef.current) updateRow(dto);
        })
        .catch((e) => {
          if (aliveRef.current) patchRow(t.id, prev); // roll back
          toast(errText(e));
        });
    },
    [
      hasActiveMutation,
      qboIdOf,
      patchRow,
      taxReadyFor,
      requestStage,
      taxState,
      updateTaxState,
      updateRow,
      toast,
    ],
  );

  const syncNow = useCallback(async () => {
    const companyId = activeCompanyId;
    const companyName = activeCompany?.nickname ?? 'selected company';
    if (!companyId) return;
    if (companySyncLocks.has(companyId)) {
      setSyncingCompanyId(companyId);
      return;
    }

    const request = companiesApi.sync(companyId);
    companySyncLocks.set(companyId, { request, listeners: new Set() });
    setSyncingCompanyId(companyId);
    const stillCurrent = () => (
      aliveRef.current && activeCompanyIdRef.current === companyId
    );

    try {
      const result = await request;
      // Company metadata belongs to the app provider, which survives Queue remounts.
      // Refresh it on sync success even when this Queue no longer owns the view.
      if (result.ok) void refreshCompanies().catch(() => {});
      if (!stillCurrent()) return;
      if (!result.ok) {
        toast(`Sync failed for ${companyName} — ${result.message}`);
        return;
      }

      let fresh: TransactionDto[];
      try {
        fresh = await fetchAllTxns(companyId);
      } catch (error) {
        if (stillCurrent()) {
          toast(`Synced ${companyName}, but Queue refresh failed — ${errText(error)}`);
        }
        return;
      }
      if (!stillCurrent()) return;
      setRows(fresh);
      toast(`Synced ${companyName} — ${result.message}`);
    } catch (error) {
      if (stillCurrent()) toast(`Sync failed for ${companyName} — ${errText(error)}`);
    } finally {
      releaseCompanySyncLock(companyId, request);
      if (stillCurrent()) {
        setSyncingCompanyId((current) => current === companyId ? null : current);
      }
    }
  }, [activeCompany, activeCompanyId, fetchAllTxns, refreshCompanies, toast]);

  const isSyncingActiveCompany = syncingCompanyId !== null && syncingCompanyId === activeCompanyId;

  const bulkPost = useCallback(async () => {
    if (!activeCompanyId) return;
    const taxLifecycleSelection = selPend
      .map((id) => rows.find((row) => row.id === id))
      .filter((row): row is TransactionDto => !!row && usesTaxLifecycleFor(row));
    if (taxLifecycleSelection.length) {
      toast(
        taxLifecycleSelection.some((row) => row.qboType === 'Deposit')
          ? 'Tax-ready transactions must be previewed and posted individually'
          : 'Tax-ready purchases must be previewed and posted individually',
      );
      return;
    }
    if (!selReady.length) {
      toast(
        tagsRequired
          ? 'Selection needs a category and at least one tag each'
          : 'Pick a category for the selection first',
      );
      return;
    }
    const ids = [...selReady];
    setRows((prev) =>
      prev.map((r) => (ids.includes(r.id) ? { ...r, status: 'POSTING' as TxnStatus } : r)),
    );
    setBulkCat(null);
    try {
      await txnApi.bulkPost(ids);
    } catch (e) {
      toast(errText(e));
    }
    // Refetch and keep polling briefly while the server finishes posting.
    for (let attempt = 0; attempt < 8; attempt++) {
      let fresh: TransactionDto[];
      try {
        fresh = await fetchAllTxns(activeCompanyId);
      } catch {
        break;
      }
      if (!aliveRef.current) return;
      setRows(fresh);
      setSel((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const r = fresh.find((x) => x.id === id);
          if (r && r.status !== 'PENDING' && r.status !== 'ERROR') delete next[id];
        }
        return next;
      });
      if (!fresh.some((r) => ids.includes(r.id) && r.status === 'POSTING')) break;
      await new Promise((res) => setTimeout(res, 1200));
    }
  }, [
    activeCompanyId,
    selReady,
    selPend,
    rows,
    taxReadyFor,
    usesTaxLifecycleFor,
    tagsRequired,
    fetchAllTxns,
    toast,
  ]);

  const createRule = useCallback(() => {
    if (!activeCompanyId || !rulePrompt) return;
    const rp = rulePrompt;
    setRulePrompt(null);
    rulesApi
      .create(activeCompanyId, {
        matchText: rp.payee,
        category: rp.category,
        categoryQboId: rp.categoryQboId,
      })
      .then(() => toast('Rule created — matching payees will be pre-filled'))
      .catch((e) => toast(errText(e)));
  }, [activeCompanyId, rulePrompt, toast]);

  // Prototype cycleSort: first press asc, second desc, third back to original.
  const cycleSort = useCallback(
    (k: SortKey) => {
      if (sortKey !== k) {
        setSortKey(k);
        setSortDir(1);
      } else if (sortDir === 1) {
        setSortDir(-1);
      } else {
        setSortKey(null);
        setSortDir(1);
      }
    },
    [sortKey, sortDir],
  );

  // ---- keyboard (prototype onKey, verbatim ordering) ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    // The split dialog owns keyboard interaction, including its non-input heading.
    if (splitEditId !== null) return;
    if (e.key === 'Escape') {
      setSel({});
      setTagPicker(null);
      setErrOpenId(null);
      setRulePrompt(null);
      setSplitEditId(null);
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, .control-trigger, .control-popover, [role="combobox"], [role="listbox"], [contenteditable="true"]')) return;
    if (e.key === 'Enter' && target?.closest('button, a, summary, [role="button"]')) return;
    if (!vis.length) return;
    const i = Math.min(activeIdx, vis.length - 1);
    const cur = vis[i];
    if (!cur) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setActiveIdx(Math.min(i + 1, vis.length - 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setActiveIdx(Math.max(i - 1, 0));
    } else if (e.key === 'x') {
      if (!hasActiveMutation(cur)) {
        setSel((s) => ({ ...s, [cur.id]: !s[cur.id] }));
      }
    } else if (e.key === 't') {
      e.preventDefault();
      if (!hasActiveMutation(cur)) {
        setTagPicker((tp) => (tp === cur.id ? null : cur.id));
      }
    } else if (e.key === 'Enter') {
      // Splits count as categorized — doPost's own guards handle the rest.
      if (cur.status === 'PENDING' && !hasActiveMutation(cur) && (cur.category || (cur.splits && cur.splits.length))) {
        doPost(cur.id);
      }
    }
  };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  // ---- derived footer bits ----
  const watchingNames = useMemo(() => {
    const ids = activeCompany?.holdingAccountIds ?? [];
    return ids
      .map((hid) => accounts.find((a) => a.id === hid || a.qboId === hid)?.name)
      .filter((n): n is string => !!n)
      .join(' · ');
  }, [activeCompany, accounts]);

  const catOpts = useMemo(
    () => catAccounts.map((a) => ({ group: a.classification, name: a.name })),
    [catAccounts],
  );

  const splitTxn = splitEditId !== null ? rows.find((r) => r.id === splitEditId) ?? null : null;

  const allSel =
    vis.length > 0 &&
    vis.every((t) => sel[t.id] || t.status !== 'PENDING' || hasActiveMutation(t));
  const toggleAll = () => {
    const anyOff = vis.some(
      (t) => t.status === 'PENDING' && !hasActiveMutation(t) && !sel[t.id],
    );
    setSel((prev) => {
      const next = { ...prev };
      vis.forEach((t) => {
        if (t.status === 'PENDING' && !hasActiveMutation(t)) next[t.id] = anyOff;
      });
      return next;
    });
  };

  const selCount = selPend.length || selIds.length;

  // -------------------------------------------------------------------------
  // Per-row render helpers
  // -------------------------------------------------------------------------

  interface RowView {
    t: TransactionDto;
    state: UiState;
    hasSplit: boolean;
    suggested: boolean;
    sugName: string | null;
    isRule: boolean;
    mate: TransactionDto | null;
    effTags: boolean;
    isActive: boolean;
    canUndo: boolean;
    ready: boolean;
    notReady: boolean;
    pendTip: string;
    pickLabel: string;
  }

  const rowView = (t: TransactionDto): RowView => {
    const state = stateOf(t);
    const hasSplit = !!(t.splits && t.splits.length);
    const sugName = t.suggestion?.category ?? null;
    const suggested = !t.category && !hasSplit && !!sugName;
    const mate = xferMateOf(t);
    // Same rule as the server's tagsRequired guard (writeback.ts): split txns
    // need a tag on every split; unsplit txns need at least one row-level tag.
    const effTags = hasSplit
      ? t.splits!.every((sp) => sp.tagIds.length > 0)
      : t.tagIds.length > 0;
    const isActive = t.id === activeId;
    return {
      t,
      state,
      hasSplit,
      suggested,
      sugName,
      isRule: t.suggestion?.source === 'rule',
      mate,
      effTags,
      isActive,
      canUndo: canUndoPosted(t.postedAt),
      ready: state === 'pending' && (!!t.category || hasSplit) && !(tagsRequired && !effTags),
      notReady:
        state === 'pending' && ((!t.category && !hasSplit) || (tagsRequired && !effTags)),
      pendTip:
        tagsRequired && !effTags
          ? hasSplit
            ? 'Tags are required — add a tag to every split'
            : 'Tags are required — add a tag first'
          : 'Choose a category first',
      pickLabel: hasSplit
        ? `Split · ${t.splits!.length} ${t.splits!.length === 1 ? 'category' : 'categories'}`
        : t.category
          ? fullCat(t.category)
          : suggested
            ? sugName!
            : 'Choose category…',
    };
  };

  const onRowClick = (t: TransactionDto) => {
    setActiveIdx(vis.findIndex((v) => v.id === t.id));
    setErrOpenId((cur) => (cur === t.id ? cur : null));
  };

  const onTagBtn = (t: TransactionDto) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (hasActiveMutation(t)) return;
    setTagPicker((tp) => (tp === t.id ? null : t.id));
  };

  const rowCategoryPicker = (v: RowView, mobile: boolean) =>
    v.t.splits && v.t.splits.length ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          doOpenSplit(v.t.id);
        }}
        disabled={v.t.status !== 'PENDING' || hasActiveMutation(v.t)}
        className="control-trigger queue-split-trigger hov-brd"
      >
        {v.pickLabel}
      </button>
    ) : (
      <span onClick={(event) => event.stopPropagation()}>
        <CategoryPicker
          label={`Category for ${v.t.payee}`}
          value={v.t.categoryQboId}
          options={rowCategoryOptions(v.t)}
          onPick={(qboId) => pickRowCategory(v.t, qboId)}
          onSplitFooter={() => doOpenSplit(v.t.id)}
          showBadges={!mobile}
          disabled={v.t.status !== 'PENDING' || hasActiveMutation(v.t)}
          triggerText={v.pickLabel}
          triggerTone={v.suggested ? 'suggested' : undefined}
          triggerBadge={v.suggested ? v.isRule ? 'rule' : 'suggested' : undefined}
          triggerBadgeTooltip={
            v.isRule && (v.t.suggestion?.matchedRules ?? 0) > 1
              ? `Matched ${v.t.suggestion?.matchedRules} rules — “${v.t.suggestion?.winnerMatchText ?? ''}” won (topmost). Reorder in Rules.`
              : undefined
          }
        />
      </span>
    );

  const tagChips = (t: TransactionDto) =>
    t.tagIds
      .map((id) => tags.find((tg) => tg.id === id))
      .filter((tg): tg is NonNullable<typeof tg> => !!tg)
      .map((tg) => (
        <span
          key={tg.id}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--mut)',
            border: '1px solid var(--bd2)',
            background: 'var(--hl)',
            borderRadius: 99,
            padding: '2px 8px',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: tg.color,
              display: 'inline-block',
            }}
          />
          {tg.name}
        </span>
      ));

  const taxControls = (t: TransactionDto) => {
    if (!taxReadyFor(t) || t.status !== 'PENDING' || (!t.category && !(t.splits && t.splits.length))) {
      return null;
    }
    const state = taxState(t);
    const readyStage = readyStageFor(t, state);
    const direction = taxDirectionFor(t);
    const taxLabel = taxLabelFor(t);
    const isSplit = !!(t.splits && t.splits.length);
    const locked = hasActiveMutation(t);
    return (
      <span className="queue-tax-controls">
        <span className={`queue-tax-line${isMobile ? ' queue-tax-line-mobile' : ''}`}>
        {!isSplit && (
          <TaxCodePicker
            id={`tax-code-${t.id}`}
            label={`${taxLabel} for ${t.payee}`}
            readiness={taxReadiness}
            direction={direction ?? 'purchase'}
            value={state.taxCodeQboId}
            disabled={locked}
            onChange={(taxCodeQboId) => {
              if (locked) return;
              patchRow(t.id, {
                taxCodeQboId,
                taxCode:
                  taxCodesFor(t).find((code) => code.qboId === taxCodeQboId)?.name ?? null,
              });
              const nextState: TaxRowState = { ...state,
                taxCodeQboId,
                taxCalculation:
                  taxCodeQboId === null
                    ? 'NotApplicable'
                    : state.taxCalculation === 'TaxExcluded'
                      ? 'TaxExcluded'
                      : 'TaxInclusive',
              };
              updateTaxState(t, () => nextState);
              requestStage({ ...t, taxCodeQboId }, nextState);
            }}
          />
        )}
        {state.taxCodeQboId !== null ||
        (isSplit && state.taxCalculation !== 'NotApplicable') ? (
          <span style={{ display: 'block' }}>
            <Select
              id={`tax-calculation-${t.id}`}
              label={`Tax calculation for ${t.payee}`}
              value={state.taxCalculation === 'TaxExcluded' ? 'TaxExcluded' : 'TaxInclusive'}
              disabled={locked}
              options={[{ value: 'TaxInclusive', label: 'Tax inclusive' }, { value: 'TaxExcluded', label: 'Tax exclusive' }]}
              onValueChange={(next) => {
                if (locked || (next !== 'TaxInclusive' && next !== 'TaxExcluded')) return;
                const nextState: TaxRowState = { ...state, taxCalculation: next };
                updateTaxState(t, () => nextState);
                requestStage(t, nextState);
              }}
            />
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--mut)', paddingBottom: 8 }}>
            No tax selected
          </span>
        )}
        {readyStage !== null && (
          <span className="queue-tax-totals">
            <span>Subtotal {centsLabel(readyStage.totals.subtotalCents)}</span>
            <span>Tax {centsLabel(readyStage.totals.taxCents)}</span>
            <span>Total {centsLabel(readyStage.totals.totalCents)}</span>
          </span>
        )}
        </span>
        <span className="queue-tax-feedback">
        {!locked && stageBodyFor(t, state) === null && <span style={{ gridColumn: '1 / -1', color: 'var(--amT)', fontSize: 12 }}>
          {t.splits?.length ? 'Open Split to review its categories and tax codes before calculating tax.'
            : 'Choose an available category and tax code before calculating tax.'}
        </span>}
        {(state.stage.status === 'idle' || (state.stage.status === 'conflict' && !locked)) && <button type="button" className="btn-ghost"
          aria-label={`Calculate tax for ${t.payee}`}
          disabled={locked || stageBodyFor(t, state) === null}
          onClick={(event) => {
            event.stopPropagation();
            const next = { ...state, stage: initialTaxState(t).stage };
            if (state.stage.status === 'conflict') {
              stageCoordinatorsRef.current[t.id]?.dispose();
              delete stageCoordinatorsRef.current[t.id];
              updateTaxState(t, () => next);
            }
            requestStage(t, next);
          }}>
          Calculate tax
        </button>}
        {state.stage.status === 'calculating' && <span style={{ gridColumn: '1 / -1', color: 'var(--mut)', fontSize: 12 }}>Calculating tax…</span>}
        {state.stage.status === 'error' && <span style={{ gridColumn: '1 / -1', color: 'var(--erT)', fontSize: 12 }}>
          {state.stage.error ?? 'Could not calculate tax.'}
          <button type="button" className="btn-ghost" onClick={(event) => { event.stopPropagation(); stageCoordinatorsRef.current[t.id]?.retry(); }}>Retry calculation</button>
        </span>}
        {state.stage.status === 'conflict' && <span style={{ gridColumn: '1 / -1', color: 'var(--erT)', fontSize: 12 }}>{state.stage.error}</span>}
        </span>
      </span>
    );
  };

  const taxStatusCell = (v: RowView, mobile: boolean) => {
    const state = taxState(v.t);
    const mutation = state.mutation;
    const validStage = readyStageFor(v.t, state) !== null;
    const buttonStyle: CSSProperties = {
      fontSize: 13.5,
      fontWeight: 600,
      color: '#fff',
      background: 'var(--acc)',
      border: 'none',
      borderRadius: 7,
      padding: mobile ? '9px 16px' : '7px 16px',
      cursor: validStage ? 'pointer' : 'default',
      font: 'inherit',
      opacity: validStage ? 1 : 0.45,
    };

    if (mutation?.busy) {
      return (
        <span style={{ color: 'var(--amT)', fontSize: 12.5, fontWeight: 600 }}>
          {mutation.phase === 'resolving'
            ? 'Checking write status…'
            : mutation.phase === 'reconciling'
            ? 'Verifying…'
            : mutation.kind === 'undo'
              ? 'Undoing…'
              : 'Posting…'}
        </span>
      );
    }
    if (mutation?.resolution === 'unresolved') {
      return (
        <span style={{ color: 'var(--erT)', fontSize: 12 }}>
          Write status unresolved — reload required
        </span>
      );
    }
    if (mutation?.attemptStatus === 'PREPARED') {
      return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 5, alignItems: 'center' }}>
          <span style={{ color: 'var(--amT)', fontSize: 12 }}>
            Prepared — not sent
          </span>
          <button className="btn-ghost" onClick={() => resumePreparedTax(v.t)}>
            {mutation.kind === 'undo' ? 'Resume undo' : 'Resume post'}
          </button>
        </span>
      );
    }
    if (mutation?.outcome === 'UNCERTAIN' || mutation?.outcome === 'IN_PROGRESS') {
      return (
        <span className="queue-recovery-content">
          <span style={{ color: 'var(--erT)', fontSize: 12 }}>
            Verify in QuickBooks — outcome uncertain
          </span>
          <span className="queue-recovery-actions">
            <button className="btn-ghost" onClick={() => reconcileTax(v.t, false)}>
              Reconcile
            </button>
            <button className="btn-ghost" onClick={() => reconcileTax(v.t, true)}>
              Retry verification
            </button>
          </span>
        </span>
      );
    }
    if (mutation?.kind === 'undo' && mutation.outcome === 'VERIFIED') {
      return <span className="pill-ok">Reverted ✓</span>;
    }
    if (v.t.status === 'REVERTED') {
      return <span className="pill-ok">Reverted ✓</span>;
    }
    if (
      mutation?.kind === 'commit' &&
      (mutation.outcome === 'VERIFIED' || mutation.outcome === 'DRY_RUN')
    ) {
      return (
        <>
          <span className={mutation.outcome === 'DRY_RUN' ? 'pill-am' : 'pill-ok'}>
            {mutation.outcome === 'DRY_RUN'
              ? 'Dry run — verified'
              : mutation.reconciled
                ? 'Verified in QuickBooks ✓'
                : 'Posted — verified ✓'}
          </span>
          {mutation.outcome === 'VERIFIED' && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                undoTax(v.t);
              }}
              className="hov-ink"
              style={{ border: 'none', background: 'none', color: 'var(--fnt)', cursor: 'pointer' }}
            >
              Undo
            </button>
          )}
        </>
      );
    }
    if (v.t.status === 'POSTED') {
      return (
        <>
          <span className="pill-ok">Posted — verified ✓</span>
          {v.canUndo && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                undoTax(v.t);
              }}
              className="hov-ink"
              style={{ border: 'none', background: 'none', color: 'var(--fnt)', cursor: 'pointer' }}
            >
              Undo
            </button>
          )}
        </>
      );
    }
    if (mutation?.outcome === 'RETRYABLE' || mutation?.outcome === 'UNCHANGED') {
      return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ color: 'var(--amT)', fontSize: 12 }}>Not posted — restage to retry</span>
        <button className="btn-ghost" onClick={(event) => {
          event.stopPropagation();
          if (state.stage.status === 'conflict') {
            stageCoordinatorsRef.current[v.t.id]?.dispose();
            delete stageCoordinatorsRef.current[v.t.id];
            const next = { ...state, mutation: null, stage: initialTaxState(v.t).stage };
            updateTaxState(v.t, () => next);
            requestStage(v.t, next);
            return;
          }
          if (!stageCoordinatorsRef.current[v.t.id]?.restage()) return;
          updateTaxState(v.t, (current) => ({ ...current, mutation: null }));
        }}>Restage categorization</button>
      </span>;
    }
    if (v.t.status === 'PENDING') {
      return (
        <button
          disabled={!validStage}
          onClick={(event) => {
            event.stopPropagation();
            commitTax(v.t);
          }}
          style={buttonStyle}
        >
          Post
        </button>
      );
    }
    return null;
  };

  const statusCell = (v: RowView, mobile: boolean) => {
    if (usesTaxLifecycleFor(v.t)) return taxStatusCell(v, mobile);
    return (
    <>
      {v.ready && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            doPost(v.t.id);
          }}
          onMouseDown={stopMouse}
          className={mobile ? undefined : 'hov-acc'}
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--acc)',
            border: 'none',
            borderRadius: 7,
            padding: mobile ? '9px 16px' : '7px 16px',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Post
        </button>
      )}
      {v.notReady && (
        <span
          data-tip={v.pendTip}
          data-tip-align="right"
          style={
            mobile
              ? { fontSize: 13.5, fontWeight: 600, color: 'var(--bd)', padding: '9px 6px' }
              : { fontSize: 13.5, fontWeight: 600, color: 'var(--bd)', cursor: 'help' }
          }
        >
          Post
        </span>
      )}
      {v.state === 'posting' && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--amT)',
          }}
        >
          <Spinner size={11} colorVar="var(--amT)" trackVar="var(--amD)" />
          Posting
        </span>
      )}
      {v.state === 'posted' && (
        <>
          <span className="pill-ok">Posted ✓</span>
          {v.canUndo && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                undoPost(v.t.id);
              }}
              onMouseDown={stopMouse}
              data-tip={mobile ? 'Undo' : 'Undo — move back to the queue'}
              data-tip-align="right"
              className={mobile ? undefined : 'hov-ink'}
              style={{
                border: 'none',
                background: 'none',
                color: 'var(--fnt)',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                ...(mobile ? {} : { marginLeft: 4 }),
              }}
            >
              ↩
            </button>
          )}
        </>
      )}
      {v.state === 'dry' && (
        <>
          <span
            className="pill-am"
            {...(mobile
              ? {}
              : { 'data-tip': 'Dry run — payload logged, nothing sent to QuickBooks' })}
          >
            Dry run ✓
          </span>
          {v.canUndo && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                undoPost(v.t.id);
              }}
              onMouseDown={stopMouse}
              data-tip={mobile ? 'Undo' : 'Undo — move back to the queue'}
              data-tip-align="right"
              className={mobile ? undefined : 'hov-ink'}
              style={{
                border: 'none',
                background: 'none',
                color: 'var(--fnt)',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                ...(mobile ? {} : { marginLeft: 4 }),
              }}
            >
              ↩
            </button>
          )}
        </>
      )}
      {v.state === 'error' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setErrOpenId((cur) => (cur === v.t.id ? null : v.t.id));
          }}
          onMouseDown={stopMouse}
          className="pill-er"
          style={{ cursor: 'pointer', font: 'inherit' }}
        >
          Error ⓘ
        </button>
      )}
    </>
    );
  };

  const errLine = (v: RowView, marginTop: number) =>
    errOpenId === v.t.id && v.state === 'error' ? (
      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--erT)', marginTop }}>
        {v.t.error?.message}{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            doRetry(v.t.id);
          }}
          onMouseDown={stopMouse}
          style={{ color: 'var(--erT)', fontWeight: 600 }}
        >
          Retry
        </a>
      </span>
    ) : null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const sortHeaderStyle = (align: 'left' | 'right' | 'center'): CSSProperties => ({
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
    textTransform: 'inherit',
    letterSpacing: 'inherit',
    textAlign: align,
  });

  const sortArr = (k: SortKey) => (sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : '');

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 120px' }}>
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 18,
          flexWrap: 'wrap',
          gap: 14,
        }}
      >
        <div>
          <div className="page-title">Needs categorizing</div>
          <div className="page-sub">{subline}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveIdx(0);
            }}
            placeholder="Search anything — payee, amount, category, status…"
            style={{ width: 280, maxWidth: '100%' }}
          />
          <Select
            label="Account filter"
            value={acct}
            options={[
              { value: 'all', label: 'All accounts' },
              ...bankOpts.map((name) => ({ value: name, label: name })),
            ]}
            onValueChange={(next) => {
              setAcct(next ?? 'all');
              setActiveIdx(0);
            }}
          />
          <button
            className="btn-ghost"
            type="button"
            onClick={() => void syncNow()}
            disabled={isSyncingActiveCompany}
            aria-busy={isSyncingActiveCompany}
          >
            {isSyncingActiveCompany ? <><Spinner size={11} /> Syncing…</> : '↻ Sync now'}
          </button>
        </div>
      </div>

      {activeCompanyId && (role === 'categorizer' || role === 'admin') && (
        <AutopilotQueueStatus
          key={activeCompanyId}
          companyId={activeCompanyId}
          surface="queue"
        />
      )}

      {taxReadiness?.status !== 'ready' && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            border: '1px solid var(--bd2)',
            borderRadius: 8,
            padding: '9px 12px',
            color: 'var(--mut)',
            fontSize: 13,
          }}
        >
          {taxReadiness === null
            ? 'Purchase tax availability is unavailable. The existing no-tax category, tag, and post workflow remains available.'
            : taxReadiness.reason ??
              'Purchase tax is unavailable. The existing no-tax category, tag, and post workflow remains available.'}
        </div>
      )}

      {/* desktop table */}
      {!isMobile && (
        <div
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 9,
            background: 'var(--card)',
            boxShadow: '0 1px 6px rgba(60,55,45,.05)',
            overflowX: 'auto',
          }}
        >
          <div style={{ minWidth: GRID_MIN_WIDTH }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: GRID_COLS,
                gap: '0 12px',
                alignItems: 'center',
                padding: '10px 18px',
                fontSize: 11.5,
                fontWeight: 600,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: 'var(--fnt)',
                borderBottom: '1px solid var(--bd2)',
              }}
            >
              <input
                type="checkbox"
                checked={allSel}
                onChange={toggleAll}
                style={{ width: 15, height: 15, accentColor: 'var(--acc)', cursor: 'pointer' }}
              />
              {SORT_KEYS.map((k) => (
                <button
                  key={k}
                  onClick={() => cycleSort(k)}
                  style={sortHeaderStyle(k === 'amt' ? 'right' : k === 'status' ? 'center' : 'left')}
                >
                  {SORT_LABELS[k]}
                  {sortArr(k)}
                </button>
              ))}
            </div>
            {vis.map((t) => {
              const v = rowView(t);
              return (
                <Fragment key={t.id}>
                <div
                  className="interactive-surface"
                  onClick={() => onRowClick(t)}
                  style={{
                    position: 'relative',
                    display: 'grid',
                    gridTemplateColumns: GRID_COLS,
                    gap: '0 12px',
                    alignItems: 'center',
                    padding: 'var(--rpv) 18px',
                    borderBottom: '1px solid var(--rowbd)',
                    fontSize: 'var(--rfs)',
                    background: v.isActive ? 'var(--hl)' : 'transparent',
                    boxShadow: v.isActive ? 'inset 2.5px 0 0 var(--acc)' : 'none',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!sel[t.id]}
                    disabled={hasActiveMutation(t)}
                    onChange={() => setSel((s) => ({ ...s, [t.id]: !s[t.id] }))}
                    onClick={stopMouse}
                    onMouseDown={stopMouse}
                    style={{ width: 15, height: 15, accentColor: 'var(--acc)', cursor: 'pointer' }}
                  />
                  <span style={{ color: 'var(--mut)' }}>{fmtDate(t.date)}</span>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {t.payee}
                    </span>
                    {t.memo && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12.5,
                          color: 'var(--fnt)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.memo}
                      </span>
                    )}
                    <span
                      ref={tagPicker === t.id ? tagPickerRootRef : undefined}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 5,
                        marginTop: 5,
                        alignItems: 'center',
                        position: 'relative',
                      }}
                    >
                      {tagChips(t)}
                      <button
                        onClick={onTagBtn(t)}
                        onMouseDown={stopMouse}
                        disabled={hasActiveMutation(t)}
                        data-tip="Tags live only in Recat — never written to QuickBooks"
                        className="hov-dash"
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--fnt)',
                          border: '1px dashed var(--bd)',
                          background: 'none',
                          borderRadius: 99,
                          padding: '2px 9px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        + tag
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setAttachmentOpenId((current) => current === t.id ? null : t.id);
                        }}
                        onMouseDown={stopMouse}
                        aria-expanded={attachmentOpenId === t.id}
                        aria-label={`Attachments for ${t.payee}`}
                        className="hov-dash"
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--fnt)',
                          border: '1px dashed var(--bd)',
                          background: 'none',
                          borderRadius: 99,
                          padding: '2px 9px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        📎{attachmentCounts[t.id] === undefined ? '' : ` ${attachmentCounts[t.id]}`}
                      </button>
                      {tagPicker === t.id && (
                        <TagPicker
                          tags={tags}
                          selectedIds={t.tagIds}
                          onToggle={(tagId) => toggleTag(t, tagId)}
                          onManage={() => navigate('/tags')}
                          width={230}
                        />
                      )}
                    </span>
                    {taxControls(t)}
                    {v.mate && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12.5,
                          color: 'var(--mut)',
                          marginTop: 4,
                        }}
                      >
                        ⇄ Looks like a transfer with {v.mate.bankAccount} —{' '}
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            recordTransfer(t);
                          }}
                          onMouseDown={stopMouse}
                          style={{ fontWeight: 600 }}
                        >
                          record as transfer
                        </a>
                      </span>
                    )}
                    {errLine(v, 3)}
                  </span>
                  <span
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: t.amount > 0 ? 'var(--okT)' : 'var(--ink)',
                    }}
                  >
                    {fmtMoney(t.amount)}
                  </span>
                  <span style={{ color: 'var(--mut)', fontSize: 13 }}>{t.bankAccount}</span>
                  <span
                    style={{ position: 'relative', display: 'flex', gap: 5, alignItems: 'center' }}
                  >
                    {rowCategoryPicker(v, false)}
                    {v.state === 'pending' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          doOpenSplit(t.id);
                        }}
                        onMouseDown={stopMouse}
                        disabled={hasActiveMutation(t)}
                        data-tip="Split this transaction across multiple categories"
                        data-tip-align="right"
                        className="hov-dash"
                        style={{
                          border: '1px solid var(--bd)',
                          background: 'var(--card)',
                          color: 'var(--mut)',
                          borderRadius: 7,
                          height: 32,
                          padding: '0 9px',
                          flex: 'none',
                          cursor: 'pointer',
                          fontSize: 11.5,
                          fontWeight: 600,
                          fontFamily: 'inherit',
                        }}
                      >
                        Split
                      </button>
                    )}

                  </span>
                  <span className="queue-status-cell" style={{ textAlign: 'center' }}>{statusCell(v, false)}</span>
                </div>
                {activeCompanyId && attachmentOpenId === t.id && (
                  <AttachmentPanel
                    companyId={activeCompanyId}
                    transactionId={t.id}
                    canMutate={role === 'categorizer' || role === 'admin'}
                    onCountChange={(count) => setAttachmentCounts((current) => ({
                      ...current,
                      [t.id]: count,
                    }))}
                    toast={toast}
                  />
                )}
                </Fragment>
              );
            })}
            {loaded && vis.length === 0 && (
              <div style={{ padding: '64px 20px', textAlign: 'center' }}>
                <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
                  All caught up
                </div>
                <div style={{ fontSize: 14, color: 'var(--fnt)', marginTop: 6 }}>
                  Nothing matches — new transactions appear here as they land in your holding
                  accounts.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* mobile stacked cards */}
      {isMobile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {vis.map((t) => {
            const v = rowView(t);
            return (
              <div
                key={t.id}
                className="interactive-surface"
                onClick={() => onRowClick(t)}
                style={{
                  border: '1px solid var(--bd2)',
                  borderLeft: `3px solid ${v.isActive ? 'var(--acc)' : 'transparent'}`,
                  borderRadius: 9,
                  background: 'var(--card)',
                  padding: '13px 14px',
                  boxShadow: '0 1px 6px rgba(60,55,45,.05)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={!!sel[t.id]}
                    disabled={hasActiveMutation(t)}
                    onChange={() => setSel((s) => ({ ...s, [t.id]: !s[t.id] }))}
                    onClick={stopMouse}
                    onMouseDown={stopMouse}
                    style={{
                      width: 16,
                      height: 16,
                      accentColor: 'var(--acc)',
                      cursor: 'pointer',
                      marginTop: 2,
                      flex: 'none',
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        fontSize: 14.5,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {t.payee}
                    </span>
                    <span
                      style={{ display: 'block', fontSize: 12.5, color: 'var(--fnt)', marginTop: 2 }}
                    >
                      {fmtDate(t.date)} · {t.bankAccount}
                    </span>
                  </span>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 15,
                      color: t.amount > 0 ? 'var(--okT)' : 'var(--ink)',
                      flex: 'none',
                    }}
                  >
                    {fmtMoney(t.amount)}
                  </span>
                </div>
                <span ref={tagPicker === t.id ? tagPickerRootRef : undefined}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 5,
                    marginTop: 9,
                    alignItems: 'center',
                    position: 'relative',
                  }}
                >
                  {tagChips(t)}
                  <button
                    onClick={onTagBtn(t)}
                    onMouseDown={stopMouse}
                    disabled={hasActiveMutation(t)}
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--fnt)',
                      border: '1px dashed var(--bd)',
                      background: 'none',
                      borderRadius: 99,
                      padding: '2px 9px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + tag
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setAttachmentOpenId((current) => current === t.id ? null : t.id);
                    }}
                    onMouseDown={stopMouse}
                    aria-expanded={attachmentOpenId === t.id}
                    aria-label={`Attachments for ${t.payee}`}
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--fnt)',
                      border: '1px dashed var(--bd)',
                      background: 'none',
                      borderRadius: 99,
                      padding: '2px 9px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    📎{attachmentCounts[t.id] === undefined ? '' : ` ${attachmentCounts[t.id]}`}
                  </button>
                  {tagPicker === t.id && (
                    <TagPicker
                      tags={tags}
                      selectedIds={t.tagIds}
                      onToggle={(tagId) => toggleTag(t, tagId)}
                      width="min(230px,86vw)"
                    />
                  )}
                </span>
                {taxControls(t)}
                {v.mate && (
                  <span
                    style={{ display: 'block', fontSize: 12.5, color: 'var(--mut)', marginTop: 8 }}
                  >
                    ⇄ Looks like a transfer —{' '}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        recordTransfer(t);
                      }}
                      onMouseDown={stopMouse}
                      style={{ fontWeight: 600 }}
                    >
                      record it
                    </a>
                  </span>
                )}
                <div className="queue-mobile-actions" style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <span style={{ position: 'relative', flex: '1 1 150px', minWidth: 0 }}>
                    {rowCategoryPicker(v, true)}

                  </span>
                  {v.state === 'pending' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        doOpenSplit(t.id);
                      }}
                      onMouseDown={stopMouse}
                      disabled={hasActiveMutation(t)}
                      data-tip="Split across multiple categories"
                      style={{
                        border: '1px solid var(--bd)',
                        background: 'var(--card)',
                        color: 'var(--mut)',
                        borderRadius: 7,
                        height: 36,
                        padding: '0 10px',
                        flex: 'none',
                        cursor: 'pointer',
                        fontSize: 11.5,
                        fontWeight: 600,
                        fontFamily: 'inherit',
                      }}
                    >
                      Split
                    </button>
                  )}
                  <span className="queue-status-cell" style={{ flex: '1 1 240px', maxWidth: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    {statusCell(v, true)}
                  </span>
                </div>
                {errLine(v, 6)}
                {activeCompanyId && attachmentOpenId === t.id && (
                  <AttachmentPanel
                    companyId={activeCompanyId}
                    transactionId={t.id}
                    canMutate={role === 'categorizer' || role === 'admin'}
                    onCountChange={(count) => setAttachmentCounts((current) => ({
                      ...current,
                      [t.id]: count,
                    }))}
                    toast={toast}
                  />
                )}
              </div>
            );
          })}
          {loaded && vis.length === 0 && (
            <div style={{ padding: '48px 16px', textAlign: 'center' }}>
              <div style={{ fontFamily: "'Spectral',serif", fontSize: 19, fontWeight: 500 }}>
                All caught up
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--fnt)', marginTop: 6 }}>
                New transactions appear here as they land in your holding accounts.
              </div>
            </div>
          )}
        </div>
      )}

      {/* footer meta row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 12,
          fontSize: 12.5,
          color: 'var(--fnt)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Watching: {watchingNames}
          <InfoDot tip="Transactions land in this queue from the holding accounts checked in Settings." />
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Keyboard shortcuts
          <InfoDot tip={SHORTCUT_TIP} align="right" />
        </span>
      </div>

      {/* bulk bar */}
      {selIds.length > 0 && (
        <BulkBar
          count={selCount}
          btnOpacity={selReady.length ? 1 : 0.45}
          onPost={() => {
            void bulkPost();
          }}
          onClear={() => {
            setSel({});
            setBulkCat(null);
          }}
          categoryControl={
            <CategoryPicker
              label="Category for selected transactions"
              triggerText="Assign one category…"
              disabled={selPend.length === 0}
              value={bulkCat}
              options={bulkCategoryOptions}
              onPick={pickBulkCategory}
              showBadges={false}
            />
          }
        />
      )}

      {rulePrompt && (
        <RulePrompt
          payee={rulePrompt.payee}
          category={rulePrompt.category}
          onCreate={createRule}
          onDismiss={() => setRulePrompt(null)}
        />
      )}

      {/* split editor */}
      {splitTxn && (
        <SplitEditor
          txn={splitTxn}
          tags={tags}
          catOpts={catOpts}
          taxReadiness={taxReadiness}
          onClose={() => setSplitEditId(null)}
          onSave={(lines, taxCalculation) => saveSplit(splitTxn, lines, taxCalculation)}
        />
      )}
    </div>
  );
}
