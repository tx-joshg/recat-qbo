import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  RuleAffectedTransactionFilter, RuleAffectedTransactionPageDto,
  RuleRevisionPageDto, RuleRevisionReadDto,
} from '@recat/shared';
import { ApiError, rules } from '../../lib/api';
import { fmtDate, fmtDateY, fmtMoney } from '../../lib/format';

const buttonStyle = {
  border: '1px solid var(--bd)', background: 'var(--card)', color: 'var(--ink)',
  borderRadius: 7, padding: '7px 10px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
} as const;
const filters: RuleAffectedTransactionFilter[] = ['all', 'pending', 'processed'];
type LoadState<T> = { phase: 'idle' | 'loading' | 'ready' | 'error'; data: T | null; error: string | null };
const idle = <T,>(): LoadState<T> => ({ phase: 'idle', data: null, error: null });
const onOff = (value: boolean) => value ? 'on' : 'off';
const readable = (value: string) => value.replaceAll('_', ' ');

function revisionChanges(current: RuleRevisionReadDto, previous: RuleRevisionReadDto | undefined, truncated: boolean): string {
  if (!previous) return truncated ? 'Older comparison unavailable — history is truncated.' : 'Initial recorded revision.';
  const fields = [
    ['state', previous.state, current.state],
    ['match', previous.condition.matchText, current.condition.matchText],
    ['direction', previous.direction, current.direction],
    ['category', previous.categoryName, current.categoryName],
    ['category QBO ID', previous.action?.categoryQboId, current.action?.categoryQboId],
    ['tax calculation', previous.action?.taxCalculation, current.action?.taxCalculation],
    ['tax code', previous.taxCodeName, current.taxCodeName],
    ['tax code QBO ID', previous.action?.taxCodeQboId, current.action?.taxCodeQboId],
    ['tags', [...previous.action?.tagIds ?? []].sort().join(', '), [...current.action?.tagIds ?? []].sort().join(', ')],
    ['auto-post', onOff(previous.autoPost), onOff(current.autoPost)],
    ['validity', previous.valid ? 'valid' : 'invalid', current.valid ? 'valid' : 'invalid'],
    ['repair reason', previous.repairReason, current.repairReason],
    ['invalid reasons', previous.invalidReasons.join(' · '), current.invalidReasons.join(' · ')],
  ];
  const changes = fields.filter(([, before, after]) => before !== after)
    .map(([label, before, after]) => `${label} ${before || 'none'} → ${after || 'none'}`);
  return changes.length ? `Changed: ${changes.join(' · ')}` : 'No material classification fields changed.';
}

export default function RuleDetailsRegion({ companyId, ruleId, matchText, revision, actions }: {
  companyId: string; ruleId: string; matchText: string; revision?: number; actions?: ReactNode;
}) {
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [filter, setFilter] = useState<RuleAffectedTransactionFilter>('all');
  const [history, setHistory] = useState<LoadState<RuleRevisionPageDto>>(idle);
  const [affected, setAffected] = useState<LoadState<RuleAffectedTransactionPageDto>>(idle);
  const generation = useRef(0);
  const isOpen = useRef(false);
  const historyRequest = useRef(0);
  const affectedRequest = useRef(0);
  const affectedAttempt = useRef<{ filter: RuleAffectedTransactionFilter; cursor?: string }>({ filter: 'all' });

  useEffect(() => {
    generation.current += 1;
    isOpen.current = false;
    setOpened(false);
    setFilter('all');
    setHistory(idle());
    setAffected(idle());
    return () => { generation.current += 1; isOpen.current = false; };
  }, [companyId, ruleId, revision]);

  const loadHistory = async (epoch: number) => {
    const request = ++historyRequest.current;
    setHistory((current) => ({ ...current, phase: 'loading', error: null }));
    const isCurrent = () => isOpen.current && generation.current === epoch && historyRequest.current === request;
    try {
      const page = await rules.revisions(companyId, ruleId, undefined, 100);
      if (!isCurrent()) return;
      setHistory({ phase: 'ready', data: { ...page, items: [...page.items].sort((a, b) => b.revision - a.revision) }, error: null });
    } catch (error) {
      if (isCurrent()) setHistory((current) => ({ ...current, phase: 'error', error: error instanceof Error ? error.message : 'Revision history is unavailable.' }));
    }
  };

  const loadAffected = async (epoch: number, nextFilter: RuleAffectedTransactionFilter, cursor?: string) => {
    const request = ++affectedRequest.current;
    affectedAttempt.current = { filter: nextFilter, cursor };
    setAffected((current) => ({ phase: 'loading', data: cursor ? current.data : null, error: null }));
    const isCurrent = () => isOpen.current && generation.current === epoch && affectedRequest.current === request;
    try {
      const page = await rules.affectedTransactions(companyId, ruleId, {
        status: nextFilter, limit: 20, ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent()) return;
      setAffected((current) => ({ phase: 'ready', error: null, data: {
        ...page,
        items: cursor && current.data
          ? [...current.data.items, ...page.items.filter((item) => !current.data!.items.some(({ transactionId }) => transactionId === item.transactionId))]
          : page.items,
      } }));
    } catch (error) {
      if (isCurrent()) {
        // Rule changes invalidate the population cursor. Retry from the first
        // page of this filter instead of repeatedly sending an unusable cursor.
        if (error instanceof ApiError && error.code === 'INVALID_CURSOR') {
          affectedAttempt.current = { filter: nextFilter };
        }
        setAffected((current) => ({ ...current, phase: 'error', error: error instanceof Error ? error.message : 'Affected transactions are unavailable.' }));
      }
    }
  };

  const toggle = () => {
    const epoch = ++generation.current;
    isOpen.current = !isOpen.current;
    setOpened(isOpen.current);
    setHistory(idle());
    setAffected(idle());
    setFilter('all');
    if (isOpen.current) {
      void loadHistory(epoch);
      void loadAffected(epoch, 'all');
    }
  };

  return <div className="rule-editor-actions rule-details-footer">
    {actions}
    <button id={`${id}-control`} type="button" className="btn-ghost"
      aria-label={`View history for ${matchText}`} aria-expanded={opened} aria-controls={`${id}-details`} onClick={toggle}>
      View history
    </button>
    {opened && <section id={`${id}-details`} aria-labelledby={`${id}-control`}
      style={{ flexBasis: '100%', minWidth: 0, marginTop: 5, borderTop: '1px solid var(--bd2)', paddingTop: 12, overflowWrap: 'anywhere' }}>
      <h3>Revision history</h3>
      {history.phase === 'loading' && <p role="status">Loading revision history…</p>}
      {history.phase === 'error' && <div role="alert">
        <p>{history.error}</p>
        <button type="button" style={buttonStyle} onClick={() => void loadHistory(generation.current)}>Retry revision history</button>
      </div>}
      {history.phase === 'ready' && history.data?.items.length === 0 && <p>No revisions recorded.</p>}
      {history.data?.items.map((item, index, items) => <article key={item.id} aria-label={`Revision ${item.revision}`}
        style={{ fontSize: 13, marginTop: 9, paddingTop: 7, borderTop: index ? '1px solid var(--bd2)' : undefined }}>
        <strong>Revision {item.revision} · {item.state} · {fmtDateY(item.createdAt)}</strong>
        {item.action ? <p>
          {item.direction ?? 'Direction unavailable'} · {item.categoryName} ({item.action.categoryQboId})
          {' · '}{item.action.taxCalculation === 'NotApplicable' ? 'No tax' : `${readable(item.action.taxCalculation)} · ${item.taxCodeName ?? 'Unavailable tax code'} (${item.action.taxCodeQboId})`}
          {' · '}Tags {item.action.tagIds.join(', ') || 'none'} · auto-post {onOff(item.autoPost)}
        </p> : <p>Historical action unavailable.</p>}
        <p style={{ color: 'var(--mut)' }}>
          Provenance: {item.originIntent ? readable(item.originIntent) : 'legacy provenance'}
          {item.sourceCaseId ? ` · source case ${item.sourceCaseId}` : ''}
          {item.sourceCandidateId ? ` · source candidate ${item.sourceCandidateId}` : ''}
          {item.changedBy ? ` · actor ${item.changedBy}` : ''}
          {item.retiredAt ? ` · retired at ${fmtDateY(item.retiredAt)}` : ''}
        </p>
        {!item.valid && <p>Invalid revision: {item.invalidReasons.join(' · ') || 'No reason supplied.'}</p>}
        <p>{revisionChanges(item, items[index + 1], Boolean(history.data?.nextCursor) && index === items.length - 1)}</p>
      </article>)}
      {history.data?.nextCursor && <p role="status" aria-label="Revision history truncated">
        Showing {history.data.items.length} newest revision{history.data.items.length === 1 ? '' : 's'}; older history exists.
      </p>}

      <h3>Affected transactions</h3>
      {affected.data && <p>{affected.data.matchedCount} matched · {affected.data.pendingCount} pending · {affected.data.processedCount} processed</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {filters.map((status) => <button key={status} type="button"
          style={{ ...buttonStyle, ...(filter === status ? { background: 'var(--okB)', color: 'var(--okT)', border: '1px solid var(--okD)' } : {}) }} aria-pressed={filter === status}
          onClick={() => { setFilter(status); void loadAffected(generation.current, status); }}>
          {status[0]!.toUpperCase() + status.slice(1)}
        </button>)}
      </div>
      <p style={{ color: 'var(--mut)', fontSize: 13 }}>Processed includes POSTED and DRY_RUN outcomes.</p>
      {affected.phase === 'loading' && <p role="status">Loading affected transactions…</p>}
      {affected.phase === 'error' && <div role="alert">
        <p>{affected.error}</p>
        <button type="button" style={buttonStyle} onClick={() => void loadAffected(generation.current, affectedAttempt.current.filter, affectedAttempt.current.cursor)}>Retry affected transactions</button>
      </div>}
      {affected.phase === 'ready' && affected.data?.items.length === 0 && <p>No affected transactions match this filter.</p>}
      {affected.data?.items.map((item) => <article key={item.transactionId} aria-label={`Transaction ${item.payee}`}
        style={{ border: '1px solid var(--bd)', borderRadius: 8, padding: 10, marginTop: 8, background: 'var(--card)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span>{fmtDate(item.date)} · {item.payee}</span><strong>{fmtMoney(item.amountCents / 100)}</strong>
        </div>
        {item.memo && <p style={{ color: 'var(--mut)', fontSize: 13 }}>{item.memo}</p>}
        <p>{item.status}</p>
        {!item.ruleWins && item.winningRuleId !== null && <p>Another enabled rule currently wins</p>}
      </article>)}
      {affected.phase === 'ready' && affected.data?.nextCursor && <button type="button" style={{ ...buttonStyle, marginTop: 12 }}
        onClick={() => void loadAffected(generation.current, filter, affected.data!.nextCursor!)}>Load more affected transactions</button>}
    </section>}
  </div>;
}
