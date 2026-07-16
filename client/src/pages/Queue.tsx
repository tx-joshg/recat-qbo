// Queue — the categorization screen. Faithful port of Recat.dc.html
// lines 229–409 (markup) and the interaction logic in visible()/renderVals()/
// onKey()/post()/openSplit()/xferMate()/recordTransfer()/undoPost()/cycleSort().
// All filtering, sorting and row-state transitions happen client-side on the
// locally-held transaction list, exactly like the prototype.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SplitDto, TransactionDto, TxnStatus } from '@recat/shared';
import { useApp } from '../state/AppContext';
import {
  ApiError,
  companies as companiesApi,
  rules as rulesApi,
  transactions as txnApi,
} from '../lib/api';
import { fmtDate, fmtMoney } from '../lib/format';
import { InfoDot, Spinner } from '../components/ui';
import CategoryPicker from '../components/CategoryPicker';
import type { CategoryOption } from '../components/CategoryPicker';
import TagPicker from '../components/TagPicker';
import SplitEditor from '../components/SplitEditor';
import type { SplitLineDraft } from '../components/SplitEditor';
import BulkBar from '../components/BulkBar';
import RulePrompt from '../components/RulePrompt';

// ---------------------------------------------------------------------------
// Prototype-state mapping & small helpers
// ---------------------------------------------------------------------------

/** Server TxnStatus → prototype row state. */
type UiState = 'pending' | 'posting' | 'posted' | 'dry' | 'error';

const STATE_OF: Partial<Record<TxnStatus, UiState>> = {
  PENDING: 'pending',
  POSTING: 'posting',
  POSTED: 'posted',
  DRY_RUN: 'dry',
  ERROR: 'error',
};

/** Search words per state — prototype's statusWords map. */
const STATUS_WORDS: Record<UiState, string> = {
  pending: 'pending',
  posting: 'posting',
  posted: 'posted',
  dry: 'dry run',
  error: 'error failed',
};

type SortKey = 'date' | 'payee' | 'amt' | 'acct' | 'cat' | 'status';

const SORT_KEYS: SortKey[] = ['date', 'payee', 'amt', 'acct', 'cat', 'status'];
const SORT_LABELS: Record<SortKey, string> = {
  date: 'Date',
  payee: 'Payee',
  amt: 'Amount',
  acct: 'Account',
  cat: 'Category',
  status: 'Status',
};

const GRID_COLS = '38px 80px minmax(180px,1fr) 104px 118px minmax(200px,240px) 110px';

const SHORTCUT_TIP =
  '↑↓ or j/k — move between rows · x — select · c — open category picker · t — open tags · Enter — post the active row. Inside a picker: ↑↓ navigate, Enter select, Esc close.';

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

// ---------------------------------------------------------------------------

export default function Queue() {
  const {
    activeCompany,
    activeCompanyId,
    accounts,
    tags,
    setPendingCount,
    refreshCompanies,
    dryRun,
    tagsRequired,
    toast,
  } = useApp();
  const navigate = useNavigate();

  // ---- local state (mirrors the prototype's single component state) ----
  const [rows, setRows] = useState<TransactionDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [acct, setAcct] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [activeIdx, setActiveIdx] = useState(0);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState<string | null>(null); // txn id | 'bulk' | null
  const [pickQ, setPickQ] = useState('');
  const [pickIdx, setPickIdx] = useState(0);
  const [tagPicker, setTagPicker] = useState<string | null>(null);
  const [errOpenId, setErrOpenId] = useState<string | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePromptState | null>(null);
  const [splitEditId, setSplitEditId] = useState<string | null>(null);
  const [bulkCat, setBulkCat] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 640px)').matches,
  );
  const [, setClock] = useState(0); // re-render for 'last synced …'

  const aliveRef = useRef(true);
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
        !/^uncategorized |^ask my accountant$/i.test(a.name),
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
      if (!state) return false; // SUPERSEDED / REVERTED never render
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

  const bankOpts = useMemo(() => [...new Set(rows.map((t) => t.bankAccount))], [rows]);

  // ---- selection ----
  const selIds = useMemo(() => Object.keys(sel).filter((k) => sel[k]), [sel]);
  const selPend = useMemo(
    () => selIds.filter((id) => rows.find((r) => r.id === id)?.status === 'PENDING'),
    [selIds, rows],
  );
  const selReady = useMemo(
    () =>
      selPend.filter((id) => {
        const t = rows.find((r) => r.id === id);
        return !!t && !!t.category && !(tagsRequired && t.tagIds.length === 0);
      }),
    [selPend, rows, tagsRequired],
  );

  // ---- picker options (suggested pinned first) ----
  const filteredOpts = useMemo(() => {
    const q = pickQ.toLowerCase();
    let opts = catAccounts.filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.classification.toLowerCase().includes(q),
    );
    if (picker !== null && picker !== 'bulk') {
      const t = rows.find((x) => x.id === picker);
      const sg = t?.suggestion?.category;
      if (sg) opts = [...opts.filter((a) => a.name === sg), ...opts.filter((a) => a.name !== sg)];
    }
    return opts;
  }, [pickQ, picker, rows, catAccounts]);

  const pickOpts = useMemo<CategoryOption[]>(() => {
    const t = picker !== null && picker !== 'bulk' ? rows.find((x) => x.id === picker) : undefined;
    const sg = t?.suggestion?.category;
    return filteredOpts.slice(0, 40).map((a) => ({
      group: a.classification,
      name: a.name,
      sug: !!(t && sg === a.name),
    }));
  }, [filteredOpts, picker, rows]);

  const closePicker = useCallback(() => {
    setPicker(null);
    setPickQ('');
    setPickIdx(0);
  }, []);

  // ---- actions ----

  const openPicker = useCallback((id: string) => {
    setPicker(id);
    setPickQ('');
    setPickIdx(0);
  }, []);

  const openSplit = useCallback(() => {
    // draft seeding lives in <SplitEditor/> (mounts fresh); mirror the rest of
    // the prototype's openSplit(): close pickers, reset query.
    setPicker(null);
    setTagPicker(null);
    setPickQ('');
    setPickIdx(0);
  }, []);

  const doOpenSplit = useCallback(
    (id: string) => {
      openSplit();
      setSplitEditId(id);
    },
    [openSplit],
  );

  /** Assign a category: server merges matching rule tags — use the returned dto. */
  const categorizeTo = useCallback(
    (t: TransactionDto, name: string) => {
      const prev = { category: t.category, categoryQboId: t.categoryQboId };
      const categoryQboId = qboIdOf(name);
      patchRow(t.id, { category: name, categoryQboId }); // optimistic
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
    [qboIdOf, patchRow, updateRow, toast],
  );

  const pickChoose = useCallback(
    (name: string) => {
      const target = picker;
      closePicker();
      if (target === 'bulk') {
        setBulkCat(name);
        for (const id of selPend) {
          const t = rows.find((r) => r.id === id);
          if (t) categorizeTo(t, name);
        }
      } else if (target !== null) {
        const t = rows.find((r) => r.id === target);
        if (t) categorizeTo(t, name);
      }
    },
    [picker, closePicker, selPend, rows, categorizeTo],
  );

  const doPost = useCallback(
    (id: string) => {
      const t0 = rows.find((t) => t.id === id);
      const hasSplit = !!(t0 && t0.splits && t0.splits.length);
      if (!t0 || !(t0.category || hasSplit)) return;
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
    [rows, tagsRequired, patchRow, updateRow, toast],
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
      const prev = t.tagIds;
      const next = t.tagIds.includes(tagId)
        ? t.tagIds.filter((i) => i !== tagId)
        : [...t.tagIds, tagId];
      patchRow(t.id, { tagIds: next }); // optimistic
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
    [patchRow, updateRow, toast],
  );

  const saveSplit = useCallback(
    (t: TransactionDto, lines: SplitLineDraft[]) => {
      const sign = t.amount < 0 ? -1 : 1;
      const splits: SplitDto[] = lines.map((l) => {
        const amount = Math.round((parseFloat(l.amt) || 0) * 100) / 100;
        const categoryQboId = qboIdOf(l.cat);
        return {
          amount: amount * sign,
          category: l.cat,
          ...(categoryQboId ? { categoryQboId } : {}),
          tagIds: [...l.tags],
        };
      });
      const prev = { category: t.category, categoryQboId: t.categoryQboId, splits: t.splits };
      setSplitEditId(null);
      patchRow(t.id, { category: null, categoryQboId: null, splits }); // optimistic
      toast('Split saved — ready to post');
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
    [qboIdOf, patchRow, updateRow, toast],
  );

  const syncNow = useCallback(async () => {
    if (!activeCompanyId) return;
    try {
      const res = (await companiesApi.sync(activeCompanyId)) as unknown as
        | { message?: string }
        | undefined;
      const fresh = await fetchAllTxns(activeCompanyId);
      if (!aliveRef.current) return;
      setRows(fresh);
      refreshCompanies().catch(() => {});
      toast(res && typeof res.message === 'string' ? res.message : 'Synced — no new transactions');
    } catch (e) {
      toast(errText(e));
    }
  }, [activeCompanyId, fetchAllTxns, refreshCompanies, toast]);

  const bulkPost = useCallback(async () => {
    if (!activeCompanyId) return;
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
  }, [activeCompanyId, selReady, tagsRequired, fetchAllTxns, toast]);

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

  // ---- outside-click closes popups (prototype root onClick closeMenus) ----
  const closeMenusRef = useRef<() => void>(() => {});
  closeMenusRef.current = () => {
    if (picker !== null || tagPicker !== null) {
      setPicker(null);
      setTagPicker(null);
      setPickQ('');
      setPickIdx(0);
    }
  };
  useEffect(() => {
    const fn = () => closeMenusRef.current();
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  // ---- keyboard (prototype onKey, verbatim ordering) ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePicker();
      setSel({});
      setTagPicker(null);
      setErrOpenId(null);
      setRulePrompt(null);
      setSplitEditId(null);
      return;
    }
    if (picker !== null) {
      // Navigate/select within the rendered list (pickOpts, capped at 40) so
      // Enter can never land on an option the popup doesn't show.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPickIdx((i) => Math.min(i + 1, pickOpts.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPickIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = pickOpts[pickIdx];
        if (opt) pickChoose(opt.name);
      }
      return;
    }
    const target = e.target as HTMLElement | null;
    const tag = (target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
      setSel((s) => ({ ...s, [cur.id]: !s[cur.id] }));
    } else if (e.key === 'c') {
      e.preventDefault();
      if (cur.status === 'PENDING') openPicker(cur.id);
    } else if (e.key === 't') {
      e.preventDefault();
      setTagPicker((tp) => (tp === cur.id ? null : cur.id));
      setPicker(null);
    } else if (e.key === 'Enter') {
      // Splits count as categorized — doPost's own guards handle the rest.
      if (cur.status === 'PENDING' && (cur.category || (cur.splits && cur.splits.length))) {
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

  const allSel = vis.length > 0 && vis.every((t) => sel[t.id] || t.status !== 'PENDING');
  const toggleAll = () => {
    const anyOff = vis.some((t) => t.status === 'PENDING' && !sel[t.id]);
    setSel((prev) => {
      const next = { ...prev };
      vis.forEach((t) => {
        if (t.status === 'PENDING') next[t.id] = anyOff;
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
    pickColor: string;
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
        ? `Split · ${t.splits!.length} categories`
        : t.category
          ? fullCat(t.category)
          : suggested
            ? sugName!
            : 'Choose category…',
      pickColor:
        t.category || hasSplit ? 'var(--ink)' : suggested ? 'var(--amT)' : 'var(--fnt)',
    };
  };

  const onRowClick = (t: TransactionDto) => {
    setActiveIdx(vis.findIndex((v) => v.id === t.id));
    setErrOpenId((cur) => (cur === t.id ? cur : null));
  };

  const onOpenPicker = (v: RowView) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (v.t.status !== 'PENDING') return;
    if (v.t.splits && v.t.splits.length) {
      doOpenSplit(v.t.id);
    } else {
      openPicker(v.t.id);
    }
  };

  const onTagBtn = (t: TransactionDto) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    setTagPicker((tp) => (tp === t.id ? null : t.id));
    setPicker(null);
  };

  const rowPicker = (v: RowView, mobile: boolean) =>
    picker === v.t.id ? (
      <CategoryPicker
        query={pickQ}
        onQueryChange={(q) => {
          setPickQ(q);
          setPickIdx(0);
        }}
        options={pickOpts}
        empty={filteredOpts.length === 0}
        activeIdx={pickIdx}
        onPick={pickChoose}
        onSplitFooter={() => doOpenSplit(v.t.id)}
        showBadges={!mobile}
        containerStyle={
          mobile
            ? { zIndex: 15, top: 'calc(100% + 6px)', width: 'min(300px,86vw)' }
            : { zIndex: 15, top: 'calc(100% + 6px)', width: 300 }
        }
      />
    ) : null;

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

  const statusCell = (v: RowView, mobile: boolean) => (
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
          <select
            className="select"
            value={acct}
            onChange={(e) => {
              setAcct(e.target.value);
              setActiveIdx(0);
            }}
          >
            <option value="all">All accounts</option>
            {bankOpts.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <button className="btn-ghost" onClick={syncNow}>
            ↻ Sync now
          </button>
        </div>
      </div>

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
          <div style={{ minWidth: 1020 }}>
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
                <div
                  key={t.id}
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
                    <button
                      onClick={onOpenPicker(v)}
                      onMouseDown={stopMouse}
                      className="hov-brd"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        boxSizing: 'border-box',
                        textAlign: 'left',
                        border: `1px solid ${picker === t.id ? 'var(--acc)' : 'var(--bd)'}`,
                        borderRadius: 7,
                        padding: '7px 12px',
                        fontSize: 14,
                        background: 'var(--card)',
                        color: v.pickColor,
                        cursor: 'pointer',
                        font: 'inherit',
                        boxShadow: picker === t.id ? '0 0 0 3px rgba(47,93,80,.12)' : 'none',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {v.pickLabel}
                      {v.suggested && (
                        <span
                          {...(v.isRule && t.suggestion && (t.suggestion.matchedRules ?? 0) > 1
                            ? {
                                'data-tip': `Matched ${t.suggestion.matchedRules} rules — “${t.suggestion.winnerMatchText ?? ''}” won (topmost). Reorder in Rules.`,
                              }
                            : {})}
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: 'var(--amT)',
                            marginLeft: 7,
                          }}
                        >
                          {v.isRule ? 'rule' : 'suggested'}
                        </span>
                      )}
                    </button>
                    {v.state === 'pending' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          doOpenSplit(t.id);
                        }}
                        onMouseDown={stopMouse}
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
                    {rowPicker(v, false)}
                  </span>
                  <span style={{ textAlign: 'center' }}>{statusCell(v, false)}</span>
                </div>
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
                <span
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
                  {tagPicker === t.id && (
                    <TagPicker
                      tags={tags}
                      selectedIds={t.tagIds}
                      onToggle={(tagId) => toggleTag(t, tagId)}
                      width="min(230px,86vw)"
                    />
                  )}
                </span>
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
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <span style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <button
                      onClick={onOpenPicker(v)}
                      onMouseDown={stopMouse}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        textAlign: 'left',
                        border: `1px solid ${picker === t.id ? 'var(--acc)' : 'var(--bd)'}`,
                        borderRadius: 7,
                        padding: '9px 12px',
                        fontSize: 13.5,
                        background: 'var(--card)',
                        color: v.pickColor,
                        cursor: 'pointer',
                        font: 'inherit',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {v.pickLabel}
                    </button>
                    {rowPicker(v, true)}
                  </span>
                  {v.state === 'pending' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        doOpenSplit(t.id);
                      }}
                      onMouseDown={stopMouse}
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
                  <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center' }}>
                    {statusCell(v, true)}
                  </span>
                </div>
                {errLine(v, 6)}
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
          label={bulkCat ? fullCat(bulkCat) : 'Assign one category…'}
          btnOpacity={selReady.length ? 1 : 0.45}
          onOpenPicker={(e) => {
            e.stopPropagation();
            openPicker('bulk');
          }}
          onPost={() => {
            void bulkPost();
          }}
          onClear={() => {
            setSel({});
            setBulkCat(null);
          }}
          picker={
            picker === 'bulk' ? (
              <CategoryPicker
                query={pickQ}
                onQueryChange={(q) => {
                  setPickQ(q);
                  setPickIdx(0);
                }}
                options={pickOpts}
                empty={filteredOpts.length === 0}
                activeIdx={pickIdx}
                onPick={pickChoose}
                showBadges={false}
                containerStyle={{
                  zIndex: 30,
                  bottom: 'calc(100% + 8px)',
                  width: 300,
                  color: 'var(--ink)',
                }}
              />
            ) : null
          }
        />
      )}

      {/* rule prompt */}
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
          onClose={() => setSplitEditId(null)}
          onSave={(lines) => saveSplit(splitTxn, lines)}
        />
      )}
    </div>
  );
}
