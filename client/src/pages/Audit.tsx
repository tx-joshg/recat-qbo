// Audit log screen — append-only record of every QBO write, with server-side
// search and CSV export.
// Layout/styles copied verbatim from design_handoff_recat/Recat.dc.html lines
// 706–739; search/empty-state/chip logic mirrors renderVals() lines 1453–1457
// and the chip() helper (line 1373).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditAction, AuditEntryDto } from '@recat/shared';
import { audit as auditApi } from '../lib/api';
import { useApp } from '../state/AppContext';
import { fmtMoney } from '../lib/format';

// Grid `150px 110px 1fr 120px 1.4fr`; ≤640px rows switch to flex-wrap with
// gap 3px 14px and the header hides (prototype auditDisp / auditGap / deskQ).
const AUDIT_CSS = `
.rr .audit-head{display:grid;grid-template-columns:150px 110px 1fr 120px 1.4fr;gap:0 16px;padding:10px 18px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--fnt);border-bottom:1px solid var(--bd2);}
.rr .audit-row{display:grid;grid-template-columns:150px 110px 1fr 120px 1.4fr;flex-wrap:wrap;gap:0 16px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--rowbd);font-size:14px;}
@media (max-width:640px){.rr .audit-head{display:none;}.rr .audit-row{display:flex;gap:3px 14px;}}
`;

// Action pill colors — prototype chip(): [text, background, border].
// posted / transfer / auto-posted read as successful writes (ok); the rest
// fall back to the neutral chip.
function chipColors(action: AuditAction): [string, string, string] {
  if (action === 'posted' || action === 'transfer' || action === 'auto-posted') {
    return ['var(--okT)', 'var(--okB)', 'var(--okD)'];
  }
  if (action === 'error') return ['var(--erT)', 'var(--erB)', 'var(--erD)'];
  if (action === 'dry-run') return ['var(--amT)', 'var(--amB)', 'var(--amD)'];
  if (action === 'autopilot') {
    return ['var(--amT)', 'var(--amB)', 'var(--amD)'];
  }
  return ['var(--fnt)', 'var(--hl)', 'var(--bd2)'];
}

/** 'Jul 12, 9:41 AM' from the entry's ISO `at` timestamp. */
function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function taxSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const expected = record.expected;
  if (!expected || typeof expected !== 'object') return null;
  const lines = (expected as { targetLines?: unknown }).targetLines;
  if (!Array.isArray(lines)) return null;
  const totals = lines.reduce(
    (sum, line) => {
      if (!line || typeof line !== 'object') return sum;
      const row = line as Record<string, unknown>;
      sum.gross += typeof row.grossCents === 'number' ? row.grossCents : 0;
      sum.net += typeof row.netCents === 'number' ? row.netCents : 0;
      sum.tax += typeof row.taxCents === 'number' ? row.taxCents : 0;
      return sum;
    },
    { gross: 0, net: 0, tax: 0 },
  );
  const verification = record.verification as { ok?: unknown } | undefined;
  return `Gross $${(totals.gross / 100).toFixed(2)} · Net $${(totals.net / 100).toFixed(2)} · Tax $${(totals.tax / 100).toFixed(2)}${verification?.ok === true ? ' · verified' : ''}`;
}

const SEARCH_DEBOUNCE_MS = 300;

export default function Audit() {
  const { activeCompanyId, toast } = useApp();

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Ignore out-of-order responses (fast typing / company switch / load more).
  const seq = useRef(0);

  // Server-side search — debounce the query 300ms.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q]);

  // (Re)load the first page on company or query change.
  useEffect(() => {
    setEntries([]);
    setNextCursor(null);
    setLoaded(false);
    if (!activeCompanyId) return;
    const mySeq = ++seq.current;
    const trimmed = debouncedQ.trim();
    auditApi
      .list(activeCompanyId, trimmed ? { q: trimmed } : {})
      .then((res) => {
        if (seq.current !== mySeq) return;
        setEntries(res.entries);
        setNextCursor(res.nextCursor);
        setLoaded(true);
      })
      .catch((err: Error) => {
        if (seq.current === mySeq) toast(err.message);
      });
  }, [activeCompanyId, debouncedQ, toast]);

  const loadMore = useCallback(() => {
    if (!activeCompanyId || !nextCursor) return;
    const mySeq = ++seq.current;
    const trimmed = debouncedQ.trim();
    auditApi
      .list(activeCompanyId, trimmed ? { q: trimmed, cursor: nextCursor } : { cursor: nextCursor })
      .then((res) => {
        if (seq.current !== mySeq) return;
        setEntries((prev) => [...prev, ...res.entries]);
        setNextCursor(res.nextCursor);
      })
      .catch((err: Error) => {
        if (seq.current === mySeq) toast(err.message);
      });
  }, [activeCompanyId, nextCursor, debouncedQ, toast]);

  const exportCsv = useCallback(() => {
    if (!activeCompanyId) return;
    window.open(auditApi.exportUrl(activeCompanyId));
  }, [activeCompanyId]);

  const showEmpty = loaded && q.trim() !== '' && entries.length === 0;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      <style>{AUDIT_CSS}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div>
          <div className="page-title">Audit log</div>
          <div className="page-sub">
            Every QuickBooks result and autopilot mode change. Append-only — nothing here can be
            edited or deleted.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search anything — payee, user, action, category…"
            className="input"
            style={{ width: 300, maxWidth: '100%', flex: '1 1 auto' }}
          />
          <button className="btn-ghost" onClick={exportCsv}>
            ↓ Export CSV
          </button>
        </div>
      </div>
      <div
        style={{
          border: '1px solid var(--bd2)',
          borderRadius: 9,
          background: 'var(--card)',
          boxShadow: '0 1px 6px rgba(60,55,45,.05)',
        }}
      >
        <div className="audit-head">
          <span>When</span>
          <span>Who</span>
          <span>Transaction</span>
          <span>Action</span>
          <span>Change</span>
        </div>
        {entries.map((e) => {
          const [chipC, chipB, chipD] = chipColors(e.action);
          const tax = taxSummary(e.payload);
          return (
            <div key={e.id} className="audit-row">
              <span style={{ color: 'var(--mut)', fontSize: 13 }}>{fmtWhen(e.at)}</span>
              <span style={{ fontWeight: 500 }}>{e.actor}</span>
              <span>
                <span style={{ fontWeight: 500 }}>{e.payee}</span>{' '}
                <span style={{ color: 'var(--fnt)', fontSize: 13 }}>{fmtMoney(e.amount)}</span>
              </span>
              <span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '3px 9px',
                    borderRadius: 99,
                    color: chipC,
                    background: chipB,
                    border: `1px solid ${chipD}`,
                  }}
                >
                  {e.action}
                </span>
              </span>
              <span style={{ fontSize: 13, color: 'var(--mut)' }}>
                {e.before} <span style={{ color: 'var(--fnt)' }}>→</span>{' '}
                <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{e.after}</b>
                {tax && (
                  <span style={{ display: 'block', marginTop: 3, fontSize: 11.5, color: 'var(--fnt)' }}>
                    {tax}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {showEmpty && (
          <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 14, color: 'var(--fnt)' }}>
            Nothing in the log matches “{q}”.
          </div>
        )}
        {nextCursor && (
          <div style={{ padding: '12px 18px', textAlign: 'center' }}>
            <button className="btn-ghost" onClick={loadMore}>
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
