// Reports — P&L / Balance Sheet statements + Custom & tags slices.
// Pixel-for-pixel port of Recat.dc.html lines 588–704 (markup),
// 1266–1307 (custom report + saved reports) and 1609–1624 (control wiring).
// Statement math lives server-side — this screen renders StatementDto verbatim.

import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type {
  CustomReportDto,
  SavedReportConfig,
  SavedReportDto,
  StatementDrilldownRow,
  StatementDto,
  StatementRow,
  TransactionLogDto,
} from '@recat/shared';
import { useApp } from '../state/AppContext';
import { reports, savedReports, transactions } from '../lib/api';
import { fmtDate, fmtMoney } from '../lib/format';
import { InfoDot, Spinner } from '../components/ui';

type RptTab = 'pl' | 'bs' | 'custom' | 'txns';
type LogRange = '30d' | '90d' | 'ytd' | '12m';
type Compare = 'none' | 'prev' | 'py';
type Basis = 'cash' | 'accrual';

// Current date drives every month/year option (no hardcoded year or month list).
const NOW = new Date();
const CUR_YEAR = NOW.getFullYear();
const CUR_MONTH = NOW.getMonth(); // 0-based
const ALL_M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
/** Jan..current month of the current year. */
const M_NAMES = ALL_M.slice(0, CUR_MONTH + 1);

/** 'YYYY-MM' key for a (year, 0-based month) pair. */
function monthKey(year: number, month0: number): string {
  const d = new Date(year, month0, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const CUR_RANGE = { value: monthKey(CUR_YEAR, CUR_MONTH), label: FULL_M[CUR_MONTH] ?? '' };
const PREV_RANGE = {
  value: monthKey(CUR_YEAR, CUR_MONTH - 1),
  label: FULL_M[(CUR_MONTH + 11) % 12] ?? '',
};

// ---- shared styles copied verbatim from the prototype ----

const labeledSelectStyle: CSSProperties = {
  border: '1px solid var(--bd)',
  borderRadius: 7,
  padding: '8px 10px',
  fontSize: 14,
  fontWeight: 500,
  background: 'var(--card)',
  color: 'var(--ink)',
  cursor: 'pointer',
};

const bareSelectStyle: CSSProperties = {
  border: '1px solid var(--bd)',
  borderRadius: 7,
  padding: '8px 10px',
  fontSize: 14,
  background: 'var(--card)',
  color: 'var(--ink)',
  cursor: 'pointer',
};

const controlCard: CSSProperties = {
  display: 'flex',
  gap: 18,
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  border: '1px solid var(--bd2)',
  borderRadius: 10,
  background: 'var(--card)',
  padding: '14px 18px',
  boxShadow: '0 1px 6px rgba(60,55,45,.05)',
};

const customGrid = '1fr 80px minmax(70px,200px) 105px';

function LabeledSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--fnt)',
      }}
    >
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={labeledSelectStyle}>
        {children}
      </select>
    </label>
  );
}

/** Per-kind row styles — matches the prototype's stmtHead/stmtLine/total/grand rows. */
function rowStyles(row: StatementRow) {
  const head = row.kind === 'head';
  const line = row.kind === 'line';
  const grand = row.kind === 'grand';
  // 'Net income' (P&L) and 'Total liabilities & equity' (BS) render their label at 14px.
  const bigLabel = grand && (row.label === 'Net income' || row.label === 'Total liabilities & equity');
  return {
    bt: head ? 'transparent' : line ? 'var(--rowbd)' : 'var(--bd)',
    bg: grand ? 'var(--hl)' : 'transparent',
    ind: row.indent ? 16 : 0,
    fw: line ? 400 : 600,
    c: head ? 'var(--fnt)' : line ? 'var(--mut)' : 'var(--ink)',
    tt: (head ? 'uppercase' : 'none') as CSSProperties['textTransform'],
    fs: head ? 11.5 : bigLabel ? 14 : 13.5,
    ls: head ? '.06em' : '0',
  };
}

export default function Reports() {
  const { activeCompany, activeCompanyId, role, tags, toast } = useApp();
  const isViewer = role === 'viewer';

  const [tab, setTab] = useState<RptTab>('pl');

  // P&L controls
  const [plPeriod, setPlPeriod] = useState(String(CUR_MONTH));
  const [plCols, setPlCols] = useState<'total' | 'months'>('total');
  const [plCmp, setPlCmp] = useState<Compare>('prev');
  // Balance sheet controls
  const [bsMonth, setBsMonth] = useState(CUR_MONTH);
  const [bsCmp, setBsCmp] = useState<Compare>('none');
  // Shared
  const [basis, setBasis] = useState<Basis>('cash');

  const [stmt, setStmt] = useState<StatementDto | null>(null);
  // Row drill-down — at most one statement row expanded at a time.
  const [drill, setDrill] = useState<{ account: string; loading: boolean; rows: StatementDrilldownRow[] } | null>(null);

  // Custom & tags
  const [config, setConfig] = useState<SavedReportConfig>({
    range: 'all',
    flow: 'both',
    account: 'all',
    groupBy: 'tag',
    tagIds: [],
  });
  const [custom, setCustom] = useState<CustomReportDto | null>(null);
  const [banks, setBanks] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<SavedReportDto[]>([]);
  const [rptName, setRptName] = useState('');

  // Transaction log
  const [logRange, setLogRange] = useState<LogRange>('90d');
  const [log, setLog] = useState<TransactionLogDto | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logFilter, setLogFilter] = useState('');

  const plCmpShown = plCols === 'total' && plPeriod !== 'ytd';

  // ---- statement fetch (refires on every control change) ----
  useEffect(() => {
    if (!activeCompanyId || (tab !== 'pl' && tab !== 'bs')) return;
    let cancelled = false;
    const req =
      tab === 'pl'
        ? reports.pl(activeCompanyId, {
            period: plPeriod,
            columns: plCols,
            compare: plCols === 'total' && plPeriod !== 'ytd' ? plCmp : 'none',
            basis,
          })
        : reports.bs(activeCompanyId, {
            asOf: `${CUR_YEAR}-${String(bsMonth + 1).padStart(2, '0')}`,
            compare: bsCmp,
            basis,
          });
    req
      .then((s) => {
        if (!cancelled) {
          setStmt(s);
          setDrill(null); // a new statement collapses any open drill-down
        }
      })
      .catch(() => {
        if (!cancelled) toast('Could not load the report');
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, tab, plPeriod, plCols, plCmp, bsMonth, bsCmp, basis, toast]);

  // ---- transaction log fetch ----
  useEffect(() => {
    if (!activeCompanyId || tab !== 'txns') return;
    let cancelled = false;
    const end = new Date();
    const start = new Date(end);
    if (logRange === '30d') start.setDate(start.getDate() - 30);
    else if (logRange === '90d') start.setDate(start.getDate() - 90);
    else if (logRange === '12m') start.setFullYear(start.getFullYear() - 1);
    else {
      start.setMonth(0);
      start.setDate(1);
    }
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setLogLoading(true);
    reports
      .transactionLog(activeCompanyId, { start: ymd(start), end: ymd(end) })
      .then((r) => {
        if (!cancelled) setLog(r);
      })
      .catch(() => {
        if (!cancelled) toast('Could not load the transaction log');
      })
      .finally(() => {
        if (!cancelled) setLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, tab, logRange, toast]);

  // ---- custom report fetch ----
  useEffect(() => {
    if (!activeCompanyId || tab !== 'custom') return;
    let cancelled = false;
    reports
      .custom(activeCompanyId, config)
      .then((r) => {
        if (!cancelled) setCustom(r);
      })
      .catch(() => {
        if (!cancelled) toast('Could not load the report');
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, tab, config, toast]);

  // ---- bank account options: one transactions fetch, first time the custom tab opens ----
  // Viewers can't call transactions.list — their dropdown shows 'All bank accounts' only.
  useEffect(() => {
    if (!activeCompanyId || tab !== 'custom' || banks !== null || isViewer) return;
    let cancelled = false;
    transactions
      .list(activeCompanyId)
      .then((res) => {
        if (!cancelled) setBanks([...new Set(res.transactions.map((t) => t.bankAccount))]);
      })
      .catch(() => {
        if (!cancelled) setBanks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, tab, banks, isViewer]);

  // ---- saved reports ----
  useEffect(() => {
    if (!activeCompanyId) return;
    let cancelled = false;
    savedReports
      .list(activeCompanyId)
      .then((list) => {
        if (!cancelled) setSaved(list);
      })
      .catch(() => {
        // pills just stay empty
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId]);

  const setCfg = <K extends keyof SavedReportConfig>(key: K, value: SavedReportConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const toggleTag = (id: string) =>
    setConfig((c) => ({
      ...c,
      tagIds: c.tagIds.includes(id) ? c.tagIds.filter((i) => i !== id) : [...c.tagIds, id],
    }));

  const saveRpt = () => {
    if (!activeCompanyId) return;
    const name = rptName.trim() || `Report ${saved.length + 1}`;
    savedReports
      .create(activeCompanyId, name, { ...config, tagIds: [...config.tagIds] })
      .then((r) => {
        setSaved((prev) => [...prev, r]);
        setRptName('');
        toast(`Saved "${name}"`);
      })
      .catch(() => toast('Could not save the report'));
  };

  const deleteSaved = (id: string) => {
    if (!activeCompanyId) return;
    savedReports
      .del(activeCompanyId, id)
      .then(() => setSaved((prev) => prev.filter((r) => r.id !== id)))
      .catch(() => toast('Could not delete the report'));
  };

  const maxG = custom ? Math.max(1, ...custom.rows.map((r) => Math.abs(r.total))) : 1;

  // Expand/collapse the transactions behind one statement row. The window is
  // the statement's period (comparison columns drill the PRIMARY column's).
  const toggleDrill = (accountQboId: string) => {
    if (!activeCompanyId || !stmt?.period) return;
    if (drill?.account === accountQboId) {
      setDrill(null);
      return;
    }
    const { start, end } = stmt.period;
    setDrill({ account: accountQboId, loading: true, rows: [] });
    reports
      .drilldown(activeCompanyId, { account: accountQboId, start, end })
      .then((d) =>
        setDrill((cur) => (cur?.account === accountQboId ? { account: accountQboId, loading: false, rows: d.rows } : cur)),
      )
      .catch(() => {
        toast('Could not load transactions for this row');
        setDrill((cur) => (cur?.account === accountQboId ? null : cur));
      });
  };

  return (
    <div style={{ maxWidth: 1060, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 18,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <div className="page-title">Reports</div>
          <div className="page-sub">Statements and the transaction log read straight from QuickBooks; custom slices from synced data.</div>
        </div>
        <LabeledSelect label="Report" value={tab} onChange={(v) => setTab(v as RptTab)}>
          <option value="pl">Profit &amp; Loss</option>
          <option value="bs">Balance Sheet</option>
          <option value="txns">Transaction log</option>
          <option value="custom">Custom &amp; tags</option>
        </LabeledSelect>
      </div>

      {/* P&L controls */}
      {tab === 'pl' && (
        <div style={controlCard}>
          <LabeledSelect label="Report period" value={plPeriod} onChange={setPlPeriod}>
            {M_NAMES.map((label, v) => (
              <option key={label} value={String(v)}>
                {label} {CUR_YEAR}
              </option>
            ))}
            <option value="ytd">Year to date {CUR_YEAR}</option>
          </LabeledSelect>
          <LabeledSelect
            label="Display columns by"
            value={plCols}
            onChange={(v) => setPlCols(v as 'total' | 'months')}
          >
            <option value="total">Total only</option>
            <option value="months">Months</option>
          </LabeledSelect>
          {plCmpShown && (
            <LabeledSelect label="Compare to" value={plCmp} onChange={(v) => setPlCmp(v as Compare)}>
              <option value="none">None</option>
              <option value="prev">Previous month</option>
              <option value="py">Same month last year</option>
            </LabeledSelect>
          )}
          <LabeledSelect label="Accounting method" value={basis} onChange={(v) => setBasis(v as Basis)}>
            <option value="cash">Cash</option>
            <option value="accrual">Accrual</option>
          </LabeledSelect>
        </div>
      )}

      {/* Balance sheet controls */}
      {tab === 'bs' && (
        <div style={controlCard}>
          <LabeledSelect
            label="As of end of"
            value={String(bsMonth)}
            onChange={(v) => setBsMonth(Number(v))}
          >
            {M_NAMES.map((label, v) => (
              <option key={label} value={String(v)}>
                {label} {CUR_YEAR}
              </option>
            ))}
          </LabeledSelect>
          <LabeledSelect label="Compare to" value={bsCmp} onChange={(v) => setBsCmp(v as Compare)}>
            <option value="none">None</option>
            <option value="prev">Previous month</option>
            <option value="py">Same month last year</option>
          </LabeledSelect>
          <LabeledSelect label="Accounting method" value={basis} onChange={(v) => setBasis(v as Basis)}>
            <option value="cash">Cash</option>
            <option value="accrual">Accrual</option>
          </LabeledSelect>
        </div>
      )}

      {/* transaction log controls */}
      {tab === 'txns' && (
        <div style={controlCard}>
          <LabeledSelect label="Period" value={logRange} onChange={(v) => setLogRange(v as LogRange)}>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="ytd">This year</option>
            <option value="12m">Last 12 months</option>
          </LabeledSelect>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fnt)', marginBottom: 5 }}>Filter</div>
            <input
              className="input"
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              placeholder="Payee, memo, category, type…"
              style={{ minWidth: 220 }}
            />
          </div>
        </div>
      )}

      {/* transaction log card */}
      {tab === 'txns' && (
        <div
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 10,
            background: 'var(--card)',
            padding: '22px 24px',
            boxShadow: '0 1px 6px rgba(60,55,45,.05)',
            marginTop: 16,
            overflowX: 'auto',
          }}
        >
          {logLoading && !log ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
              <Spinner />
            </div>
          ) : log ? (
            (() => {
              const needle = logFilter.trim().toLowerCase();
              const rows =
                needle === ''
                  ? log.rows
                  : log.rows.filter((r) =>
                      [r.payee, r.memo ?? '', r.account, r.txnType, r.docNum ?? '']
                        .join(' ')
                        .toLowerCase()
                        .includes(needle),
                    );
              const total = rows.reduce((a, r) => a + r.amount, 0);
              return (
                <div style={{ minWidth: 640 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '86px 110px 1fr 220px 110px',
                      gap: '0 14px',
                      padding: '0 0 8px',
                      borderBottom: '1px solid var(--bd)',
                      fontSize: 11.5,
                      fontWeight: 600,
                      letterSpacing: '.05em',
                      textTransform: 'uppercase',
                      color: 'var(--fnt)',
                    }}
                  >
                    <span>Date</span>
                    <span>Type</span>
                    <span>Payee / memo</span>
                    <span>Category</span>
                    <span style={{ textAlign: 'right' }}>Amount</span>
                  </div>
                  {rows.length === 0 && (
                    <div style={{ padding: '18px 0', fontSize: 13.5, color: 'var(--fnt)' }}>
                      No transactions in this period{needle !== '' ? ' match the filter' : ''}.
                    </div>
                  )}
                  {rows.map((r, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '86px 110px 1fr 220px 110px',
                        gap: '0 14px',
                        alignItems: 'baseline',
                        padding: '9px 0',
                        borderBottom: '1px solid var(--rowbd)',
                        fontSize: 13.5,
                      }}
                    >
                      <span style={{ color: 'var(--mut)', fontSize: 12.5 }}>{fmtDate(r.date)}</span>
                      <span style={{ color: 'var(--mut)', fontSize: 12.5 }}>{r.txnType}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ fontWeight: 500 }}>{r.payee || '—'}</span>
                        {r.memo !== undefined && (
                          <span style={{ color: 'var(--fnt)', fontSize: 12.5 }}> · {r.memo}</span>
                        )}
                      </span>
                      <span
                        style={{
                          color: 'var(--mut)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.account}
                      </span>
                      <span
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 500,
                          color: r.amount >= 0 ? 'var(--okT)' : 'var(--ink)',
                        }}
                      >
                        {fmtMoney(r.amount)}
                      </span>
                    </div>
                  ))}
                  {rows.length > 0 && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 110px',
                        gap: '0 14px',
                        padding: '10px 0 0',
                        fontSize: 13,
                        color: 'var(--mut)',
                      }}
                    >
                      <span>
                        {rows.length} transaction{rows.length === 1 ? '' : 's'} · read live from
                        QuickBooks
                      </span>
                      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--ink)' }}>
                        {fmtMoney(total)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })()
          ) : null}
        </div>
      )}

      {/* statement card */}
      {(tab === 'pl' || tab === 'bs') && stmt && (
        <div
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 10,
            background: 'var(--card)',
            padding: '28px 30px',
            boxShadow: '0 1px 6px rgba(60,55,45,.05)',
            marginTop: 16,
            overflowX: 'auto',
          }}
        >
          <div
            style={{
              textAlign: 'center',
              fontFamily: "'Spectral',serif",
              fontSize: 21,
              fontWeight: 600,
            }}
          >
            {activeCompany?.nickname ?? '—'}
          </div>
          <div
            style={{
              textAlign: 'center',
              fontFamily: "'Spectral',serif",
              fontSize: 15,
              color: 'var(--mut)',
              marginTop: 2,
            }}
          >
            {stmt.title}
          </div>
          <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--fnt)', margin: '3px 0 20px' }}>
            {stmt.subtitle}
          </div>
          {/* min-width: label column (360) + 106 per amount column — the card's
              overflowX:auto scrolls this block instead of crushing row labels. */}
          <div style={{ minWidth: 360 + stmt.columns.length * 106 }}>
            <div style={{ display: 'flex', padding: '5px 10px 7px', borderBottom: '1.5px solid var(--bd)' }}>
              <span style={{ flex: 1 }} />
              {stmt.columns.map((col, i) => (
                <span
                  key={i}
                  style={{
                    width: 106,
                    textAlign: 'right',
                    fontSize: 11.5,
                    fontWeight: 600,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: 'var(--fnt)',
                  }}
                >
                  {col.label}
                </span>
              ))}
            </div>
            {stmt.rows.map((sr, i) => {
              const st = rowStyles(sr);
              const netIncome = sr.kind === 'grand' && sr.label === 'Net income';
              // 'line' rows with an account behind them drill into transactions.
              const drillable = sr.kind === 'line' && sr.accountQboId !== undefined && stmt.period !== undefined;
              const expanded = drillable && drill?.account === sr.accountQboId;
              const drillTotal = drill?.rows.reduce((a, r) => a + r.amount, 0) ?? 0;
              return (
                <Fragment key={i}>
                  <div
                    {...(drillable ? { className: 'hov-hl', onClick: () => toggleDrill(sr.accountQboId!) } : {})}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '5.5px 10px',
                      borderTop: `1px solid ${st.bt}`,
                      background: st.bg,
                      ...(drillable ? { cursor: 'pointer' } : {}),
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        paddingLeft: st.ind,
                        fontWeight: st.fw,
                        color: st.c,
                        textTransform: st.tt,
                        fontSize: st.fs,
                        letterSpacing: st.ls,
                      }}
                    >
                      {sr.label}
                    </span>
                    {sr.cells.map((v, j) => (
                      <span
                        key={j}
                        style={{
                          width: 106,
                          textAlign: 'right',
                          fontSize: 13.5,
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: st.fw,
                          color: netIncome ? (v.value >= 0 ? 'var(--okT)' : 'var(--erT)') : 'var(--ink)',
                        }}
                      >
                        {v.text}
                      </span>
                    ))}
                  </div>
                  {expanded && drill && (
                    <div
                      style={{
                        background: 'var(--hl)',
                        borderTop: '1px solid var(--rowbd)',
                        padding: '6px 10px 8px 26px',
                      }}
                    >
                      {drill.loading ? (
                        <div style={{ padding: '5px 0' }}>
                          <Spinner size={14} />
                        </div>
                      ) : drill.rows.length === 0 ? (
                        <div style={{ fontSize: 12.5, color: 'var(--fnt)', padding: '4px 0' }}>
                          No transactions recorded for this row in this period.
                        </div>
                      ) : (
                        <>
                          {drill.rows.map((r, k) => (
                            <div
                              key={k}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                fontSize: 13,
                                padding: '3.5px 0',
                              }}
                            >
                              <span style={{ flex: 1, color: 'var(--mut)' }}>
                                {fmtDate(r.date)} · {r.payee}
                                {r.memo ? ` · ${r.memo}` : ''}
                              </span>
                              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>
                                {fmtMoney(r.amount)}
                              </span>
                            </div>
                          ))}
                          <div style={{ fontSize: 12.5, color: 'var(--fnt)', paddingTop: 4 }}>
                            {drill.rows.length} transaction{drill.rows.length === 1 ? '' : 's'} · {fmtMoney(drillTotal)}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 16, textAlign: 'center' }}>
            {stmt.basisLabel} · computed from synced QuickBooks data · {FULL_M[CUR_MONTH]} is
            month-to-date
          </div>
        </div>
      )}

      {/* Custom & tags */}
      {tab === 'custom' && (
        <div
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 10,
            background: 'var(--card)',
            padding: '22px 24px',
            boxShadow: '0 1px 6px rgba(60,55,45,.05)',
          }}
        >
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={config.range}
              onChange={(e) => setCfg('range', e.target.value)}
              style={bareSelectStyle}
            >
              <option value="all">All time</option>
              <option value={CUR_RANGE.value}>{CUR_RANGE.label}</option>
              <option value={PREV_RANGE.value}>{PREV_RANGE.label}</option>
            </select>
            <select
              value={config.flow}
              onChange={(e) => setCfg('flow', e.target.value as SavedReportConfig['flow'])}
              style={bareSelectStyle}
            >
              <option value="both">Money in &amp; out</option>
              <option value="out">Money out only</option>
              <option value="in">Money in only</option>
            </select>
            <select
              value={config.account}
              onChange={(e) => setCfg('account', e.target.value)}
              style={bareSelectStyle}
            >
              <option value="all">All bank accounts</option>
              {(banks ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 13.5, color: 'var(--fnt)', marginLeft: 'auto' }}>Group by</span>
            <select
              value={config.groupBy}
              onChange={(e) => setCfg('groupBy', e.target.value as SavedReportConfig['groupBy'])}
              style={bareSelectStyle}
            >
              <option value="tag">Tag</option>
              <option value="cat">Category</option>
              <option value="acct">Bank account</option>
            </select>
          </div>

          {/* tag filter pills */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginTop: 14 }}>
            <span style={{ fontSize: 13, color: 'var(--fnt)' }}>Only tagged:</span>
            {tags.map((tag) => {
              const sel = config.tagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleTag(tag.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12.5,
                    fontWeight: 600,
                    border: `1.5px solid ${sel ? 'var(--acc)' : 'var(--bd2)'}`,
                    background: sel ? 'var(--okB)' : 'transparent',
                    color: 'var(--ink)',
                    borderRadius: 99,
                    padding: '4px 11px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: tag.color,
                      display: 'inline-block',
                    }}
                  />
                  {tag.name}
                </button>
              );
            })}
            <InfoDot tip="With nothing selected, every transaction is included — pick tags to narrow the report to just those." />
          </div>

          {/* result table */}
          <div style={{ border: '1px solid var(--bd2)', borderRadius: 8, marginTop: 18, overflow: 'hidden' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: customGrid,
                gap: '0 16px',
                padding: '9px 16px',
                fontSize: 11.5,
                fontWeight: 600,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: 'var(--fnt)',
                borderBottom: '1px solid var(--bd2)',
                background: 'var(--hl)',
              }}
            >
              <span>Group</span>
              <span style={{ textAlign: 'right' }}>Transactions</span>
              <span />
              <span style={{ textAlign: 'right' }}>Total</span>
            </div>
            {(custom?.rows ?? []).map((rr) => (
              <div
                key={rr.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: customGrid,
                  gap: '0 16px',
                  alignItems: 'center',
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--rowbd)',
                  fontSize: 14,
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: rr.color ?? (rr.name === 'Untagged' ? 'var(--bd)' : 'var(--acc)'),
                      display: 'inline-block',
                    }}
                  />
                  {rr.name}
                </span>
                <span style={{ textAlign: 'right', color: 'var(--mut)' }}>{rr.count}</span>
                <span
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: 'var(--hl)',
                    position: 'relative',
                    display: 'block',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: 0,
                      width: `${Math.round((Math.abs(rr.total) / maxG) * 100)}%`,
                      background: 'var(--acc)',
                      borderRadius: 4,
                      display: 'block',
                    }}
                  />
                </span>
                <span style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMoney(rr.total)}
                </span>
              </div>
            ))}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: customGrid,
                gap: '0 16px',
                padding: '10px 16px',
                fontSize: 14,
                fontWeight: 600,
                background: 'var(--hl)',
              }}
            >
              <span>Total</span>
              <span style={{ textAlign: 'right' }}>{custom?.count ?? 0}</span>
              <span />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {fmtMoney(custom?.total ?? 0)}
              </span>
            </div>
          </div>

          {/* save / load — saving/deleting is categorizer+; viewers still load pills */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
            {!isViewer && (
              <>
                <input
                  value={rptName}
                  onChange={(e) => setRptName(e.target.value)}
                  placeholder="Name this report…"
                  className="input"
                  style={{ padding: '8px 12px', width: 220 }}
                />
                <button
                  onClick={saveRpt}
                  className="hov-hl"
                  style={{
                    border: '1px solid var(--bd)',
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    borderRadius: 7,
                    padding: '8px 14px',
                    fontSize: 13.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  Save report
                </button>
              </>
            )}
            {saved.map((sv) => (
              <span
                key={sv.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  border: '1px solid var(--bd2)',
                  background: 'var(--hl)',
                  borderRadius: 99,
                  padding: '5px 6px 5px 13px',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                <button
                  onClick={() => setConfig({ ...sv.config, tagIds: [...sv.config.tagIds] })}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: 'var(--acc)',
                    cursor: 'pointer',
                    font: 'inherit',
                    padding: 0,
                  }}
                >
                  {sv.name}
                </button>
                {!isViewer && (
                  <button
                    onClick={() => deleteSaved(sv.id)}
                    className="hov-del"
                    style={{
                      border: 'none',
                      background: 'none',
                      color: 'var(--fnt)',
                      cursor: 'pointer',
                      fontSize: 13,
                      padding: '0 4px',
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
