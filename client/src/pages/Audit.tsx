// Audit log screen — append-only record of every QBO write, with server-side
// search and CSV export.
// Layout/styles copied verbatim from design_handoff_recat/Recat.dc.html lines
// 706–739; search/empty-state/chip logic mirrors renderVals() lines 1453–1457
// and the chip() helper (line 1373).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditAction, AuditEntryDto } from '@recat/shared';
import {
  audit as auditApi,
  createCategorizationRequestId,
  transactions as txnApi,
} from '../lib/api';
import { useApp } from '../state/AppContext';
import { fmtMoney } from '../lib/format';
import { AutopilotQueueStatus } from './settings/AutopilotCard';

// Grid `140px 110px minmax(0,1fr) 100px minmax(0,1.4fr)`; ≤640px rows switch to flex-wrap with
// gap 3px 14px and the header hides (prototype auditDisp / auditGap / deskQ).
const AUDIT_CSS = `
.rr .audit-head{display:grid;grid-template-columns:140px 110px minmax(0,1fr) 100px minmax(0,1.4fr);gap:0 16px;padding:10px 18px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--fnt);border-bottom:1px solid var(--bd2);}
.rr .audit-row{display:grid;grid-template-columns:140px 110px minmax(0,1fr) 100px minmax(0,1.4fr);flex-wrap:wrap;gap:0 16px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--rowbd);font-size:14px;}
.rr .audit-change{display:flex;align-items:center;gap:12px;min-width:0}.rr .audit-change>span{flex:1;min-width:0;overflow-wrap:anywhere}.rr .audit-change>button{flex:none;white-space:nowrap}
@media (max-width:640px){.rr .audit-change{flex-basis:100%}.rr .audit-head{display:none;}.rr .audit-row{display:flex;gap:3px 14px;}}
`;

// Action pill colors — prototype chip(): [text, background, border].
// posted / transfer / auto-posted read as successful writes (ok); the rest
// fall back to the neutral chip.
function chipColors(action: AuditAction): [string, string, string] {
  if (action === 'posted' || action === 'transfer' || action === 'auto-posted') {
    return ['var(--okT)', 'var(--okB)', 'var(--okD)'];
  }
  if (action === 'error') return ['var(--erT)', 'var(--erB)', 'var(--erD)'];
  if (action === 'dry-run' || action === 'blocked') {
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

const SEARCH_DEBOUNCE_MS = 300;

export default function Audit() {
  const { activeCompanyId, toast, qboMutationRevision, notifyQboMutation } = useApp();

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [undoingEntryId, setUndoingEntryId] = useState<string | null>(null);

  // Ignore out-of-order responses (fast typing / company switch / load more).
  const seq = useRef(0);
  const mounted = useRef(true);
  const scope = useRef({ companyId: activeCompanyId, generation: 0 });
  if (scope.current.companyId !== activeCompanyId) {
    scope.current = { companyId: activeCompanyId, generation: scope.current.generation + 1 };
  }
  const undoLock = useRef<object | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; seq.current += 1; }; }, []);

  useEffect(() => { undoLock.current = null; setUndoingEntryId(null); }, [activeCompanyId]);

  // Server-side search — debounce the query 300ms.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q]);

  // (Re)load the first page on company or query change.
  useEffect(() => {
    const mySeq = ++seq.current;
    setEntries([]);
    setNextCursor(null);
    setLoaded(false);
    if (!activeCompanyId) return;
    const trimmed = debouncedQ.trim();
    auditApi
      .list(activeCompanyId, trimmed ? { q: trimmed } : {})
      .then((res) => {
        if (!mounted.current || seq.current !== mySeq) return;
        setEntries(res.entries);
        setNextCursor(res.nextCursor);
        setLoaded(true);
      })
      .catch((err: Error) => {
        if (mounted.current && seq.current === mySeq) toast(err.message);
      });
    return () => { seq.current += 1; };
  }, [activeCompanyId, debouncedQ, qboMutationRevision, toast]);

  const loadMore = useCallback(() => {
    if (!activeCompanyId || !nextCursor) return;
    const mySeq = ++seq.current;
    const trimmed = debouncedQ.trim();
    auditApi
      .list(activeCompanyId, trimmed ? { q: trimmed, cursor: nextCursor } : { cursor: nextCursor })
      .then((res) => {
        if (!mounted.current || seq.current !== mySeq) return;
        setEntries((prev) => [...prev, ...res.entries]);
        setNextCursor(res.nextCursor);
      })
      .catch((err: Error) => {
        if (mounted.current && seq.current === mySeq) toast(err.message);
      });
  }, [activeCompanyId, nextCursor, debouncedQ, toast]);

  const exportCsv = useCallback(() => {
    if (!activeCompanyId) return;
    window.open(auditApi.exportUrl(activeCompanyId));
  }, [activeCompanyId]);

  const undoWrite = useCallback((entry: AuditEntryDto) => {
    if (!activeCompanyId || entry.companyId !== activeCompanyId || !entry.transactionId || !entry.undo || undoLock.current !== null) return;
    const isDryRun = entry.action === 'dry-run';
    const confirmation = isDryRun
      ? `Move this dry run back to the queue for ${entry.payee}?`
      : `Undo this QuickBooks categorization for ${entry.payee}?`;
    if (!window.confirm(confirmation)) return;
    const token = {};
    const companyId = activeCompanyId;
    const generation = scope.current.generation;
    const current = () => mounted.current && scope.current.generation === generation;
    undoLock.current = token;
    setUndoingEntryId(entry.id);
    const request = entry.undo.kind === 'categorization'
      ? txnApi.undoCategorization(entry.transactionId, createCategorizationRequestId())
      : txnApi.undo(entry.transactionId);
    Promise.resolve(request).then((result) => {
      notifyQboMutation(companyId, [entry.transactionId!]);
      if (!current()) return;
      const durable = 'outcome' in result;
      const completed = durable
        ? result.ok && result.outcome === 'VERIFIED' && (result.status === 'REVERTED' || result.status === 'PENDING')
        : result.status === 'PENDING';
      if (completed) toast(isDryRun ? 'Dry run moved back to the queue.' : durable ? 'Undo verified in QuickBooks.' : 'Categorization undone in QuickBooks.');
      else if (durable && result.outcome === 'IN_PROGRESS') toast('Undo is still in progress. Check Audit again before retrying.');
      else if (durable && result.outcome === 'UNCHANGED') toast('QuickBooks was unchanged; nothing was reverted.');
      else toast(durable ? result.error?.message ?? 'The QuickBooks undo could not be verified.' : 'The QuickBooks undo could not be verified.');
    }).catch((error: Error) => {
      notifyQboMutation(companyId, [entry.transactionId!]);
      if (current()) toast(error.message);
    }).finally(() => {
      if (undoLock.current !== token) return;
      undoLock.current = null;
      if (current()) setUndoingEntryId(null);
    });
  }, [activeCompanyId, notifyQboMutation, toast]);

  const showEmpty = loaded && q.trim() !== '' && entries.length === 0;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      <style>{AUDIT_CSS}</style>
      {activeCompanyId && (
        <AutopilotQueueStatus
          key={`audit-autopilot-${activeCompanyId}`}
          companyId={activeCompanyId}
          surface="audit"
        />
      )}
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
            Every attempt to change QuickBooks and its verified outcome. Append-only — nothing here
            can be edited or deleted.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search anything — payee, user, action, category…"
            className="input"
            style={{ width: 300, maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', flex: '1 1 auto' }}
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
              <span className="audit-change" style={{ fontSize: 13, color: 'var(--mut)' }}>
                <span>
                  {e.before} <span style={{ color: 'var(--fnt)' }}>→</span>{' '}
                  <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{e.after}</b>
                </span>
                {e.undo && (
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-label={`Undo ${e.payee}`}
                    disabled={undoingEntryId !== null}
                    onClick={() => undoWrite(e)}
                    style={{ padding: '4px 9px' }}
                  >
                    {undoingEntryId === e.id ? 'Undoing…' : 'Undo'}
                  </button>
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
