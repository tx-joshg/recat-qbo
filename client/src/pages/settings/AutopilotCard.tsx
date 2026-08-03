import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Role } from '@recat/shared';
import {
  autopilot,
  type LiveReadinessDto,
  type AutopilotOverviewDto,
  type AutopilotRunDto,
  type AutopilotSettingsPatch,
} from '../../lib/api';
import { useApp } from '../../state/AppContext';

const VERIFIER_LABEL = {
  deterministic: 'Deterministic checks',
  same_model: 'Same-model critique',
  distinct_model: 'Distinct-model review',
  unavailable: 'Verification unavailable',
} as const;

const cardStyle = {
  border: '1px solid var(--bd2)',
  borderRadius: 10,
  background: 'var(--card)',
  padding: '20px 24px',
  boxShadow: '0 1px 6px rgba(60,55,45,.05)',
} as const;

const RECONCILIATION_POLL_INTERVAL_MS = 250;
const RECONCILIATION_MAX_POLLS = 8;

function errorMessage(_error: unknown): string {
  return 'Could not load autopilot operations';
}

const OUTCOME_LABEL: Record<AutopilotRunDto['outcome'], string> = {
  shadow_proposed: 'Shadow proposal',
  shadow_verified: 'Shadow proposal verified',
  abstained: 'Abstained',
  failed_before_write: 'Failed before write',
  posted_verified: 'Posted and independently verified in QuickBooks',
  possible_write_uncertain: 'Outcome uncertain — verify in QuickBooks',
  readback_mismatch: 'QuickBooks readback mismatch — explicit review required',
  reconciled_unchanged: 'Reconciled — QuickBooks unchanged',
  reconciled_posted: 'Reconciled — posted and independently verified',
  reverted: 'Reverted and independently verified',
  retrying: 'Retrying',
  in_progress: 'In progress',
  dry_run: 'Dry run — nothing posted',
  unavailable: 'Outcome unavailable',
};

const RUN_ERROR_LABEL: Readonly<Record<string, string>> = {
  LIVE_DAILY_LIMIT_REACHED: 'Daily live-write limit reached',
};

function runErrorLabel(code: string): string {
  return RUN_ERROR_LABEL[code] ?? code;
}

function numberField(form: FormData, name: string): number {
  return Number(form.get(name));
}

function settingsPatch(form: FormData): AutopilotSettingsPatch {
  return {
    mode: form.get('mode') === 'shadow' ? 'shadow' : 'off',
    provider: form.get('provider') === 'openrouter' ? 'openrouter' : 'custom',
    decisionModel: String(form.get('decisionModel') ?? ''),
    verifierModel: String(form.get('verifierModel') ?? ''),
    scheduleMinutes: numberField(form, 'scheduleMinutes'),
    companyConcurrency: numberField(form, 'companyConcurrency'),
    evidenceThreshold: numberField(form, 'evidenceThreshold'),
    dailyLiveWriteLimit: numberField(form, 'dailyLiveWriteLimit'),
    limits: {
      maxToolCalls: numberField(form, 'maxToolCalls'),
      maxTurns: numberField(form, 'maxTurns'),
      maxContextBytes: numberField(form, 'maxContextBytes'),
      maxResponseBytes: numberField(form, 'maxResponseBytes'),
      timeoutMs: numberField(form, 'timeoutMs'),
    },
  };
}

function Field({
  label,
  name,
  defaultValue,
  min,
  max,
}: {
  label: string;
  name: string;
  defaultValue: number;
  min: number;
  max: number;
}) {
  return (
    <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
      {label}
      <input
        className="input"
        aria-label={label}
        name={name}
        type="number"
        defaultValue={defaultValue}
        min={min}
        max={max}
        required
        style={{ width: '100%' }}
      />
    </label>
  );
}

function VerifierGuide() {
  return (
    <div
      aria-label="Verifier kinds"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}
    >
      {Object.values(VERIFIER_LABEL).map((label) => (
        <span
          key={label}
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 99,
            padding: '3px 9px',
            fontSize: 11.5,
            color: 'var(--mut)',
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function EvidenceProgress({ state }: { state: AutopilotOverviewDto }) {
  const { evidence } = state;
  const agreementRate = evidence.eligibleRuns === 0
    ? null
    : Math.round((evidence.agreements / evidence.eligibleRuns) * 100);
  return (
    <div style={{ minWidth: 190 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {evidence.eligibleRuns} of {evidence.threshold} qualified outcomes
      </div>
      <div
        role="progressbar"
        aria-label="Qualified evidence progress"
        aria-valuemin={0}
        aria-valuemax={evidence.threshold}
        aria-valuenow={Math.min(evidence.eligibleRuns, evidence.threshold)}
        style={{
          height: 7,
          background: 'var(--hl)',
          borderRadius: 99,
          overflow: 'hidden',
          marginTop: 7,
        }}
      >
        <div
          style={{
            width: `${Math.min(100, (evidence.eligibleRuns / evidence.threshold) * 100)}%`,
            height: '100%',
            background: evidence.thresholdMet ? 'var(--okT)' : 'var(--acc)',
          }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 5 }}>
        {agreementRate === null
          ? 'No qualified comparison outcomes yet'
          : `${agreementRate}% agreement · ${evidence.disagreements} disagreements`}
      </div>
    </div>
  );
}

function RunSummary({
  run,
  canReconcile = false,
  reconciling = false,
  reconciliationInProgress = false,
  onReconcile,
}: {
  run: AutopilotRunDto;
  canReconcile?: boolean;
  reconciling?: boolean;
  reconciliationInProgress?: boolean;
  onReconcile?: (operationId: string) => void;
}) {
  const proposal = run.proposal;
  const evidence = run.verification.evidence;
  const outcome = proposal?.kind === 'proposal'
    ? `${proposal.lineCount} line proposal · ${Math.round(proposal.confidence * 100)}% confidence`
    : proposal?.kind === 'abstain'
      ? `Abstained · ${proposal.reasonCode.replaceAll('_', ' ').toLowerCase()}`
      : 'No safe proposal summary';
  const evidenceLabel = evidence?.state === 'eligible'
    ? evidence.agreement
      ? 'Qualified agreement'
      : 'Qualified disagreement'
    : evidence?.state === 'invalidated'
      ? `Evidence invalidated · ${evidence.invalidationReason}`
      : 'Not qualified as evidence';
  return (
    <li
      style={{
        listStyle: 'none',
        padding: '11px 0',
        borderTop: '1px solid var(--rowbd)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {OUTCOME_LABEL[run.outcome]}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
          Durable state: {run.status} · {outcome}
        </div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
          Verifier: {VERIFIER_LABEL[run.verification.verifierKind]} · {evidenceLabel}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
          Attempt {run.attemptCount} · config {run.configVersion}
        </div>
        {proposal?.kind === 'proposal' && (
          <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
            {proposal.taxCalculation} · evidence{' '}
            {proposal.evidenceKinds.length === 0 ? 'none' : proposal.evidenceKinds.join(', ')}
          </div>
        )}
        {run.verification.diagnosticCode && (
          <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
            {run.verification.diagnosticCode}
          </div>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--fnt)',
            marginTop: 3,
            overflowWrap: 'anywhere',
          }}
        >
          {run.models.decision} → {run.models.verifier} · prompt {run.models.promptVersion} ·
          schema {run.models.schemaVersion}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fnt)', textAlign: 'right' }}>
        <div>Started {run.timing.createdAt}</div>
        <div>Completed {run.timing.completedAt ?? 'not completed'}</div>
        <div>{run.timing.durationMs === null ? '—' : `${run.timing.durationMs} ms`}</div>
        <div>
          input {run.usage?.inputTokens ?? '—'} · output {run.usage?.outputTokens ?? '—'} · total{' '}
          {run.usage?.totalTokens ?? '—'} tokens
        </div>
        {run.errorCode && (
          <div style={{ color: 'var(--erT)' }}>{runErrorLabel(run.errorCode)}</div>
        )}
        {reconciliationInProgress && (
          <div role="status" style={{ color: 'var(--amT)', marginTop: 5 }}>
            Reconciliation in progress
          </div>
        )}
        {canReconcile && run.operationId !== null && (
          <button
            className="btn-ghost"
            type="button"
            disabled={reconciling || reconciliationInProgress}
            onClick={() => onReconcile?.(run.operationId!)}
            style={{ marginTop: 7 }}
          >
            {reconciling ? 'Reconciling…' : 'Reconcile live operation'}
          </button>
        )}
      </div>
    </li>
  );
}

export function LiveRunHistory({
  runs,
  canReconcile = false,
  reconcilingOperationId = null,
  inProgressOperationId = null,
  onReconcile,
  label = 'Recent autopilot runs',
}: {
  runs: AutopilotRunDto[];
  canReconcile?: boolean;
  reconcilingOperationId?: string | null;
  inProgressOperationId?: string | null;
  onReconcile?: (operationId: string) => void;
  label?: string;
}) {
  return (
    <ul aria-label={label} style={{ margin: '7px 0 0', padding: 0 }}>
      {runs.map((run) => (
        <RunSummary
          key={run.id}
          run={run}
          canReconcile={canReconcile}
          reconciling={run.operationId === reconcilingOperationId}
          reconciliationInProgress={
            inProgressOperationId !== null
            && run.operationId === inProgressOperationId
          }
          onReconcile={onReconcile}
        />
      ))}
    </ul>
  );
}

function LiveReadiness({
  readiness,
  compact = false,
}: {
  readiness: LiveReadinessDto;
  compact?: boolean;
}) {
  const evidenceStart = new Date(readiness.evidence.completedSince)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const evidenceEnd = new Date(readiness.evidence.completedThrough)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <section
      aria-label="Live readiness"
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 8,
        padding: compact ? 10 : 14,
        marginTop: compact ? 0 : 16,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
        {readiness.state.enabled
          ? 'Live mode enabled'
          : readiness.state.paused
            ? 'Live mode paused'
            : 'Live mode not enabled'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 5 }}>
        Policy {readiness.policyVersion}
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        {readiness.policy.supportedEntities.join(', ')} only · Minimum confidence{' '}
        {Math.round(readiness.policy.minimumConfidence * 100)}%
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        {readiness.models.decisionAlias} → {readiness.models.verifierAlias} ·{' '}
        provider {readiness.models.provider}
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        {readiness.models.decisionIdentity ?? 'canonical identity unavailable'} →{' '}
        {readiness.models.verifierIdentity ?? 'canonical identity unavailable'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        Evidence {evidenceStart} – {evidenceEnd} · {readiness.evidence.eligibleRuns} qualified /{' '}
        {readiness.evidence.threshold} required
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        Agreement ≥ {Math.round(readiness.evidence.minimumAgreement * 100)}% · abstention ≤{' '}
        {Math.round(readiness.evidence.maximumAbstentionRate * 100)}% · errors ≤{' '}
        {Math.round(readiness.evidence.maximumErrorRate * 100)}%
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        Policy {readiness.policy.policyAccepted ? 'accepted' : 'not accepted'} · configuration{' '}
        {readiness.policy.configurationAccepted ? 'accepted' : 'not accepted'} · model binding{' '}
        {readiness.policy.modelBindingAccepted ? 'accepted' : 'not accepted'}
      </div>
      {readiness.state.pauseMessage && (
        <div role="status" style={{ fontSize: 12, color: 'var(--amT)', marginTop: 5 }}>
          Pause reason: {readiness.state.pauseMessage}
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
        Last live action:{' '}
        {readiness.lastAction === null
          ? 'none'
          : `${OUTCOME_LABEL[readiness.lastAction.outcome]} · ${readiness.lastAction.at}`}
      </div>
      <ul aria-label="Live readiness gates" style={{ padding: 0, margin: '10px 0 0' }}>
        {readiness.gates.map((gate) => (
          <li
            key={gate.code}
            style={{ listStyle: 'none', fontSize: compact ? 11.5 : 12, marginTop: 4 }}
          >
            <span style={{ color: gate.ok ? 'var(--okT)' : 'var(--erT)' }}>
              {gate.ok ? 'Ready' : 'Blocked'}
            </span>
            {' · '}
            {gate.code.replaceAll('_', ' ')}
            {' · '}
            {gate.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AutopilotCard({
  companyId,
  companyName,
  role,
}: {
  companyId: string;
  companyName: string;
  role: Exclude<Role, 'viewer'>;
}) {
  const { toast } = useApp();
  const [state, setState] = useState<AutopilotOverviewDto | null>(null);
  const [runs, setRuns] = useState<AutopilotRunDto[]>([]);
  const [readiness, setReadiness] = useState<LiveReadinessDto | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [enabling, setEnabling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [reconcilingOperationId, setReconcilingOperationId] = useState<string | null>(null);
  const [inProgressOperationId, setInProgressOperationId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const reconciliationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAdmin = role === 'admin';

  useEffect(() => {
    if (reconciliationTimerRef.current !== null) {
      clearTimeout(reconciliationTimerRef.current);
      reconciliationTimerRef.current = null;
    }
    const generation = ++generationRef.current;
    let cancelled = false;
    setState(null);
    setRuns([]);
    setReadiness(null);
    setLoadingError(null);
    setSaving(false);
    setCancelling(false);
    setConfirmation('');
    setEnabling(false);
    setPausing(false);
    setReconcilingOperationId(null);
    setInProgressOperationId(null);
    Promise.all([
      autopilot.get(companyId),
      autopilot.listRuns(companyId, { limit: 10 }),
      autopilot.getReadiness(companyId),
    ])
      .then(([nextState, page, nextReadiness]) => {
        if (cancelled || generationRef.current !== generation) return;
        setState(nextState);
        setRuns(page.runs);
        setReadiness(nextReadiness);
      })
      .catch((error) => {
        if (!cancelled && generationRef.current === generation) {
          setLoadingError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
      if (reconciliationTimerRef.current !== null) {
        clearTimeout(reconciliationTimerRef.current);
        reconciliationTimerRef.current = null;
      }
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [companyId]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || saving) return;
    const generation = generationRef.current;
    setSaving(true);
    try {
      const updated = await autopilot.patch(companyId, settingsPatch(new FormData(event.currentTarget)));
      if (generationRef.current !== generation) return;
      setState((current) => current === null ? current : {
        ...current,
        settings: updated,
        liveWrites: {
          ...current.liveWrites,
          limit: updated.dailyLiveWriteLimit,
        },
      });
      toast('Shadow autopilot settings saved');
    } catch (error) {
      if (generationRef.current === generation) toast(errorMessage(error));
    } finally {
      if (generationRef.current === generation) setSaving(false);
    }
  };

  const cancelQueued = async () => {
    if (cancelling) return;
    const generation = generationRef.current;
    setCancelling(true);
    try {
      const result = await autopilot.cancelQueued(companyId);
      if (generationRef.current !== generation) return;
      setState((current) => current === null
        ? current
        : {
            ...current,
            queue: {
              ...current.queue,
              queued: 0,
              retrying: 0,
              cancelled: current.queue.cancelled + result.cancelled,
              earliestDueAt: null,
            },
          });
      toast(`${result.cancelled} queued shadow job${result.cancelled === 1 ? '' : 's'} cancelled`);
    } catch (error) {
      if (generationRef.current === generation) toast(errorMessage(error));
    } finally {
      if (generationRef.current === generation) setCancelling(false);
    }
  };

  const enableLive = async () => {
    if (
      readiness === null
      || confirmation !== companyName
      || enabling
    ) return;
    const generation = generationRef.current;
    setEnabling(true);
    try {
      const next = await autopilot.enableLive(companyId, {
        confirmation,
        acceptedPolicyVersion: readiness.policyVersion,
      });
      if (generationRef.current !== generation) return;
      setReadiness(next);
      setConfirmation('');
      if (next.state.enabled && next.gates.every((gate) => gate.ok)) {
        toast('Live mode enabled');
      } else if (next.state.paused) {
        toast('Live mode remains paused');
      } else {
        toast('Live mode was not enabled');
      }
    } catch {
      if (generationRef.current === generation) toast('Could not enable live mode');
    } finally {
      if (generationRef.current === generation) setEnabling(false);
    }
  };

  const pauseLive = async () => {
    if (pausing) return;
    const generation = generationRef.current;
    setPausing(true);
    try {
      const ack = await autopilot.pauseLive(companyId);
      if (generationRef.current !== generation) return;
      setReadiness((current) => current === null
        ? current
        : {
            ...current,
            state: ack,
          });
      try {
        const next = await autopilot.getReadiness(companyId);
        if (generationRef.current !== generation) return;
        setReadiness(next);
        toast(ack.paused ? 'Live mode paused' : 'Live mode was not active');
      } catch {
        if (generationRef.current === generation) {
          toast('Could not refresh live mode status');
        }
      }
    } catch {
      if (generationRef.current === generation) toast('Could not pause live mode');
    } finally {
      if (generationRef.current === generation) setPausing(false);
    }
  };

  const reconcileLive = async (operationId: string) => {
    if (reconcilingOperationId !== null || inProgressOperationId === operationId) return;
    const generation = generationRef.current;
    setReconcilingOperationId(operationId);
    let result: Awaited<ReturnType<typeof autopilot.reconcileLive>>;
    try {
      result = await autopilot.reconcileLive(companyId, operationId);
    } catch {
      if (generationRef.current === generation) {
        toast('Could not reconcile live operation');
      }
      if (generationRef.current === generation) setReconcilingOperationId(null);
      return;
    }
    try {
      if (generationRef.current !== generation) return;
      if (result.outcome === 'IN_PROGRESS') {
        setInProgressOperationId(operationId);
        void pollReconciliation(operationId, generation, 0);
      } else {
        try {
          await refreshReconciliationTruth(generation);
        } catch {
          if (generationRef.current === generation) {
            toast('Could not refresh reconciliation status');
          }
        }
      }
    } finally {
      if (generationRef.current === generation) setReconcilingOperationId(null);
    }
  };

  const refreshReconciliationTruth = async (
    generation: number,
  ): Promise<AutopilotRunDto[] | null> => {
    const [nextState, page, nextReadiness] = await Promise.all([
      autopilot.get(companyId),
      autopilot.listRuns(companyId, { limit: 10 }),
      autopilot.getReadiness(companyId),
    ]);
    if (generationRef.current !== generation) return null;
    setState(nextState);
    setRuns(page.runs);
    setReadiness(nextReadiness);
    return page.runs;
  };

  const pollReconciliation = async (
    operationId: string,
    generation: number,
    pollCount: number,
  ): Promise<void> => {
    if (generationRef.current !== generation) return;
    try {
      const refreshedRuns = await refreshReconciliationTruth(generation);
      if (refreshedRuns === null || generationRef.current !== generation) return;
      const operation = refreshedRuns.find((run) => run.id === operationId);
      if (
        operation !== undefined
        && operation.operationId === null
        && operation.outcome !== 'in_progress'
        && operation.outcome !== 'retrying'
        && operation.outcome !== 'possible_write_uncertain'
        && operation.outcome !== 'readback_mismatch'
      ) {
        setInProgressOperationId((current) =>
          current === operationId ? null : current);
        return;
      }
    } catch {
      if (generationRef.current !== generation) return;
    }
    if (pollCount + 1 >= RECONCILIATION_MAX_POLLS) return;
    reconciliationTimerRef.current = setTimeout(() => {
      reconciliationTimerRef.current = null;
      void pollReconciliation(operationId, generation, pollCount + 1);
    }, RECONCILIATION_POLL_INTERVAL_MS);
  };

  if (loadingError) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Shadow autopilot</div>
        <div role="alert" style={{ color: 'var(--erT)', marginTop: 6, fontSize: 13 }}>
          {loadingError}
        </div>
      </div>
    );
  }
  if (state === null || readiness === null) {
    return (
      <div style={cardStyle} aria-busy="true">
        <div style={{ fontSize: 15, fontWeight: 600 }}>Shadow autopilot</div>
        <div style={{ color: 'var(--mut)', marginTop: 6, fontSize: 13 }}>Loading operations…</div>
      </div>
    );
  }

  const { settings, queue } = state;
  return (
    <section style={cardStyle} aria-labelledby="autopilot-title">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 18,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 360px' }}>
          <div id="autopilot-title" style={{ fontSize: 15, fontWeight: 600 }}>
            Shadow autopilot
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
            Evaluates pending transactions in the background for inspection only. Shadow results
            cannot categorize or change QuickBooks.
          </div>
          <VerifierGuide />
          <div style={{ fontSize: 12, color: 'var(--fnt)', marginTop: 7 }}>
            Same-model results never count toward the evidence threshold; only qualified
            distinct-model outcomes do.
          </div>
        </div>
        <EvidenceProgress state={state} />
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 16,
          padding: '10px 12px',
          background: 'var(--hl)',
          borderRadius: 8,
          fontSize: 12.5,
          color: 'var(--mut)',
        }}
      >
        <span>{settings.mode === 'shadow' ? 'Shadow enabled' : 'Shadow off'}</span>
        <span>{queue.queued} queued</span>
        <span>{queue.running} running</span>
        <span>{queue.retrying} retrying</span>
        <span>{queue.terminal} terminal</span>
        <span>{queue.cancelled} cancelled</span>
        <span>
          {state.liveWrites.used} of {state.liveWrites.limit} live writes used today (UTC)
        </span>
        {queue.earliestLeaseExpiryAt && (
          <span>
            Earliest lease expiry{' '}
            {new Date(queue.earliestLeaseExpiryAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <LiveReadiness readiness={readiness} />

      {isAdmin && (
        <div
          aria-label="Live mode controls"
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 8,
            padding: 12,
            marginTop: 12,
            display: 'grid',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
            Enabling reruns every durable and credential-backed gate. Type the exact legal company
            name and accept the displayed policy.
          </div>
          <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
            Type company name
            <input
              className="input"
              aria-label="Type company name"
              value={confirmation}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn-ghost"
              type="button"
              disabled={confirmation !== companyName || enabling}
              onClick={() => void enableLive()}
            >
              {enabling ? 'Enabling live mode…' : 'Enable live mode'}
            </button>
            <button
              className="btn-ghost"
              type="button"
              disabled={pausing}
              onClick={() => void pauseLive()}
            >
              {pausing ? 'Pausing live mode…' : 'Pause live mode'}
            </button>
          </div>
        </div>
      )}

      {isAdmin ? (
        <form key={settings.configVersion} onSubmit={(event) => void save(event)} style={{ marginTop: 18 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: 10,
            }}
          >
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Mode
              <select className="select" name="mode" defaultValue={settings.mode}>
                <option value="off">Off</option>
                <option value="shadow">Shadow</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Provider
              <select className="select" name="provider" defaultValue={settings.provider}>
                <option value="custom">Custom</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Decision model
              <input
                className="input"
                name="decisionModel"
                defaultValue={settings.decisionModel}
                maxLength={200}
                required
              />
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Verifier model
              <input
                className="input"
                name="verifierModel"
                defaultValue={settings.verifierModel}
                maxLength={200}
                required
              />
            </label>
            <Field
              label="Schedule (minutes)"
              name="scheduleMinutes"
              defaultValue={settings.scheduleMinutes}
              min={1}
              max={1_440}
            />
            <Field
              label="Company concurrency"
              name="companyConcurrency"
              defaultValue={settings.companyConcurrency}
              min={1}
              max={4}
            />
            <Field
              label="Evidence threshold"
              name="evidenceThreshold"
              defaultValue={settings.evidenceThreshold}
              min={25}
              max={1_000}
            />
            <Field
              label="Daily live writes (UTC)"
              name="dailyLiveWriteLimit"
              defaultValue={settings.dailyLiveWriteLimit}
              min={1}
              max={10_000}
            />
            <Field
              label="Tool-call limit"
              name="maxToolCalls"
              defaultValue={settings.limits.maxToolCalls}
              min={1}
              max={8}
            />
            <Field
              label="Turn limit"
              name="maxTurns"
              defaultValue={settings.limits.maxTurns}
              min={1}
              max={4}
            />
            <Field
              label="Context bytes"
              name="maxContextBytes"
              defaultValue={settings.limits.maxContextBytes}
              min={1}
              max={65_536}
            />
            <Field
              label="Response bytes"
              name="maxResponseBytes"
              defaultValue={settings.limits.maxResponseBytes}
              min={1}
              max={32_768}
            />
            <Field
              label="Timeout (ms)"
              name="timeoutMs"
              defaultValue={settings.limits.timeoutMs}
              min={1}
              max={30_000}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 14,
            }}
          >
            <button className="btn-ghost" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save shadow settings'}
            </button>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fnt)' }}>
                Running leases are not interrupted and run history is kept.
              </span>
              <button
                className="btn-ghost"
                type="button"
                disabled={cancelling}
                onClick={() => void cancelQueued()}
              >
                {cancelling ? 'Cancelling queued work…' : 'Cancel queued and retrying work'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div style={{ marginTop: 14, color: 'var(--fnt)', fontSize: 12.5 }}>
          Company administrators manage shadow scheduling and queue cancellation.
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Recent safe run summaries</div>
        {runs.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 7 }}>
            No shadow runs yet.
          </div>
        ) : (
          <LiveRunHistory
            runs={runs}
            canReconcile={isAdmin}
            reconcilingOperationId={reconcilingOperationId}
            inProgressOperationId={inProgressOperationId}
            onReconcile={(operationId) => void reconcileLive(operationId)}
            label="Recent autopilot runs"
          />
        )}
      </div>
    </section>
  );
}

export function AutopilotQueueStatus({
  companyId,
  surface = 'queue',
}: {
  companyId: string;
  surface?: 'queue' | 'audit';
}) {
  const [state, setState] = useState<AutopilotOverviewDto | null>(null);
  const [readiness, setReadiness] = useState<LiveReadinessDto | null>(null);
  const [runs, setRuns] = useState<AutopilotRunDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expanded, setExpanded] = useState(surface === 'audit');
  const detailsId = useId();
  const generationRef = useRef(0);

  // A paused live mode, or a run that stopped before writing, has to reach the
  // operator whether or not the panel is expanded. Prefer the pause reason:
  // it persists, where a run error is a single event.
  const blockingNotice: string | null = (() => {
    if (readiness?.state.paused) {
      return readiness.state.pauseMessage ?? 'Live mode paused';
    }
    const stopped = runs.find((run) => run.errorCode);
    return stopped?.errorCode ? runErrorLabel(stopped.errorCode) : null;
  })();

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    setState(null);
    setReadiness(null);
    setRuns([]);
    setNextCursor(null);
    setLoadingOlder(false);
    setExpanded(surface === 'audit');
    Promise.all([
      autopilot.get(companyId),
      autopilot.listRuns(companyId, { limit: 5 })
        .catch(() => ({ runs: [], nextCursor: null })),
      autopilot.getReadiness(companyId),
    ])
      .then(([nextState, page, nextReadiness]) => {
        if (cancelled || generationRef.current !== generation) return;
        setState(nextState);
        setReadiness(nextReadiness);
        setRuns(page.runs);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        // Queue operations are supplementary; categorization remains available.
      });
    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [companyId, surface]);

  const loadOlder = async () => {
    if (nextCursor === null || loadingOlder) return;
    const generation = generationRef.current;
    setLoadingOlder(true);
    try {
      const page = await autopilot.listRuns(companyId, { limit: 5, cursor: nextCursor });
      if (generationRef.current !== generation) return;
      setRuns((current) => {
        const ids = new Set(current.map((run) => run.id));
        return [...current, ...page.runs.filter((run) => !ids.has(run.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the current page and cursor so a supplementary history read can be retried.
    } finally {
      if (generationRef.current === generation) setLoadingOlder(false);
    }
  };

  if (state === null || readiness === null) return null;
  return (
    <aside
      aria-label={`${surface === 'audit' ? 'Audit' : 'Queue'} live autopilot status`}
      style={{
        ...cardStyle,
        padding: '12px 16px',
        marginBottom: 14,
        display: 'grid',
        gap: 12,
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${expanded ? 'Hide' : 'Show'} Shadow Autopilot details`}
        onClick={() => setExpanded((current) => !current)}
        style={{
          appearance: 'none',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          padding: 0,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                color: 'var(--mut)',
                display: 'inline-block',
                fontSize: 14,
                lineHeight: '20px',
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 120ms ease',
              }}
            >
              ▸
            </span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Shadow autopilot</div>
              <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                {state.queue.queued} queued · {state.queue.running} running ·{' '}
                {state.queue.retrying} retrying
              </div>
            </div>
          </div>
          <EvidenceProgress state={state} />
        </div>
      </button>
      {blockingNotice !== null && (
        // Collapsing the panel must not hide a stop. A paused live mode or a
        // run that halted before writing is exactly what the operator needs to
        // see on the queue surface, where the panel starts collapsed.
        <div
          role="status"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--erT)',
            background: 'var(--erB)',
            border: '1px solid var(--erD)',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          {blockingNotice}
        </div>
      )}
      <div
        id={detailsId}
        hidden={!expanded}
        style={{ display: expanded ? 'grid' : undefined, gap: 12 }}
      >
        <LiveReadiness readiness={readiness} compact />
        {runs.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>No shadow runs yet.</div>
        ) : (
          <LiveRunHistory runs={runs} label="Recent autopilot runs" />
        )}
        {nextCursor !== null && (
          <button
            className="btn-ghost"
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            style={{ justifySelf: 'start' }}
          >
            {loadingOlder ? 'Loading older runs…' : 'Load older runs'}
          </button>
        )}
      </div>
    </aside>
  );
}
