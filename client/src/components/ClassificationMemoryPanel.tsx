import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ClassificationSearchHit, ClassificationSearchMode } from '@recat/shared';
import {
  ApiError,
  classificationMemory,
  type ClassificationSearchPageDto,
  type ClassificationSemanticHealthDto,
} from '../lib/api';
import { Select } from './SelectCombobox';

const SEARCH_MODES: ClassificationSearchMode[] = ['auto', 'exact', 'lexical', 'hybrid', 'semantic'];

interface ClassificationMemoryPanelProps {
  companyId: string;
  initialQuery?: string;
  transactionId?: string;
  title?: string;
  autoSearch?: boolean;
}

function readable(value: string): string {
  const normalized = value.replaceAll('_', ' ');
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function sourceNavigation(hit: ClassificationSearchHit): { href: string; label: string } | null {
  const label = hit.kind === 'classification_case'
    ? 'case'
    : hit.kind === 'historical_observation'
      ? 'observation'
    : hit.kind === 'rule_candidate'
      ? 'candidate'
      : hit.kind === 'rule'
        ? 'rule'
        : null;
  if (label === null) return null;
  const query = new URLSearchParams({ source: hit.kind, sourceId: hit.sourceId });
  return { href: `/rules?${query.toString()}`, label };
}

function verifiedLabel(value: string | null): string {
  if (value === null) return 'Not independently verified';
  return `Verified ${new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(value))}`;
}

function sourceTypeLabel(hit: ClassificationSearchHit): string {
  switch (hit.kind) {
    case 'rule': return 'Rule';
    case 'classification_case': return 'Verified decision';
    case 'rule_candidate': return 'Learned candidate';
    case 'vendor_alias': return 'Vendor alias';
    case 'vendor_identity': return 'Vendor identity';
    case 'historical_observation': return 'Advisory historical observation';
  }
}

function searchFailureCopy(error: unknown): string {
  if (error instanceof ApiError && error.code === 'SEMANTIC_UNAVAILABLE') {
    return 'Semantic search is unavailable for this request. Try Auto, Exact, or Lexical search.';
  }
  return 'Could not search prior decisions. Try again; manual categorization is still available.';
}

function semanticIndexStatus(health: ClassificationSemanticHealthDto): string {
  if (!health.configured) return 'not configured';
  if (!health.vectorAvailable) return 'unavailable';
  if (health.expectedState === 'failed' || health.latestAttemptState === 'failed') {
    return 'unavailable';
  }
  if (health.backlog > 0 || health.expectedState === 'building') {
    return `building — ${health.backlog} remaining — ${Math.round(health.progress * 100)}%`;
  }
  return 'ready';
}

export default function ClassificationMemoryPanel({
  companyId,
  initialQuery = '',
  transactionId,
  title = 'Classification rules',
  autoSearch = false,
}: ClassificationMemoryPanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState<ClassificationSearchMode>('auto');
  const [result, setResult] = useState<ClassificationSearchPageDto | null>(null);
  const [health, setHealth] = useState<ClassificationSemanticHealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef(0);
  const searchContextRef = useRef<{
    companyId: string;
    query: string;
    mode: ClassificationSearchMode;
    transactionId?: string;
  } | null>(null);

  useEffect(() => {
    requestRef.current += 1;
    setQuery(initialQuery);
    setBusy(false);
    setLoadingMore(false);
  }, [initialQuery]);

  useEffect(() => {
    requestRef.current += 1;
    setResult(null);
    setHealth(null);
    setError(null);
    setBusy(false);
    setLoadingMore(false);
    searchContextRef.current = null;
    return () => {
      requestRef.current += 1;
    };
  }, [companyId, transactionId]);

  const search = useCallback(async (overrideQuery?: string) => {
    const requestedQuery = (overrideQuery ?? query).normalize('NFC').trim();
    if (!requestedQuery) return;
    const requestId = ++requestRef.current;
    const context = {
      companyId,
      query: requestedQuery,
      mode,
      ...(transactionId === undefined ? {} : { transactionId }),
    };
    searchContextRef.current = context;
    setBusy(true);
    setLoadingMore(false);
    setError(null);
    setResult(null);
    const [searchOutcome, healthOutcome] = await Promise.allSettled([
      classificationMemory.search(companyId, {
        query: requestedQuery,
        mode,
        scope: 'current_company',
        ...(transactionId === undefined ? {} : { transactionId }),
        limit: 20,
      }),
      classificationMemory.health(companyId),
    ]);
    if (requestRef.current !== requestId) return;
    if (healthOutcome.status === 'fulfilled') setHealth(healthOutcome.value);
    else setHealth(null);
    if (searchOutcome.status === 'fulfilled') {
      const page = searchOutcome.value;
      if (page.companyId !== context.companyId || page.query !== context.query || page.requestedMode !== context.mode) {
        setError(searchFailureCopy(new Error('Classification search response does not match the active search.')));
      } else setResult(page);
    } else setError(searchFailureCopy(searchOutcome.reason));
    setBusy(false);
  }, [companyId, mode, query, transactionId]);

  const loadMore = useCallback(async () => {
    const context = searchContextRef.current;
    if (!context || !result?.nextCursor || loadingMore || result.items.length >= 100) return;
    const cursor = result.nextCursor;
    const requestId = ++requestRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await classificationMemory.search(context.companyId, {
        query: context.query,
        mode: context.mode,
        scope: 'current_company',
        ...(context.transactionId === undefined ? {} : { transactionId: context.transactionId }),
        limit: 20,
        cursor,
      });
      if (requestRef.current !== requestId || searchContextRef.current !== context) return;
      if (
        page.companyId !== context.companyId
        || page.query !== context.query
        || page.requestedMode !== context.mode
      ) throw new Error('Classification search page no longer matches the active search.');
      setResult((current) => {
        if (!current || current.nextCursor !== cursor) return current;
        const ids = new Set(current.items.map((hit) => hit.id));
        const items = [
          ...current.items,
          ...page.items.filter((hit) => !ids.has(hit.id)),
        ].slice(0, 100);
        return { ...current, items, total: page.total, nextCursor: page.nextCursor };
      });
    } catch (loadError) {
      if (requestRef.current === requestId && searchContextRef.current === context) {
        setError(searchFailureCopy(loadError));
      }
    } finally {
      if (requestRef.current === requestId && searchContextRef.current === context) setLoadingMore(false);
    }
  }, [loadingMore, result]);

  const invalidatePendingRequest = () => {
    requestRef.current += 1;
    searchContextRef.current = null;
    setResult(null);
    setError(null);
    setBusy(false);
    setLoadingMore(false);
  };

  useEffect(() => {
    if (!autoSearch || !initialQuery.trim()) return;
    void search(initialQuery);
    // Search once for each transaction/query identity. Mode changes remain an
    // explicit user action so we never issue a semantic request implicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearch, companyId, initialQuery, transactionId]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void search();
  };

  return (
    <section aria-label={title} style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 8 }}>{title}</div>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 220px' }}>
          <input
            aria-label="Classification search"
            className="input"
            value={query}
            onChange={(event) => {
              invalidatePendingRequest();
              setQuery(event.target.value);
            }}
            placeholder="Search vendors, rationale, categories…"
            maxLength={256}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
        <span>
          <Select
            label="Search mode"
            value={mode}
            onValueChange={(next) => {
              if (next === null) return;
              invalidatePendingRequest();
              setMode(next as ClassificationSearchMode);
            }}
            options={SEARCH_MODES.map((option) => ({ value: option, label: readable(option) }))}
          />
        </span>
        <button className="btn-ghost" type="submit" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search rules'}
        </button>
      </form>
      {busy && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 8 }}>
          Searching prior decisions…
        </div>
      )}
      {result && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 8 }}>
          {result.degraded
            ? `This search: lexical fallback — ${readable(result.degradedReason ?? 'semantic unavailable')}`
            : `This search: ${readable(result.mode)}`}
        </div>
      )}
      {health && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 4 }}>
          Semantic index status: {semanticIndexStatus(health)}
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: 'var(--erT)', marginTop: 10 }}>
          {error}
        </div>
      )}
      {result?.noMatch && !error && (
        <div style={{ color: 'var(--mut)', marginTop: 12 }}>
          No prior matching rule or decision was found. Manual categorization is still available.
        </div>
      )}
      {result && !result.noMatch && !error && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {result.items.slice(0, 100).map((hit) => {
            const summary = hit.actionSummary;
            const source = sourceNavigation(hit);
            return (
              <article
                key={hit.id}
                id={`classification-${hit.kind}-${hit.sourceId}`}
                style={{ border: '1px solid var(--bd2)', borderRadius: 9, padding: 13 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <strong>{hit.vendorName ?? readable(hit.kind)}</strong>
                    <div style={{ color: 'var(--mut)', fontSize: 12.5 }}>{hit.companyName}</div>
                  </div>
                  <span className={hit.executable ? 'pill-ok' : 'pill-am'}>
                    {hit.executable ? 'Executable' : 'Advisory'}
                  </span>
                </div>
                <div style={{ marginTop: 7, fontSize: 13.5 }}>
                  {summary
                    ? `${summary.categoryName} · ${readable(summary.taxCalculation)}${summary.taxCodeName ? ` · ${summary.taxCodeName}` : ''}`
                    : 'No executable category or tax action'}
                </div>
                <div style={{ color: 'var(--mut)', fontSize: 12.5, marginTop: 5 }}>
                  {sourceTypeLabel(hit)} · Matched in {hit.matchedIn.map(readable).join(' · ')} · {hit.evidenceCount} verified evidence · {hit.conflictingEvidenceCount} conflict
                  {hit.conflictingEvidenceCount === 1 ? '' : 's'} · {verifiedLabel(hit.verifiedAt)}
                </div>
                {hit.rationale && <p style={{ margin: '8px 0 0', fontSize: 13.5 }}>{hit.rationale}</p>}
                {hit.conflicts.slice(0, 10).map((conflict) => (
                  <div key={conflict.id} role="alert" style={{ color: 'var(--amT)', fontSize: 12.5, marginTop: 6 }}>
                    {conflict.reason}
                  </div>
                ))}
                {source && (
                  <Link to={source.href} style={{ display: 'inline-block', marginTop: 8, fontSize: 12.5 }}>
                    Open source {source.label}
                  </Link>
                )}
              </article>
            );
          })}
        </div>
      )}
      {result?.nextCursor && result.items.length < Math.min(result.total, 100) && (
        <button
          type="button"
          className="btn-ghost"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          style={{ marginTop: 12 }}
        >
          {loadingMore ? 'Loading more…' : `Load more · ${result.items.length} of ${result.total}`}
        </button>
      )}
    </section>
  );
}
