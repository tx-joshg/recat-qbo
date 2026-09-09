import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import {
  companyTransactionsRouter,
  transactionActionsRouter,
  transactionDtos,
} from './transactions.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000020';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000030';
const OTHER_TRANSACTION_ID = '00000000-0000-4000-8000-000000000031';
const TAG_ID = '00000000-0000-4000-8000-000000000001';
const LINE_TAG_ID = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-000000000040';
const UNDO_REQUEST_ID = '00000000-0000-4000-8000-000000000041';

const mocks = vi.hoisted(() => ({
  bulkPost: vi.fn(),
  commitStagedCategorization: vi.fn(),
  companyFindUnique: vi.fn(),
  getTaxReadiness: vi.fn(),
  membershipFindUnique: vi.fn(),
  mutationAttemptFindFirst: vi.fn(),
  mutationAttemptFindUnique: vi.fn(),
  isLiveReconciliationOwnedRequest: vi.fn(),
  loadLiveReconciliationRequest: vi.fn(),
  postTransaction: vi.fn(),
  qboAccountFindFirst: vi.fn(),
  reconcileMutationAttempt: vi.fn(),
  reconcileLiveMutation: vi.fn(),
  retryError: vi.fn(),
  ruleFindMany: vi.fn(),
  ruleTagFindMany: vi.fn(),
  sessionFindUnique: vi.fn(),
  splitLineDtos: vi.fn(),
  stageCategorization: vi.fn(),
  suggestForMany: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionFindUnique: vi.fn(),
  transactionCount: vi.fn(),
  transactionUpdate: vi.fn(),
  transferCandidates: vi.fn(),
  txnTagCreate: vi.fn(),
  txnTagDeleteMany: vi.fn(),
  txnTagUpsert: vi.fn(),
  tagFindMany: vi.fn(),
  undoCategorization: vi.fn(),
  undoPost: vi.fn(),
  userFindMany: vi.fn(),
  validateSplits: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    qboAccount: { findFirst: mocks.qboAccountFindFirst },
    qboMutationAttempt: {
      findFirst: mocks.mutationAttemptFindFirst,
      findUnique: mocks.mutationAttemptFindUnique,
    },
    rule: { findMany: mocks.ruleFindMany },
    ruleTag: { findMany: mocks.ruleTagFindMany },
    session: { findUnique: mocks.sessionFindUnique },
    tag: { findMany: mocks.tagFindMany },
    transaction: {
      count: mocks.transactionCount,
      findMany: mocks.transactionFindMany,
      findUnique: mocks.transactionFindUnique,
      update: mocks.transactionUpdate,
    },
    txnTag: {
      create: mocks.txnTagCreate,
      deleteMany: mocks.txnTagDeleteMany,
      upsert: mocks.txnTagUpsert,
    },
    user: { findMany: mocks.userFindMany },
  },
}));

vi.mock('../services/categorization.js', () => ({
  stageCategorization: mocks.stageCategorization,
}));

vi.mock('../services/agent/liveReconciliation.js', () => ({
  isLiveReconciliationOwnedRequest: mocks.isLiveReconciliationOwnedRequest,
  loadLiveReconciliationRequest: mocks.loadLiveReconciliationRequest,
  reconcileLiveMutation: mocks.reconcileLiveMutation,
}));

vi.mock('../services/tax/reference.js', () => ({
  getTaxReadiness: mocks.getTaxReadiness,
}));

vi.mock('../services/writeback.js', () => ({
  bulkPost: mocks.bulkPost,
  commitStagedCategorization: mocks.commitStagedCategorization,
  postTransaction: mocks.postTransaction,
  reconcileMutationAttempt: mocks.reconcileMutationAttempt,
  retryError: mocks.retryError,
  splitLineDtos: mocks.splitLineDtos,
  undoCategorization: mocks.undoCategorization,
  undoPost: mocks.undoPost,
  validateSplits: mocks.validateSplits,
}));

vi.mock('../services/suggestions.js', () => ({
  ruleSuggestion: vi.fn(() => null),
  suggestForMany: mocks.suggestForMany,
}));

vi.mock('../services/transfers.js', () => ({
  recordTransfer: vi.fn(),
  transferCandidates: mocks.transferCandidates,
}));

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/companies/:companyId/transactions', companyTransactionsRouter);
  app.use('/api/transactions', transactionActionsRouter);
  app.use(errorMiddleware);
  return app;
}

const sessionHeaders = { Cookie: 'recat_session=transaction-route-test' };
let role: 'viewer' | 'categorizer' | 'admin' = 'categorizer';

const transactionRow = {
  id: TRANSACTION_ID,
  companyId: COMPANY_ID,
  qboId: 'PURCHASE_GENERIC',
  qboType: 'Purchase',
  qboSyncToken: '7',
  date: new Date('2026-07-27T00:00:00.000Z'),
  payee: 'Generic supplier',
  memo: null,
  amount: -10.5,
  bankAccount: 'Generic bank',
  status: 'PENDING',
  revision: 1,
  category: null,
  categoryQboId: null,
  taxCalculation: null,
  taxCode: null,
  taxCodeQboId: null,
  suggestion: null,
  errorCode: null,
  errorMessage: null,
  postedAt: null,
  postedByUserId: null,
  splitLines: [],
  txnTags: [],
  qboMutationAttempts: [],
};

const stageBody = {
  expectedRevision: 0,
  taxCalculation: 'TaxInclusive',
  lines: [{
    grossCents: -1050,
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCodeQboId: 'TAX_CODE_STANDARD',
    memo: 'Prepared purchase',
    tagIds: [LINE_TAG_ID],
  }],
  tagIds: [TAG_ID],
};

const stagedResult = {
  transactionId: TRANSACTION_ID,
  revision: 1,
  taxCalculation: 'TaxInclusive',
  totals: { subtotalCents: -1000, taxCents: -50, totalCents: -1050 },
  lines: [{
    idx: 0,
    subtotalCents: -1000,
    taxCents: -50,
    totalCents: -1050,
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCodeQboId: 'TAX_CODE_STANDARD',
    memo: 'Prepared purchase',
    tagIds: [LINE_TAG_ID],
  }],
  tagIds: [TAG_ID],
};

const verifiedResult = {
  transactionId: TRANSACTION_ID,
  requestId: REQUEST_ID,
  ok: true,
  status: 'POSTED',
  outcome: 'VERIFIED',
};

beforeEach(() => {
  vi.clearAllMocks();
  role = 'categorizer';
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'transaction-route-user',
      email: 'categorizer@example.test',
      name: 'Generic categorizer',
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.membershipFindUnique.mockImplementation(
    async ({ where }: { where: { userId_companyId: { companyId: string } } }) =>
      where.userId_companyId.companyId === COMPANY_ID ? { role } : null,
  );
  mocks.transactionFindUnique.mockResolvedValue(transactionRow);
  mocks.transactionCount.mockResolvedValue(1);
  mocks.companyFindUnique.mockResolvedValue({ id: COMPANY_ID, disconnectedAt: null });
  mocks.getTaxReadiness.mockResolvedValue({ salesStatus: 'ready' });
  mocks.mutationAttemptFindFirst.mockResolvedValue(null);
  mocks.mutationAttemptFindUnique.mockResolvedValue({ transactionId: TRANSACTION_ID });
  mocks.stageCategorization.mockResolvedValue(stagedResult);
  mocks.commitStagedCategorization.mockResolvedValue(verifiedResult);
  mocks.reconcileMutationAttempt.mockResolvedValue(verifiedResult);
  mocks.isLiveReconciliationOwnedRequest.mockResolvedValue(false);
  mocks.loadLiveReconciliationRequest.mockResolvedValue(null);
  mocks.reconcileLiveMutation.mockResolvedValue(verifiedResult);
  mocks.undoCategorization.mockResolvedValue({
    ...verifiedResult,
    requestId: UNDO_REQUEST_ID,
    status: 'REVERTED',
  });
  mocks.transactionUpdate.mockResolvedValue(transactionRow);
  mocks.tagFindMany.mockResolvedValue([{ id: TAG_ID }]);
  mocks.qboAccountFindFirst.mockResolvedValue({ qboId: 'EXPENSE_ACCOUNT' });
  mocks.ruleFindMany.mockResolvedValue([]);
  mocks.ruleTagFindMany.mockResolvedValue([]);
  mocks.txnTagDeleteMany.mockResolvedValue({ count: 0 });
  mocks.txnTagCreate.mockResolvedValue({});
  mocks.txnTagUpsert.mockResolvedValue({});
  mocks.userFindMany.mockResolvedValue([]);
  mocks.suggestForMany.mockResolvedValue([]);
  mocks.transferCandidates.mockResolvedValue(new Map());
  mocks.splitLineDtos.mockReturnValue(null);
  mocks.validateSplits.mockReturnValue({ ok: true });
});

describe('tax-aware categorization action routes', () => {
  it('does not return success when a legacy undo result is unverified', async () => {
    mocks.undoPost.mockResolvedValue({
      id: TRANSACTION_ID,
      ok: false,
      status: 'ERROR',
      error: {
        code: 'DB_COMMIT_FAILED',
        message: 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.',
      },
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/undo`)
      .set(sessionHeaders);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.',
      code: 'DB_COMMIT_FAILED',
    });
  });

  it('keeps one Queue with legacy cleared/reconciled rows and omits terminal rows', async () => {
    const checkedAt = new Date();
    const providerRow = (
      id: string,
      disposition: string,
      status = 'PENDING',
      qboId = id,
    ) => ({
      ...transactionRow,
      id,
      qboId,
      status,
      providerActionability: {
        companyId: COMPANY_ID,
        transactionId: id,
        disposition,
        checkedAt,
        revision: 1,
        qboSyncToken: '7',
        qboType: 'Purchase',
        qboId,
        txnDate: transactionRow.date,
      },
    });
    mocks.transactionFindMany.mockResolvedValue([
      providerRow('WRITABLE_TXN', 'WRITABLE'),
      providerRow('BLOCKED_TXN', 'BLOCKED_RECONCILED'),
      providerRow('UNKNOWN_TXN', 'WRITABLE', 'PENDING', 'mismatched-binding'),
      providerRow('POSTED_TXN', 'WRITABLE', 'POSTED'),
      {
        ...providerRow('POSTED_RESTORE_TXN', 'WRITABLE', 'POSTED'),
        qboMutationAttempts: [{
          requestId: REQUEST_ID,
          operation: 'restore',
          status: 'PREPARED',
        }],
      },
      {
        ...providerRow('POSTED_RETRYABLE_RESTORE_TXN', 'WRITABLE', 'POSTED'),
        qboMutationAttempts: [{
          requestId: '00000000-0000-4000-8000-000000000099',
          operation: 'restore',
          status: 'RETRYABLE',
        }],
      },
    ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/transactions`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.transactions.map((row: { id: string }) => row.id)).toEqual([
      'BLOCKED_TXN',
      'UNKNOWN_TXN',
      'POSTED_RESTORE_TXN',
      'POSTED_RETRYABLE_RESTORE_TXN',
      'WRITABLE_TXN',
    ]);
    expect(mocks.transactionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: COMPANY_ID,
        OR: [
          { status: { in: ['PENDING', 'ERROR', 'POSTING'] } },
          {
            status: 'POSTED',
            qboMutationAttempts: {
              some: {
                operation: 'restore',
                status: { in: ['PREPARED', 'RETRYABLE', 'COMMITTING', 'UNCERTAIN'] },
              },
            },
          },
        ],
      },
    }));
  });

  it('requires reconciliation when a provider rejection could not be persisted', async () => {
    mocks.commitStagedCategorization.mockResolvedValue({
      transactionId: TRANSACTION_ID,
      requestId: REQUEST_ID,
      ok: false,
      status: 'PENDING',
      outcome: 'IN_PROGRESS',
      error: {
        code: 'OPERATION_RECONCILIATION_REQUIRED',
        message: 'private database detail',
      },
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      transactionId: TRANSACTION_ID,
      requestId: REQUEST_ID,
      ok: false,
      status: 'PENDING',
      outcome: 'IN_PROGRESS',
      error: {
        code: 'OPERATION_RECONCILIATION_REQUIRED',
        message: 'QuickBooks rejected the write, but Recat could not persist that outcome. Reconcile this operation before continuing.',
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private|database detail/i);
  });

  it('returns a bounded 422 response for a provider-rejected write', async () => {
    mocks.commitStagedCategorization.mockResolvedValue({
      transactionId: TRANSACTION_ID,
      requestId: REQUEST_ID,
      ok: false,
      status: 'PENDING',
      outcome: 'REJECTED',
      error: {
        code: 'QBO_WRITE_REJECTED',
        message: 'private provider validation detail',
        rawPayload: { token: 'secret' },
      },
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      transactionId: TRANSACTION_ID,
      requestId: REQUEST_ID,
      ok: false,
      status: 'PENDING',
      outcome: 'REJECTED',
      error: {
        code: 'QBO_WRITE_REJECTED',
        message: 'QuickBooks rejected the prepared transaction. Correct it and prepare a new operation.',
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/payload|token|secret|private provider/i);
  });

  it('loads only the latest attempt so a terminal retry successor suppresses stale RETRYABLE state', async () => {
    mocks.transactionFindMany.mockResolvedValue([{
      ...transactionRow,
      status: 'POSTED',
      qboMutationAttempts: [{
        requestId: '00000000-0000-4000-8000-000000000098',
        operation: 'restore',
        status: 'VERIFIED',
      }],
    }]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/transactions`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.transactions).toEqual([]);
    expect(mocks.transactionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        qboMutationAttempts: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            requestId: true,
            operation: true,
            status: true,
          },
        },
      }),
    }));
  });

  it('exposes a bounded RETRYABLE restore summary for a new-request retry', async () => {
    const [dto] = await transactionDtos(
      COMPANY_ID,
      [{
        ...transactionRow,
        status: 'POSTED',
        qboMutationAttempts: [{
          requestId: REQUEST_ID,
          operation: 'restore',
          status: 'RETRYABLE',
          requestHash: 'INTERNAL_HASH',
          requestPayload: { internal: 'payload' },
          beforeSnapshot: { internal: 'before' },
          errorMessage: 'internal error detail',
        }],
      } as never],
      new Map(),
    );

    expect(dto?.activeCategorizationAttempt).toEqual({
      requestId: REQUEST_ID,
      operation: 'restore',
      status: 'RETRYABLE',
    });
    expect(JSON.stringify(dto?.activeCategorizationAttempt)).not.toMatch(
      /hash|payload|snapshot|error|internal/i,
    );
  });

  it('keeps explicit SUPERSEDED queue reads empty', async () => {
    mocks.transactionFindMany.mockResolvedValue([]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/transactions?status=SUPERSEDED`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.transactions).toEqual([]);
    expect(mocks.transactionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: COMPANY_ID, status: { in: [] } },
    }));
  });

  it('exposes the current revision and staged transaction tax identity for reloads', async () => {
    mocks.splitLineDtos.mockReturnValue(null);

    const [dto] = await transactionDtos(
      COMPANY_ID,
      [{
        ...transactionRow,
        taxCalculation: 'TaxInclusive',
        taxCode: 'Standard tax',
        taxCodeQboId: 'TAX_CODE_STANDARD',
      } as never],
      new Map(),
    );

    expect(dto).toMatchObject({
      revision: 1,
      taxCalculation: 'TaxInclusive',
      taxCode: 'Standard tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
    });
  });

  it('exposes only a bounded unresolved mutation summary on a transaction DTO', async () => {
    const [dto] = await transactionDtos(
      COMPANY_ID,
      [{
        ...transactionRow,
        status: 'ERROR',
        qboMutationAttempts: [{
          requestId: REQUEST_ID,
          operation: 'recategorize',
          status: 'UNCERTAIN',
          expectedRevision: 1,
          requestHash: 'INTERNAL_HASH',
          requestPayload: { internal: 'payload' },
          beforeSnapshot: { internal: 'before' },
          errorMessage: 'internal error detail',
        }],
      } as never],
      new Map(),
    );

    expect(dto?.activeCategorizationAttempt).toEqual({
      requestId: REQUEST_ID,
      operation: 'recategorize',
      status: 'UNCERTAIN',
    });
    expect(JSON.stringify(dto?.activeCategorizationAttempt)).not.toMatch(
      /hash|payload|snapshot|error|internal/i,
    );
  });

  it.each(['recategorize', 'restore'] as const)(
    'exposes a bounded PREPARED %s summary for exact-request resume',
    async (operation) => {
      const [dto] = await transactionDtos(
        COMPANY_ID,
        [{
          ...transactionRow,
          qboMutationAttempts: [{
            requestId: REQUEST_ID,
            operation,
            status: 'PREPARED',
            requestHash: 'INTERNAL_HASH',
            requestPayload: { internal: 'payload' },
            beforeSnapshot: { internal: 'before' },
            errorMessage: 'internal error detail',
          }],
        } as never],
        new Map(),
      );

      expect(dto?.activeCategorizationAttempt).toEqual({
        requestId: REQUEST_ID,
        operation,
        status: 'PREPARED',
      });
      expect(JSON.stringify(dto?.activeCategorizationAttempt)).not.toMatch(
        /hash|payload|snapshot|error|internal/i,
      );
    },
  );

  it.each([
    ['malformed', 'not-a-request-id'],
    ['oversized', `00000000-0000-4000-8000-${'0'.repeat(200)}`],
  ])(
    'drops a %s legacy mutation request ID instead of exposing a raw attempt',
    async (_label, requestId) => {
      const [dto] = await transactionDtos(
        COMPANY_ID,
        [{
          ...transactionRow,
          status: 'ERROR',
          qboMutationAttempts: [{
            requestId,
            operation: 'recategorize',
            status: 'UNCERTAIN',
          }],
        } as never],
        new Map(),
      );

      expect(dto?.activeCategorizationAttempt).toBeNull();
    },
  );

  it('loads the latest attempt with an allowlisted relation select', async () => {
    mocks.transactionFindMany.mockResolvedValue([{
      ...transactionRow,
      qboMutationAttempts: [],
    }]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/transactions`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(mocks.transactionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        qboMutationAttempts: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            requestId: true,
            operation: true,
            status: true,
          },
        },
      }),
    }));
  });

  it('maps the tax-aware staging guard to a transaction-neutral conflict response', async () => {
    mocks.postTransaction.mockRejectedValue({
      name: 'WritebackLifecycleError',
      code: 'TAX_AWARE_STAGING_REQUIRED',
      message: 'internal detail',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/post`)
      .set(sessionHeaders);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Tax-ready transactions must use staged categorization.',
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['QBO_PERIOD_CLOSED', 409, 'QuickBooks has closed this accounting period.'],
    ['QBO_TRANSACTION_LOCKED', 409, 'QuickBooks reports this transaction as cleared or reconciled.'],
    ['QBO_WRITE_SAFETY_UNAVAILABLE', 503, 'QuickBooks write-safety status is unavailable.'],
  ])('maps a legacy post result error %s to a bounded response', async (code, status, message) => {
    mocks.postTransaction.mockResolvedValue({
      id: TRANSACTION_ID,
      ok: false,
      status: 'PENDING',
      error: { code, message: 'internal provider report detail' },
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/post`)
      .set(sessionHeaders);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: message, code });
    expect(JSON.stringify(response.body)).not.toMatch(/internal|provider|private|secret/i);
  });

  it('blocks direct legacy categorization for a tax-ready Purchase before local mutation', async () => {
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: null,
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorize`)
      .set(sessionHeaders)
      .send({
        category: 'Generic prepared expense',
        categoryQboId: 'EXPENSE_ACCOUNT',
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Tax-ready Purchases must use staged categorization.',
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(mocks.qboAccountFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('blocks direct legacy categorization for a tax-ready Deposit before local mutation', async () => {
    mocks.transactionFindUnique.mockResolvedValue({ ...transactionRow, qboType: 'Deposit' });
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: null,
      taxSupportStatus: 'needs_setup',
      taxUsingSalesTax: true,
    });
    mocks.getTaxReadiness.mockResolvedValue({ salesStatus: 'ready' });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorize`)
      .set(sessionHeaders)
      .send({
        category: 'Generic prepared income',
        categoryQboId: 'INCOME_ACCOUNT',
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Tax-ready transactions must use staged categorization.',
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(mocks.qboAccountFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('allows direct legacy Deposit categorization when only purchase references are ready', async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      ...transactionRow,
      qboType: 'Deposit',
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
    });
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: null,
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    });
    mocks.getTaxReadiness.mockResolvedValue({ salesStatus: 'needs_setup' });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorize`)
      .set(sessionHeaders)
      .send({
        category: 'Generic prepared income',
        categoryQboId: 'INCOME_ACCOUNT',
      });

    expect(response.status).toBe(200);
    expect(mocks.getTaxReadiness).toHaveBeenCalledWith(COMPANY_ID);
    expect(mocks.transactionUpdate).toHaveBeenCalled();
  });

  it('blocks direct legacy Deposit categorization after staged tax readiness is lost', async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      ...transactionRow,
      qboType: 'Deposit',
      taxCalculation: 'TaxInclusive',
      qboMutationAttempts: [],
    });
    mocks.getTaxReadiness.mockResolvedValue({ salesStatus: 'needs_setup' });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorize`)
      .set(sessionHeaders)
      .send({
        category: 'Generic prepared income',
        categoryQboId: 'INCOME_ACCOUNT',
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Tax-ready transactions must use staged categorization.',
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(mocks.getTaxReadiness).not.toHaveBeenCalled();
    expect(mocks.qboAccountFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('maps the tax-aware undo guard without mutating locally', async () => {
    mocks.undoPost.mockRejectedValue({
      name: 'WritebackLifecycleError',
      code: 'TAX_AWARE_STAGING_REQUIRED',
      message: 'internal detail',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/undo`)
      .set(sessionHeaders);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Tax-ready transactions must use staged categorization.',
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it.each(['categorizer', 'admin'] as const)(
    'lets a %s stage and passes the normalized proposal unchanged',
    async (allowedRole) => {
      role = allowedRole;

      const response = await request(testApp())
        .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
        .set(sessionHeaders)
        .send(stageBody);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(stagedResult);
      expect(mocks.stageCategorization).toHaveBeenCalledWith({
        transactionId: TRANSACTION_ID,
        companyId: COMPANY_ID,
        expectedRevision: 0,
        proposal: {
          taxCalculation: stageBody.taxCalculation,
          lines: stageBody.lines,
          tagIds: stageBody.tagIds,
        },
      });
    },
  );

  it('allowlists the complete nested stage response and drops internal fields', async () => {
    mocks.stageCategorization.mockResolvedValue({
      ...stagedResult,
      rawPayload: { privateNote: 'secret top-level payload' },
      token: 'secret-token',
      stack: 'internal stack',
      totals: {
        ...stagedResult.totals,
        snapshot: { secret: 'nested totals snapshot' },
      },
      lines: [{
        ...stagedResult.lines[0],
        beforeSnapshot: { secret: 'line snapshot' },
        rawPayload: { secret: 'line payload' },
        token: 'line-secret-token',
      }],
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(stagedResult);
    expect(JSON.stringify(response.body)).not.toMatch(
      /rawPayload|privateNote|snapshot|token|stack|secret/i,
    );
  });

  it('fails closed when a stage response does not match the path transaction', async () => {
    mocks.stageCategorization.mockResolvedValue({
      ...stagedResult,
      transactionId: OTHER_TRANSACTION_ID,
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  it('rejects a viewer before staging', async () => {
    role = 'viewer';

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.stageCategorization).not.toHaveBeenCalled();
  });

  it('returns the same bounded 404 for nonexistent and other-company nonmember transactions', async () => {
    mocks.transactionFindUnique.mockResolvedValueOnce(null);
    const nonexistent = await request(testApp())
      .post(`/api/transactions/${OTHER_TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);
    mocks.transactionFindUnique.mockResolvedValueOnce({
      ...transactionRow,
      id: OTHER_TRANSACTION_ID,
      companyId: OTHER_COMPANY_ID,
    });

    const otherCompany = await request(testApp())
      .post(`/api/transactions/${OTHER_TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(nonexistent.status).toBe(404);
    expect(otherCompany.status).toBe(404);
    expect(nonexistent.body).toEqual({
      error: 'Transaction not found',
      code: 'TRANSACTION_NOT_FOUND',
    });
    expect(otherCompany.body).toEqual(nonexistent.body);
    expect(mocks.stageCategorization).not.toHaveBeenCalled();
  });

  it('rejects a disconnected company before staging', async () => {
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: new Date('2026-07-27T00:00:00.000Z'),
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'This company is disconnected from QuickBooks.',
      code: 'COMPANY_DISCONNECTED',
    });
    expect(mocks.stageCategorization).not.toHaveBeenCalled();
  });

  it('checks authorization before disclosing that a company is disconnected', async () => {
    role = 'viewer';
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: new Date('2026-07-27T00:00:00.000Z'),
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.stageCategorization).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown total', { ...stageBody, totalCents: -1050 }],
    ['unsafe revision', { ...stageBody, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['too many lines', { ...stageBody, lines: Array.from({ length: 21 }, () => stageBody.lines[0]) }],
    ['empty lines', { ...stageBody, lines: [] }],
    ['unsafe cents', {
      ...stageBody,
      lines: [{ ...stageBody.lines[0], grossCents: Number.MAX_SAFE_INTEGER + 1 }],
    }],
    ['long account reference', {
      ...stageBody,
      lines: [{ ...stageBody.lines[0], categoryQboId: 'A'.repeat(121) }],
    }],
    ['long tax reference', {
      ...stageBody,
      lines: [{ ...stageBody.lines[0], taxCodeQboId: 'T'.repeat(121) }],
    }],
    ['long memo', {
      ...stageBody,
      lines: [{ ...stageBody.lines[0], memo: 'M'.repeat(501) }],
    }],
    ['duplicate line tags', {
      ...stageBody,
      lines: [{ ...stageBody.lines[0], tagIds: [LINE_TAG_ID, LINE_TAG_ID] }],
    }],
    ['too many transaction tags', {
      ...stageBody,
      tagIds: Array.from(
        { length: 51 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    }],
    ['unknown line field', {
      ...stageBody,
      lines: [{ ...stageBody.lines[0], clientTaxCents: -50 }],
    }],
  ])('strictly rejects %s before staging', async (_name, body) => {
    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION' });
    expect(mocks.stageCategorization).not.toHaveBeenCalled();
  });

  it('maps a cross-company line tag service rejection without leaking details', async () => {
    mocks.stageCategorization.mockRejectedValue({
      name: 'CategorizationError',
      code: 'INVALID_TAG',
      message: 'secret-bearing internal lookup detail',
      stack: 'internal stack',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'One or more tags are unavailable for this company.',
      code: 'INVALID_TAG',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-bearing');
    expect(JSON.stringify(response.body)).not.toContain('stack');
  });

  it('maps stable tax-reference failures to a bounded client response', async () => {
    mocks.stageCategorization.mockRejectedValue({
      name: 'CategorizationError',
      code: 'TAX_CODE_MALFORMED',
      message: 'unsafe tax reference detail',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'A selected tax code is unsupported.',
      code: 'TAX_CODE_MALFORMED',
    });
    expect(JSON.stringify(response.body)).not.toContain('unsafe');
  });

  it('maps a tax-code direction mismatch to a bounded client response', async () => {
    mocks.stageCategorization.mockRejectedValue({
      name: 'CategorizationError',
      code: 'TAX_CODE_PURCHASE_ONLY',
      message: 'internal tax component direction detail',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'A selected tax code is unsupported.',
      code: 'TAX_CODE_PURCHASE_ONLY',
    });
    expect(JSON.stringify(response.body)).not.toContain('internal');
  });

  it('maps an unsupported taxed transaction type without a Purchase-only message', async () => {
    mocks.stageCategorization.mockRejectedValue({
      name: 'CategorizationError',
      code: 'TAX_REQUIRES_PURCHASE',
      message: 'internal transaction type detail',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Tax selection is unsupported for this transaction type.',
      code: 'TAX_REQUIRES_PURCHASE',
    });
    expect(JSON.stringify(response.body)).not.toContain('internal');
  });

  it('maps an active staging attempt to a stable bounded resume conflict', async () => {
    mocks.stageCategorization.mockRejectedValue({
      name: 'CategorizationError',
      code: 'MUTATION_BLOCKED',
      message: 'internal attempt identity and payload detail',
      stack: 'internal stack',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/stage`)
      .set(sessionHeaders)
      .send(stageBody);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'This transaction has a prepared write that must be resumed or verified.',
      code: 'MUTATION_BLOCKED',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/identity|payload|stack/i);
  });

  it('rechecks permission and forwards the revision/request-bound commit', async () => {
    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(verifiedResult);
    expect(mocks.commitStagedCategorization).toHaveBeenCalledWith({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      expectedRevision: 1,
      requestId: REQUEST_ID,
      actor: { id: 'transaction-route-user', label: 'Generic categorizer' },
    });
  });

  it('returns the service-recorded result for a duplicate request ID', async () => {
    const app = testApp();
    const first = await request(app)
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });
    const duplicate = await request(app)
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(first.body).toEqual(verifiedResult);
    expect(duplicate.body).toEqual(verifiedResult);
    expect(mocks.commitStagedCategorization).toHaveBeenCalledTimes(2);
  });

  it('replays a recorded commit result after disconnect without a route connection veto', async () => {
    const app = testApp();
    const first = await request(app)
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: new Date('2026-07-27T00:00:00.000Z'),
    });

    const duplicate = await request(app)
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual(verifiedResult);
    expect(mocks.commitStagedCategorization).toHaveBeenCalledTimes(2);
  });

  it('delegates a disconnected new commit so the lifecycle service can reject it', async () => {
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: new Date('2026-07-27T00:00:00.000Z'),
    });
    mocks.commitStagedCategorization.mockRejectedValue({
      name: 'WritebackLifecycleError',
      code: 'COMPANY_DISCONNECTED',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    expect(mocks.commitStagedCategorization).toHaveBeenCalledTimes(1);
  });

  it('maps a transaction scope race from the commit service to a stable 404', async () => {
    mocks.commitStagedCategorization.mockRejectedValue({
      name: 'WritebackLifecycleError',
      code: 'TRANSACTION_NOT_FOUND',
      message: 'internal transaction identity',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Transaction not found.',
      code: 'TRANSACTION_NOT_FOUND',
    });
  });

  it.each([
    ['QBO_PERIOD_CLOSED', 'QuickBooks has closed this accounting period.'],
    ['QBO_TRANSACTION_LOCKED', 'QuickBooks reports this transaction as cleared or reconciled.'],
    ['QBO_WRITE_SAFETY_UNAVAILABLE', 'QuickBooks write-safety status is unavailable.'],
  ])('maps %s to a bounded conflict response', async (code, message) => {
    mocks.commitStagedCategorization.mockRejectedValue({
      name: 'QboWriteSafetyError',
      code,
      message: 'internal provider report detail',
      report: { privateNote: 'secret' },
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(code === 'QBO_WRITE_SAFETY_UNAVAILABLE' ? 503 : 409);
    expect(response.body).toEqual({ error: message, code });
    expect(JSON.stringify(response.body)).not.toMatch(/internal|provider|private|secret/i);
  });

  it.each([
    [
      'QBO_DEPOSIT_UNSUPPORTED',
      'This transaction cannot use tax-aware Deposit writeback.',
    ],
    [
      'QBO_REFERENCE_MISSING',
      'Required QuickBooks references are unavailable.',
    ],
    [
      'QBO_AMOUNT_UNSAFE',
      'The transaction amount cannot be categorized safely.',
    ],
    [
      'QBO_ENTITY_UNSUPPORTED',
      'This transaction type cannot use tax-aware writeback.',
    ],
  ])('maps %s preparation failures to bounded client responses', async (code, message) => {
    mocks.commitStagedCategorization.mockRejectedValue({
      name: 'QboPreparationError',
      code,
      message: 'internal raw entity and reference detail',
      rawPayload: { privateNote: 'secret' },
      stack: 'internal stack',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: message, code });
    expect(JSON.stringify(response.body)).not.toMatch(/raw|private|secret|stack|internal/i);
  });

  it.each([
    ['unknown commit field', { expectedRevision: 1, requestId: REQUEST_ID, force: true }],
    ['invalid request ID', { expectedRevision: 1, requestId: 'REQUEST_GENERIC' }],
    ['unsafe expected revision', { expectedRevision: 2_147_483_647, requestId: REQUEST_ID }],
  ])('strictly rejects %s', async (_name, body) => {
    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION' });
    expect(mocks.commitStagedCategorization).not.toHaveBeenCalled();
  });

  it('returns a bounded uncertain response with only stable verification guidance', async () => {
    mocks.commitStagedCategorization.mockResolvedValue({
      transactionId: TRANSACTION_ID,
      requestId: REQUEST_ID,
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message: 'raw service payload token=secret',
        rawPayload: { token: 'secret' },
      },
      beforeSnapshot: { privateNote: 'secret' },
      stack: 'internal stack',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/commit`)
      .set(sessionHeaders)
      .send({ expectedRevision: 1, requestId: REQUEST_ID });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      transactionId: TRANSACTION_ID,
      requestId: REQUEST_ID,
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message: 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.',
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/payload|snapshot|token|stack|secret/i);
  });

  it('delegates an unresolved retry to reconciliation and never the legacy reset', async () => {
    mocks.reconcileMutationAttempt.mockResolvedValue({
      ...verifiedResult,
      outcome: 'UNCHANGED',
      status: 'PENDING',
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/retry`)
      .set(sessionHeaders)
      .send({ requestId: REQUEST_ID });

    expect(response.status).toBe(200);
    expect(mocks.reconcileMutationAttempt).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      actor: { id: 'transaction-route-user', label: 'Generic categorizer' },
    });
    expect(mocks.retryError).not.toHaveBeenCalled();
  });

  it('requires admin authority and the exact live service for a live recheck', async () => {
    const liveInput = {
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      qboType: 'Purchase',
      qboId: 'purchase-generic',
      requestId: REQUEST_ID,
      operation: 'recategorize',
      expectedRevision: 1,
      configVersion: 'config-v1',
      requestHash: 'a'.repeat(64),
      checkpointHash: 'b'.repeat(64),
    };
    mocks.isLiveReconciliationOwnedRequest.mockResolvedValue(true);
    mocks.loadLiveReconciliationRequest.mockResolvedValue(liveInput);

    const denied = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/reconcile`)
      .set(sessionHeaders)
      .send({ requestId: REQUEST_ID });
    expect(denied.status).toBe(403);
    expect(mocks.reconcileLiveMutation).not.toHaveBeenCalled();

    role = 'admin';
    const allowed = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/reconcile`)
      .set(sessionHeaders)
      .send({ requestId: REQUEST_ID });
    expect(allowed.status).toBe(200);
    expect(mocks.reconcileLiveMutation).toHaveBeenCalledWith(
      liveInput,
      {
        actor: {
          id: 'transaction-route-user',
          label: 'Generic categorizer',
        },
      },
    );
    expect(mocks.reconcileMutationAttempt).not.toHaveBeenCalled();
  });

  it('fails closed for a live-owned request whose exact binding has drifted', async () => {
    mocks.isLiveReconciliationOwnedRequest.mockResolvedValue(true);
    mocks.loadLiveReconciliationRequest.mockResolvedValue(null);

    const denied = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/reconcile`)
      .set(sessionHeaders)
      .send({ requestId: REQUEST_ID });
    expect(denied.status).toBe(403);
    expect(mocks.reconcileMutationAttempt).not.toHaveBeenCalled();

    role = 'admin';
    const drifted = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/reconcile`)
      .set(sessionHeaders)
      .send({ requestId: REQUEST_ID });
    expect(drifted.status).toBe(409);
    expect(mocks.reconcileMutationAttempt).not.toHaveBeenCalled();
    expect(mocks.reconcileLiveMutation).not.toHaveBeenCalled();
  });

  it('rejects a reconcile request scoped to another transaction before service mutation', async () => {
    mocks.mutationAttemptFindUnique.mockResolvedValue({ transactionId: OTHER_TRANSACTION_ID });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/reconcile`)
      .set(sessionHeaders)
      .send({ requestId: REQUEST_ID });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
    expect(mocks.reconcileMutationAttempt).not.toHaveBeenCalled();
  });

  it('returns a safe conflict response for an expired new undo window', async () => {
    mocks.undoCategorization.mockRejectedValueOnce({ name: 'WritebackLifecycleError', code: 'UNDO_WINDOW_EXPIRED', message: 'synthetic internal detail' });
    const response = await request(testApp()).post(`/api/transactions/${TRANSACTION_ID}/categorization/undo`).set(sessionHeaders).send({ requestId: UNDO_REQUEST_ID });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'UNDO_WINDOW_EXPIRED', error: 'The 30-day undo window is unavailable for this transaction.' });
    expect(JSON.stringify(response.body)).not.toContain('synthetic internal detail');
  });

  it('uses a strict Recat UUID for undo and forwards only scoped service input', async () => {
    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/undo`)
      .set(sessionHeaders)
      .send({ requestId: UNDO_REQUEST_ID });

    expect(response.status).toBe(200);
    expect(mocks.undoCategorization).toHaveBeenCalledWith({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      requestId: UNDO_REQUEST_ID,
      actor: { id: 'transaction-route-user', label: 'Generic categorizer' },
    });
  });

  it('replays a recorded undo result after disconnect without a route connection veto', async () => {
    const app = testApp();
    const first = await request(app)
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/undo`)
      .set(sessionHeaders)
      .send({ requestId: UNDO_REQUEST_ID });
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: new Date('2026-07-27T00:00:00.000Z'),
    });

    const duplicate = await request(app)
      .post(`/api/transactions/${TRANSACTION_ID}/categorization/undo`)
      .set(sessionHeaders)
      .send({ requestId: UNDO_REQUEST_ID });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({
      ...verifiedResult,
      requestId: UNDO_REQUEST_ID,
      status: 'REVERTED',
    });
    expect(mocks.undoCategorization).toHaveBeenCalledTimes(2);
  });

  it('keeps the legacy unavailable-tax category/tag staging request compatible', async () => {
    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorize`)
      .set(sessionHeaders)
      .send({
        category: 'Prepared purchases',
        categoryQboId: 'EXPENSE_ACCOUNT',
        tagIds: [TAG_ID],
      });

    expect(response.status).toBe(200);
    expect(mocks.transactionUpdate).toHaveBeenCalled();
    expect(mocks.txnTagCreate).toHaveBeenCalledWith({
      data: { txnId: TRANSACTION_ID, tagId: TAG_ID },
    });
    expect(mocks.stageCategorization).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported readiness', 'Purchase', 'unsupported', true],
    ['setup-incomplete readiness', 'Purchase', 'needs_setup', true],
    ['tax disabled', 'Purchase', 'ready', false],
    ['unsupported transaction', 'JournalEntry', 'ready', true],
  ] as const)('preserves direct legacy categorization for %s', async (
    _case,
    qboType,
    taxSupportStatus,
    taxUsingSalesTax,
  ) => {
    mocks.transactionFindUnique.mockResolvedValue({ ...transactionRow, qboType });
    mocks.companyFindUnique.mockResolvedValue({
      id: COMPANY_ID,
      disconnectedAt: null,
      taxSupportStatus,
      taxUsingSalesTax,
    });

    const response = await request(testApp())
      .post(`/api/transactions/${TRANSACTION_ID}/categorize`)
      .set(sessionHeaders)
      .send({
        category: 'Generic prepared expense',
        categoryQboId: 'EXPENSE_ACCOUNT',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mocks.transactionUpdate).toHaveBeenCalled();
  });
});
