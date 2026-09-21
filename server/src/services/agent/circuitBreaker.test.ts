import { describe, expect, it, vi } from 'vitest';
import type { LivePauseStateDto } from '@recat/shared';
import {
  evaluateCircuitBreakers,
  pauseLiveCompanyInTransaction,
  pauseLiveModeManually,
  type CircuitBreakerDeps,
  type LiveBreakerEvidence,
  type LivePauseCode,
} from './circuitBreaker.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function evidence(
  overrides: Partial<LiveBreakerEvidence> = {},
): LiveBreakerEvidence {
  return {
    version: 1,
    companyId: 'company-generic',
    configVersion: 'config-v1',
    acceptedConfigVersion: 'config-v1',
    acceptedProviderBinding: 'binding-v1',
    currentProviderBinding: 'binding-v1',
    policyAccepted: true,
    completedSince: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000),
    completedThrough: NOW,
    eligibleRuns: 100,
    agreements: 100,
    disagreements: 0,
    abstentions: 0,
    providerErrors: 0,
    qboErrors: 0,
    unclassifiedErrors: 0,
    uncertainMutations: 0,
    readbackMismatches: 0,
    taxReferenceStatus: 'ready',
    taxReferenceRefreshedAt: new Date(NOW.getTime() - 60_000),
    leaseHealthy: true,
    identityProof: {
      version: 1,
      providerBinding: 'binding-v1',
      decisionIdentity: 'custom:resolved/decision',
      verifierIdentity: 'custom:resolved/verifier',
    },
    ...overrides,
  };
}

function deps(
  current: LiveBreakerEvidence,
  pause = vi.fn(async () => undefined),
): CircuitBreakerDeps {
  return {
    now: () => NOW,
    loadEvidence: vi.fn(async () => current),
    pause,
  };
}

describe('live circuit breakers', () => {
  it('requires durable company-admin authority before invoking the manual kill', async () => {
    // never invoked here: the call is rejected for authority first
    const pause = vi.fn(async () => undefined as unknown as LivePauseStateDto);
    const authorizeAdmin = vi.fn(async () => false);

    await expect(pauseLiveModeManually(
      'company-generic',
      'categorizer-generic',
      { authorizeAdmin, pause },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authorizeAdmin).toHaveBeenCalledWith(
      'categorizer-generic',
      'company-generic',
    );
    expect(pause).not.toHaveBeenCalled();
  });

  it('checks durable administrator authority after entering the manual-pause company fence', async () => {
    const order: string[] = [];
    const authorizeAdmin = vi.fn(async () => {
      order.push('authorize');
      return false;
    });
    const pause = vi.fn(async () => {
      order.push('mutate');
    });
    const withCompanyScope = vi.fn(async (
      _companyId: string,
      callback: (deps: {
        authorizeAdmin: typeof authorizeAdmin;
        pause: typeof pause;
      }) => Promise<void>,
    ) => {
      order.push('company-fence');
      return callback({ authorizeAdmin, pause });
    });

    await expect(pauseLiveModeManually(
      'company-generic',
      'revoked-admin',
      { authorizeAdmin, pause, withCompanyScope } as never,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(order).toEqual(['company-fence', 'authorize']);
    expect(pause).not.toHaveBeenCalled();
  });

  it('returns the exact final durable pause ACK instead of assuming a manual pause won', async () => {
    const finalState = {
      liveRequested: true,
      enabled: false,
      paused: true,
      pauseCode: 'READBACK_MISMATCH',
      pauseMessage: 'Live mode is paused: A live mutation readback did not match durable intent.',
    };
    const pause = vi.fn(async () => finalState);

    await expect(pauseLiveModeManually(
      'company-generic',
      'admin-generic',
      {
        authorizeAdmin: vi.fn(async () => true),
        pause,
      } as never,
    )).resolves.toEqual(finalState);
  });

  it.each([
    ['UNCERTAIN_MUTATION', { uncertainMutations: 1 }],
    ['READBACK_MISMATCH', { readbackMismatches: 1 }],
    ['QBO_ERROR_BURST', { qboErrors: 6 }],
    ['PROVIDER_ERROR_BURST', { providerErrors: 6 }],
    ['TAX_REFERENCE_STALE', { taxReferenceRefreshedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000) }],
    ['LEASE_HEALTH_FAILED', { leaseHealthy: false }],
    ['VERIFIER_NOT_DISTINCT', {
      identityProof: {
        version: 1,
        providerBinding: 'binding-v1',
        decisionIdentity: 'custom:resolved/shared',
        verifierIdentity: 'custom:resolved/shared',
      },
    }],
    ['POLICY_CONFIG_CHANGED', { acceptedConfigVersion: 'config-v0' }],
    ['SHADOW_DISAGREEMENT_DEGRADED', { agreements: 97, disagreements: 3 }],
    ['SHADOW_ABSTENTION_DEGRADED', { eligibleRuns: 74, agreements: 74, abstentions: 26 }],
  ] satisfies readonly [LivePauseCode, Partial<LiveBreakerEvidence>][])(
    'pauses new writes for %s',
    async (code, change) => {
      const pause = vi.fn(async () => undefined);
      const result = await evaluateCircuitBreakers(
        'company-generic',
        deps(evidence(change), pause),
      );

      expect(result).toEqual({ paused: true, code });
      expect(pause).toHaveBeenCalledWith(
        'company-generic',
        code,
        expect.stringMatching(/^Live mode is paused:/),
      );
    },
  );

  it('fails closed when durable counts or timestamps are invalid', async () => {
    const pause = vi.fn(async () => undefined);
    const result = await evaluateCircuitBreakers(
      'company-generic',
      deps(evidence({
        uncertainMutations: Number.NaN,
        completedThrough: new Date('invalid'),
      }), pause),
    );

    expect(result).toEqual({ paused: true, code: 'BREAKER_EVIDENCE_INVALID' });
  });

  it('fails closed instead of omitting an unclassified failed run', async () => {
    await expect(evaluateCircuitBreakers(
      'company-generic',
      deps(evidence({ unclassifiedErrors: 1 })),
    )).resolves.toEqual({
      paused: true,
      code: 'BREAKER_EVIDENCE_INVALID',
    });
  });

  it('uses deterministic severity priority when multiple breakers fire', async () => {
    const pause = vi.fn(async () => undefined);
    const result = await evaluateCircuitBreakers(
      'company-generic',
      deps(evidence({
        uncertainMutations: 1,
        qboErrors: 100,
        identityProof: {
          version: 1,
          providerBinding: 'binding-v1',
          decisionIdentity: 'custom:resolved/shared',
          verifierIdentity: 'custom:resolved/shared',
        },
      }), pause),
    );

    expect(result).toEqual({ paused: true, code: 'UNCERTAIN_MUTATION' });
    expect(pause).toHaveBeenCalledOnce();
  });

  it('does not pause healthy versioned evidence', async () => {
    const pause = vi.fn(async () => undefined);
    await expect(
      evaluateCircuitBreakers('company-generic', deps(evidence(), pause)),
    ).resolves.toEqual({ paused: false, code: null });
    expect(pause).not.toHaveBeenCalled();
  });

  it('fails closed when canonical provider identity proof belongs to an old binding', async () => {
    const pause = vi.fn(async () => undefined);
    const result = await evaluateCircuitBreakers(
      'company-generic',
      deps(evidence({
        identityProof: {
          version: 1,
          providerBinding: 'binding-v0',
          decisionIdentity: 'custom:resolved/decision',
          verifierIdentity: 'custom:resolved/verifier',
        },
      }), pause),
    );

    expect(result).toEqual({ paused: true, code: 'BREAKER_EVIDENCE_INVALID' });
  });

  it('lets uncertainty replace an older non-breaker pause without downgrading it later', async () => {
    const config = {
      liveRequested: true,
      livePausedAt: new Date(NOW.getTime() - 60_000),
      livePauseCode: 'QBO_DISCONNECTED',
    };
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(config, data);
      return config;
    });
    const db = {
      agentCompanyConfig: {
        findUnique: vi.fn(async () => config),
        update,
      },
    };

    await pauseLiveCompanyInTransaction(
      db as never,
      'company-generic',
      'UNCERTAIN_MUTATION',
      'Live mode is paused: A live mutation requires reconciliation.',
      NOW,
    );
    expect(config.livePauseCode).toBe('UNCERTAIN_MUTATION');

    await pauseLiveCompanyInTransaction(
      db as never,
      'company-generic',
      'TAX_REFERENCE_STALE',
      'Live mode is paused: Tax references are stale.',
      new Date(NOW.getTime() + 1_000),
    );
    expect(config.livePauseCode).toBe('UNCERTAIN_MUTATION');
    expect(update).toHaveBeenCalledOnce();
  });

  it('keeps an exact readback mismatch visible over generic uncertainty', async () => {
    const config = {
      liveRequested: true,
      livePausedAt: NOW,
      livePauseCode: 'UNCERTAIN_MUTATION',
    };
    const db = {
      agentCompanyConfig: {
        findUnique: vi.fn(async () => config),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(config, data);
          return config;
        }),
      },
    };

    await pauseLiveCompanyInTransaction(
      db as never,
      'company-generic',
      'READBACK_MISMATCH',
      'Live mode is paused: A live mutation readback did not match durable intent.',
      new Date(NOW.getTime() + 1_000),
    );
    await pauseLiveCompanyInTransaction(
      db as never,
      'company-generic',
      'UNCERTAIN_MUTATION',
      'Live mode is paused: A live mutation requires reconciliation.',
      new Date(NOW.getTime() + 2_000),
    );

    expect(config.livePauseCode).toBe('READBACK_MISMATCH');
  });

  it('returns paused false when live was never requested and no durable write occurs', async () => {
    const config = {
      liveRequested: false,
      liveEnabledAt: null,
      livePausedAt: null,
      livePauseCode: null,
      livePauseMessage: null,
    };
    const db = {
      agentCompanyConfig: {
        findUnique: vi.fn(async () => config),
        update: vi.fn(),
      },
    };

    await expect(pauseLiveCompanyInTransaction(
      db as never,
      'company-generic',
      'MANUAL_PAUSE',
      'Live mode is paused by a company administrator.',
      NOW,
    )).resolves.toEqual({
      liveRequested: false,
      enabled: false,
      paused: false,
      pauseCode: null,
      pauseMessage: null,
    });
    expect(db.agentCompanyConfig.update).not.toHaveBeenCalled();
  });
});
