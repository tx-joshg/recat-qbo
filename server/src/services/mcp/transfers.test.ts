import { describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import type {
  TransferOperationRecord,
  TransferPreparationWorkflow,
} from '../transferOperations.js';
import {
  createPreparedOperation,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';
import {
  commitMcpTransfer,
  getMcpTransferOperation,
  parseStoredMcpTransferPayload,
  prepareMcpTransfer,
  retryMcpTransferOperation,
  validateMcpTransferEnvelope,
  type McpTransferExecutionDeps,
  type McpTransferStore,
  type PrepareWithWorkflow,
} from './transfers.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const principal: McpPrincipal = {
  tokenId: '11111111-1111-4111-8111-111111111111',
  tokenPrefix: 'rct_example1',
  userId: '22222222-2222-4222-8222-222222222222',
  isInstanceAdmin: false,
  memberships: [{
    companyId: '33333333-3333-4333-8333-333333333333',
    role: 'categorizer',
  }],
};
const firstId = '44444444-4444-4444-8444-444444444444';
const secondId = '55555555-5555-4555-8555-555555555555';
const transferId = '66666666-6666-4666-8666-666666666666';

const coordinator: TransferOperationRecord = {
  id: transferId,
  actorId: principal.userId,
  companyId: principal.memberships[0]!.companyId,
  firstTransactionId: firstId,
  secondTransactionId: secondId,
  firstExpectedRevision: 3,
  secondExpectedRevision: 4,
  firstQboType: 'Purchase',
  firstQboId: 'qbo-first',
  firstQboSyncToken: '7',
  firstTargetAccountQboId: 'target-first',
  firstAttemptRequestId: `${transferId}-t0`,
  secondQboType: 'Deposit',
  secondQboId: 'qbo-second',
  secondQboSyncToken: '8',
  secondTargetAccountQboId: 'target-second',
  secondAttemptRequestId: `${transferId}-t1`,
  idempotencyHash: 'a'.repeat(64),
  inputHash: 'b'.repeat(64),
  preparedHash: 'c'.repeat(64),
  expiresAt: new Date(NOW.getTime() + 15 * 60_000),
  retryOfId: null,
  createdAt: NOW,
};

function matches(row: McpOperationRecord, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) =>
    row[key as keyof McpOperationRecord] === value);
}

function harness() {
  const operations = new Map<string, McpOperationRecord>();
  const coordinators = new Map([[coordinator.id, structuredClone(coordinator)]]);
  let insideFinalTransaction = false;
  const mcpOperation: McpOperationStore['mcpOperation'] = {
    async findFirst({ where }) {
      const row = [...operations.values()].find((candidate) => matches(candidate, where));
      return row ? structuredClone(row) : null;
    },
    async createMany({ data }) {
      expect(insideFinalTransaction).toBe(true);
      const existing = [...operations.values()].find((row) =>
        row.tokenId === data.tokenId
        && row.toolName === data.toolName
        && row.transactionId === data.transactionId
        && row.idempotencyKey === data.idempotencyKey);
      if (existing) return { count: 0 };
      const row = {
        ...structuredClone(data),
        createdAt: NOW,
        updatedAt: NOW,
      };
      operations.set(row.id, row);
      return { count: 1 };
    },
  };
  const store: McpTransferStore = {
    mcpOperation,
    mcpToken: {
      findFirst: vi.fn(async () => ({
        id: principal.tokenId,
        user: { isInstanceAdmin: false },
      })),
    },
    membership: { findUnique: vi.fn(async () => ({ role: 'categorizer' })) },
    company: { findUnique: vi.fn(async () => ({ disconnectedAt: null })) },
    qboTransferOperation: {
      findFirst: vi.fn(async ({ where }) =>
        structuredClone(coordinators.get(where.id) ?? null)),
    },
  };
  const prepare = vi.fn(async <T>(
    input: unknown,
    workflow: TransferPreparationWorkflow<T>,
  ): Promise<T> => {
    const before = await workflow.beforeValidation?.(store as never);
    if (before?.kind === 'return') return before.value;
    insideFinalTransaction = true;
    try {
      return await workflow.afterPrepare(store as never, {
        operation: structuredClone(coordinator),
        prepared: {
          operationId: coordinator.id,
          state: 'PREPARED',
          expiresAt: coordinator.expiresAt.toISOString(),
          preview: {
            action: 'record_transfer',
            direction: 'between_accounts',
            totalCents: 12_500,
            legCount: 2,
            preparationDigest: coordinator.preparedHash,
          },
        },
      });
    } finally {
      insideFinalTransaction = false;
    }
  });
  const withFinalTransaction = async <T>(callback: () => Promise<T>): Promise<T> => {
    insideFinalTransaction = true;
    try {
      return await callback();
    } finally {
      insideFinalTransaction = false;
    }
  };
  return { store, operations, coordinators, prepare, withFinalTransaction };
}

describe('MCP transfer preparation', () => {
  it('stores the complete private pair binding in the shared final transaction and returns only a bounded preview', async () => {
    const h = harness();
    const result = await prepareMcpTransfer(principal, {
      companyId: coordinator.companyId,
      transactionId: secondId,
      counterpartTransactionId: firstId,
      expectedRevision: 4,
      counterpartExpectedRevision: 3,
      idempotencyKey: ' transfer-one ',
    }, {
      prepare: h.prepare as unknown as PrepareWithWorkflow,
      createOperation: createPreparedOperation,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      expiresAt: coordinator.expiresAt.toISOString(),
      preview: {
        action: 'record_transfer',
        direction: 'between_accounts',
        totalCents: 12_500,
        legCount: 2,
        preparationDigest: coordinator.preparedHash,
      },
    });
    expect(JSON.stringify(result)).not.toContain(firstId);
    expect(JSON.stringify(result)).not.toContain(secondId);
    expect(JSON.stringify(result)).not.toContain('qbo-first');
    const stored = [...h.operations.values()][0]!;
    expect(stored).toMatchObject({
      tokenId: principal.tokenId,
      tokenPrefix: principal.tokenPrefix,
      userId: principal.userId,
      companyId: coordinator.companyId,
      transactionId: coordinator.firstTransactionId,
      toolName: 'prepare_transfer',
      kind: 'transfer',
      idempotencyKey: 'transfer-one',
      sourceRevision: coordinator.firstExpectedRevision,
      preparedRevision: coordinator.firstExpectedRevision,
      qboType: coordinator.firstQboType,
      qboId: coordinator.firstQboId,
      qboSyncToken: coordinator.firstQboSyncToken,
    });
    expect(parseStoredMcpTransferPayload(stored.payload)).toMatchObject({
      transferOperationId: coordinator.id,
      second: { transactionId: coordinator.secondTransactionId },
    });
  });

  it('returns an exact private-envelope replay before shared mutable preparation', async () => {
    const h = harness();
    const input = {
      companyId: coordinator.companyId,
      transactionId: firstId,
      counterpartTransactionId: secondId,
      expectedRevision: 3,
      counterpartExpectedRevision: 4,
      idempotencyKey: 'same-key',
    };
    const first = await prepareMcpTransfer(principal, input, {
      prepare: h.prepare as unknown as PrepareWithWorkflow,
      createOperation: createPreparedOperation,
      now: () => NOW,
    });
    const replay = await prepareMcpTransfer(principal, input, {
      prepare: h.prepare as unknown as PrepareWithWorkflow,
      createOperation: createPreparedOperation,
      now: () => NOW,
    });

    expect(replay).toEqual(first);
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.operations).toHaveLength(1);
  });

  it('rejects a private payload or scalar binding that disagrees with the immutable coordinator', async () => {
    const h = harness();
    await prepareMcpTransfer(principal, {
      companyId: coordinator.companyId,
      transactionId: firstId,
      counterpartTransactionId: secondId,
      expectedRevision: 3,
      counterpartExpectedRevision: 4,
      idempotencyKey: 'binding',
    }, {
      prepare: h.prepare as unknown as PrepareWithWorkflow,
      createOperation: createPreparedOperation,
      now: () => NOW,
    });
    const operation = [...h.operations.values()][0]!;

    expect(() => validateMcpTransferEnvelope(operation, coordinator)).not.toThrow();
    expect(() => validateMcpTransferEnvelope({
      ...operation,
      qboSyncToken: 'changed',
    }, coordinator)).toThrow(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    const tampered = structuredClone(operation);
    (tampered.payload as Record<string, any>).second.qboId = 'changed';
    expect(() => validateMcpTransferEnvelope(tampered, coordinator))
      .toThrow(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
  });
});

describe('MCP transfer execution', () => {
  async function preparedHarness() {
    const h = harness();
    const prepared = await prepareMcpTransfer(principal, {
      companyId: coordinator.companyId,
      transactionId: firstId,
      counterpartTransactionId: secondId,
      expectedRevision: 3,
      counterpartExpectedRevision: 4,
      idempotencyKey: 'execution-key',
    }, {
      prepare: h.prepare as unknown as PrepareWithWorkflow,
      createOperation: createPreparedOperation,
      now: () => NOW,
    });
    return { ...h, prepared };
  }

  it('projects both authoritative legs without exposing company, transaction, QBO, or account identifiers', async () => {
    const h = await preparedHarness();
    const getTransfer = vi.fn(async () => ({
      operationId: coordinator.id,
      state: 'PARTIAL' as const,
      complete: false,
      firstLeg: { outcome: 'VERIFIED' as const },
      secondLeg: { outcome: 'UNCHANGED' as const },
      error: { code: 'TRANSFER_PARTIAL', message: 'Recovery is required.' },
    }));

    const result = await getMcpTransferOperation(
      principal,
      h.prepared.operationId,
      { store: h.store, getTransfer, now: () => NOW },
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      kind: 'transfer',
      state: 'retryable',
      phase: 'write_unchanged',
      result: {
        complete: false,
        firstLeg: { outcome: 'VERIFIED' },
        secondLeg: { outcome: 'UNCHANGED' },
      },
      actions: { canCommit: false, canRetry: true },
    });
    for (const privateValue of [
      coordinator.companyId,
      firstId,
      secondId,
      coordinator.firstQboId,
      coordinator.secondQboId,
      coordinator.firstTargetAccountQboId,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('revalidates the current token and exact commit key before shared execution', async () => {
    const h = await preparedHarness();
    const commitTransfer = vi.fn();

    await expect(commitMcpTransfer(principal, {
      operationId: h.prepared.operationId,
      idempotencyKey: 'different',
    }, {
      store: h.store,
      getTransfer: vi.fn<NonNullable<McpTransferExecutionDeps['getTransfer']>>(async () => ({
        operationId: coordinator.id,
        state: 'PREPARED',
        complete: false,
        firstLeg: { outcome: 'IN_PROGRESS' },
        secondLeg: { outcome: 'IN_PROGRESS' },
      })),
      commitTransfer,
      now: () => NOW,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(commitTransfer).not.toHaveBeenCalled();

    vi.mocked(h.store.mcpToken.findFirst).mockResolvedValueOnce(null);
    await expect(getMcpTransferOperation(
      principal,
      h.prepared.operationId,
      { store: h.store, getTransfer: vi.fn(), now: () => NOW },
    )).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
  });

  it('uses the shared one-child retry and binds the child coordinator in one MCP child envelope', async () => {
    const h = await preparedHarness();
    const childCoordinator = {
      ...structuredClone(coordinator),
      id: '77777777-7777-4777-8777-777777777777',
      firstAttemptRequestId: `${'77777777-7777-4777-8777-777777777777'}-t0`,
      secondAttemptRequestId: `${'77777777-7777-4777-8777-777777777777'}-t1`,
      preparedHash: 'd'.repeat(64),
      idempotencyHash: 'e'.repeat(64),
      inputHash: 'f'.repeat(64),
      retryOfId: coordinator.id,
    };
    h.coordinators.set(childCoordinator.id, childCoordinator);
    const getTransfer = vi.fn()
      .mockResolvedValueOnce({
        operationId: coordinator.id,
        state: 'RETRYABLE',
        complete: false,
        firstLeg: { outcome: 'RETRYABLE' },
        secondLeg: { outcome: 'RETRYABLE' },
      })
      .mockResolvedValue({
        operationId: childCoordinator.id,
        state: 'PREPARED',
        complete: false,
        firstLeg: { outcome: 'IN_PROGRESS' },
        secondLeg: { outcome: 'IN_PROGRESS' },
      });
    const retryTransfer = vi.fn(async (
      _operationId,
      _actor,
      workflow,
    ) => h.withFinalTransaction(() => workflow.afterRetry(h.store as never, {
        parent: coordinator,
        operation: childCoordinator,
        retry: {
          retryOfId: coordinator.id,
          operationId: childCoordinator.id,
          state: 'PREPARED' as const,
          complete: false,
          firstLeg: { outcome: 'IN_PROGRESS' as const },
          secondLeg: { outcome: 'IN_PROGRESS' as const },
        },
      })));
    const commitTransfer = vi.fn(async () => ({
      operationId: childCoordinator.id,
      state: 'PREPARED' as const,
      complete: false,
      firstLeg: { outcome: 'IN_PROGRESS' as const },
      secondLeg: { outcome: 'IN_PROGRESS' as const },
    }));

    const result = await retryMcpTransferOperation(
      principal,
      h.prepared.operationId,
      {
        store: h.store,
        getTransfer,
        retryTransfer: retryTransfer as unknown as McpTransferExecutionDeps['retryTransfer'],
        commitTransfer,
        createOperation: createPreparedOperation,
        now: () => NOW,
      },
    );

    expect(retryTransfer).toHaveBeenCalledWith(
      coordinator.id,
      expect.objectContaining({ id: principal.userId }),
      expect.objectContaining({
        beforeValidation: expect.any(Function),
        afterRetry: expect.any(Function),
      }),
      expect.objectContaining({ kind: 'mcp', tokenId: principal.tokenId }),
    );
    const childMcp = [...h.operations.values()].find((row) =>
      row.retryOfId === h.prepared.operationId)!;
    expect(parseStoredMcpTransferPayload(childMcp.payload))
      .toMatchObject({ transferOperationId: childCoordinator.id });
    expect(result.operationId).toBe(childMcp.id);
  });
});
