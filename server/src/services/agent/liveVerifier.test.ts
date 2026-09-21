import { describe, expect, it, vi } from 'vitest';
import { parseAgentDecision, type AgentDecision } from './core/decision.js';
import type { AgentModel, AgentModelIdentity } from './core/model.js';
import {
  buildAgentSnapshot,
  type AgentTransactionSnapshot,
} from './core/snapshot.js';
import { verifyAgentDecision } from './core/verifier.js';
import {
  LiveVerifierError,
  modelIdentity,
  probeAgentModel,
  verifyLiveDecision,
  type LiveAgentModel,
} from './liveVerifier.js';

const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';

function snapshot(): AgentTransactionSnapshot {
  return buildAgentSnapshot({
    transaction: { id: TRANSACTION_ID, revision: 4 },
    date: '2026-07-29',
    signedAmountCents: -1000,
    currency: 'XTS',
    sourceAccount: { displayName: 'Synthetic source', type: 'BANK' },
    payee: 'Synthetic counterparty',
    candidateCategories: [{ qboId: 'category-a', name: 'Category alpha' }],
    tax: {
      status: 'ready',
      supportedCalculationModes: ['TaxExcluded'],
      eligibleReferences: [{ qboId: 'tax-a', label: 'Reference alpha' }],
    },
    tags: [],
    rules: [],
    similarVerifiedTransactions: [{
      transactionId: '22222222-2222-4222-8222-222222222222',
      date: '2026-07-20',
      signedAmountCents: -1000,
      currency: 'XTS',
      payee: 'Synthetic history',
      taxCalculation: 'TaxExcluded',
      lines: [{
        signedGrossCents: -1000,
        categoryQboId: 'category-a',
        taxCodeQboId: 'tax-a',
        tagIds: [],
      }],
      tagIds: [],
      verifiedAt: '2026-07-21T00:00:00.000Z',
    }],
    featureVersion: 'shadow-core.1',
    configurationVersion: 'config-v1',
  });
}

function decision(): AgentDecision {
  return parseAgentDecision({
    decision: {
      kind: 'proposal',
      confidence: 0.95,
      taxCalculation: 'TaxExcluded',
      tagIds: [],
      evidence: [{
        kind: 'similar_transaction',
        transactionId: '22222222-2222-4222-8222-222222222222',
      }],
      rationale: 'Synthetic evidence.',
      lines: [{
        grossCents: -1000,
        categoryQboId: 'category-a',
        taxCodeQboId: 'tax-a',
        memo: null,
        tagIds: [],
      }],
    },
  });
}

function liveModel(options: {
  requested?: string;
  resolved?: string;
  authority?: string;
  review?: unknown;
  probe?: LiveAgentModel['probe'];
  reviewLiveDecision?: LiveAgentModel['reviewLiveDecision'];
} = {}): LiveAgentModel {
  const identity: AgentModelIdentity = {
    provider: 'custom',
    model: options.requested ?? 'requested-model',
  };
  return {
    identity,
    healthAuthority: options.authority ?? `authority:${identity.model}`,
    nextTurn: vi.fn<LiveAgentModel['nextTurn']>(),
    probe: options.probe ?? vi.fn<LiveAgentModel['probe']>(async () => ({
      identity: {
        provider: 'custom',
        model: options.resolved ?? identity.model,
      },
    })),
    reviewLiveDecision: options.reviewLiveDecision ?? vi.fn<LiveAgentModel['reviewLiveDecision']>(async () => ({
      identity: {
        provider: 'custom',
        model: options.resolved ?? identity.model,
      },
      rawReview: options.review ?? { approved: true, issues: [] },
    })),
  };
}

describe('live verifier identity and approval', () => {
  it('normalizes only a validated provider-returned identity', () => {
    const model = {
      identity: { provider: 'custom', model: '  Resolved/Model  ' },
      nextTurn: vi.fn<LiveAgentModel['nextTurn']>(),
    } satisfies AgentModel;

    expect(modelIdentity(model)).toBe('custom:resolved/model');
  });

  it('bypasses a successful cached probe when fresh authority is required', async () => {
    const model = liveModel({
      authority: 'opaque-fresh-authority',
      resolved: 'resolved/fresh',
    });

    await probeAgentModel(model, { authorityContext: 'binding-fresh' });
    await probeAgentModel(model, {
      authorityContext: 'binding-fresh',
      bypassSuccessCache: true,
    });

    expect(model.probe).toHaveBeenCalledTimes(2);
  });

  it('rejects aliases that resolve to the same provider/model identity', async () => {
    const decisionModel = liveModel({
      requested: 'decision-alias',
      resolved: 'Resolved/Shared',
    });
    const verifierModel = liveModel({
      requested: 'verifier-alias',
      resolved: ' resolved/shared ',
    });

    await expect(verifyLiveDecision({
      snapshot: snapshot(),
      decision: decision(),
    }, {
      decisionModel,
      verifierModel,
      timeoutMs: 100,
    })).rejects.toMatchObject({
      code: 'VERIFIER_NOT_DISTINCT',
      message: 'Live verifier model must be distinct.',
    });
    expect(verifierModel.reviewLiveDecision).not.toHaveBeenCalled();
  });

  it('preserves the complete deterministic proof after explicit approval', async () => {
    const input = { snapshot: snapshot(), decision: decision() };
    const result = await verifyLiveDecision(input, {
      decisionModel: liveModel({ requested: 'decision', resolved: 'resolved/decision' }),
      verifierModel: liveModel({ requested: 'verifier', resolved: 'resolved/verifier' }),
      timeoutMs: 100,
      authorityContext: 'binding-v1',
    });

    expect(result).toMatchObject({
      ...verifyAgentDecision(input.snapshot, input.decision),
      liveIdentityProof: {
        version: 1,
        providerBinding: 'binding-v1',
        decisionIdentity: 'custom:resolved/decision',
        verifierIdentity: 'custom:resolved/verifier',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('reviews one immutable snapshot and decision captured before provider awaits', async () => {
    const mutableSnapshot = structuredClone(snapshot());
    const mutableDecision = structuredClone(decision());
    let releaseProbe: ((value: { identity: AgentModelIdentity }) => void) | undefined;
    const decisionModel = liveModel({
      requested: 'decision',
      resolved: 'resolved/decision',
      authority: 'opaque-immutable-decision',
      probe: vi.fn<LiveAgentModel['probe']>(async () => new Promise((resolve) => {
        releaseProbe = resolve;
      })),
    });
    const reviewLiveDecision = vi.fn(async (input: {
      snapshot: AgentTransactionSnapshot;
      candidateDecision: AgentDecision;
    }) => ({
      identity: { provider: 'custom' as const, model: 'resolved/verifier' },
      rawReview: { approved: true, issues: [] },
      observed: input,
    }));
    const verifierModel = liveModel({
      requested: 'verifier',
      resolved: 'resolved/verifier',
      authority: 'opaque-immutable-verifier',
      reviewLiveDecision,
    });

    const verifying = verifyLiveDecision({
      snapshot: mutableSnapshot,
      decision: mutableDecision,
    }, {
      decisionModel,
      verifierModel,
      timeoutMs: 100,
    });
    await vi.waitFor(() => expect(decisionModel.probe).toHaveBeenCalledOnce());
    (mutableSnapshot as { payee: string }).payee = 'Changed after verification';
    const proposal = mutableDecision as Extract<AgentDecision, { kind: 'proposal' }>;
    proposal.lines[0]!.grossCents = -999;
    releaseProbe?.({ identity: { provider: 'custom', model: 'resolved/decision' } });
    await verifying;

    const reviewed = reviewLiveDecision.mock.calls[0]![0];
    expect(reviewed.snapshot.payee).toBe('Synthetic counterparty');
    expect((reviewed.candidateDecision as Extract<AgentDecision, { kind: 'proposal' }>)
      .lines[0]!.grossCents).toBe(-1000);
    expect(Object.isFrozen(reviewed.snapshot)).toBe(true);
    expect(Object.isFrozen(reviewed.candidateDecision)).toBe(true);
  });

  it('returns a fixed rejection without provider prose when approval is withheld', async () => {
    const result = await verifyLiveDecision({
      snapshot: snapshot(),
      decision: decision(),
    }, {
      decisionModel: liveModel({ requested: 'decision', resolved: 'resolved/decision' }),
      verifierModel: liveModel({
        requested: 'verifier',
        resolved: 'resolved/verifier',
        review: { approved: false, issues: ['DECISION_NOT_SUPPORTED'] },
      }),
      timeoutMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      code: 'AGENT_DISTINCT_REVIEW_REJECTED',
      message: 'Distinct live review did not approve the proposal.',
    });
    expect(JSON.stringify(result)).not.toContain('DECISION_NOT_SUPPORTED');
  });

  it('replaces provider failures with a fixed safe error', async () => {
    const providerProse = 'provider-private-prose-sentinel';
    await expect(verifyLiveDecision({
      snapshot: snapshot(),
      decision: decision(),
    }, {
      decisionModel: liveModel({ requested: 'decision', resolved: 'resolved/decision' }),
      verifierModel: liveModel({
        requested: 'verifier',
        resolved: 'resolved/verifier',
        reviewLiveDecision: vi.fn(async () => {
          throw new Error(providerProse);
        }),
      }),
      timeoutMs: 100,
    })).rejects.toEqual(expect.objectContaining({
      code: 'LIVE_VERIFIER_UNAVAILABLE',
      message: 'Live verifier request failed.',
    }));
  });

  it.each([
    [{ approved: true }],
    [{ approved: 'yes', issues: [] }],
    [{ approved: true, issues: ['UNKNOWN_ISSUE'] }],
    [{ approved: true, issues: [], unexpected: true }],
  ])('fails closed with a stable error for invalid review schema %#', async (rawReview) => {
    await expect(verifyLiveDecision({
      snapshot: snapshot(),
      decision: decision(),
    }, {
      decisionModel: liveModel({ requested: 'decision', resolved: 'resolved/decision' }),
      verifierModel: liveModel({
        requested: 'verifier',
        resolved: 'resolved/verifier',
        review: rawReview,
      }),
      timeoutMs: 100,
    })).rejects.toEqual(expect.objectContaining({
      code: 'LIVE_VERIFIER_RESPONSE_INVALID',
      message: 'Live verifier returned an invalid response.',
    }));
  });

  it('fails closed when the review response resolves to a different model', async () => {
    await expect(verifyLiveDecision({
      snapshot: snapshot(),
      decision: decision(),
    }, {
      decisionModel: liveModel({ requested: 'decision', resolved: 'resolved/decision' }),
      verifierModel: liveModel({
        requested: 'verifier',
        resolved: 'resolved/verifier',
        reviewLiveDecision: vi.fn<LiveAgentModel['reviewLiveDecision']>(async () => ({
          identity: { provider: 'custom', model: 'resolved/other' },
          rawReview: { approved: true, issues: [] },
        })),
      }),
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: 'LIVE_VERIFIER_IDENTITY_MISMATCH' });
  });

  it('uses a hard timeout even when a provider ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const promise = verifyLiveDecision({
        snapshot: snapshot(),
        decision: decision(),
      }, {
        decisionModel: liveModel({ requested: 'decision', resolved: 'resolved/decision' }),
        verifierModel: liveModel({
          requested: 'verifier',
          resolved: 'resolved/verifier',
          reviewLiveDecision: vi.fn(async () => new Promise<never>(() => undefined)),
        }),
        timeoutMs: 25,
      });
      const rejection = expect(promise).rejects.toMatchObject({
        code: 'LIVE_VERIFIER_TIMEOUT',
        message: 'Live verifier request timed out.',
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns deterministic failure without contacting either provider', async () => {
    const invalid = decision() as Extract<AgentDecision, { kind: 'proposal' }>;
    const malformed = { ...invalid, lines: [{ ...invalid.lines[0]!, grossCents: -999 }] };
    const decisionModel = liveModel();
    const verifierModel = liveModel({ requested: 'verifier' });

    const result = await verifyLiveDecision({
      snapshot: snapshot(),
      decision: malformed as Extract<AgentDecision, { kind: 'proposal' }>,
    }, {
      decisionModel,
      verifierModel,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ ok: false, code: 'AGENT_LINE_TOTAL_UNBALANCED' });
    expect(decisionModel.probe).not.toHaveBeenCalled();
    expect(verifierModel.probe).not.toHaveBeenCalled();
  });
});

describe('credential-bound model health', () => {
  it('shares one in-flight probe and caches only success for at most five minutes', async () => {
    let now = 1_000;
    let release: ((value: { identity: AgentModelIdentity }) => void) | undefined;
    const probe = vi.fn(async () => new Promise<{ identity: AgentModelIdentity }>((resolve) => {
      release = resolve;
    }));
    const model = liveModel({ authority: 'opaque-authority-cache', probe });
    const options = { now: () => now, timeoutMs: 100, successTtlMs: 300_000 };

    const first = probeAgentModel(model, options);
    const concurrent = probeAgentModel(model, options);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    release?.({ identity: { provider: 'custom', model: 'resolved/model' } });

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { identity: { provider: 'custom', model: 'resolved/model' } },
      { identity: { provider: 'custom', model: 'resolved/model' } },
    ]);
    await probeAgentModel(model, options);
    expect(probe).toHaveBeenCalledTimes(1);

    now += 300_001;
    const expired = probeAgentModel(model, options);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    release?.({ identity: { provider: 'custom', model: 'resolved/model' } });
    await expired;
  });

  it('does not let a longer shared probe defeat a shorter caller timeout', async () => {
    vi.useFakeTimers();
    try {
      const model = liveModel({
        authority: 'opaque-timeout-policy',
        probe: vi.fn(async () => new Promise<never>(() => undefined)),
      });
      const longer = probeAgentModel(model, { now: () => 1_000, timeoutMs: 100 });
      const shorter = probeAgentModel(model, { now: () => 1_000, timeoutMs: 10 });
      const longRejection = expect(longer).rejects.toMatchObject({
        code: 'MODEL_HEALTH_UNAVAILABLE',
      });
      const shortRejection = expect(shorter).rejects.toMatchObject({
        code: 'MODEL_HEALTH_UNAVAILABLE',
      });

      await vi.advanceTimersByTimeAsync(10);
      await shortRejection;
      expect(model.probe).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(90);
      await longRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not share cache entries across credential or endpoint authority', async () => {
    const first = liveModel({ authority: 'opaque-credential-a' });
    const credentialChanged = liveModel({ authority: 'opaque-credential-b' });
    const endpointChanged = liveModel({ authority: 'opaque-endpoint-b' });
    const options = { now: () => 1_000, timeoutMs: 100 };

    await Promise.all([
      probeAgentModel(first, options),
      probeAgentModel(credentialChanged, options),
      probeAgentModel(endpointChanged, options),
    ]);

    expect(first.probe).toHaveBeenCalledOnce();
    expect(credentialChanged.probe).toHaveBeenCalledOnce();
    expect(endpointChanged.probe).toHaveBeenCalledOnce();
  });

  it('does not share successful probes across configuration authority versions', async () => {
    const model = liveModel({ authority: 'opaque-stable-provider-authority' });
    const options = { now: () => 1_000, timeoutMs: 100 };

    await probeAgentModel(model, { ...options, authorityContext: 'config-version-a' });
    await probeAgentModel(model, { ...options, authorityContext: 'config-version-b' });

    expect(model.probe).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed or schema-invalid probes', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('provider-private-error'))
      .mockResolvedValueOnce({ identity: { provider: 'custom', model: '' } })
      .mockResolvedValueOnce({ identity: { provider: 'custom', model: 'resolved/model' } });
    const model = liveModel({ authority: 'opaque-failure-cache', probe });
    const options = { now: () => 1_000, timeoutMs: 100 };

    await expect(probeAgentModel(model, options)).rejects.toBeInstanceOf(LiveVerifierError);
    await expect(probeAgentModel(model, options)).rejects.toBeInstanceOf(LiveVerifierError);
    await expect(probeAgentModel(model, options)).resolves.toEqual({
      identity: { provider: 'custom', model: 'resolved/model' },
    });
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
