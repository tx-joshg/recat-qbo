import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClassificationCase,
  HistoricalObservationPastDecision,
  RuleCandidateDto,
  RuleDetailDto,
  RuleDirection,
  RuleLifecycleFilter,
  RuleRuntimeMode,
  RuleMutationKind,
  RuleMutationResult,
  RuleTestResult,
} from '@recat/shared';
import { isQboHoldingAccountName } from '@recat/shared';
import { Link, useLocation } from 'react-router-dom';
import {
  classificationMemory,
  createCategorizationRequestId,
  ruleCandidates as ruleCandidatesApi,
  ruleOperations,
  rules as rulesApi,
  type PrepareRuleOperationBody,
} from '../lib/api';
import ClassificationMemoryPanel from '../components/ClassificationMemoryPanel';
import PastDecisionsSection from './rules/PastDecisionsSection';
import ConfirmDialog from '../components/ConfirmDialog';
import { Select } from '../components/SelectCombobox';
import { fmtDate, fmtMoney } from '../lib/format';
import { useApp } from '../state/AppContext';
import RuleEditorCard from './rules/RuleEditorCard';
import RuleDetailsRegion from './rules/RuleDetailsRegion';

const PAGE_SIZE = 100;
const MAX_VISIBLE_RULES = 200;
const MAX_VISIBLE_CANDIDATES = 100;
const buttonStyle = {
  border: '1px solid var(--bd)', background: 'var(--card)', color: 'var(--ink)',
  borderRadius: 7, padding: '7px 10px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
} as const;

type PreparedIntent = {
  result: RuleMutationResult;
  idempotencyKey: string;
  confirmLabel: string;
  successMessage: string;
};

type PendingPreparation = {
  body: PrepareRuleOperationBody;
  candidateId: string | null;
};

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

function operationLabels(
  mutation: RuleMutationKind,
  proposal?: PrepareRuleOperationBody['proposal'],
): Pick<PreparedIntent, 'confirmLabel' | 'successMessage'> {
  if (mutation === 'activate_candidate') {
    return { confirmLabel: 'Confirm activate candidate', successMessage: 'Rule activated — auto-post remains off' };
  }
  if (mutation === 'dismiss_candidate') {
    return { confirmLabel: 'Confirm dismiss candidate', successMessage: 'Rule candidate dismissed' };
  }
  if (mutation === 'update' && Object.keys(proposal ?? {}).length === 1 && proposal?.autoPost === true) {
    return { confirmLabel: 'Confirm enable auto-post', successMessage: 'Auto-post enabled' };
  }
  if (mutation === 'update') {
    return { confirmLabel: 'Confirm update rule', successMessage: 'Rule updated' };
  }
  if (mutation === 'review') {
    return { confirmLabel: 'Confirm review and save', successMessage: 'Rule reviewed and saved' };
  }
  return {
    confirmLabel: `Confirm ${mutation} rule`,
    successMessage: `Rule ${mutation === 'enable' ? 'enabled' : 'disabled'}`,
  };
}

function PreviewBody({ operation }: { operation: PreparedIntent }) {
  const preview = operation.result.preview;
  if (!preview) return null;
  return <div>
    <p style={{ margin: '0 0 8px' }}>
      <strong>{preview.condition.matchText}</strong> → {preview.categoryName}
      {' · '}{readable(preview.action?.taxCalculation ?? 'action unavailable')}
      {preview.taxCodeName ? ` · ${preview.taxCodeName}` : ''}
    </p>
    <p style={{ margin: '0 0 8px' }}>
      {preview.affectedPendingCount} pending · {preview.affectedProcessedCount} processed
    </p>
    <p style={{ margin: '0 0 8px' }}>Auto-post: <strong>{preview.autoPost ? 'on' : 'off'}</strong></p>
    {preview.warnings.slice(0, 10).map((warning) => <div key={warning} role="alert" className="rule-warning">{warning}</div>)}
    {preview.conflicts.slice(0, 10).map((conflict) => <div key={conflict.id} role="alert" className="rule-error">{conflict.reason}</div>)}
    {preview.sampleTransactions.length > 0 && <ul style={{ paddingLeft: 20, marginBottom: 0 }}>
      {preview.sampleTransactions.slice(0, 20).map((sample) => <li key={sample.transactionId}>
        {sample.payee} · {fmtDate(sample.date)} · {fmtMoney(sample.amountCents / 100)} · {sample.status.toLowerCase()}
      </li>)}
    </ul>}
  </div>;
}

export default function Rules() {
  const { search: sourceSearch } = useLocation();
  const { activeCompanyId, activeCompany, accounts, tags, taxReadiness, toast } = useApp();
  const [filter, setFilter] = useState<RuleLifecycleFilter>('all');
  const [ruleList, setRuleList] = useState<RuleDetailDto[]>([]);
  const [ruleCursor, setRuleCursor] = useState<string | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<{ companyId: string; mode: RuleRuntimeMode | null } | null>(null);
  const runtimeMode = runtimeStatus?.companyId === activeCompanyId ? runtimeStatus.mode : null;
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesTruncated, setRulesTruncated] = useState(false);
  const [candidateList, setCandidateList] = useState<RuleCandidateDto[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [candidatesTruncated, setCandidatesTruncated] = useState(false);
  const [prepared, setPrepared] = useState<PreparedIntent | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, { revision: number; result: RuleTestResult }>>({});
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [sourceCase, setSourceCase] = useState<ClassificationCase | null>(null);
  const [sourceObservation, setSourceObservation] = useState<HistoricalObservationPastDecision | null>(null);
  const [sourceRule, setSourceRule] = useState<RuleDetailDto | null>(null);
  const [sourceCandidate, setSourceCandidate] = useState<RuleCandidateDto | null>(null);
  const companyRef = useRef(activeCompanyId);
  const rulePageRequestRef = useRef(0);
  const candidatePageRequestRef = useRef(0);
  const operationRequestRef = useRef(0);
  const preparingRef = useRef(false);
  const committingRef = useRef(false);
  const testRequestRef = useRef(0);
  const pendingPreparationRef = useRef<PendingPreparation | null>(null);
  const ruleListRef = useRef<RuleDetailDto[]>([]);
  const candidateListRef = useRef<RuleCandidateDto[]>([]);
  companyRef.current = activeCompanyId;
  ruleListRef.current = ruleList;
  candidateListRef.current = candidateList;

  const eligibleAccounts = useMemo(() => {
    const holdingIds = new Set((activeCompany?.holdingAccountIds ?? []).map(String));
    return accounts.filter((account) => (
      account.classification === 'Income'
      || account.classification === 'COGS'
      || account.classification === 'Expenses'
    ) && !holdingIds.has(account.id) && !holdingIds.has(account.qboId) && !isQboHoldingAccountName(account.name));
  }, [accounts, activeCompany]);
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.name])), [tags]);

  const loadFirstPage = useCallback(async (companyId: string, state: RuleLifecycleFilter) => {
    const requestId = ++rulePageRequestRef.current;
    setRulesBusy(true); setRulesError(null); setRulesTruncated(false);
    setRuntimeStatus(null);
    try {
      const page = await rulesApi.lifecycle(companyId, state, undefined, PAGE_SIZE);
      if (requestId !== rulePageRequestRef.current || companyRef.current !== companyId) return;
      setRuntimeStatus({ companyId, mode: page.runtimeMode ?? null });
      const items = page.items.slice(0, MAX_VISIBLE_RULES);
      const truncated = page.items.length > MAX_VISIBLE_RULES
        || (items.length >= MAX_VISIBLE_RULES && page.nextCursor !== null);
      ruleListRef.current = items; setRuleList(items); setRulesTruncated(truncated);
      setRuleCursor(truncated ? null : page.nextCursor);
    } catch (error) {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) {
        setRulesError(error instanceof Error ? error.message : 'Rules are unavailable.');
      }
    } finally {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) setRulesBusy(false);
    }
  }, []);

  const loadCandidates = useCallback(async (companyId: string, cursor?: string, append = false) => {
    if (append && candidateListRef.current.length >= MAX_VISIBLE_CANDIDATES) return;
    const requestId = ++candidatePageRequestRef.current;
    setCandidateBusy(true);
    if (!append) { setCandidatesError(null); setCandidatesTruncated(false); }
    try {
      const page = cursor === undefined
        ? await ruleCandidatesApi.list(companyId)
        : await ruleCandidatesApi.list(companyId, cursor);
      if (requestId !== candidatePageRequestRef.current || companyRef.current !== companyId) return;
      const current = append ? candidateListRef.current : [];
      const existing = new Set(current.map((candidate) => candidate.id));
      const combined = [...current, ...page.candidates.filter((candidate) => !existing.has(candidate.id))];
      const retained = combined.slice(0, MAX_VISIBLE_CANDIDATES);
      const truncated = combined.length > MAX_VISIBLE_CANDIDATES
        || (retained.length >= MAX_VISIBLE_CANDIDATES && page.nextCursor !== null);
      candidateListRef.current = retained; setCandidateList(retained); setCandidatesTruncated(truncated);
      setCandidateCursor(truncated ? null : page.nextCursor);
    } catch (error) {
      if (requestId === candidatePageRequestRef.current && companyRef.current === companyId) {
        setCandidatesError(error instanceof Error ? error.message : 'Rule candidates are unavailable.');
      }
    } finally {
      if (requestId === candidatePageRequestRef.current && companyRef.current === companyId) setCandidateBusy(false);
    }
  }, []);

  useEffect(() => {
    const companyId = activeCompanyId;
    let cancelled = false;
    const cleanup = () => {
      cancelled = true;
      operationRequestRef.current += 1; rulePageRequestRef.current += 1; candidatePageRequestRef.current += 1;
      testRequestRef.current += 1;
    };
    operationRequestRef.current += 1; rulePageRequestRef.current += 1; candidatePageRequestRef.current += 1;
    setRuntimeStatus(null);
    setRuleList([]); ruleListRef.current = []; setRuleCursor(null); setRulesError(null); setRulesTruncated(false);
    setCandidateList([]); candidateListRef.current = []; setCandidateCursor(null); setCandidatesError(null); setCandidatesTruncated(false);
    setPrepared(null); setPrepareBusy(false); setPrepareError(null); setCommitBusy(false);
    preparingRef.current = false; committingRef.current = false; pendingPreparationRef.current = null;
    setTestBusy(null); setTestResult({}); setSourceCase(null); setSourceObservation(null); setSourceRule(null); setSourceCandidate(null);
    if (!companyId) return cleanup;
    void loadFirstPage(companyId, filter); void loadCandidates(companyId);

    const source = new URLSearchParams(sourceSearch);
    const sourceKind = source.get('source');
    const sourceId = source.get('sourceId');
    if (sourceKind === 'classification_case' && sourceId) {
      classificationMemory.getCase(companyId, sourceId)
        .then(value => { if (!cancelled && companyRef.current === companyId && value.companyId === companyId && value.id === sourceId) setSourceCase(value); })
        .catch((error: Error) => { if (!cancelled && companyRef.current === companyId) toast(error.message); });
    } else if (sourceKind === 'historical_observation' && sourceId) {
      classificationMemory.getObservation(companyId, sourceId)
        .then(value => { if (!cancelled && companyRef.current === companyId && value.companyId === companyId && value.id === sourceId) setSourceObservation(value); })
        .catch((error: Error) => { if (!cancelled && companyRef.current === companyId) toast(error.message); });
    } else if (sourceKind === 'rule' && sourceId) {
      rulesApi.detail(companyId, sourceId)
        .then((value) => { if (!cancelled && companyRef.current === companyId) setSourceRule(value); })
        .catch((error: Error) => { if (!cancelled && companyRef.current === companyId) toast(error.message); });
    } else if (sourceKind === 'rule_candidate' && sourceId) {
      ruleCandidatesApi.get(companyId, sourceId)
        .then((value) => { if (!cancelled && companyRef.current === companyId) setSourceCandidate(value); })
        .catch((error: Error) => { if (!cancelled && companyRef.current === companyId) toast(error.message); });
    }
    return cleanup;
  }, [activeCompanyId, filter, loadCandidates, loadFirstPage, sourceSearch, toast]);

  const loadMoreRules = useCallback(async () => {
    if (!activeCompanyId || !ruleCursor || rulesBusy || ruleListRef.current.length >= MAX_VISIBLE_RULES) return;
    const companyId = activeCompanyId;
    const requestId = ++rulePageRequestRef.current;
    setRulesBusy(true);
    try {
      const page = await rulesApi.lifecycle(companyId, filter, ruleCursor, PAGE_SIZE);
      if (requestId !== rulePageRequestRef.current || companyRef.current !== companyId) return;
      setRuntimeStatus({ companyId, mode: page.runtimeMode ?? null });
      const ids = new Set(ruleListRef.current.map((rule) => rule.revision.ruleId));
      const combined = [...ruleListRef.current, ...page.items.filter((rule) => !ids.has(rule.revision.ruleId))];
      const retained = combined.slice(0, MAX_VISIBLE_RULES);
      const truncated = combined.length > MAX_VISIBLE_RULES
        || (retained.length >= MAX_VISIBLE_RULES && page.nextCursor !== null);
      ruleListRef.current = retained; setRuleList(retained); setRulesTruncated(truncated);
      setRuleCursor(truncated ? null : page.nextCursor);
    } catch (error) {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) {
        toast(error instanceof Error ? error.message : 'Rules are unavailable.');
      }
    } finally {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) setRulesBusy(false);
    }
  }, [activeCompanyId, filter, ruleCursor, rulesBusy, toast]);

  const completeOperation = useCallback(async (intent: PreparedIntent) => {
    if (!activeCompanyId || committingRef.current) return;
    const companyId = activeCompanyId;
    const requestId = operationRequestRef.current;
    committingRef.current = true; setCommitBusy(true);
    try {
      const result = await ruleOperations.commit(companyId, intent.result.operationId, intent.idempotencyKey);
      if (requestId !== operationRequestRef.current || companyRef.current !== companyId) return;
      if (!result.ok || result.companyId !== companyId || result.operationId !== intent.result.operationId
        || result.mutation !== intent.result.mutation || !['COMMITTED', 'REPLAYED'].includes(result.status)) {
        throw new Error(result.error?.message ?? 'Rule operation could not be verified. Retry the same operation.');
      }
      await Promise.all([loadFirstPage(companyId, filter), loadCandidates(companyId)]);
      if (requestId !== operationRequestRef.current || companyRef.current !== companyId) return;
      setPrepared(null); pendingPreparationRef.current = null; setPrepareError(null);
      setSourceRule(null); setSourceCandidate(null); toast(intent.successMessage);
    } catch (error) {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) {
        const message = error instanceof Error ? error.message : 'Rule operation failed.';
        setPrepareError(message);
        toast(message);
      }
    } finally {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) { committingRef.current = false; setCommitBusy(false); }
    }
  }, [activeCompanyId, commitBusy, filter, loadCandidates, loadFirstPage, toast]);

  const runPreparation = useCallback(async (pending: PendingPreparation) => {
    if (!activeCompanyId || preparingRef.current || prepared || commitBusy) return;
    const companyId = activeCompanyId;
    preparingRef.current = true; setPrepareBusy(true); setPrepareError(null);
    const requestId = ++operationRequestRef.current;
    try {
      const result = await ruleOperations.prepare(companyId, pending.body);
      if (requestId !== operationRequestRef.current || companyRef.current !== companyId) return;
      if (!result.ok || result.companyId !== companyId
        || result.mutation !== pending.body.mutation
        || (pending.body.ruleId !== undefined && result.ruleId !== pending.body.ruleId)) {
        throw new Error(result.error?.message ?? 'The server did not return the requested rule operation.');
      }
      if (result.status === 'REPLAYED') {
        if (pending.body.candidateId !== undefined && result.candidate?.candidateId !== pending.body.candidateId) {
          throw new Error('The server did not return the requested candidate operation.');
        }
        await Promise.all([loadFirstPage(companyId, filter), loadCandidates(companyId)]);
        if (requestId !== operationRequestRef.current || companyRef.current !== companyId) return;
        setPrepared(null); pendingPreparationRef.current = null; setPrepareError(null);
        setSourceRule(null); setSourceCandidate(null);
        toast(operationLabels(pending.body.mutation, pending.body.proposal).successMessage);
        return;
      }
      if (result.status !== 'PREPARED' || !result.preview || result.preview.companyId !== companyId
        || result.preview.operationId !== result.operationId || result.preview.mutation !== pending.body.mutation
        || (pending.body.candidateId !== undefined && result.preview.candidateId !== pending.body.candidateId)) {
        throw new Error(result.error?.message ?? 'The server did not return a reviewable preview.');
      }
      const intent: PreparedIntent = {
        result, idempotencyKey: pending.body.idempotencyKey,
        ...operationLabels(pending.body.mutation, pending.body.proposal),
      };
      const immediate = pending.body.mutation === 'disable'
        || (pending.body.mutation === 'enable' && result.preview.conflicts.length === 0);
      if (immediate) {
        preparingRef.current = false; setPrepareBusy(false);
        await completeOperation(intent);
      } else {
        setPrepared(intent);
      }
    } catch (error) {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) {
        setPrepareError(error instanceof Error ? error.message : 'Rule preparation failed.');
      }
    } finally {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) {
        preparingRef.current = false; setPrepareBusy(false);
      }
    }
  }, [activeCompanyId, commitBusy, completeOperation, filter, loadCandidates, loadFirstPage, prepared, toast]);

  const beginOperation = useCallback((body: PrepareRuleOperationBody, candidateId: string | null = null) => {
    if (!activeCompanyId || runtimeMode !== 'canonical' || prepared || commitBusy || preparingRef.current || pendingPreparationRef.current) return;
    const pending = { body, candidateId };
    pendingPreparationRef.current = pending;
    void runPreparation(pending);
  }, [activeCompanyId, commitBusy, prepared, runPreparation, runtimeMode]);

  const startRuleOperation = useCallback((
    rule: RuleDetailDto,
    mutation: Exclude<RuleMutationKind, 'create' | 'activate_candidate' | 'dismiss_candidate'>,
    proposal?: PrepareRuleOperationBody['proposal'],
  ) => beginOperation({
    mutation, ruleId: rule.revision.ruleId, expectedRevision: rule.revision.revision,
    idempotencyKey: createCategorizationRequestId(), ...(proposal === undefined ? {} : { proposal }),
  }), [beginOperation]);

  const startCandidateOperation = useCallback((candidate: RuleCandidateDto, mutation: 'activate_candidate' | 'dismiss_candidate') => {
    beginOperation({ mutation, candidateId: candidate.id, expectedRevision: 0, idempotencyKey: createCategorizationRequestId() }, candidate.id);
  }, [beginOperation]);

  const testRule = useCallback(async (rule: RuleDetailDto, matchText: string, direction: RuleDirection) => {
    if (!activeCompanyId || testBusy) return;
    const companyId = activeCompanyId;
    const ruleId = rule.revision.ruleId;
    const requestId = ++testRequestRef.current;
    setTestBusy(ruleId);
    try {
      const result = await rulesApi.test(companyId, matchText, direction);
      if (requestId === testRequestRef.current && companyRef.current === companyId) setTestResult((current) => ({ ...current, [ruleId]: { revision: rule.revision.revision, result } }));
    } catch (error) {
      if (requestId === testRequestRef.current && companyRef.current === companyId) toast(error instanceof Error ? error.message : 'Rule test failed.');
    } finally {
      if (requestId === testRequestRef.current && companyRef.current === companyId) setTestBusy(null);
    }
  }, [activeCompanyId, testBusy, toast]);

  const cancelPreparation = useCallback(() => {
    if (committingRef.current) return;
    operationRequestRef.current += 1; preparingRef.current = false; pendingPreparationRef.current = null;
    setPrepareBusy(false); setPrepareError(null); setPrepared(null);
  }, [commitBusy]);

  const linkedSourceRule = sourceRule
    && !ruleList.some((rule) => rule.revision.ruleId === sourceRule.revision.ruleId) ? sourceRule : null;
  const linkedSourceCandidate = sourceCandidate
    && !candidateList.some((candidate) => candidate.id === sourceCandidate.id) ? sourceCandidate : null;
  const ruleGroups = [
    ...(linkedSourceRule ? [{ key: 'linked-source', linked: true, items: [linkedSourceRule] }] : []),
    { key: 'lifecycle-collection', linked: false, items: ruleList },
  ];
  const candidateGroups = [
    ...(linkedSourceCandidate ? [{ key: 'linked-source', linked: true, items: [linkedSourceCandidate] }] : []),
    { key: 'candidate-collection', linked: false, items: candidateList },
  ];
  const operationBusy = runtimeMode !== 'canonical' || prepareBusy || commitBusy || prepared !== null || pendingPreparationRef.current !== null;

  return <main style={{ maxWidth: 1040, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
    <header className="rules-page-header">
      <div>
        <h1 className="page-title" style={{ margin: 0 }}>Rules</h1>
        <p className="page-sub" style={{ marginBottom: 0 }}>Match vendors and apply structured categorization rules.</p>
      </div>
      <Select label="Rule lifecycle" value={filter}
        onValueChange={(next) => { if (next) setFilter(next as RuleLifecycleFilter); }}
        options={[{ value: 'all', label: 'All' }, { value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]}/>
    </header>

    {activeCompanyId && runtimeMode !== 'canonical' && <div role="status" aria-label="Rule editing status" className="rule-warning" style={{ marginTop: 16 }}>
      {runtimeMode === 'legacy' ? 'This company’s rules need migration before editing is available.'
        : runtimeMode === 'bridge' ? 'Rule migration is not finished. Editing is unavailable.'
        : runtimeMode === 'paused' ? 'Rule changes are paused. You can still view rules and history.'
        : rulesBusy ? 'Checking whether rule editing is available…'
        : 'Rule editing is unavailable until the current status can be loaded.'}
    </div>}

    {activeCompanyId && <ClassificationMemoryPanel companyId={activeCompanyId} title="Search rules" />}

    {sourceCase && <section id={`classification-case-${sourceCase.id}`} aria-label="Source classification case" className="rule-source-card">
      <h2>Source classification case</h2><p>{sourceCase.rationale}</p>
      <div className="rule-editor-meta">Verified {fmtDate(sourceCase.verifiedAt)} · {sourceCase.context.sourceAccountName ?? 'Unknown source account'} · {readable(sourceCase.originIntent)}</div>
      {sourceCase.citations.slice(0, 10).map((citation) => <a key={citation.url} href={citation.url} target="_blank" rel="noreferrer">{citation.title} — {citation.publisher}</a>)}
    </section>}
    {sourceObservation && <section id={`classification-historical_observation-${sourceObservation.id}`} aria-label="Source historical observation" className="rule-source-card">
      <h2>Advisory historical observation</h2><p>{sourceObservation.payee}</p>
      {sourceObservation.memo && <p>{sourceObservation.memo}</p>}
      <p className="rule-editor-meta">Observed {fmtDate(sourceObservation.observedAt)} · Source status {sourceObservation.sourceStatus ?? 'unknown'}</p>
      {sourceObservation.supersededByCaseId && <Link to={`/rules?source=classification_case&sourceId=${sourceObservation.supersededByCaseId}`}>Superseded by verified decision</Link>}
    </section>}

    <section aria-labelledby="lifecycle-rules-title">
      <h2 id="lifecycle-rules-title" style={{ fontSize: 19 }}>Rules</h2>
      {rulesError && <div role="alert" aria-label="Rules unavailable" className="rule-error">{rulesError}{' '}<button style={buttonStyle} disabled={rulesBusy} onClick={() => activeCompanyId && void loadFirstPage(activeCompanyId, filter)}>Retry rules</button></div>}
      {rulesBusy && ruleList.length === 0 && <div role="status">Loading rules…</div>}
      {!rulesBusy && !rulesError && ruleList.length === 0 && <section className="card" role="status" aria-label="No rules" style={{ padding: 18, marginTop: 12 }}>
        <strong>No rules match this state.</strong>
        <p style={{ color: 'var(--mut)', marginBottom: 12 }}>{runtimeMode === 'canonical' ? 'Rules are optional. Create one from a reviewed Queue decision when a vendor pattern is stable.' : 'Rules are optional. You can continue reviewing transactions in Queue.'}</p>
        {runtimeMode === 'canonical' && <Link to="/" className="btn-ghost">Create rule from Queue</Link>}
      </section>}
      {ruleGroups.map((group) => group.items.length > 0 && <div key={group.key} role={group.linked ? 'region' : undefined} aria-labelledby={group.linked ? 'linked-source-rule-title' : undefined}>
        {group.linked && <><h3 id="linked-source-rule-title">Linked source rule</h3><p className="rule-editor-meta">Shown from the deep link; it is not part of the currently loaded state collection.</p></>}
        <div className="rule-editor-list">
          {group.items.map((rule) => {
            const ruleId = rule.revision.ruleId;
            const tested = testResult[ruleId];
            const currentTest = tested?.revision === rule.revision.revision ? tested.result : undefined;
            return <RuleEditorCard key={ruleId} rule={rule} accounts={eligibleAccounts} tags={tags}
              taxReadiness={taxReadiness} operationBusy={operationBusy} testing={testBusy === ruleId}
              onOperation={startRuleOperation}
              onTest={(currentRule, matchText, direction) => void testRule(currentRule, matchText, direction)}
              footer={(actions) => <>
                <RuleDetailsRegion companyId={rule.revision.companyId} ruleId={ruleId}
                  matchText={rule.revision.condition.matchText} revision={rule.revision.revision} actions={actions} />
                {currentTest && <div role="status" className="rule-test-result">
                  <div>{currentTest.pendingCount} pending · {currentTest.processedCount} processed · {currentTest.conflicts.length} conflicts</div>
                  {currentTest.conflicts.slice(0, 20).map((conflict) => <div key={conflict.ruleId}>Conflict: {conflict.matchText} → {conflict.category}</div>)}
                  {currentTest.matches.slice(0, 20).map((match) => <div key={match.txnId}>{match.payee} · {fmtDate(match.date)} · {fmtMoney(match.amount)}{match.wouldWin ? ' · would win' : ` · existing winner: ${match.currentWinner ?? 'unknown'}`}</div>)}
                </div>}
              </>}/>;
          })}
        </div>
      </div>)}
      {rulesTruncated && <div role="status" aria-label="Rule lifecycle truncated">Showing first {ruleList.length} rules; more rules exist.</div>}
      {ruleCursor && <button style={{ ...buttonStyle, marginTop: 12 }} disabled={rulesBusy} onClick={() => void loadMoreRules()}>{rulesBusy ? 'Loading…' : 'Load more rules'}</button>}
    </section>

    {activeCompanyId && <PastDecisionsSection companyId={activeCompanyId} />}

    <section aria-labelledby="candidate-title" style={{ marginTop: 28 }}>
      <h2 id="candidate-title" style={{ fontSize: 19 }}>Learned Candidates</h2>
      <p style={{ color: 'var(--mut)', marginTop: 0 }}>These suggestions come from verified outcomes. Activation is explicit and never posts automatically; auto-post remains off.</p>
      {candidatesError && <div role="alert" aria-label="Candidates unavailable" className="rule-error">
        {candidatesError}{' '}
        <button style={buttonStyle} disabled={candidateBusy} onClick={() => activeCompanyId && void loadCandidates(activeCompanyId)}>Retry candidates</button>
      </div>}
      {candidateBusy && candidateList.length === 0 && !candidatesError && <div role="status">Loading candidates…</div>}
      {candidateGroups.map((group) => group.items.length > 0 && <div
        key={group.key}
        role={group.linked ? 'region' : undefined}
        aria-label={group.linked ? 'Linked source candidate' : undefined}
      >
        {group.linked && <h3>Linked source candidate</h3>}
        <div className="rule-editor-list">{group.items.map((candidate) => {
          const actionable = candidate.state !== 'activated' && candidate.state !== 'dismissed';
          return <article key={candidate.id} id={`rule-candidate-${candidate.id}`} className="rule-candidate-card">
            <div className="rule-editor-header"><strong>{candidate.matchText}</strong><span className={candidate.canActivate ? 'pill-ok' : 'pill-am'}>{readable(candidate.state)}</span></div>
            <div>{candidate.category ?? 'Unavailable category'} · {readable(candidate.taxCalculation ?? 'tax unavailable')}{candidate.taxCode ? ` · ${candidate.taxCode}` : ''}</div>
            <div className="rule-editor-meta">{candidate.evidenceCount} verified outcomes · {candidate.provenance.user} reviewed by a person · {candidate.provenance.autopilot} by autopilot · {candidate.provenance.mcp} by MCP</div>
            {candidate.tagIds.length > 0 && <div className="rule-editor-meta">Tags: {candidate.tagIds.map((id) => tagById.get(id) ?? 'Unavailable tag').join(', ')}</div>}
            {candidate.conflictingEvidenceCount > 0 && <div role="alert" className="rule-warning">{candidate.conflictingEvidenceCount} conflicting outcome{candidate.conflictingEvidenceCount === 1 ? '' : 's'}</div>}
            {candidate.staleReasons.map((reason) => <div key={reason} role="alert" className="rule-error">{reason}</div>)}
            {actionable && <div className="rule-editor-actions">
              {candidate.canActivate && <button style={buttonStyle} disabled={operationBusy} onClick={() => startCandidateOperation(candidate, 'activate_candidate')}>Activate rule</button>}
              <button style={buttonStyle} disabled={operationBusy} onClick={() => startCandidateOperation(candidate, 'dismiss_candidate')}>Dismiss</button>
            </div>}
          </article>;
        })}</div>
      </div>)}
      {candidatesTruncated && <div role="status" aria-label="Rule candidates truncated">Showing newest {candidateList.length} candidates; older candidates exist.</div>}
      {candidateCursor && <button style={{ ...buttonStyle, marginTop: 12 }} disabled={candidateBusy} onClick={() => activeCompanyId && void loadCandidates(activeCompanyId, candidateCursor, true)}>{candidateBusy ? 'Loading…' : 'Load more candidates'}</button>}
    </section>

    {prepareError && <div role="alert" aria-label="Rule preparation unavailable" className="rule-error" style={{ marginTop: 16 }}>
      {prepareError}{' '}
      {pendingPreparationRef.current && <button style={buttonStyle} disabled={prepareBusy} onClick={() => pendingPreparationRef.current && void runPreparation(pendingPreparationRef.current)}>Retry preparation</button>}
      <button style={{ ...buttonStyle, marginLeft: 6 }} disabled={prepareBusy} onClick={cancelPreparation}>Cancel preparation</button>
    </div>}

    <ConfirmDialog open={prepared?.result.preview != null} title="Review rule change"
      confirmLabel={prepared?.confirmLabel ?? 'Confirm'}
      tone={prepared?.result.mutation === 'dismiss_candidate' ? 'danger' : 'primary'} busy={commitBusy}
      onConfirm={() => prepared && void completeOperation(prepared)} onCancel={cancelPreparation}>
      {prepared && <PreviewBody operation={prepared} />}
    </ConfirmDialog>
  </main>;
}
