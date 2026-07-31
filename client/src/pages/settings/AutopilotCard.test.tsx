import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveReadinessDto,
  AutopilotOverviewDto,
  AutopilotRunListDto,
} from '../../lib/api';

const mocks = vi.hoisted(() => ({
  cancelQueued: vi.fn(),
  enableLive: vi.fn(),
  get: vi.fn(),
  getReadiness: vi.fn(),
  listRuns: vi.fn(),
  patch: vi.fn(),
  pauseLive: vi.fn(),
  reconcileLive: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  autopilot: {
    cancelQueued: mocks.cancelQueued,
    enableLive: mocks.enableLive,
    get: mocks.get,
    getReadiness: mocks.getReadiness,
    listRuns: mocks.listRuns,
    patch: mocks.patch,
    pauseLive: mocks.pauseLive,
    reconcileLive: mocks.reconcileLive,
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({ toast: mocks.toast }),
}));

import AutopilotCard, {
  AutopilotQueueStatus,
  LiveRunHistory,
} from './AutopilotCard';

const CONFIG_VERSION = 'a'.repeat(64);
const SECOND_CONFIG_VERSION = 'b'.repeat(64);
const LIVE_POLICY_VERSION = 'recat-live-purchase-v1';

const readiness: LiveReadinessDto = {
  policyVersion: LIVE_POLICY_VERSION,
  gates: [
    { code: 'SHADOW_MODE_UNHEALTHY', ok: true, message: 'Ready.' },
    { code: 'EVIDENCE_INSUFFICIENT', ok: true, message: 'Ready.' },
    { code: 'SHADOW_AGREEMENT_INSUFFICIENT', ok: true, message: 'Ready.' },
    { code: 'SHADOW_ABSTENTION_EXCESSIVE', ok: true, message: 'Ready.' },
    { code: 'SHADOW_ERROR_RATE_EXCESSIVE', ok: true, message: 'Ready.' },
    { code: 'VERIFIER_NOT_DISTINCT', ok: true, message: 'Ready.' },
    { code: 'PROVIDER_UNHEALTHY', ok: true, message: 'Ready.' },
    { code: 'TAX_REFERENCE_STALE', ok: true, message: 'Ready.' },
    { code: 'QBO_DISCONNECTED', ok: true, message: 'Ready.' },
    { code: 'WRITEBACK_DISABLED', ok: true, message: 'Ready.' },
    { code: 'UNRESOLVED_MUTATION', ok: true, message: 'Ready.' },
    { code: 'WORKER_UNHEALTHY', ok: true, message: 'Ready.' },
    { code: 'LIVE_POLICY_NOT_ACCEPTED', ok: true, message: 'Ready.' },
  ],
  evidence: {
    completedSince: '2026-06-29T10:00:00.000Z',
    completedThrough: '2026-07-29T10:00:00.000Z',
    eligibleRuns: 50,
    threshold: 50,
    minimumAgreement: 0.98,
    maximumAbstentionRate: 0.25,
    maximumErrorRate: 0.05,
  },
  models: {
    provider: 'custom',
    decisionAlias: 'decision-model',
    verifierAlias: 'verifier-model',
    decisionIdentity: 'provider/decision-v1',
    verifierIdentity: 'provider/verifier-v1',
  },
  policy: {
    supportedEntities: ['Purchase'],
    minimumConfidence: 0.9,
    policyAccepted: true,
    configurationAccepted: true,
    modelBindingAccepted: true,
  },
  state: {
    liveRequested: true,
    enabled: true,
    paused: false,
    pauseCode: null,
    pauseMessage: null,
  },
  lastAction: {
    outcome: 'posted_verified',
    at: '2026-07-29T10:00:00.250Z',
  },
};

const overview: AutopilotOverviewDto = {
  settings: {
    mode: 'shadow',
    provider: 'custom',
    decisionModel: 'decision-model',
    verifierModel: 'verifier-model',
    scheduleMinutes: 10,
    companyConcurrency: 1,
    evidenceThreshold: 50,
    dailyLiveWriteLimit: 100,
    limits: {
      maxToolCalls: 8,
      maxTurns: 4,
      maxContextBytes: 65_536,
      maxResponseBytes: 32_768,
      timeoutMs: 30_000,
    },
    configVersion: CONFIG_VERSION,
  },
  liveWrites: {
    utcDay: '2026-08-02',
    used: 0,
    limit: 100,
  },
  queue: {
    queued: 3,
    running: 1,
    retrying: 1,
    terminal: 0,
    cancelled: 2,
    earliestDueAt: '2026-07-29T09:00:00.000Z',
    earliestLeaseExpiryAt: '2026-07-29T10:01:00.000Z',
  },
  evidence: {
    eligibleRuns: 12,
    agreements: 10,
    disagreements: 2,
    threshold: 50,
    thresholdMet: false,
  },
};

const secondOverview: AutopilotOverviewDto = {
  ...overview,
  settings: {
    ...overview.settings,
    decisionModel: 'company-2-decision',
    verifierModel: 'company-2-verifier',
    configVersion: SECOND_CONFIG_VERSION,
  },
  queue: {
    ...overview.queue,
    queued: 9,
    running: 0,
    retrying: 0,
    cancelled: 7,
  },
  evidence: {
    ...overview.evidence,
    eligibleRuns: 4,
    agreements: 4,
    disagreements: 0,
  },
};

const runs: AutopilotRunListDto = {
  runs: [
    {
      id: 'run-1',
      status: 'verified',
      outcome: 'shadow_verified',
      operationId: null,
      attemptCount: 1,
      configVersion: CONFIG_VERSION,
      proposal: {
        kind: 'proposal',
        taxCalculation: 'TaxInclusive',
        confidence: 0.9,
        lineCount: 1,
        evidenceKinds: ['rule'],
      },
      verification: {
        diagnosticCode: 'AGENT_RUN_VERIFIED',
        verifierKind: 'same_model',
        evidence: null,
      },
      models: {
        decision: 'decision-model',
        verifier: 'decision-model',
        promptVersion: 'agent-model-v1',
        schemaVersion: '1',
      },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      timing: {
        durationMs: 250,
        createdAt: '2026-07-29T10:00:00.000Z',
        completedAt: '2026-07-29T10:00:00.250Z',
      },
      errorCode: null,
    },
  ],
  nextCursor: 'opaque-next-cursor',
};

const olderRuns: AutopilotRunListDto = {
  runs: [{
    ...runs.runs[0]!,
    id: 'run-older',
    status: 'failed',
    outcome: 'failed_before_write',
    proposal: { kind: 'abstain', reasonCode: 'PROVIDER_FAILURE' },
    verification: {
      diagnosticCode: 'AGENT_RUN_ABANDONED',
      verifierKind: 'unavailable',
      evidence: null,
    },
    timing: {
      durationMs: null,
      createdAt: '2026-07-29T09:00:00.000Z',
      completedAt: '2026-07-29T09:01:00.000Z',
    },
  }],
  nextCursor: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(overview);
  mocks.getReadiness.mockResolvedValue(readiness);
  mocks.listRuns.mockResolvedValue(runs);
  mocks.patch.mockResolvedValue(overview.settings);
  mocks.cancelQueued.mockResolvedValue({ cancelled: 4 });
  mocks.enableLive.mockResolvedValue(readiness);
  mocks.pauseLive.mockResolvedValue({
    liveRequested: true,
    enabled: false,
    paused: true,
    pauseCode: 'MANUAL_PAUSE',
    pauseMessage: 'Live mode is paused by a company administrator.',
  });
  mocks.reconcileLive.mockResolvedValue({
    ok: false,
    status: 'POSTING',
    outcome: 'IN_PROGRESS',
    error: {
      code: 'MUTATION_IN_PROGRESS',
      message: 'Reconciliation is already in progress.',
    },
  });
});

describe('AutopilotCard', () => {
  it('shows health, progress, verifier kinds, and no shadow mutation action', async () => {
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="categorizer"
      />,
    );

    expect(await screen.findByText('Same-model critique')).toBeInTheDocument();
    expect(screen.getByText(/0 of 100 live writes used today \(UTC\)/i)).toBeInTheDocument();
    expect(screen.getByText('Shadow autopilot')).toBeInTheDocument();
    expect(screen.getByText('Deterministic checks')).toBeInTheDocument();
    expect(screen.getByText('Distinct-model review')).toBeInTheDocument();
    expect(screen.getByText(/same-model results never count toward the evidence threshold/i))
      .toBeInTheDocument();
    expect(screen.getByText(/12 of 50 qualified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText('2 cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|approve|post|stage|write/i }))
      .not.toBeInTheDocument();
  });

  it('lets an admin save bounded settings and explicitly cancel only queued work', async () => {
    mocks.patch.mockResolvedValueOnce({
      ...overview.settings,
      evidenceThreshold: 75,
      dailyLiveWriteLimit: 250,
    });
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await screen.findByLabelText('Evidence threshold');
    expect(screen.getByLabelText('Daily live writes (UTC)')).toHaveValue(100);
    await user.clear(screen.getByLabelText('Evidence threshold'));
    await user.type(screen.getByLabelText('Evidence threshold'), '75');
    await user.clear(screen.getByLabelText('Daily live writes (UTC)'));
    await user.type(screen.getByLabelText('Daily live writes (UTC)'), '250');
    await user.click(screen.getByRole('button', { name: 'Save shadow settings' }));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({ evidenceThreshold: 75, dailyLiveWriteLimit: 250 }),
    ));
    expect(screen.getByText(/0 of 250 live writes used today \(UTC\)/i)).toBeInTheDocument();

    expect(screen.getByText(/running leases are not interrupted and run history is kept/i))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel queued and retrying work' }));
    await waitFor(() => expect(mocks.cancelQueued).toHaveBeenCalledWith('company-1'));
  });

  it('keeps settings and cancellation read-only for categorizers', async () => {
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="categorizer"
      />,
    );

    await screen.findByText('Shadow autopilot');
    expect(screen.queryByRole('button', { name: 'Save shadow settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel queued and retrying work' }))
      .not.toBeInTheDocument();
  });

  it('ignores stale save and cancellation responses after the company changes', async () => {
    const pendingSave = deferred<typeof overview.settings>();
    const pendingCancel = deferred<{ cancelled: number }>();
    mocks.get.mockImplementation(async (companyId: string) =>
      companyId === 'company-1' ? overview : secondOverview);
    mocks.listRuns.mockResolvedValue({ runs: [], nextCursor: null });
    mocks.patch.mockReturnValueOnce(pendingSave.promise);
    mocks.cancelQueued.mockReturnValueOnce(pendingCancel.promise);
    const view = render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await screen.findByDisplayValue('decision-model');
    await user.click(screen.getByRole('button', { name: 'Save shadow settings' }));
    await user.click(screen.getByRole('button', { name: 'Cancel queued and retrying work' }));
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledWith('company-1', expect.any(Object));
      expect(mocks.cancelQueued).toHaveBeenCalledWith('company-1');
    });

    view.rerender(
      <AutopilotCard
        companyId="company-2"
        companyName="Second Company"
        role="admin"
      />,
    );
    expect(await screen.findByDisplayValue('company-2-decision')).toBeInTheDocument();
    expect(screen.getByText('9 queued')).toBeInTheDocument();
    expect(screen.getByText('7 cancelled')).toBeInTheDocument();

    await act(async () => {
      pendingSave.resolve({
        ...overview.settings,
        decisionModel: 'stale-old-decision',
      });
      pendingCancel.resolve({ cancelled: 4 });
    });

    expect(screen.getByDisplayValue('company-2-decision')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('stale-old-decision')).not.toBeInTheDocument();
    expect(screen.getByText('9 queued')).toBeInTheDocument();
    expect(screen.getByText('7 cancelled')).toBeInTheDocument();
  });

  it('requires typing the exact legal company name and accepts only the displayed policy', async () => {
    mocks.getReadiness.mockResolvedValue({
      ...readiness,
      state: {
        ...readiness.state,
        enabled: false,
        paused: true,
        pauseCode: 'MANUAL_PAUSE',
        pauseMessage: 'Live mode is paused by a company administrator.',
      },
    });
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    const confirmation = await screen.findByLabelText('Type company name');
    await user.type(confirmation, 'Generic');
    expect(screen.getByRole('button', { name: 'Enable live mode' })).toBeDisabled();
    await user.type(confirmation, ' Company');
    expect(screen.getByRole('button', { name: 'Enable live mode' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Enable live mode' }));

    await waitFor(() => expect(mocks.enableLive).toHaveBeenCalledWith(
      'company-1',
      {
        confirmation: 'Generic Company',
        acceptedPolicyVersion: LIVE_POLICY_VERSION,
      },
    ));
  });

  it('renders every live gate and exact safe policy, model, evidence, and support disclosure', async () => {
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="categorizer"
      />,
    );

    expect(await screen.findByText(`Policy ${LIVE_POLICY_VERSION}`)).toBeVisible();
    expect(screen.getByText(/Purchase only · Minimum confidence 90%/i)).toBeVisible();
    expect(screen.getByText(/decision-model → verifier-model/i)).toBeVisible();
    expect(screen.getByText(/provider\/decision-v1 → provider\/verifier-v1/i)).toBeVisible();
    expect(screen.getByText(/Jun 29, 2026/i)).toBeVisible();
    expect(screen.getByText(/50 qualified \/ 50 required/i)).toBeVisible();
    const gateList = screen.getByRole('list', { name: 'Live readiness gates' });
    for (const gate of readiness.gates) {
      expect(gateList).toHaveTextContent(gate.code.replaceAll('_', ' '));
    }
    expect(screen.queryByRole('button', { name: 'Enable live mode' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause live mode' }))
      .not.toBeInTheDocument();
  });

  it('provides an admin kill switch and restores safe generic button state after failure', async () => {
    mocks.pauseLive.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_RAW_ERROR'));
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pause live mode' }));

    await waitFor(() => expect(mocks.pauseLive).toHaveBeenCalledWith('company-1'));
    expect(screen.getByRole('button', { name: 'Pause live mode' })).toBeEnabled();
    expect(mocks.toast).toHaveBeenCalledWith('Could not pause live mode');
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE_PROVIDER_RAW_ERROR');
  });

  it('does not report pause failure after the pause ACK when only readiness refresh fails', async () => {
    mocks.getReadiness
      .mockResolvedValueOnce(readiness)
      .mockRejectedValueOnce(new Error('PRIVATE_REFRESH_ERROR'));
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pause live mode' }));

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith('Could not refresh live mode status');
    });
    expect(mocks.toast).not.toHaveBeenCalledWith('Could not pause live mode');
  });

  it('renders the exact stronger pause ACK when the advisory readiness refresh fails', async () => {
    mocks.pauseLive.mockResolvedValueOnce({
      liveRequested: true,
      enabled: false,
      paused: true,
      pauseCode: 'UNCERTAIN_MUTATION',
      pauseMessage: 'Live mode is paused: A live mutation requires reconciliation.',
    });
    mocks.getReadiness
      .mockResolvedValueOnce(readiness)
      .mockRejectedValueOnce(new Error('PRIVATE_REFRESH_ERROR'));
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pause live mode' }));

    expect(await screen.findByText(
      'Pause reason: Live mode is paused: A live mutation requires reconciliation.',
    )).toBeVisible();
    expect(screen.queryByText(/paused by a company administrator/i)).not.toBeInTheDocument();
  });

  it('does not invent a pause when live was not requested and the refresh fails', async () => {
    mocks.pauseLive.mockResolvedValueOnce({
      liveRequested: false,
      enabled: false,
      paused: false,
      pauseCode: null,
      pauseMessage: null,
    });
    mocks.getReadiness
      .mockResolvedValueOnce(readiness)
      .mockRejectedValueOnce(new Error('PRIVATE_REFRESH_ERROR'));
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pause live mode' }));

    expect(await screen.findByText('Live mode not enabled')).toBeVisible();
    expect(screen.queryByText(/Pause reason:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/MANUAL_PAUSE|paused by a company administrator/i))
      .not.toBeInTheDocument();
  });

  it('ignores a stale enable response after the company changes', async () => {
    const pendingEnable = deferred<LiveReadinessDto>();
    mocks.get.mockImplementation(async (companyId: string) =>
      companyId === 'company-1' ? overview : secondOverview);
    mocks.getReadiness.mockImplementation(async (companyId: string) => ({
      ...readiness,
      models: {
        ...readiness.models,
        decisionAlias: companyId === 'company-1'
          ? 'decision-model'
          : 'company-2-decision',
      },
      state: {
        ...readiness.state,
        enabled: false,
        paused: true,
      },
    }));
    mocks.enableLive.mockReturnValueOnce(pendingEnable.promise);
    const view = render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Type company name'), 'Generic Company');
    await user.click(screen.getByRole('button', { name: 'Enable live mode' }));
    view.rerender(
      <AutopilotCard
        companyId="company-2"
        companyName="Second Company"
        role="admin"
      />,
    );
    expect(await screen.findByText(/company-2-decision → verifier-model/i)).toBeVisible();

    await act(async () => pendingEnable.resolve(readiness));

    expect(screen.getByText(/company-2-decision → verifier-model/i)).toBeVisible();
    expect(mocks.toast).not.toHaveBeenCalledWith('Live mode enabled');
  });

  it('does not report enabled when a successful enable response remains blocked and paused', async () => {
    const blocked = {
      ...readiness,
      gates: readiness.gates.map((gate) => gate.code === 'PROVIDER_UNHEALTHY'
        ? { ...gate, ok: false, message: 'Configured model health checks have not passed.' }
        : gate),
      state: {
        ...readiness.state,
        enabled: false,
        paused: true,
        pauseCode: 'PROVIDER_UNHEALTHY',
        pauseMessage: 'Live mode is paused: Agent provider health degraded.',
      },
    };
    mocks.getReadiness.mockResolvedValue(blocked);
    mocks.enableLive.mockResolvedValue(blocked);
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Type company name'), 'Generic Company');
    await user.click(screen.getByRole('button', { name: 'Enable live mode' }));

    expect(await screen.findByText('Live mode paused')).toBeVisible();
    expect(mocks.toast).not.toHaveBeenCalledWith('Live mode enabled');
    expect(mocks.toast).toHaveBeenCalledWith('Live mode remains paused');
  });
});

describe('LiveRunHistory', () => {
  const uncertainRun = {
    ...runs.runs[0]!,
    id: 'run-uncertain',
    status: 'uncertain' as const,
    outcome: 'possible_write_uncertain' as const,
    operationId: 'run-uncertain',
    verification: {
      diagnosticCode: 'LIVE_RECONCILIATION_REQUIRED',
      verifierKind: 'distinct_model' as const,
      evidence: null,
    },
  };

  it('renders possible-write ambiguity as uncertain, never posted', () => {
    render(<LiveRunHistory runs={[uncertainRun]} />);

    expect(screen.getByText('Outcome uncertain — verify in QuickBooks')).toBeVisible();
    expect(screen.queryByText(/posted successfully/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/posted and independently verified/i)).not.toBeInTheDocument();
  });

  it('renders every safe outcome label without collapsing unchanged, mismatch, or in-progress', () => {
    const outcomes = [
      ['shadow_proposed', 'Shadow proposal'],
      ['shadow_verified', 'Shadow proposal verified'],
      ['abstained', 'Abstained'],
      ['failed_before_write', 'Failed before write'],
      ['posted_verified', 'Posted and independently verified in QuickBooks'],
      ['possible_write_uncertain', 'Outcome uncertain — verify in QuickBooks'],
      ['readback_mismatch', 'QuickBooks readback mismatch — explicit review required'],
      ['reconciled_unchanged', 'Reconciled — QuickBooks unchanged'],
      ['reconciled_posted', 'Reconciled — posted and independently verified'],
      ['reverted', 'Reverted and independently verified'],
      ['retrying', 'Retrying'],
      ['in_progress', 'In progress'],
      ['dry_run', 'Dry run — nothing posted'],
      ['unavailable', 'Outcome unavailable'],
    ] as const;
    render(
      <LiveRunHistory
        runs={outcomes.map(([outcome], index) => ({
          ...runs.runs[0]!,
          id: `run-outcome-${index}`,
          outcome,
          operationId: null,
        }))}
      />,
    );

    for (const [, label] of outcomes) expect(screen.getByText(label)).toBeVisible();
  });

  it('disables duplicate reconciliation, shows in progress, and refreshes server truth', async () => {
    const pending = deferred<{
      ok: boolean;
      status: 'POSTING';
      outcome: 'IN_PROGRESS';
    }>();
    mocks.reconcileLive.mockReturnValueOnce(pending.promise);
    mocks.listRuns.mockResolvedValue({
      runs: [uncertainRun],
      nextCursor: null,
    });
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Reconcile live operation' });

    await user.click(button);
    await user.click(button);

    expect(mocks.reconcileLive).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Reconciling…');

    await act(async () => pending.resolve({
      ok: false,
      status: 'POSTING',
      outcome: 'IN_PROGRESS',
    }));
    expect(await screen.findByText('Reconciliation in progress')).toBeVisible();
    await waitFor(() => {
      expect(mocks.getReadiness).toHaveBeenCalledTimes(2);
      expect(mocks.listRuns).toHaveBeenCalledTimes(2);
    });
  });

  it('boundedly polls authoritative history after IN_PROGRESS until terminal', async () => {
    const terminalRun = {
      ...uncertainRun,
      status: 'posted_verified' as const,
      outcome: 'reconciled_posted' as const,
      operationId: null,
    };
    const pausedReadiness = {
      ...readiness,
      state: {
        ...readiness.state,
        enabled: false,
        paused: true,
        pauseCode: 'UNCERTAIN_MUTATION',
        pauseMessage: 'A live mutation requires reconciliation.',
      },
    };
    mocks.getReadiness.mockResolvedValue(pausedReadiness);
    let historyReads = 0;
    mocks.listRuns.mockImplementation(async () => {
      historyReads += 1;
      return historyReads < 3
        ? { runs: [uncertainRun], nextCursor: null }
        : { runs: [terminalRun], nextCursor: null };
    });
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    const button = await screen.findByRole('button', { name: 'Reconcile live operation' });
    await user.click(button);
    await waitFor(() => {
      expect(mocks.listRuns).toHaveBeenCalledTimes(3);
    }, { timeout: 1_500 });
    expect(await screen.findByText('Reconciled — posted and independently verified')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText('Reconciliation in progress')).not.toBeInTheDocument();
    });
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/success|fail/i));
    expect(screen.getByText('Live mode paused')).toBeVisible();
  });

  it('stops bounded polling safely when authoritative history remains in progress', async () => {
    mocks.listRuns.mockResolvedValue({ runs: [uncertainRun], nextCursor: null });
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reconcile live operation' }));
    await waitFor(() => {
      expect(mocks.listRuns).toHaveBeenCalledTimes(9);
    }, { timeout: 2_500 });
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(mocks.listRuns).toHaveBeenCalledTimes(9);
    expect(screen.getByText('Reconciliation in progress')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconcile live operation' })).toBeDisabled();
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/success|fail/i));
  });

  it('cancels reconciliation polling when the selected company changes', async () => {
    mocks.listRuns.mockImplementation(async (companyId: string) => (
      companyId === 'company-1'
        ? { runs: [uncertainRun], nextCursor: null }
        : { runs: [], nextCursor: null }
    ));
    const view = render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reconcile live operation' }));
    await waitFor(() => {
      expect(mocks.listRuns.mock.calls.filter(([id]) => id === 'company-1')).toHaveLength(2);
    });
    view.rerender(
      <AutopilotCard
        companyId="company-2"
        companyName="Second Generic Company"
        role="admin"
      />,
    );
    await waitFor(() => {
      expect(mocks.listRuns).toHaveBeenCalledWith('company-2', { limit: 10 });
    });
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(mocks.listRuns.mock.calls.filter(([id]) => id === 'company-1')).toHaveLength(2);
    expect(screen.queryByText('Reconciliation in progress')).not.toBeInTheDocument();
  });

  it('does not report reconciliation failure after a terminal ACK when only refresh fails', async () => {
    mocks.reconcileLive.mockResolvedValueOnce({
      ok: true,
      status: 'POSTED',
      outcome: 'VERIFIED',
    });
    mocks.listRuns
      .mockResolvedValueOnce({ runs: [uncertainRun], nextCursor: null })
      .mockRejectedValueOnce(new Error('PRIVATE_REFRESH_ERROR'));
    render(
      <AutopilotCard
        companyId="company-1"
        companyName="Generic Company"
        role="admin"
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reconcile live operation' }));

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith('Could not refresh reconciliation status');
    });
    expect(mocks.toast).not.toHaveBeenCalledWith('Could not reconcile live operation');
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE_REFRESH_ERROR');
  });
});

describe('AutopilotQueueStatus', () => {
  it('renders the daily cap stop as a safe operator-facing message', async () => {
    mocks.listRuns.mockResolvedValueOnce({
      runs: [{
        ...runs.runs[0]!,
        status: 'failed',
        outcome: 'failed_before_write',
        errorCode: 'LIVE_DAILY_LIMIT_REACHED',
      }],
      nextCursor: null,
    });

    render(<AutopilotQueueStatus companyId="company-1" />);

    expect(await screen.findByText('Daily live-write limit reached')).toBeInTheDocument();
    expect(screen.queryByText('LIVE_DAILY_LIMIT_REACHED')).not.toBeInTheDocument();
  });

  it('keeps the summary visible while details are collapsed by default and toggle accessibly', async () => {
    render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    expect(await screen.findByText(/3 queued · 1 running · 1 retrying/i)).toBeInTheDocument();
    expect(screen.getByText(/12 of 50 qualified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText(/1 line proposal/i)).not.toBeVisible();

    const toggle = screen.getByRole('button', { name: 'Show Shadow Autopilot details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide Shadow Autopilot details' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(/1 line proposal/i)).toBeInTheDocument();
    expect(screen.getByText(/attempt 1/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`config ${CONFIG_VERSION}`))).toBeInTheDocument();
    expect(screen.getByText(/TaxInclusive · evidence rule/i)).toBeInTheDocument();
    expect(screen.getByText(/AGENT_RUN_VERIFIED/i)).toBeInTheDocument();
    expect(screen.getByText(/started 2026-07-29T10:00:00.000Z/i)).toBeInTheDocument();
    expect(screen.getByText(/completed 2026-07-29T10:00:00.250Z/i)).toBeInTheDocument();
    expect(screen.getByText(/input 100 · output 20 · total 120 tokens/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|approve|post|stage|write/i }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide Shadow Autopilot details' }));
    expect(screen.getByText(/1 line proposal/i)).not.toBeVisible();
  });

  it('keeps the audit surface expanded by default', async () => {
    render(<AutopilotQueueStatus companyId="company-1" surface="audit" />);

    expect(await screen.findByRole('button', { name: 'Hide Shadow Autopilot details' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/1 line proposal/i)).toBeVisible();
  });

  it('loads older run summaries through the opaque cursor without adding mutation controls', async () => {
    mocks.listRuns
      .mockResolvedValueOnce(runs)
      .mockResolvedValueOnce(olderRuns);
    render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Show Shadow Autopilot details' }));
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));

    await waitFor(() => expect(mocks.listRuns).toHaveBeenLastCalledWith(
      'company-1',
      { limit: 5, cursor: 'opaque-next-cursor' },
    ));
    expect(await screen.findByText(/Abstained · provider failure/i)).toBeInTheDocument();
    expect(screen.getByText(/Verification unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|approve|post|stage|write/i }))
      .not.toBeInTheDocument();
  });

  it('keeps older-run pagination retryable after a transient read failure', async () => {
    mocks.listRuns
      .mockResolvedValueOnce(runs)
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(olderRuns);
    render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Show Shadow Autopilot details' }));
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load older runs' }))
      .toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));

    expect(await screen.findByText(/Abstained · provider failure/i)).toBeInTheDocument();
    expect(mocks.listRuns).toHaveBeenCalledTimes(3);
  });

  it('keeps queue health visible when the supplementary initial history read fails', async () => {
    mocks.listRuns.mockRejectedValueOnce(new Error('temporary read failure'));

    render(<AutopilotQueueStatus companyId="company-1" />);

    expect(await screen.findByText(/3 queued · 1 running · 1 retrying/i)).toBeInTheDocument();
    expect(screen.getByText(/12 of 50 qualified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText('No shadow runs yet.')).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Show Shadow Autopilot details' }));
    expect(screen.getByText('No shadow runs yet.')).toBeInTheDocument();
  });

  it('ignores slow older-run pagination after the company changes', async () => {
    const pendingOlderRuns = deferred<AutopilotRunListDto>();
    mocks.get.mockImplementation(async (companyId: string) =>
      companyId === 'company-1' ? overview : secondOverview);
    mocks.listRuns.mockImplementation(async (
      companyId: string,
      params: { cursor?: string },
    ) => {
      if (companyId === 'company-1' && params.cursor !== undefined) {
        return pendingOlderRuns.promise;
      }
      return companyId === 'company-1'
        ? runs
        : { runs: [], nextCursor: null };
    });
    const view = render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Show Shadow Autopilot details' }));
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));
    await waitFor(() => expect(mocks.listRuns).toHaveBeenCalledWith(
      'company-1',
      { limit: 5, cursor: 'opaque-next-cursor' },
    ));

    view.rerender(<AutopilotQueueStatus companyId="company-2" />);
    expect(await screen.findByText(/9 queued · 0 running · 0 retrying/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Shadow Autopilot details' }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('No shadow runs yet.')).not.toBeVisible();

    await act(async () => pendingOlderRuns.resolve(olderRuns));

    expect(screen.queryByText(/Abstained · provider failure/i)).not.toBeInTheDocument();
    expect(screen.getByText('No shadow runs yet.')).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load older runs' })).not.toBeInTheDocument();
  });
});
