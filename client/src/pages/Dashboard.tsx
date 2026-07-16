// Dashboard ("Financials") — customizable widget grid.
// Pixel-for-pixel port of Recat.dc.html lines 411–500 (markup) and
// 1489–1504 / 1528–1545 (KPI + widget add/drag/resize/remove logic).
// Layout persists per user via GET/PUT /api/me/dashboard-layout.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DashboardDataDto, DashboardWidget, WidgetType } from '@recat/shared';
import { useApp } from '../state/AppContext';
import { companies as companiesApi, dashboardLayout } from '../lib/api';
import { moneyK } from '../lib/format';

const DEFAULT_WIDGETS: DashboardWidget[] = [
  { t: 'rev', sp: 1 },
  { t: 'exp', sp: 1 },
  { t: 'net', sp: 1 },
  { t: 'uncat', sp: 1 },
  { t: 'chart', sp: 2 },
  { t: 'break', sp: 2 },
  { t: 'pl', sp: 2 },
];

const WIDGET_LABELS: { t: WidgetType; label: string }[] = [
  { t: 'rev', label: 'Revenue' },
  { t: 'exp', label: 'Expenses' },
  { t: 'net', label: 'Net profit' },
  { t: 'uncat', label: 'Needs categorizing' },
  { t: 'chart', label: 'Revenue vs expenses' },
  { t: 'break', label: 'Where the money went' },
  { t: 'pl', label: 'P&L summary' },
];

/** Default span when a widget is (re-)added from the ＋ Add widget menu. */
function defaultSpan(t: WidgetType): 1 | 2 {
  return t === 'chart' || t === 'break' || t === 'pl' ? 2 : 1;
}

/** 'Jul' → 'July' for the page subtitle / P&L widget title (data months are short names). */
const FULL_MONTH: Record<string, string> = {
  Jan: 'January',
  Feb: 'February',
  Mar: 'March',
  Apr: 'April',
  May: 'May',
  Jun: 'June',
  Jul: 'July',
  Aug: 'August',
  Sep: 'September',
  Oct: 'October',
  Nov: 'November',
  Dec: 'December',
};
function fullMonth(m: string | undefined): string {
  if (!m) return '';
  return FULL_MONTH[m] ?? m;
}

// ---- style constants copied verbatim from the prototype ----

const kpiLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--fnt)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
};

const kpiValue: CSSProperties = {
  fontFamily: "'Spectral',serif",
  fontSize: 28,
  fontWeight: 600,
  marginTop: 6,
};

const kpiSub: CSSProperties = { fontSize: 12.5, color: 'var(--fnt)', marginTop: 2 };

const widgetCtl: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--fnt)',
  cursor: 'pointer',
  padding: '2px 4px',
  fontFamily: 'inherit',
};

export default function Dashboard() {
  const { activeCompany, activeCompanyId, toast } = useApp();
  const navigate = useNavigate();

  const [data, setData] = useState<DashboardDataDto | null>(null);
  const [widgets, setWidgets] = useState<DashboardWidget[]>(DEFAULT_WIDGETS);
  const [addOpen, setAddOpen] = useState(false);
  // Track the dragged widget by its stable key (widget types are unique on the
  // board), not by index — indices drift as dragover reorders the array.
  const [dragKey, setDragKey] = useState<WidgetType | null>(null);
  // Mirror for use inside rapid-fire dragover handlers (state can lag a render).
  const dragRef = useRef<WidgetType | null>(null);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 640px)').matches,
  );

  // ---- mobile breakpoint (2-col grid ≤640px, like the prototype) ----
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ---- dashboard data ----
  useEffect(() => {
    if (!activeCompanyId) return;
    let cancelled = false;
    companiesApi
      .dashboard(activeCompanyId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) toast('Could not load dashboard data');
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, toast]);

  // ---- layout: load once on mount; default board only when never saved ----
  // A persisted `[]` means the user deliberately emptied the board — honor it.
  useEffect(() => {
    let cancelled = false;
    dashboardLayout
      .get()
      .then((res) => {
        if (!cancelled && res.widgets) setWidgets(res.widgets);
      })
      .catch(() => {
        // keep the default layout
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: DashboardWidget[]) => {
    dashboardLayout.save(next).catch(() => {
      // best-effort — the board still works locally
    });
  }, []);

  // ---- close the add-widget dropdown on outside click / Esc ----
  useEffect(() => {
    if (!addOpen) return;
    const close = () => setAddOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  const setDrag = (v: WidgetType | null) => {
    dragRef.current = v;
    setDragKey(v);
  };

  const addWidget = (t: WidgetType) => (e: MouseEvent) => {
    e.stopPropagation();
    const next: DashboardWidget[] = [...widgets, { t, sp: defaultSpan(t) }];
    setWidgets(next);
    setAddOpen(false);
    persist(next);
  };

  const cycleSize = (i: number) => () => {
    const next = widgets.map((w, j) =>
      j === i ? { ...w, sp: ((w.sp % 4) + 1) as 1 | 2 | 3 | 4 } : w,
    );
    setWidgets(next);
    persist(next);
  };

  const removeWidget = (i: number) => () => {
    const next = widgets.filter((_, j) => j !== i);
    setWidgets(next);
    persist(next);
  };

  const onDragStart = (t: WidgetType) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', '');
    } catch {
      // some browsers throw on setData — harmless
    }
    setDrag(t);
  };

  // Both indices are resolved from the CURRENT array at event time — the
  // render-time index can be stale after a mid-drag reorder.
  const onDragOver = (t: WidgetType) => (e: DragEvent) => {
    e.preventDefault();
    const d = dragRef.current;
    if (d === null || d === t) return;
    setWidgets((ws) => {
      const from = ws.findIndex((w) => w.t === d);
      const to = ws.findIndex((w) => w.t === t);
      if (from === -1 || to === -1 || from === to) return ws;
      const a = [...ws];
      const mv = a.splice(from, 1)[0];
      if (!mv) return ws;
      a.splice(to, 0, mv);
      return a;
    });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(null);
  };

  const onDragEnd = () => {
    setDrag(null);
    persist(widgets);
  };

  const addOpts = WIDGET_LABELS.filter((p) => !widgets.some((w) => w.t === p.t));

  // ---- derived KPI values (prototype lines 1489–1504) ----
  const last = data ? data.months.length - 1 : 0;
  const lastMonth = data?.months[last];
  const prevMonth = data?.months[last - 1];

  const renderWidget = (w: DashboardWidget) => {
    if (!data) return null;
    switch (w.t) {
      case 'rev':
        return (
          <>
            <div style={kpiLabel}>Revenue</div>
            <div style={kpiValue}>{moneyK(data.rev[last] ?? 0)}</div>
            <div style={kpiSub}>
              vs {moneyK(data.rev[last - 1] ?? 0)} all of {fullMonth(prevMonth)}
            </div>
          </>
        );
      case 'exp':
        return (
          <>
            <div style={kpiLabel}>Expenses</div>
            <div style={kpiValue}>{moneyK(data.exp[last] ?? 0)}</div>
            <div style={kpiSub}>
              vs {moneyK(data.exp[last - 1] ?? 0)} all of {fullMonth(prevMonth)}
            </div>
          </>
        );
      case 'net': {
        const net = (data.rev[last] ?? 0) - (data.exp[last] ?? 0);
        return (
          <>
            <div style={kpiLabel}>Net profit</div>
            <div style={{ ...kpiValue, color: net >= 0 ? 'var(--okT)' : 'var(--erT)' }}>
              {moneyK(net)}
            </div>
            <div style={kpiSub}>month to date</div>
          </>
        );
      }
      case 'uncat':
        return (
          <>
            <div style={{ ...kpiLabel, color: 'var(--amT)' }}>Needs categorizing</div>
            <div style={{ ...kpiValue, color: 'var(--amT)' }}>{data.pendingCount}</div>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                navigate('/');
              }}
              style={{
                fontSize: 12.5,
                color: 'var(--amT)',
                marginTop: 2,
                display: 'block',
                fontWeight: 600,
              }}
            >
              ${data.pendingTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} — review
              queue →
            </a>
          </>
        );
      case 'chart': {
        const maxV = Math.max(1, ...data.rev, ...data.exp);
        return (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 14,
                paddingRight: 44,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600 }}>Revenue vs expenses</div>
              <div style={{ display: 'flex', gap: 14, fontSize: 12.5, color: 'var(--mut)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 2,
                      background: 'var(--acc)',
                      display: 'inline-block',
                    }}
                  />
                  Revenue
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 2,
                      background: 'var(--bd)',
                      display: 'inline-block',
                    }}
                  />
                  Expenses
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, height: 150 }}>
              {data.months.map((m, i) => (
                <div
                  key={m}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 7,
                    height: '100%',
                    justifyContent: 'flex-end',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
                    <div
                      style={{
                        width: 17,
                        borderRadius: '3px 3px 0 0',
                        background: 'var(--acc)',
                        height: Math.max(4, Math.round(((data.rev[i] ?? 0) / maxV) * 118)),
                      }}
                    />
                    <div
                      style={{
                        width: 17,
                        borderRadius: '3px 3px 0 0',
                        background: 'var(--bd)',
                        height: Math.max(4, Math.round(((data.exp[i] ?? 0) / maxV) * 118)),
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fnt)' }}>{m}</div>
                </div>
              ))}
            </div>
          </>
        );
      }
      case 'break': {
        const maxB = data.breakdown[0]?.amount || 1;
        return (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
              Where the money went
            </div>
            {data.breakdown.map((b) => (
              <div
                key={b.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 0',
                  fontSize: 13.5,
                }}
              >
                <span
                  style={{
                    width: 140,
                    color: 'var(--mut)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {b.name}
                </span>
                <span
                  style={{
                    flex: 1,
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
                      width: `${Math.round((b.amount / maxB) * 100)}%`,
                      background: 'var(--acc)',
                      borderRadius: 4,
                      display: 'block',
                    }}
                  />
                </span>
                <span style={{ width: 56, textAlign: 'right', fontWeight: 600 }}>
                  {moneyK(b.amount)}
                </span>
              </div>
            ))}
          </>
        );
      }
      case 'pl': {
        const gross = data.pl.income - data.pl.cogs;
        const net = gross - data.pl.expenses;
        const rows: {
          label: string;
          val: string;
          bt: string;
          fw: number;
          c: string;
          vc: string;
        }[] = [
          {
            label: 'Income',
            val: moneyK(data.pl.income),
            bt: 'transparent',
            fw: 400,
            c: 'var(--mut)',
            vc: 'var(--ink)',
          },
          {
            label: 'Cost of goods sold',
            val: '−' + moneyK(data.pl.cogs),
            bt: 'var(--rowbd)',
            fw: 400,
            c: 'var(--mut)',
            vc: 'var(--ink)',
          },
          {
            label: 'Gross profit',
            val: moneyK(gross),
            bt: 'var(--bd)',
            fw: 600,
            c: 'var(--ink)',
            vc: 'var(--ink)',
          },
          {
            label: 'Operating expenses',
            val: '−' + moneyK(data.pl.expenses),
            bt: 'var(--rowbd)',
            fw: 400,
            c: 'var(--mut)',
            vc: 'var(--ink)',
          },
          {
            label: 'Net income',
            val: moneyK(net),
            bt: 'var(--bd)',
            fw: 600,
            c: 'var(--ink)',
            vc: net >= 0 ? 'var(--okT)' : 'var(--erT)',
          },
        ];
        return (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              Profit &amp; loss — {fullMonth(lastMonth)} to date
            </div>
            {rows.map((pl) => (
              <div
                key={pl.label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '9px 0',
                  fontSize: 14,
                  borderTop: `1px solid ${pl.bt}`,
                }}
              >
                <span style={{ color: pl.c, fontWeight: pl.fw }}>{pl.label}</span>
                <span style={{ fontWeight: 600, color: pl.vc }}>{pl.val}</span>
              </div>
            ))}
          </>
        );
      }
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 18,
        }}
      >
        <div>
          <div className="page-title">Financials</div>
          <div className="page-sub">
            {activeCompany?.nickname ?? '—'}
            {data
              ? ` · ${fullMonth(lastMonth)} ${new Date().getFullYear()} to date · cash basis · refreshed with each sync`
              : ''}
          </div>
        </div>
        <span style={{ position: 'relative' }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAddOpen((v) => !v);
            }}
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
            ＋ Add widget
          </button>
          {addOpen && (
            <span
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 6px)',
                width: 230,
                background: 'var(--card)',
                border: '1px solid var(--bd)',
                borderRadius: 9,
                boxShadow: 'var(--sh)',
                overflow: 'hidden',
                display: 'block',
                zIndex: 30,
              }}
            >
              {addOpts.map((ao) => (
                <button
                  key={ao.t}
                  onClick={addWidget(ao.t)}
                  className="hov-hl"
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    padding: '10px 14px',
                    font: 'inherit',
                    fontSize: 13.5,
                    color: 'var(--ink)',
                  }}
                >
                  {ao.label}
                </button>
              ))}
              {addOpts.length === 0 && (
                <span style={{ display: 'block', padding: '10px 14px', fontSize: 13, color: 'var(--fnt)' }}>
                  All widgets are on the board
                </span>
              )}
            </span>
          )}
        </span>
      </div>

      {/* widget grid */}
      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)',
            gap: 14,
            gridAutoFlow: 'dense',
          }}
        >
          {widgets.map((w, i) => (
            <div
              key={w.t}
              draggable
              onDragStart={onDragStart(w.t)}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver(w.t)}
              onDrop={onDrop}
              style={{
                gridColumn: `span ${Math.min(w.sp, isMobile ? 2 : 4)}`,
                opacity: dragKey === w.t ? 0.35 : 1,
                position: 'relative',
                border: `1px solid ${w.t === 'uncat' ? 'var(--amD)' : 'var(--bd2)'}`,
                borderRadius: 10,
                background: w.t === 'uncat' ? 'var(--amB)' : 'var(--card)',
                padding: '18px 20px',
                boxShadow: '0 1px 6px rgba(60,55,45,.05)',
                boxSizing: 'border-box',
                minWidth: 0,
                cursor: 'grab',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 7,
                  right: 9,
                  display: 'inline-flex',
                  gap: 1,
                  alignItems: 'center',
                  zIndex: 2,
                }}
              >
                <button
                  onClick={cycleSize(i)}
                  data-tip="Resize — cycles the widget width"
                  className="hov-ink"
                  style={{ ...widgetCtl, fontSize: 12 }}
                >
                  ⛶
                </button>
                <button
                  onClick={removeWidget(i)}
                  data-tip="Remove — bring it back with ＋ Add widget"
                  className="hov-del"
                  style={{ ...widgetCtl, fontSize: 14 }}
                >
                  ×
                </button>
              </span>
              {renderWidget(w)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
