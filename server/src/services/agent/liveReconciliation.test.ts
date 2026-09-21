import { describe, expect, it, vi } from 'vitest';
import {
  reconcileLiveMutation,
  reconcileScheduledLiveMutation,
  type LiveReconciliationDeps,
  type LiveReconciliationInput,
} from './liveReconciliation.js';

const input: LiveReconciliationInput = {
  companyId: 'company-generic',
  transactionId: 'transaction-generic',
  qboType: 'Purchase',
  qboId: 'purchase-generic',
  requestId: 'request-generic',
  operation: 'recategorize',
  expectedRevision: 1,
  configVersion: 'config-v1',
  requestHash: 'a'.repeat(64),
  checkpointHash: 'b'.repeat(64),
};

function deps(
  overrides: Partial<LiveReconciliationDeps> = {},
): LiveReconciliationDeps {
  return {
    authorizeAdmin: vi.fn(async () => true),
    loadBinding: vi.fn(async () => ({ ...input })),
    reconcile: vi.fn<LiveReconciliationDeps['reconcile']>(async () => ({
      transactionId: input.transactionId,
      requestId: input.requestId,
      ok: true,
      status: 'POSTED',
      outcome: 'VERIFIED',
    })),
    ...overrides,
  };
}

describe('live mutation reconciliation', () => {
  it('does not grant the scheduler system capability by omitting an actor', async () => {
    await expect(
      reconcileLiveMutation(input, undefined as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('checks durable company-admin authority before loading a live binding', async () => {
    const d = deps({
      authorizeAdmin: vi.fn(async () => false),
    });

    await expect(reconcileLiveMutation(
      input,
      { actor: { id: 'categorizer-generic', label: 'Generic categorizer' } },
      d,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(d.loadBinding).not.toHaveBeenCalled();
    expect(d.reconcile).not.toHaveBeenCalled();
  });

  it('keeps automatic system reconciliation in a distinct scheduler entrypoint', async () => {
    const d = deps();

    await expect(
      reconcileScheduledLiveMutation(input, d),
    ).resolves.toMatchObject({ outcome: 'VERIFIED' });
    expect(d.reconcile).toHaveBeenCalledWith(input, {});
  });

  it('invokes the canonical durable reconciler exactly once for an exact binding', async () => {
    const d = deps();

    await expect(reconcileLiveMutation(
      input,
      { actor: { id: 'admin-generic', label: 'Generic administrator' } },
      d,
    )).resolves.toMatchObject({
      outcome: 'VERIFIED',
    });

    expect(d.reconcile).toHaveBeenCalledOnce();
    expect(d.reconcile).toHaveBeenCalledWith(input, {
      actor: { id: 'admin-generic', label: 'Generic administrator' },
      authorizeInTransaction: expect.any(Function),
    });
  });

  it('fails closed without reading QBO when any durable binding differs', async () => {
    const d = deps({
      loadBinding: vi.fn(async () => ({
        ...input,
        checkpointHash: 'c'.repeat(64),
      })),
    });

    await expect(reconcileLiveMutation(
      input,
      { actor: { id: 'admin-generic', label: 'Generic administrator' } },
      d,
    )).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    expect(d.reconcile).not.toHaveBeenCalled();
  });

  it.each(['VERIFIED', 'UNCHANGED', 'UNCERTAIN'] as const)(
    'returns canonical %s truth without auto-resuming live mode',
    async (outcome) => {
      const d = deps({
        reconcile: vi.fn<LiveReconciliationDeps['reconcile']>(async () => ({
          transactionId: input.transactionId,
          requestId: input.requestId,
          ok: outcome !== 'UNCERTAIN',
          status: outcome === 'VERIFIED' ? 'POSTED' : outcome === 'UNCHANGED' ? 'PENDING' : 'ERROR',
          outcome,
        })),
      });

      await expect(reconcileLiveMutation(
        input,
        { actor: { id: 'admin-generic', label: 'Generic administrator' } },
        d,
      )).resolves.toMatchObject({ outcome });
      expect(Object.keys(d)).not.toContain('resume');
    },
  );
});
