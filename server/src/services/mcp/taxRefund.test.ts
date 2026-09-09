import { describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import { QboDepositPreparationError } from '../../lib/qbo/depositTax.js';
import type { QboClient } from '../../lib/qbo/types.js';
import {
  hashOperationPayload,
  McpOperationError,
  type McpOperationRecord,
} from './operations.js';
import {
  acknowledgeMcpTaxRefundRecorded,
  cancelMcpTaxRefund,
  McpTaxRefundError,
  prepareMcpTaxRefund,
  type CancelMcpTaxRefundInput,
  type PrepareMcpTaxRefundInput,
} from './taxRefund.js';
import { McpCategorizationError } from './categorization.js';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const TRANSACTION_ID = '22222222-2222-4222-8222-222222222222';
const principal: McpPrincipal = {
  tokenId: '33333333-3333-4333-8333-333333333333',
  tokenPrefix: 'rct_refund',
  userId: '44444444-4444-4444-8444-444444444444',
  isInstanceAdmin: false,
  memberships: [{ companyId: COMPANY_ID, role: 'categorizer' }],
};

function input(overrides: Partial<PrepareMcpTaxRefundInput> = {}): PrepareMcpTaxRefundInput {
  return {
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    expectedRevision: 0,
    idempotencyKey: 'example-refund',
    taxAgencyQboId: 'CRA',
    filedReturnRef: '2025-Q4',
    filingEvidenceSha256: 'a'.repeat(64),
    suspenseAccountQboId: '55',
    bankAccountQboId: 'BANK-1',
    refundDate: '2026-01-15',
    principalCents: 123_456,
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    companyId: COMPANY_ID,
    qboId: 'TEST-DEPOSIT-1',
    qboType: 'Deposit',
    qboSyncToken: '0',
    revision: 0,
    status: 'PENDING',
    amount: 1_234.56,
    date: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  };
}

function qboClient(overrides: Partial<QboClient> = {}): QboClient {
  return {
    realmId: 'realm-1',
    probeTaxRefundCapability: vi.fn().mockResolvedValue({
      mode: 'manual_required',
      reason: 'UNSUPPORTED_PUBLIC_API',
      api: 'intuit-accounting-v3',
      minorVersion: '75',
    }),
    listAccounts: vi.fn().mockResolvedValue([
      {
        qboId: '55',
        name: 'GST/HST Suspense',
        fullName: 'GST/HST Suspense',
        classification: 'Liability',
        accountType: 'Other Current Liabilities',
        accountSubType: 'GlobalTaxSuspense',
        active: true,
      },
      {
        qboId: 'BANK-1',
        name: 'Operating',
        fullName: 'Operating',
        classification: 'Bank',
        accountType: 'Bank',
        accountSubType: 'Checking',
        active: true,
      },
    ]),
    fetchPreparedSnapshot: vi.fn().mockResolvedValue({
      qboId: 'TEST-DEPOSIT-1',
      syncToken: '0',
      totalCents: 123_456,
      depositToAccountQboId: 'BANK-1',
      date: '2026-01-15',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      preservedHash: 'b'.repeat(64),
      lines: [],
    }),
    fetchWriteSafety: vi.fn().mockResolvedValue({
      bookCloseDate: null,
      cleared: false,
      reconciled: false,
    }),
    ...overrides,
  } as unknown as QboClient;
}

function dependencies(client = qboClient(), txn = transaction()) {
  const createOperation = vi.fn().mockImplementation(async (request) => ({
    id: '55555555-5555-4555-8555-555555555555',
    expiresAt: new Date('2026-09-04T22:15:00.000Z'),
    sourceRevision: request.sourceRevision,
    payload: request.payload,
  }));
  return {
    authorize: vi.fn().mockResolvedValue(undefined),
    loadReplay: vi.fn().mockResolvedValue(null),
    loadSourcePreparation: vi.fn().mockResolvedValue(null),
    loadTransaction: vi.fn().mockResolvedValue(txn),
    getClient: vi.fn().mockResolvedValue(client),
    createOperation,
    now: () => new Date('2026-09-04T22:00:00.000Z'),
  };
}

function replayOperation(): McpOperationRecord {
  const operation: McpOperationRecord = {
    id: '66666666-6666-4666-8666-666666666666',
    tokenId: principal.tokenId,
    tokenPrefix: principal.tokenPrefix,
    userId: principal.userId,
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    toolName: 'prepare_tax_refund',
    kind: 'tax_refund',
    idempotencyKey: 'example-refund',
    inputHash: '',
    payloadHash: '',
    sourceRevision: 0,
    preparedRevision: 0,
    qboType: 'Deposit',
    qboId: 'TEST-DEPOSIT-1',
    qboSyncToken: '0',
    expiresAt: new Date('2026-09-04T22:15:00.000Z'),
    retryOfId: null,
    cancelledAt: null,
    createdAt: new Date('2026-09-04T22:00:00.000Z'),
    updatedAt: new Date('2026-09-04T22:00:00.000Z'),
    payload: {
      capability: 'manual_required',
      preview: {
        action: 'record_gst_hst_refund',
        operatorPath: 'Sales Tax > Filed > Record refund',
        sourceDepositQboId: 'TEST-DEPOSIT-1',
        taxAgencyQboId: 'CRA',
        filedReturnRef: '2025-Q4',
        filingEvidenceSha256: 'a'.repeat(64),
        suspenseAccountQboId: '55',
        bankAccountQboId: 'BANK-1',
        refundDate: '2026-01-15',
        principalCents: 123_456,
        interestCents: 0,
        interestAccountQboId: null,
        totalBankCreditCents: 123_456,
        existingDepositTreatment: 'replace_or_match_before_verification',
      },
      warnings: [
        'Manual QuickBooks Tax Centre action required; preparation does not post the refund.',
        'The existing Deposit must be replaced or matched before verification so cash is not duplicated.',
      ],
    },
  };
  operation.payloadHash = hashOperationPayload(operation.payload);
  operation.inputHash = hashOperationPayload({
    tokenId: operation.tokenId,
    tokenPrefix: operation.tokenPrefix,
    userId: operation.userId,
    companyId: operation.companyId,
    transactionId: operation.transactionId,
    toolName: operation.toolName,
    kind: operation.kind,
    idempotencyKey: operation.idempotencyKey,
    payloadHash: operation.payloadHash,
    sourceRevision: operation.sourceRevision,
    preparedRevision: operation.preparedRevision,
    qboType: operation.qboType,
    qboId: operation.qboId,
    qboSyncToken: operation.qboSyncToken,
    retryOfId: operation.retryOfId,
  });
  return operation;
}

describe('prepareMcpTaxRefund', () => {
  it('prepares an immutable manual Tax Centre action without posting the Deposit', async () => {
    const deps = dependencies();

    const prepared = await prepareMcpTaxRefund(principal, input(), deps);

    expect(prepared).toMatchObject({
      operationId: '55555555-5555-4555-8555-555555555555',
      capability: 'manual_required',
      preview: {
        action: 'record_gst_hst_refund',
        operatorPath: 'Sales Tax > Filed > Record refund',
        sourceDepositQboId: 'TEST-DEPOSIT-1',
        suspenseAccountQboId: '55',
        bankAccountQboId: 'BANK-1',
        principalCents: 123_456,
        totalBankCreditCents: 123_456,
        existingDepositTreatment: 'replace_or_match_before_verification',
      },
    });
    expect(deps.createOperation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'prepare_tax_refund',
      kind: 'tax_refund',
      qboType: 'Deposit',
      qboId: 'TEST-DEPOSIT-1',
      qboSyncToken: '0',
    }), expect.anything());
    const operationDependencies = deps.createOperation.mock.calls[0]![1];
    expect(operationDependencies.expiresAt()).toEqual(
      new Date('9999-12-31T23:59:59.999Z'),
    );
  });

  it.each([
    ['non-Deposit source', transaction({ qboType: 'Purchase' }), input(), 'SOURCE_NOT_DEPOSIT'],
    ['non-pending source', transaction({ status: 'POSTED' }), input(), 'SOURCE_NOT_PENDING'],
    ['stale revision', transaction({ revision: 1 }), input(), 'STALE_SOURCE'],
    ['local date mismatch', transaction({ date: new Date('2026-01-16T00:00:00.000Z') }), input(), 'QBO_SOURCE_CHANGED'],
    ['amount mismatch', transaction(), input({ principalCents: 123_455 }), 'AMOUNT_MISMATCH'],
  ])('rejects %s', async (_label, txn, request, code) => {
    const caught = await prepareMcpTaxRefund(
      principal,
      request as PrepareMcpTaxRefundInput,
      dependencies(qboClient(), txn),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(McpTaxRefundError);
    expect(caught).toMatchObject({ code });
  });

  it('rejects a refund dated in a closed accounting period', async () => {
    const client = qboClient({
      fetchWriteSafety: vi.fn().mockResolvedValue({
        bookCloseDate: '2026-01-31',
        cleared: false,
        reconciled: false,
      }),
    });
    const deps = dependencies(client);

    await expect(prepareMcpTaxRefund(principal, input(), deps)).rejects.toMatchObject({
      code: 'QBO_PERIOD_CLOSED',
    });
    expect(deps.createOperation).not.toHaveBeenCalled();
  });

  it('rejects a lookalike liability account instead of creating generic suspense', async () => {
    const client = qboClient({
      listAccounts: vi.fn().mockResolvedValue([{
        qboId: '55',
        name: 'GST suspense',
        fullName: 'GST suspense',
        classification: 'Liability',
        accountType: 'Other Current Liabilities',
        accountSubType: 'OtherCurrentLiabilities',
        active: true,
      }]),
    });

    const caught = await prepareMcpTaxRefund(
      principal,
      input(),
      dependencies(client),
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'SYSTEM_SUSPENSE_REQUIRED' });
  });

  it.each([
    ['missing', []],
    ['inactive', [{
      qboId: 'INTEREST-1',
      name: 'Interest income',
      fullName: 'Interest income',
      classification: 'Revenue',
      accountType: 'Other Income',
      accountSubType: 'InterestEarned',
      active: false,
    }]],
  ])('rejects a %s CRA interest account', async (_label, interestAccounts) => {
    const baseAccounts = await qboClient().listAccounts();
    const client = qboClient({
      listAccounts: vi.fn().mockResolvedValue([...baseAccounts, ...interestAccounts]),
    });

    const caught = await prepareMcpTaxRefund(
      principal,
      input({ interestCents: 100, interestAccountQboId: 'INTEREST-1', principalCents: 123_356 }),
      dependencies(client),
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'INTEREST_ACCOUNT_REQUIRED' });
  });

  it.each([
    ['sync token', { syncToken: 'changed' }],
    ['QBO id', { qboId: 'OTHER-DEPOSIT' }],
    ['date', { date: '2026-01-16' }],
    ['bank account', { depositToAccountQboId: 'BANK-2' }],
  ])('rejects QBO %s drift', async (_label, snapshotOverride) => {
    const baseClient = qboClient();
    const snapshot = await baseClient.fetchPreparedSnapshot('Deposit', 'TEST-DEPOSIT-1');
    const client = qboClient({
      fetchPreparedSnapshot: vi.fn().mockResolvedValue({ ...snapshot, ...snapshotOverride }),
    });

    const caught = await prepareMcpTaxRefund(
      principal,
      input(),
      dependencies(client),
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'QBO_SOURCE_CHANGED' });
  });

  it('maps a malformed QBO Deposit snapshot to source drift', async () => {
    const client = qboClient({
      fetchPreparedSnapshot: vi.fn().mockRejectedValue(
        new QboDepositPreparationError('QBO_REFERENCE_MISSING', 'private provider detail'),
      ),
    });

    const caught = await prepareMcpTaxRefund(
      principal,
      input(),
      dependencies(client),
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'QBO_SOURCE_CHANGED' });
  });

  it('rejects a calendar-invalid refund date before any reads', async () => {
    const deps = dependencies();

    const caught = await prepareMcpTaxRefund(
      principal,
      input({ refundDate: '2026-02-31' }),
      deps,
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'INVALID_INPUT' });
    expect(deps.loadReplay).not.toHaveBeenCalled();
  });

  it('returns a byte-identical replay before reading QBO again', async () => {
    const client = qboClient();
    const replay = replayOperation();
    const deps = {
      ...dependencies(client),
      loadReplay: vi.fn().mockResolvedValue(replay),
    };

    const prepared = await prepareMcpTaxRefund(principal, input(), deps);

    expect(prepared).toMatchObject({
      operationId: replay.id,
      preview: { sourceDepositQboId: 'TEST-DEPOSIT-1' },
    });
    expect(deps.loadTransaction).not.toHaveBeenCalled();
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(client.fetchPreparedSnapshot).not.toHaveBeenCalled();
    expect(deps.createOperation).not.toHaveBeenCalled();
  });

  it('rejects a changed request that reuses a refund idempotency key', async () => {
    const deps = {
      ...dependencies(),
      loadReplay: vi.fn().mockResolvedValue(replayOperation()),
    };

    const caught = await prepareMcpTaxRefund(
      principal,
      input({ principalCents: 123_455 }),
      deps,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(McpOperationError);
    expect(caught).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(deps.loadTransaction).not.toHaveBeenCalled();
  });

  it('does not present a cancelled preparation as active on replay', async () => {
    const deps = dependencies();
    const replay = replayOperation();
    replay.cancelledAt = new Date('2026-09-04T22:04:00.000Z');
    deps.loadReplay.mockResolvedValue(replay);

    await expect(prepareMcpTaxRefund(principal, input(), deps)).rejects.toMatchObject({
      code: 'SOURCE_PREPARATION_CANCELLED',
    });
    expect(deps.loadTransaction).not.toHaveBeenCalled();
  });

  it('does not present a manually recorded refund as merely prepared on replay', async () => {
    const deps = dependencies();
    const replay = replayOperation();
    replay.manualRecordedAt = new Date('2026-09-04T22:06:00.000Z');
    deps.loadReplay.mockResolvedValue(replay);

    await expect(prepareMcpTaxRefund(principal, input(), deps)).rejects.toMatchObject({
      code: 'SOURCE_ALREADY_RECORDED',
    });
    expect(deps.loadTransaction).not.toHaveBeenCalled();
  });

  it('rejects a second preparation for the same source transaction', async () => {
    const deps = {
      ...dependencies(),
      loadSourcePreparation: vi.fn().mockResolvedValue(replayOperation()),
    };

    const caught = await prepareMcpTaxRefund(
      principal,
      input({ idempotencyKey: 'different-refund-key' }),
      deps,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(McpTaxRefundError);
    expect(caught).toMatchObject({ code: 'SOURCE_ALREADY_PREPARED' });
    expect(deps.loadTransaction).not.toHaveBeenCalled();
  });

  it('maps a concurrent source-reservation loss to an actionable conflict', async () => {
    const deps = dependencies();
    deps.loadSourcePreparation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replayOperation());
    deps.createOperation.mockRejectedValue(new McpOperationError('OPERATION_CONFLICT'));

    const caught = await prepareMcpTaxRefund(
      principal,
      input(),
      deps,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(McpTaxRefundError);
    expect(caught).toMatchObject({ code: 'SOURCE_ALREADY_PREPARED' });
    expect(deps.loadSourcePreparation).toHaveBeenCalledTimes(2);
  });
});

describe('cancelMcpTaxRefund', () => {
  const request: CancelMcpTaxRefundInput = {
    operationId: '66666666-6666-4666-8666-666666666666',
    confirmNoQuickBooksAction: true,
  };

  it('cancels an intact manual preparation after current authorization', async () => {
    const operation = replayOperation();
    operation.tokenId = '99999999-9999-4999-8999-999999999999';
    operation.tokenPrefix = 'rct_rotated';
    operation.inputHash = hashOperationPayload({
      tokenId: operation.tokenId,
      tokenPrefix: operation.tokenPrefix,
      userId: operation.userId,
      companyId: operation.companyId,
      transactionId: operation.transactionId,
      toolName: operation.toolName,
      kind: operation.kind,
      idempotencyKey: operation.idempotencyKey,
      payloadHash: operation.payloadHash,
      sourceRevision: operation.sourceRevision,
      preparedRevision: operation.preparedRevision,
      qboType: operation.qboType,
      qboId: operation.qboId,
      qboSyncToken: operation.qboSyncToken,
      retryOfId: operation.retryOfId,
    });
    const cancelOperation = vi.fn().mockResolvedValue({ count: 1 });
    const loadOperation = vi.fn().mockResolvedValue(operation);
    const result = await cancelMcpTaxRefund(principal, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation,
      cancelOperation,
      now: () => new Date('2026-09-04T22:05:00.000Z'),
    });

    expect(result).toEqual({
      operationId: operation.id,
      state: 'cancelled',
      cancelledAt: '2026-09-04T22:05:00.000Z',
    });
    expect(loadOperation).toHaveBeenCalledWith(operation.id);
    expect(cancelOperation).toHaveBeenCalledWith(
      operation.id,
      new Date('2026-09-04T22:05:00.000Z'),
    );
  });

  it('hides another creator preparation from an authorized company categorizer', async () => {
    const other = { ...principal, userId: '99999999-9999-4999-8999-999999999999' };
    const authorize = vi.fn().mockResolvedValue(undefined);
    const cancelOperation = vi.fn().mockResolvedValue({ count: 1 });
    await expect(cancelMcpTaxRefund(other, request, {
      authorize, loadOperation: vi.fn().mockResolvedValue(replayOperation()), cancelOperation,
      now: () => new Date('2026-09-04T22:05:00.000Z'),
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    expect(authorize).toHaveBeenCalledWith(other, COMPANY_ID, expect.any(Date));
    expect(cancelOperation).not.toHaveBeenCalled();
  });

  it('is idempotent for an already-cancelled preparation', async () => {
    const operation = replayOperation();
    operation.cancelledAt = new Date('2026-09-04T22:04:00.000Z');
    const cancelOperation = vi.fn();

    await expect(cancelMcpTaxRefund(principal, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation: vi.fn().mockResolvedValue(operation),
      cancelOperation,
      now: () => new Date('2026-09-04T22:05:00.000Z'),
    })).resolves.toEqual({
      operationId: operation.id,
      state: 'cancelled',
      cancelledAt: '2026-09-04T22:04:00.000Z',
    });
    expect(cancelOperation).not.toHaveBeenCalled();
  });

  it('requires a company or instance admin to correct a recorded attestation', async () => {
    const operation = replayOperation();
    operation.manualRecordedAt = new Date('2026-09-04T22:04:00.000Z');
    const cancelOperation = vi.fn();

    await expect(cancelMcpTaxRefund(principal, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation: vi.fn().mockResolvedValue(operation),
      cancelOperation,
    })).rejects.toMatchObject({ code: 'SOURCE_ALREADY_RECORDED' });
    expect(cancelOperation).not.toHaveBeenCalled();
  });

  it('lets an admin cancel a mistaken recorded attestation after confirming no QBO action', async () => {
    const operation = replayOperation();
    operation.manualRecordedAt = new Date('2026-09-04T22:04:00.000Z');
    const admin = {
      ...principal,
      memberships: [{ companyId: COMPANY_ID, role: 'admin' as const }],
    };
    const cancelOperation = vi.fn().mockResolvedValue({ count: 1 });

    await expect(cancelMcpTaxRefund(admin, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation: vi.fn().mockResolvedValue(operation),
      cancelOperation,
      now: () => new Date('2026-09-04T22:05:00.000Z'),
    })).resolves.toEqual({
      operationId: operation.id,
      state: 'cancelled',
      cancelledAt: '2026-09-04T22:05:00.000Z',
    });
    expect(cancelOperation).toHaveBeenCalledWith(
      operation.id,
      new Date('2026-09-04T22:05:00.000Z'),
    );
  });

  it('requires an explicit assertion that no QuickBooks action occurred', async () => {
    await expect(cancelMcpTaxRefund(principal, {
      ...request,
      confirmNoQuickBooksAction: false,
    } as unknown as CancelMcpTaxRefundInput)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('hides a foreign company operation behind not found', async () => {
    await expect(cancelMcpTaxRefund(principal, request, {
      authorize: vi.fn().mockRejectedValue(new McpCategorizationError('MCP_FORBIDDEN')),
      loadOperation: vi.fn().mockResolvedValue(replayOperation()),
      cancelOperation: vi.fn(),
      now: () => new Date('2026-09-04T22:05:00.000Z'),
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
  });

  it('preserves disconnected-company and infrastructure authorization failures', async () => {
    const operation = replayOperation();
    await expect(cancelMcpTaxRefund(principal, request, {
      authorize: vi.fn().mockRejectedValue(new McpCategorizationError('COMPANY_DISCONNECTED')),
      loadOperation: vi.fn().mockResolvedValue(operation),
      cancelOperation: vi.fn(),
    })).rejects.toMatchObject({ code: 'COMPANY_DISCONNECTED' });

    const databaseFailure = new Error('database unavailable');
    await expect(cancelMcpTaxRefund(principal, request, {
      authorize: vi.fn().mockRejectedValue(databaseFailure),
      loadOperation: vi.fn().mockResolvedValue(operation),
      cancelOperation: vi.fn(),
    })).rejects.toBe(databaseFailure);
  });

  it('lets a current company admin recover another user\'s preparation', async () => {
    const operation = replayOperation();
    operation.userId = '99999999-9999-4999-8999-999999999999';
    operation.inputHash = hashOperationPayload({
      tokenId: operation.tokenId,
      tokenPrefix: operation.tokenPrefix,
      userId: operation.userId,
      companyId: operation.companyId,
      transactionId: operation.transactionId,
      toolName: operation.toolName,
      kind: operation.kind,
      idempotencyKey: operation.idempotencyKey,
      payloadHash: operation.payloadHash,
      sourceRevision: operation.sourceRevision,
      preparedRevision: operation.preparedRevision,
      qboType: operation.qboType,
      qboId: operation.qboId,
      qboSyncToken: operation.qboSyncToken,
      retryOfId: operation.retryOfId,
    });
    const admin = {
      ...principal,
      memberships: [{ companyId: COMPANY_ID, role: 'admin' }],
    };

    await expect(cancelMcpTaxRefund(admin, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation: vi.fn().mockResolvedValue(operation),
      cancelOperation: vi.fn().mockResolvedValue({ count: 1 }),
      now: () => new Date('2026-09-04T22:05:00.000Z'),
    })).resolves.toMatchObject({ state: 'cancelled' });
  });
});

describe('acknowledgeMcpTaxRefundRecorded', () => {
  const request = {
    operationId: '66666666-6666-4666-8666-666666666666',
    confirmQuickBooksActionPerformed: true as const,
  };

  it('hides another creator attestation from an authorized company categorizer', async () => {
    const other = { ...principal, userId: '99999999-9999-4999-8999-999999999999' };
    const authorize = vi.fn().mockResolvedValue(undefined);
    const recordOperation = vi.fn().mockResolvedValue({ count: 1 });
    await expect(acknowledgeMcpTaxRefundRecorded(other, request, {
      authorize, loadOperation: vi.fn().mockResolvedValue(replayOperation()), recordOperation,
      now: () => new Date('2026-09-04T22:06:00.000Z'),
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    expect(authorize).toHaveBeenCalledWith(other, COMPANY_ID, expect.any(Date));
    expect(recordOperation).not.toHaveBeenCalled();
  });

  it('records the manual QBO action without claiming verification', async () => {
    const operation = replayOperation();
    const recordOperation = vi.fn().mockResolvedValue({ count: 1 });

    await expect(acknowledgeMcpTaxRefundRecorded(principal, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation: vi.fn().mockResolvedValue(operation),
      recordOperation,
      now: () => new Date('2026-09-04T22:06:00.000Z'),
    })).resolves.toEqual({
      operationId: operation.id,
      state: 'reconciliation_required',
      manualRecordedAt: '2026-09-04T22:06:00.000Z',
    });
    expect(recordOperation).toHaveBeenCalledWith(
      operation.id,
      new Date('2026-09-04T22:06:00.000Z'),
    );
  });

  it('rejects acknowledgement of a cancelled preparation', async () => {
    const operation = replayOperation();
    operation.cancelledAt = new Date('2026-09-04T22:04:00.000Z');

    await expect(acknowledgeMcpTaxRefundRecorded(principal, request, {
      authorize: vi.fn().mockResolvedValue(undefined),
      loadOperation: vi.fn().mockResolvedValue(operation),
      recordOperation: vi.fn(),
      now: () => new Date('2026-09-04T22:06:00.000Z'),
    })).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_CANCELLED' });
  });
});
