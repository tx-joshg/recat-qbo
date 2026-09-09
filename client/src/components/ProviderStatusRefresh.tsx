import { useEffect, useRef, useState } from 'react';
import { transactions } from '../lib/api';

const MAX_CHECKS_PER_BATCH = 25;
type Progress = { checked: number; failed: number; cursor: string | null; message: string };
const initial = (): Progress => ({ checked: 0, failed: 0, cursor: null, message: '' });

/** Refreshes read-only provider observations. It does not prepare or post transactions. */
export default function ProviderStatusRefresh({ companyId, onRefreshed }: {
  companyId: string;
  onRefreshed: (companyId: string) => Promise<void>;
}) {
  const [progress, setProgress] = useState<Progress>(initial);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const activeCompany = useRef(companyId);
  activeCompany.current = companyId;
  const activeRun = useRef<{ stop: boolean } | null>(null);
  const saved = useRef<Progress>(initial());
  useEffect(() => {
    activeRun.current = null;
    saved.current = initial();
    setProgress(initial());
    setBusy(false);
    setStopping(false);
    return () => { activeRun.current = null; };
  }, [companyId]);

  const check = async () => {
    if (activeRun.current) return;
    const run = { stop: false };
    activeRun.current = run;
    const current = () => activeRun.current === run && activeCompany.current === companyId;
    let next = saved.current.cursor ? { ...saved.current } : initial();
    let received = false;
    let interrupted = false;
    const seen = new Set<string>();
    if (next.cursor) seen.add(next.cursor);
    setBusy(true);
    setStopping(false);
    setProgress({ ...next, message: 'Checking QuickBooks status…' });
    try {
      for (let page = 0; page < MAX_CHECKS_PER_BATCH && !run.stop; page += 1) {
        const result = await transactions.refreshProviderStatus(companyId, next.cursor ?? undefined);
        if (!current()) return;
        if (result.companyId !== companyId || (result.nextCursor && (
          result.nextCursor.length > 128 || seen.has(result.nextCursor)
        ))) throw new Error('Invalid status continuation');
        next.checked += result.processed;
        next.failed += Math.max(result.failed, result.processed - result.persisted,
          result.items.filter(item => item.disposition === 'UNAVAILABLE').length);
        received = true;
        next.cursor = result.nextCursor;
        if (next.cursor) seen.add(next.cursor);
        saved.current = { ...next };
        setProgress({ ...next, message: `Checked ${next.checked} transaction${next.checked === 1 ? '' : 's'}…` });
        if (result.complete || !next.cursor) break;
      }
    } catch {
      interrupted = true;
    } finally {
      if (current()) {
        let reloadFailed = false;
        if (received) {
          try { await onRefreshed(companyId); } catch { reloadFailed = true; }
        }
        if (current()) {
          let message = `Checked ${next.checked} transaction${next.checked === 1 ? '' : 's'}.`;
          if (next.failed) message += ` Status unavailable for ${next.failed}.`;
          if (interrupted) message += ' Some checks could not finish. Try again.';
          else if (next.cursor) message += run.stop ? ' Stopped. More remain.' : ' More remain.';
          if (reloadFailed) message += ' The Queue could not reload. Try again.';
          saved.current = { ...next, message };
          setProgress(saved.current);
          activeRun.current = null;
          setBusy(false);
          setStopping(false);
        }
      }
    }
  };

  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
    <button type="button" className="btn-ghost" disabled={busy} onClick={() => { void check(); }}>
      {progress.cursor && !busy ? 'Continue checking' : 'Check QuickBooks status'}
    </button>
    {busy && <button type="button" className="btn-ghost" disabled={stopping} onClick={() => {
      if (activeRun.current) activeRun.current.stop = true;
      setStopping(true);
    }}>{stopping ? 'Stopping after current check…' : 'Stop after current check'}</button>}
    {progress.message && <span role="status" style={{ fontSize: 12.5, color: 'var(--mut)', overflowWrap: 'anywhere' }}>{progress.message}</span>}
  </div>;
}
