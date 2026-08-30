import { describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import { hashOperationPayload, type McpOperationRecord } from './operations.js';
import {
  McpOperationExecutionError,
  commitMcpCategorization,
  commitMcpUndo,
  getMcpOperation,
  retryMcpOperation,
  type McpOperationExecutionDeps,
} from './reconciliation.js';

const principal: McpPrincipal = {
  tokenId: 'token-1',
  tokenPrefix: 'rct_example',
  userId: 'user-1',
  isInstanceAdmin: false,
  memberships: [{ companyId: 'company-1', role: 'categorizer' }],
};
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000101';

function operation(overrides: Partial<McpOperationRecord> = {}): McpOperationRecord {
  const record: McpOperationRecord = {
    id: 'operation-1',
    tokenId: principal.tokenId,
    tokenPrefix: principal.tokenPrefix,
    userId: principal.userId,
    companyId: 'company-1',
    transactionId: TRANSACTION_ID,
    toolName: 'prepare_categorization',
    kind: 'categorization',
    idempotencyKey: 'prepare-1',
    inputHash: '',
    payload: {
      proposal: {},
      preview: {
        transactionId: TRANSACTION_ID,
        revision: 2,
        taxCalculation: 'NotApplicable',
        totals: { subtotalCents: -1000, taxCents: 0, totalCents: -1000 },
        lines: [{
          idx: 0,
          subtotalCents: -1000,
          taxCents: 0,
          totalCents: -1000,
          categoryQboId: 'category-1',
          taxCodeQboId: null,
          memo: null,
          tagIds: [],
        }],
        tagIds: [],
      },
      warnings: [],
    },
    payloadHash: '',
    sourceRevision: 1,
    preparedRevision: 2,
    qboType: 'Purchase',
    qboId: 'qbo-private',
    qboSyncToken: 'sync-private',
    expiresAt: new Date('2026-07-29T12:15:00.000Z'),
    retryOfId: null,
    cancelledAt: null,
    createdAt: new Date('2026-07-29T12:00:00.000Z'),
    updatedAt: new Date('2026-07-29T12:00:00.000Z'),
    ...overrides,
  };
  if (overrides.payloadHash === undefined) {
    record.payloadHash = hashOperationPayload(record.payload);
  }
  if (overrides.inputHash === undefined) {
    record.inputHash = hashOperationPayload({
      tokenId: record.tokenId,
      tokenPrefix: record.tokenPrefix,
      userId: record.userId,
      companyId: record.companyId,
      transactionId: record.transactionId,
      toolName: record.toolName,
      kind: record.kind,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      sourceRevision: record.sourceRevision,
      preparedRevision: record.preparedRevision,
      qboType: record.qboType,
      qboId: record.qboId,
      qboSyncToken: record.qboSyncToken,
      retryOfId: record.retryOfId,
    });
  }
  return record;
}

function undoOperation(
  overrides: Partial<McpOperationRecord> = {},
): McpOperationRecord {
  return operation({
    toolName: 'prepare_undo',
    kind: 'undo',
    idempotencyKey: 'undo-prepare-1',
    payload: {
      sourceOperationId: '10000000-0000-4000-8000-000000000001',
      sourcePreparedHash: 'a'.repeat(64),
      currentPostHash: 'b'.repeat(64),
      restoreHash: 'c'.repeat(64),
      preview: {
        action: 'restore_purchase_categorization',
        resultingStatus: 'REVERTED',
        direction: 'purchase',
        totalCents: -1000,
        totalTaxCents: null,
        lineCount: 1,
        restorationDigest: 'c'.repeat(64),
      },
      warnings: [],
    },
    sourceRevision: 2,
    preparedRevision: 2,
    qboSyncToken: '8',
    ...overrides,
  });
}

function fixture(status: string | null = null) {
  const operations = [operation()];
  const attempts: Array<{
    id: string;
    requestId: string;
    transactionId: string;
    operation: string;
    status: string;
    expectedRevision: number;
    expectedSyncToken: string;
    requestHash: string;
    requestPayload: unknown;
    beforeSnapshot: unknown;
    responseSnapshot: unknown;
    verification: unknown;
    errorCode: string | null;
    errorMessage: string | null;
  }> = status === null ? [] : [{
    id: 'attempt-1',
    requestId: 'operation-1',
    transactionId: TRANSACTION_ID,
    operation: 'recategorize',
    status,
    expectedRevision: 2,
    expectedSyncToken: 'sync-private',
    requestHash: 'request-hash',
    requestPayload: {},
    beforeSnapshot: {},
    responseSnapshot: null,
    verification: null,
    errorCode: null,
    errorMessage: null,
  }];
  const transactionStatus = {
    value: status === 'VERIFIED'
      ? 'POSTED'
      : status === 'UNCERTAIN'
        ? 'ERROR'
        : status === 'DRY_RUN'
          ? 'DRY_RUN'
          : 'PENDING',
  };
  const transactionSync = {
    value: status === 'VERIFIED' ? '8' : 'sync-private',
  };
  const commit = vi.fn(async () => {
    attempts.splice(
      0,
      attempts.length,
      {
        id: 'attempt-committed',
        requestId: operations.at(-1)!.id,
        transactionId: TRANSACTION_ID,
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 2,
        expectedSyncToken: 'sync-private',
        requestHash: 'request-hash',
        requestPayload: {},
        beforeSnapshot: {},
        responseSnapshot: {},
        verification: {
          outcome: 'VERIFIED',
          status: 'POSTED',
          newSyncToken: '8',
        },
        errorCode: null,
        errorMessage: null,
      },
    );
    transactionStatus.value = 'POSTED';
    transactionSync.value = '8';
    return {
      transactionId: TRANSACTION_ID,
      requestId: operations.at(-1)!.id,
      ok: true,
      status: 'POSTED' as const,
      outcome: 'VERIFIED' as const,
    };
  });
  const reconcile = vi.fn(async () => {
    attempts[0]!.status = 'VERIFIED';
    attempts[0]!.verification = {
      outcome: 'VERIFIED',
      status: 'POSTED',
      newSyncToken: '8',
    };
    transactionStatus.value = 'POSTED';
    transactionSync.value = '8';
    return {
      transactionId: TRANSACTION_ID,
      requestId: 'operation-1',
      ok: true,
      status: 'POSTED' as const,
      outcome: 'VERIFIED' as const,
    };
  });
  const createOperation = vi.fn(async (input: Parameters<NonNullable<McpOperationExecutionDeps['createOperation']>>[0]) => {
    const child = operation({
      id: 'operation-2',
      retryOfId: input.retryOfId ?? null,
      idempotencyKey: null,
    });
    operations.push(child);
    return child;
  });
  const deps: McpOperationExecutionDeps = {
    store: {
      mcpOperation: {
        findFirst: vi.fn(async ({ where }) => operations.find((candidate) =>
          Object.entries(where).every(([key, value]) =>
            candidate[key as keyof McpOperationRecord] === value,
          ),
        ) ?? null),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      qboMutationAttempt: {
        findUnique: vi.fn(async ({ where }) =>
          attempts.find((attempt) => attempt.requestId === where.requestId) ?? null),
      },
      transaction: {
        findUnique: vi.fn(async () => ({
          status: transactionStatus.value,
          revision: 2,
          qboType: 'Purchase',
          qboId: 'qbo-private',
          qboSyncToken: transactionSync.value,
        })),
      },
      user: {
        findUnique: vi.fn(async () => ({ name: 'Generic User' })),
      },
      mcpToken: {
        findFirst: vi.fn(async () => ({
          id: principal.tokenId,
          user: { isInstanceAdmin: false },
        })),
      },
      company: {
        findUnique: vi.fn(async () => ({ disconnectedAt: null })),
      },
      membership: {
        findUnique: vi.fn(async () => ({ role: 'categorizer' })),
      },
    },
    now: () => new Date('2026-07-29T12:05:00.000Z'),
    commit,
    reconcile,
    createOperation,
    validateAttempt: vi.fn(() => ({
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: 'qbo-private',
      requestId: operations.at(-1)!.id,
      requestHash: 'request-hash',
      expectedSyncToken: 'sync-private',
    })),
  };
  return {
    deps,
    commit,
    reconcile,
    createOperation,
    operations,
    attempts,
    transactionStatus,
    transactionSync,
  };
}

function undoFixture(status: string | null = null) {
  const value = fixture(status);
  value.operations[0] = undoOperation();
  const sourceOperation = operation({
    id: '10000000-0000-4000-8000-000000000001',
    idempotencyKey: 'source-prepare-1',
    qboSyncToken: '7',
  });
  value.operations.push(sourceOperation);
  const sourceAttempt = {
    id: 'source-attempt',
    requestId: '10000000-0000-4000-8000-000000000001',
    transactionId: TRANSACTION_ID,
    operation: 'recategorize',
    status: 'VERIFIED',
    expectedRevision: 2,
    expectedSyncToken: '7',
    requestHash: 'source-request-hash',
    requestPayload: {},
    beforeSnapshot: {},
    responseSnapshot: {},
    verification: {
      outcome: 'VERIFIED',
      status: 'POSTED',
      newSyncToken: '8',
    },
    errorCode: null,
    errorMessage: null,
  };
  const findAttempt = value.deps.store!.qboMutationAttempt.findUnique;
  vi.mocked(findAttempt).mockImplementation(async ({ where }) => (
    where.requestId === sourceAttempt.requestId
      ? sourceAttempt
      : value.attempts.find(
          (attempt) => attempt.requestId === where.requestId,
        ) ?? null
  ));
  value.transactionStatus.value = status === 'VERIFIED'
    ? 'REVERTED'
    : status === 'UNCERTAIN'
      ? 'ERROR'
      : 'POSTED';
  value.transactionSync.value = status === 'VERIFIED' ? '9' : '8';
  if (value.attempts[0] !== undefined) {
    value.attempts[0].operation = 'restore';
    value.attempts[0].expectedSyncToken = '8';
    if (status === 'VERIFIED') {
      value.attempts[0].verification = {
        outcome: 'VERIFIED',
        status: 'REVERTED',
        newSyncToken: '9',
      };
    } else if (status === 'UNCHANGED') {
      value.attempts[0].verification = {
        outcome: 'UNCHANGED',
        status: 'POSTED',
      };
    }
  }
  value.deps.validateAttempt = vi.fn((attempt) => ({
    operation: attempt.requestId === sourceAttempt.requestId
      ? 'recategorize'
      : 'restore',
    qboType: 'Purchase',
    qboId: 'qbo-private',
    requestId: attempt.requestId,
    requestHash: attempt.requestHash,
    expectedSyncToken: attempt.expectedSyncToken,
    preparedBindingHash: attempt.requestId === sourceAttempt.requestId
      ? 'a'.repeat(64)
      : 'c'.repeat(64),
    beforeSnapshotHash: attempt.requestId === sourceAttempt.requestId
      ? 'source-before'
      : 'b'.repeat(64),
  }));
  const undo = vi.fn(async () => {
    const target = [...value.operations]
      .reverse()
      .find((candidate) => candidate.kind === 'undo')!;
    value.attempts.splice(0, value.attempts.length, {
      id: 'attempt-undo',
      requestId: target.id,
      transactionId: TRANSACTION_ID,
      operation: 'restore',
      status: 'VERIFIED',
      expectedRevision: 2,
      expectedSyncToken: '8',
      requestHash: 'request-hash',
      requestPayload: {},
      beforeSnapshot: {},
      responseSnapshot: {},
      verification: {
        outcome: 'VERIFIED',
        status: 'REVERTED',
        newSyncToken: '9',
      },
      errorCode: null,
      errorMessage: null,
    });
    value.transactionStatus.value = 'REVERTED';
    value.transactionSync.value = '9';
    return {
      transactionId: TRANSACTION_ID,
      requestId: target.id,
      ok: true,
      status: 'REVERTED' as const,
      outcome: 'VERIFIED' as const,
    };
  });
  Object.assign(value.deps, { undo });
  value.reconcile.mockImplementation(async () => {
    value.attempts[0]!.status = 'VERIFIED';
    value.attempts[0]!.verification = {
      outcome: 'VERIFIED',
      status: 'REVERTED',
      newSyncToken: '9',
    };
    value.transactionStatus.value = 'REVERTED';
    value.transactionSync.value = '9';
    return {
      transactionId: TRANSACTION_ID,
      requestId: value.operations[0]!.id,
      ok: true,
      status: 'REVERTED',
      outcome: 'VERIFIED',
    };
  });
  return { ...value, undo, sourceAttempt, sourceOperation };
}

describe('MCP attachment operation dispatch', () => {
  function attachmentDto(
    status: 'FAILED' | 'UNCERTAIN' | 'ATTACHED',
  ) {
    return {
      operationId: 'attachment-operation-1',
      status:
        status === 'ATTACHED'
          ? 'VERIFIED' as const
          : status === 'UNCERTAIN'
            ? 'UNCERTAIN' as const
            : 'FAILED' as const,
      files: [{
        id: 'attachment-1',
        transactionId: TRANSACTION_ID,
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        sourceKind: 'LOCAL_UPLOAD' as const,
        retainedLocally: true,
        status,
        qboAttached: status === 'ATTACHED',
        canPreview: true,
        error: status === 'ATTACHED'
          ? null
          : { code: `ATTACHMENT_${status}`, message: 'Safe attachment error.' },
      }],
      actions: {
        canRetry: status === 'FAILED',
        requiresReconciliation: status === 'UNCERTAIN',
      },
    };
  }

  it('falls back only to an operation owned by the exact MCP actor key', async () => {
    const value = fixture();
    value.operations.splice(0);
    const findAttachmentOperation = vi.fn(async (
      _operationId: string,
      actorKey: string,
    ) => actorKey === `mcp:${principal.tokenId}`);
    const getAttachmentOperation = vi.fn(async () =>
      attachmentDto('ATTACHED'));
    const result = await getMcpOperation(
      principal,
      { operationId: 'attachment-operation-1' },
      {
        ...value.deps,
        findAttachmentOperation,
        getAttachmentOperation,
      },
    );

    expect(result).toMatchObject({
      operationId: 'attachment-operation-1',
      kind: 'attachment',
      state: 'committed',
      result: {
        fileCount: 1,
        attachedCount: 1,
        failedCount: 0,
        uncertainCount: 0,
      },
    });
    expect(findAttachmentOperation).toHaveBeenCalledWith(
      'attachment-operation-1',
      `mcp:${principal.tokenId}`,
    );
  });

  it('reconciles uncertain attachment operations before any retry dispatch', async () => {
    const value = fixture();
    value.operations.splice(0);
    const retryAttachmentOperation = vi.fn(async () =>
      attachmentDto('ATTACHED'));
    const reconcileAttachmentOperation = vi.fn(async () =>
      attachmentDto('ATTACHED'));
    const result = await retryMcpOperation(
      principal,
      { operationId: 'attachment-operation-1' },
      {
        ...value.deps,
        findAttachmentOperation: vi.fn(async () => true),
        getAttachmentOperation: vi.fn(async () => attachmentDto('UNCERTAIN')),
        retryAttachmentOperation,
        reconcileAttachmentOperation,
      },
    );

    expect(result).toMatchObject({ kind: 'attachment', state: 'committed' });
    expect(reconcileAttachmentOperation).toHaveBeenCalledTimes(1);
    expect(retryAttachmentOperation).not.toHaveBeenCalled();
  });
});

describe('MCP categorization operation execution', () => {
  it('routes transfer status and retry through the shared paired-operation adapter', async () => {
    const f = fixture();
    f.operations[0] = operation({
      kind: 'transfer',
      toolName: 'prepare_transfer',
    });
    const transferDto = {
      operationId: 'operation-1',
      kind: 'transfer' as const,
      expiresAt: '2026-07-29T12:15:00.000Z',
      state: 'prepared' as const,
      phase: 'awaiting_commit' as const,
      result: {
        complete: false,
        firstLeg: { outcome: 'IN_PROGRESS' as const },
        secondLeg: { outcome: 'IN_PROGRESS' as const },
      },
      error: null,
      actions: {
        canCommit: true,
        canRetry: false,
        requiresReconciliation: false,
      },
    };
    const getTransferOperation = vi.fn(async () => transferDto);
    const retryTransferOperation = vi.fn(async () => ({
      ...transferDto,
      state: 'committed' as const,
      phase: 'verified' as const,
      result: {
        complete: true,
        firstLeg: { outcome: 'VERIFIED' as const },
        secondLeg: { outcome: 'VERIFIED' as const },
      },
      actions: {
        canCommit: false,
        canRetry: false,
        requiresReconciliation: false,
      },
    }));
    f.deps.getTransferOperation = getTransferOperation;
    f.deps.retryTransferOperation = retryTransferOperation;

    await expect(getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      f.deps,
    )).resolves.toEqual(transferDto);
    await expect(retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      f.deps,
    )).resolves.toMatchObject({
      kind: 'transfer',
      state: 'committed',
      result: { complete: true },
    });
    expect(getTransferOperation).toHaveBeenCalledWith(
      principal,
      'operation-1',
      expect.objectContaining({ store: f.deps.store }),
    );
    expect(retryTransferOperation).toHaveBeenCalledWith(
      principal,
      'operation-1',
      expect.objectContaining({ store: f.deps.store }),
    );
  });

  it('returns a DB-only prepared projection without private payload or QBO fields', async () => {
    const { deps, commit, reconcile } = fixture();
    const result = await getMcpOperation(principal, { operationId: 'operation-1' }, deps);

    expect(result).toMatchObject({
      operationId: 'operation-1',
      state: 'prepared',
      phase: 'awaiting_commit',
      actions: { canCommit: true, canRetry: false, requiresReconciliation: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/qbo-private|sync-private|proposal|memo/i);
    expect(commit).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('fails closed when the immutable payload hash does not match', async () => {
    const { deps, operations } = fixture();
    operations[0]!.payloadHash = '0'.repeat(64);
    await expect(
      getMcpOperation(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'OPERATION_CORRUPT' });
  });

  it('fails closed when immutable binding metadata no longer matches inputHash', async () => {
    const { deps, operations } = fixture();
    operations[0]!.qboId = 'redirected-private-id';
    await expect(
      getMcpOperation(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'OPERATION_CORRUPT' });
  });

  it('rechecks the live token before a status read', async () => {
    const { deps } = fixture();
    vi.mocked(deps.store!.mcpToken.findFirst).mockResolvedValue(null);
    await expect(
      getMcpOperation(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
  });

  it('commits a prepared envelope with its exact stage hash and MCP authorization', async () => {
    const { deps, commit } = fixture();
    await commitMcpCategorization(principal, { operationId: 'operation-1' }, deps);

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: TRANSACTION_ID,
      companyId: 'company-1',
      expectedRevision: 2,
      requestId: 'operation-1',
      expectedStageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedTaxDisposition: 'set',
      expectedQboBinding: {
        qboType: 'Purchase',
        qboId: 'qbo-private',
        qboSyncToken: 'sync-private',
      },
      actor: { id: 'user-1', label: 'Generic User (MCP rct_example)' },
      authorization: {
        kind: 'mcp',
        tokenId: 'token-1',
        tokenPrefix: 'rct_example',
      },
    }));
  });

  it('binds a preserve-current commit to its immutable tax disposition', async () => {
    const { deps, commit, operations } = fixture();
    const payload = operations[0]!.payload as {
      preview: {
        taxDisposition?: 'set' | 'preserve_current';
        lines: Array<{ taxCodeQboId: string | null }>;
      };
    };
    payload.preview.taxDisposition = 'preserve_current';
    payload.preview.lines[0]!.taxCodeQboId = 'NON';
    operations[0]!.payloadHash = hashOperationPayload(operations[0]!.payload);
    operations[0]!.inputHash = hashOperationPayload({
      tokenId: operations[0]!.tokenId,
      tokenPrefix: operations[0]!.tokenPrefix,
      userId: operations[0]!.userId,
      companyId: operations[0]!.companyId,
      transactionId: operations[0]!.transactionId,
      toolName: operations[0]!.toolName,
      kind: operations[0]!.kind,
      idempotencyKey: operations[0]!.idempotencyKey,
      payloadHash: operations[0]!.payloadHash,
      sourceRevision: operations[0]!.sourceRevision,
      preparedRevision: operations[0]!.preparedRevision,
      qboType: operations[0]!.qboType,
      qboId: operations[0]!.qboId,
      qboSyncToken: operations[0]!.qboSyncToken,
      retryOfId: operations[0]!.retryOfId,
    });

    await commitMcpCategorization(principal, { operationId: 'operation-1' }, deps);

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedTaxDisposition: 'preserve_current',
      expectedStageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('rechecks the current company role before commit', async () => {
    const { deps, commit } = fixture();
    vi.mocked(deps.store!.membership.findUnique).mockResolvedValue({ role: 'viewer' });
    await expect(
      commitMcpCategorization(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'MCP_FORBIDDEN' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('checks a supplied idempotency key before returning a terminal replay', async () => {
    const { deps, attempts } = fixture('VERIFIED');
    attempts[0]!.verification = {
      outcome: 'VERIFIED',
      status: 'POSTED',
      newSyncToken: '8',
    };
    await expect(
      commitMcpCategorization(
        principal,
        { operationId: 'operation-1', idempotencyKey: 'different-key' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('projects invalid terminal evidence as visible corrupt reconciliation state', async () => {
    const { deps } = fixture('VERIFIED');
    const result = await getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    );
    expect(result).toMatchObject({
      state: 'reconciliation_required',
      phase: 'corrupt',
      error: { code: 'OPERATION_CORRUPT' },
      actions: {
        canCommit: false,
        canRetry: false,
        requiresReconciliation: true,
      },
    });
  });

  it('projects malformed durable PREPARED evidence as corrupt', async () => {
    const { deps } = fixture('PREPARED');
    deps.validateAttempt = vi.fn(() => {
      throw new Error('private malformed payload detail');
    });
    const result = await getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    );
    expect(result).toMatchObject({
      state: 'reconciliation_required',
      phase: 'corrupt',
      error: {
        code: 'OPERATION_CORRUPT',
        message: 'This MCP operation requires manual reconciliation.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private malformed payload detail');
  });

  it('applies expiry only before an attempt exists and lets terminal evidence win', async () => {
    const expiredAt = new Date('2026-07-29T12:04:00.000Z');
    const beforeAttempt = fixture();
    beforeAttempt.operations[0]!.expiresAt = expiredAt;
    beforeAttempt.operations[0]!.inputHash = hashOperationPayload({
      tokenId: beforeAttempt.operations[0]!.tokenId,
      tokenPrefix: beforeAttempt.operations[0]!.tokenPrefix,
      userId: beforeAttempt.operations[0]!.userId,
      companyId: beforeAttempt.operations[0]!.companyId,
      transactionId: beforeAttempt.operations[0]!.transactionId,
      toolName: beforeAttempt.operations[0]!.toolName,
      kind: beforeAttempt.operations[0]!.kind,
      idempotencyKey: beforeAttempt.operations[0]!.idempotencyKey,
      payloadHash: beforeAttempt.operations[0]!.payloadHash,
      sourceRevision: beforeAttempt.operations[0]!.sourceRevision,
      preparedRevision: beforeAttempt.operations[0]!.preparedRevision,
      qboType: beforeAttempt.operations[0]!.qboType,
      qboId: beforeAttempt.operations[0]!.qboId,
      qboSyncToken: beforeAttempt.operations[0]!.qboSyncToken,
      retryOfId: beforeAttempt.operations[0]!.retryOfId,
    });
    expect(await getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      beforeAttempt.deps,
    )).toMatchObject({ state: 'expired' });

    const terminal = fixture('VERIFIED');
    terminal.operations[0]!.expiresAt = expiredAt;
    terminal.attempts[0]!.verification = {
      outcome: 'VERIFIED',
      status: 'POSTED',
      newSyncToken: '8',
    };
    expect(await getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      terminal.deps,
    )).toMatchObject({ state: 'committed', phase: 'verified' });
  });

  it.each(['COMMITTING', 'UNCERTAIN'])(
    'reconciles %s and never resends it',
    async (status) => {
      const { deps, commit, reconcile } = fixture(status);
      await commitMcpCategorization(principal, { operationId: 'operation-1' }, deps);
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'operation-1',
        expectedStageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expectedTaxDisposition: 'set',
        expectedQboBinding: {
          qboType: 'Purchase',
          qboId: 'qbo-private',
          qboSyncToken: 'sync-private',
        },
        authorization: {
          kind: 'mcp',
          tokenId: 'token-1',
          tokenPrefix: 'rct_example',
        },
      }));
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it('creates at most one retry child for a retryable root', async () => {
    const {
      deps,
      createOperation,
      attempts,
      transactionStatus,
      transactionSync,
    } = fixture('RETRYABLE');
    await retryMcpOperation(principal, { operationId: 'operation-1' }, deps);
    attempts[0]!.status = 'RETRYABLE';
    attempts[0]!.verification = null;
    transactionStatus.value = 'PENDING';
    transactionSync.value = 'sync-private';
    await expect(
      retryMcpOperation(principal, { operationId: 'operation-2' }, deps),
    ).rejects.toMatchObject<McpOperationExecutionError>({ code: 'RETRY_NOT_ALLOWED' });
    expect(createOperation).toHaveBeenCalledOnce();
  });

  it('requires a fresh prepare when a retry child itself becomes retryable', async () => {
    const fixtureValue = fixture('PREPARED');
    fixtureValue.operations[0] = operation({ retryOfId: 'root-operation' });
    fixtureValue.commit.mockImplementationOnce(async () => {
      fixtureValue.attempts[0]!.status = 'RETRYABLE';
      fixtureValue.attempts[0]!.verification = null;
      fixtureValue.transactionStatus.value = 'PENDING';
      fixtureValue.transactionSync.value = 'sync-private';
      return {
        transactionId: TRANSACTION_ID,
        requestId: 'operation-1',
        ok: false,
        status: 'PENDING',
        outcome: 'RETRYABLE',
      };
    });

    await expect(retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      fixtureValue.deps,
    )).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' });
    expect(fixtureValue.createOperation).not.toHaveBeenCalled();
  });

  it('requires a fresh prepare when a newly created root retry child becomes retryable', async () => {
    const fixtureValue = fixture('RETRYABLE');
    fixtureValue.commit.mockImplementationOnce(async () => {
      fixtureValue.attempts.splice(0, fixtureValue.attempts.length, {
        id: 'attempt-child',
        requestId: 'operation-2',
        transactionId: TRANSACTION_ID,
        operation: 'recategorize',
        status: 'RETRYABLE',
        expectedRevision: 2,
        expectedSyncToken: 'sync-private',
        requestHash: 'request-hash',
        requestPayload: {},
        beforeSnapshot: {},
        responseSnapshot: null,
        verification: null,
        errorCode: null,
        errorMessage: null,
      });
      fixtureValue.transactionStatus.value = 'PENDING';
      fixtureValue.transactionSync.value = 'sync-private';
      return {
        transactionId: TRANSACTION_ID,
        requestId: 'operation-2',
        ok: false,
        status: 'PENDING',
        outcome: 'RETRYABLE',
      };
    });

    await expect(retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      fixtureValue.deps,
    )).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' });
    expect(fixtureValue.createOperation).toHaveBeenCalledOnce();
    expect(fixtureValue.commit).toHaveBeenCalledOnce();
  });

  it.each([null, 'PREPARED'] as const)(
    'retry resumes the same %s root operation instead of creating a child',
    async (status) => {
      const { deps, commit, createOperation } = fixture(status);
      const result = await retryMcpOperation(
        principal,
        { operationId: 'operation-1' },
        deps,
      );
      expect(result.state).toBe('committed');
      expect(commit).toHaveBeenCalledOnce();
      expect(createOperation).not.toHaveBeenCalled();
    },
  );

  it('retry reconciles an uncertain root and never invokes commit/send', async () => {
    const { deps, commit, reconcile, createOperation } = fixture('UNCERTAIN');
    const result = await retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    );
    expect(result.state).toBe('committed');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(createOperation).not.toHaveBeenCalled();
  });

  it.each(['COMMITTING', 'UNCERTAIN'])(
    'retry creates exactly one child when %s reconciliation proves UNCHANGED',
    async (status) => {
      const fixtureValue = fixture(status);
      fixtureValue.reconcile.mockImplementationOnce(async () => {
        fixtureValue.attempts[0]!.status = 'UNCHANGED';
        fixtureValue.attempts[0]!.verification = {
          outcome: 'UNCHANGED',
          status: 'PENDING',
        };
        fixtureValue.transactionStatus.value = 'PENDING';
        return {
          transactionId: TRANSACTION_ID,
          requestId: 'operation-1',
          ok: true,
          status: 'PENDING',
          outcome: 'UNCHANGED',
        };
      });

      const result = await retryMcpOperation(
        principal,
        { operationId: 'operation-1' },
        fixtureValue.deps,
      );

      expect(result.state).toBe('committed');
      expect(fixtureValue.reconcile).toHaveBeenCalledOnce();
      expect(fixtureValue.createOperation).toHaveBeenCalledOnce();
      expect(fixtureValue.commit).toHaveBeenCalledOnce();
    },
  );

  it.each(['COMMITTING', 'UNCERTAIN'])(
    'retry creates no child while %s remains unresolved',
    async (status) => {
      const fixtureValue = fixture(status);
      fixtureValue.reconcile.mockImplementationOnce(async () => ({
        transactionId: TRANSACTION_ID,
        requestId: 'operation-1',
        ok: false,
        status: status === 'UNCERTAIN' ? 'ERROR' : 'PENDING',
        outcome: status === 'UNCERTAIN' ? 'UNCERTAIN' : 'IN_PROGRESS',
      }));

      const result = await retryMcpOperation(
        principal,
        { operationId: 'operation-1' },
        fixtureValue.deps,
      );

      expect(result.state).toBe('reconciliation_required');
      expect(fixtureValue.createOperation).not.toHaveBeenCalled();
      expect(fixtureValue.commit).not.toHaveBeenCalled();
    },
  );

  it('retry returns a valid terminal root without mutation', async () => {
    const { deps, attempts, commit, reconcile, createOperation } = fixture('VERIFIED');
    attempts[0]!.verification = {
      outcome: 'VERIFIED',
      status: 'POSTED',
      newSyncToken: '8',
    };
    const result = await retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    );
    expect(result.state).toBe('committed');
    expect(commit).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(createOperation).not.toHaveBeenCalled();
  });

  it('returns a valid DRY_RUN terminal operation without mutation', async () => {
    const { deps, attempts, commit, reconcile, createOperation } = fixture('DRY_RUN');
    attempts[0]!.verification = { outcome: 'DRY_RUN', status: 'DRY_RUN' };
    const committed = await commitMcpCategorization(
      principal,
      { operationId: 'operation-1' },
      deps,
    );
    const retried = await retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    );
    expect(committed).toMatchObject({ state: 'committed', phase: 'dry_run' });
    expect(retried).toEqual(committed);
    expect(commit).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(createOperation).not.toHaveBeenCalled();
  });

  it('projects a cancelled unattempted operation and refuses commit and retry', async () => {
    const { deps, operations, commit, createOperation } = fixture();
    operations[0]!.cancelledAt = new Date('2026-07-29T12:03:00.000Z');
    expect(await getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    )).toMatchObject({ state: 'cancelled' });
    await expect(
      commitMcpCategorization(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    await expect(
      retryMcpOperation(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' });
    expect(commit).not.toHaveBeenCalled();
    expect(createOperation).not.toHaveBeenCalled();
  });

  it('rechecks company connectivity before retry creation', async () => {
    const { deps, createOperation } = fixture('RETRYABLE');
    vi.mocked(deps.store!.company.findUnique).mockResolvedValue({
      disconnectedAt: new Date('2026-07-29T12:00:00.000Z'),
    });
    await expect(
      retryMcpOperation(principal, { operationId: 'operation-1' }, deps),
    ).rejects.toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    expect(createOperation).not.toHaveBeenCalled();
  });
});

describe('MCP undo operation execution', () => {
  it('projects an unattempted undo as a redacted prepared operation', async () => {
    const { deps } = undoFixture();

    const result = await getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      deps,
    );

    expect(result).toMatchObject({
      operationId: 'operation-1',
      kind: 'undo',
      state: 'prepared',
      phase: 'awaiting_commit',
      actions: {
        canCommit: true,
        canRetry: false,
        requiresReconciliation: false,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /sourceOperationId|sourcePreparedHash|currentPostHash|restoreHash|qbo-private|sync-private/i,
    );
  });

  it('commits an exact proof-bound undo with optional idempotency and MCP attribution', async () => {
    const { deps, undo } = undoFixture();

    await commitMcpUndo(
      principal,
      { operationId: 'operation-1', idempotencyKey: ' undo-prepare-1 ' },
      deps,
    );

    expect(undo).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: TRANSACTION_ID,
      companyId: 'company-1',
      requestId: 'operation-1',
      actor: { id: 'user-1', label: 'Generic User (MCP rct_example)' },
      authorization: {
        kind: 'mcp',
        tokenId: 'token-1',
        tokenPrefix: 'rct_example',
      },
      proof: {
        sourceRequestId: '10000000-0000-4000-8000-000000000001',
        expectedRevision: 2,
        expectedQboBinding: {
          qboType: 'Purchase',
          qboId: 'qbo-private',
          qboSyncToken: '8',
        },
        sourcePreparedHash: 'a'.repeat(64),
        currentPostHash: 'b'.repeat(64),
        restoreHash: 'c'.repeat(64),
      },
      auditAttribution: {
        sourceOperationId: '10000000-0000-4000-8000-000000000001',
        operationId: 'operation-1',
        tokenPrefix: 'rct_example',
      },
    }));
  });

  it('rejects a mismatched optional commit idempotency key before restore execution', async () => {
    const { deps, undo } = undoFixture();

    await expect(commitMcpUndo(
      principal,
      { operationId: 'operation-1', idempotencyKey: 'different-key' },
      deps,
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(undo).not.toHaveBeenCalled();
  });

  it.each(['COMMITTING', 'UNCERTAIN'])(
    'reconciles an undo in %s and never invokes restore again',
    async (status) => {
      const { deps, undo, reconcile } = undoFixture(status);

      const result = await commitMcpUndo(
        principal,
        { operationId: 'operation-1' },
        deps,
      );

      expect(result).toMatchObject({
        kind: 'undo',
        state: 'committed',
        phase: 'verified',
        result: { outcome: 'VERIFIED', status: 'REVERTED' },
      });
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'operation-1',
        expectedQboBinding: {
          qboType: 'Purchase',
          qboId: 'qbo-private',
          qboSyncToken: '8',
        },
        authorization: {
          kind: 'mcp',
          tokenId: 'token-1',
          tokenPrefix: 'rct_example',
        },
        auditAttribution: {
          sourceOperationId: '10000000-0000-4000-8000-000000000001',
          operationId: 'operation-1',
          tokenPrefix: 'rct_example',
        },
      }));
      expect(undo).not.toHaveBeenCalled();
    },
  );

  it('accepts only restore POSTED→REVERTED verified evidence for undo', async () => {
    const verified = undoFixture('VERIFIED');
    await expect(getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      verified.deps,
    )).resolves.toMatchObject({
      kind: 'undo',
      state: 'committed',
      result: { outcome: 'VERIFIED', status: 'REVERTED' },
    });

    verified.attempts[0]!.operation = 'recategorize';
    await expect(getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      verified.deps,
    )).rejects.toMatchObject({ code: 'OPERATION_CORRUPT' });

    const dryRun = undoFixture('DRY_RUN');
    dryRun.attempts[0]!.verification = {
      outcome: 'DRY_RUN',
      status: 'DRY_RUN',
    };
    await expect(getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      dryRun.deps,
    )).resolves.toMatchObject({
      state: 'reconciliation_required',
      phase: 'corrupt',
    });
  });

  it('projects persisted undo evidence as corrupt when restore or current-post hashes differ', async () => {
    const value = undoFixture('VERIFIED');
    value.deps.validateAttempt = vi.fn((attempt) => ({
      operation: attempt.requestId === value.sourceAttempt.requestId
        ? 'recategorize'
        : 'restore',
      qboType: 'Purchase',
      qboId: 'qbo-private',
      requestId: attempt.requestId,
      requestHash: attempt.requestHash,
      expectedSyncToken: attempt.expectedSyncToken,
      preparedBindingHash: attempt.requestId === value.sourceAttempt.requestId
        ? 'a'.repeat(64)
        : 'f'.repeat(64),
      beforeSnapshotHash: attempt.requestId === value.sourceAttempt.requestId
        ? 'source-before'
        : 'b'.repeat(64),
    }));

    await expect(getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      value.deps,
    )).resolves.toMatchObject({
      state: 'reconciliation_required',
      phase: 'corrupt',
    });
  });

  it('projects missing or non-VERIFIED exact source evidence as corrupt without QBO access', async () => {
    const value = undoFixture();
    value.sourceAttempt.status = 'UNCERTAIN';

    await expect(getMcpOperation(
      principal,
      { operationId: 'operation-1' },
      value.deps,
    )).resolves.toMatchObject({
      state: 'reconciliation_required',
      phase: 'corrupt',
    });
    expect(value.undo).not.toHaveBeenCalled();
    expect(value.reconcile).not.toHaveBeenCalled();
  });

  it('creates at most one direct undo retry child after proven UNCHANGED', async () => {
    const value = undoFixture('UNCHANGED');
    value.createOperation.mockImplementationOnce(async (input) => {
      const child = undoOperation({
        id: 'operation-2',
        retryOfId: input.retryOfId ?? null,
        idempotencyKey: null,
      });
      value.operations.push(child);
      return child;
    });

    const result = await retryMcpOperation(
      principal,
      { operationId: 'operation-1' },
      value.deps,
    );

    expect(result).toMatchObject({ kind: 'undo', state: 'committed' });
    expect(value.createOperation).toHaveBeenCalledOnce();
    expect(value.createOperation.mock.calls[0]?.[0]).toMatchObject({
      kind: 'undo',
      toolName: 'prepare_undo',
      retryOfId: 'operation-1',
    });
    await expect(retryMcpOperation(
      principal,
      { operationId: 'operation-2' },
      value.deps,
    )).resolves.toMatchObject({ kind: 'undo', state: 'committed' });
    expect(value.createOperation).toHaveBeenCalledOnce();
  });
});
