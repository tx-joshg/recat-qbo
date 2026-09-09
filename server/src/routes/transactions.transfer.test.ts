import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { transactionActionsRouter } from './transactions.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const SOURCE_ID = '00000000-0000-4000-8000-000000000020';
const COUNTERPART_ID = '00000000-0000-4000-8000-000000000030';
const OPERATION_ID = '00000000-0000-4000-8000-000000000040';

const SENTINELS = {
  payee: 'PRIVATE_PAYEE_SENTINEL',
  memo: 'PRIVATE_MEMO_SENTINEL',
  account: 'PRIVATE_ACCOUNT_SENTINEL',
  provider: 'PRIVATE_PROVIDER_ERROR_SENTINEL',
  token: 'PRIVATE_TOKEN_SENTINEL',
  body: 'PRIVATE_BODY_SENTINEL',
  snapshot: 'PRIVATE_SNAPSHOT_SENTINEL',
} as const;

const mocks = vi.hoisted(() => ({
  commitTransfer: vi.fn(),
  getTransferOperation: vi.fn(),
  membershipFindUnique: vi.fn(),
  prepareTransfer: vi.fn(),
  retryTransferOperation: vi.fn(),
  sessionFindUnique: vi.fn(),
  suggestForMany: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => ({ holdingAccountIds: [] })) },
    membership: { findUnique: mocks.membershipFindUnique },
    session: { findUnique: mocks.sessionFindUnique },
    transaction: {
      findMany: mocks.transactionFindMany,
      findUnique: mocks.transactionFindUnique,
    },
    user: { findMany: mocks.userFindMany },
  },
}));

// Keep the route and recordTransfer wrapper real. Stub only the durable
// prepare/commit boundary that is also consumed by the MCP transfer adapter.
vi.mock('../services/transferOperations.js', () => ({
  prepareTransfer: mocks.prepareTransfer,
}));

vi.mock('../services/transferExecution.js', () => ({
  commitTransfer: mocks.commitTransfer,
  getTransferOperation: mocks.getTransferOperation,
  retryTransferOperation: mocks.retryTransferOperation,
}));

vi.mock('../services/suggestions.js', () => ({
  ruleSuggestion: vi.fn(() => null),
  suggestForMany: mocks.suggestForMany,
}));

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/transactions', transactionActionsRouter);
  app.use(errorMiddleware);
  return app;
}

const sessionHeaders = { Cookie: 'recat_session=transfer-route-test' };
let role: 'viewer' | 'categorizer' | 'admin' = 'categorizer';

function transactionRow(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    companyId: COMPANY_ID,
    qboId: id === SOURCE_ID ? 'QBO_SOURCE' : 'QBO_COUNTERPART',
    qboType: id === SOURCE_ID ? 'Purchase' : 'Deposit',
    qboSyncToken: '7',
    date: new Date('2026-07-29T00:00:00.000Z'),
    payee: 'Generic counterparty',
    memo: null,
    amount: id === SOURCE_ID ? -42 : 42,
    bankAccount: id === SOURCE_ID ? 'Generic source account' : 'Generic target account',
    status: 'POSTED',
    revision: id === SOURCE_ID ? 3 : 5,
    category: 'Generic transfer account',
    categoryQboId: 'GENERIC_TRANSFER_ACCOUNT',
    taxCalculation: 'NotApplicable',
    taxCode: null,
    taxCodeQboId: null,
    suggestion: null,
    errorCode: null,
    errorMessage: null,
    postedAt: new Date('2026-07-29T00:05:00.000Z'),
    postedByUserId: null,
    splitLines: [],
    txnTags: [],
    qboMutationAttempts: [],
    ...overrides,
  };
}

function transferResult(
  state:
    | 'PREPARED'
    | 'VERIFIED'
    | 'PARTIAL'
    | 'RETRYABLE'
    | 'UNCERTAIN',
  errorMessage?: string,
) {
  const complete = state === 'VERIFIED';
  const firstOutcome = state === 'VERIFIED'
    ? 'VERIFIED'
    : state === 'PARTIAL'
      ? 'VERIFIED'
      : state === 'UNCERTAIN'
        ? 'UNCERTAIN'
        : state === 'RETRYABLE'
          ? 'RETRYABLE'
          : 'IN_PROGRESS';
  const secondOutcome = state === 'VERIFIED'
    ? 'VERIFIED'
    : state === 'UNCERTAIN'
      ? 'UNCERTAIN'
      : state === 'RETRYABLE'
        ? 'RETRYABLE'
        : 'IN_PROGRESS';
  return {
    operationId: OPERATION_ID,
    state,
    complete,
    firstLeg: { outcome: firstOutcome },
    secondLeg: { outcome: secondOutcome },
    ...(errorMessage === undefined
      ? {}
      : { error: { code: 'INTERNAL_TRANSFER_DETAIL', message: errorMessage } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  role = 'categorizer';
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'route-user',
      email: 'route-user@example.test',
      name: 'Generic operator',
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.membershipFindUnique.mockImplementation(async () => ({ role }));
  mocks.transactionFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => {
      if (where.id === SOURCE_ID) return transactionRow(SOURCE_ID);
      if (where.id === COUNTERPART_ID) return transactionRow(COUNTERPART_ID);
      return null;
    },
  );
  mocks.transactionFindMany.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
  mocks.suggestForMany.mockResolvedValue([]);
  mocks.prepareTransfer.mockResolvedValue({
    operationId: OPERATION_ID,
    state: 'PREPARED',
    expiresAt: '2026-07-29T01:00:00.000Z',
    preview: {
      action: 'record_transfer',
      direction: 'between_accounts',
      totalCents: 4200,
      legCount: 2,
      preparationDigest: 'a'.repeat(64),
    },
  });
  mocks.getTransferOperation.mockResolvedValue(transferResult('PREPARED'));
  mocks.commitTransfer.mockResolvedValue(transferResult('VERIFIED'));
  mocks.retryTransferOperation.mockRejectedValue(
    new Error('Unexpected retry in route test'),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/transactions/:id/transfer', () => {
  it('keeps session and company-role authorization ahead of the shared write boundary', async () => {
    const unauthenticated = await request(testApp())
      .post(`/api/transactions/${SOURCE_ID}/transfer`)
      .send({ counterpartTxnId: COUNTERPART_ID });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      error: 'Not signed in',
      code: 'UNAUTHENTICATED',
    });
    expect(mocks.prepareTransfer).not.toHaveBeenCalled();
    expect(mocks.commitTransfer).not.toHaveBeenCalled();

    role = 'viewer';
    const forbidden = await request(testApp())
      .post(`/api/transactions/${SOURCE_ID}/transfer`)
      .set(sessionHeaders)
      .send({ counterpartTxnId: COUNTERPART_ID });

    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({
      error: 'You do not have permission to do that',
      code: 'FORBIDDEN',
    });
    expect(mocks.membershipFindUnique).toHaveBeenCalledWith({
      where: {
        userId_companyId: {
          userId: 'route-user',
          companyId: COMPANY_ID,
        },
      },
      select: { role: true },
    });
    expect(mocks.prepareTransfer).not.toHaveBeenCalled();
    expect(mocks.commitTransfer).not.toHaveBeenCalled();
  });

  it('uses the shared durable prepare/commit implementation and returns both refreshed DTOs', async () => {
    const response = await request(testApp())
      .post(`/api/transactions/${SOURCE_ID}/transfer`)
      .set(sessionHeaders)
      .send({ counterpartTxnId: COUNTERPART_ID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ id: SOURCE_ID, status: 'POSTED', revision: 3 }),
      expect.objectContaining({ id: COUNTERPART_ID, status: 'POSTED', revision: 5 }),
    ]);
    expect(mocks.prepareTransfer).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      transactionId: SOURCE_ID,
      counterpartTransactionId: COUNTERPART_ID,
      expectedRevision: 3,
      counterpartExpectedRevision: 5,
      actor: {
        id: 'route-user',
        label: 'Generic operator',
      },
    }));
    expect(mocks.getTransferOperation).toHaveBeenCalledWith(
      OPERATION_ID,
      { id: 'route-user', label: 'Generic operator' },
    );
    expect(mocks.commitTransfer).toHaveBeenCalledWith(
      OPERATION_ID,
      { id: 'route-user', label: 'Generic operator' },
    );
    const includedReads = mocks.transactionFindUnique.mock.calls
      .map(([args]) => args)
      .filter((args) => 'include' in args);
    expect(includedReads.map((args) => args.where.id)).toEqual([
      SOURCE_ID,
      SOURCE_ID,
      COUNTERPART_ID,
    ]);
  });

  it.each(['PREPARED', 'RETRYABLE'] as const)(
    'maps a %s outcome to a fixed retry-safe conflict',
    async (state) => {
      mocks.commitTransfer.mockResolvedValueOnce(transferResult(
        state,
        Object.values(SENTINELS).join(' '),
      ));

      const response = await request(testApp())
        .post(`/api/transactions/${SOURCE_ID}/transfer`)
        .set(sessionHeaders)
        .send({ counterpartTxnId: COUNTERPART_ID });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: 'The transfer was not sent. Retry this transfer.',
        code: 'TRANSFER_RETRYABLE',
      });
    },
  );

  it.each(['PARTIAL', 'UNCERTAIN'] as const)(
    'maps a %s outcome to fixed reconciliation guidance without leaking private evidence',
    async (state) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      mocks.transactionFindUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) => {
          if (where.id === SOURCE_ID) {
            return transactionRow(SOURCE_ID, {
              payee: SENTINELS.payee,
              memo: SENTINELS.memo,
              bankAccount: SENTINELS.account,
            });
          }
          if (where.id === COUNTERPART_ID) return transactionRow(COUNTERPART_ID);
          return null;
        },
      );
      mocks.commitTransfer.mockResolvedValueOnce(transferResult(
        state,
        [
          SENTINELS.provider,
          SENTINELS.token,
          SENTINELS.body,
          SENTINELS.snapshot,
        ].join(' '),
      ));

      const response = await request(testApp())
        .post(`/api/transactions/${SOURCE_ID}/transfer`)
        .set(sessionHeaders)
        .send({ counterpartTxnId: COUNTERPART_ID });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error:
          'The transfer may be partially recorded. Verify both transactions in QuickBooks before retrying.',
        code: 'TRANSFER_RECONCILIATION_REQUIRED',
      });
      const exposed = JSON.stringify({
        response: response.body,
        error: consoleError.mock.calls,
        warn: consoleWarn.mock.calls,
        log: consoleLog.mock.calls,
      });
      for (const sentinel of Object.values(SENTINELS)) {
        expect(exposed).not.toContain(sentinel);
      }
    },
  );

  it('maps an unexpected provider failure to a fixed non-leaking response', async () => {
    const privateDetail = Object.values(SENTINELS).join(' ');
    const providerFailure = Object.assign(new Error(privateDetail), {
      token: SENTINELS.token,
      requestBody: { memo: SENTINELS.body },
      responseSnapshot: { payee: SENTINELS.snapshot },
    });
    mocks.commitTransfer.mockRejectedValueOnce(providerFailure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(testApp())
      .post(`/api/transactions/${SOURCE_ID}/transfer`)
      .set(sessionHeaders)
      .send({ counterpartTxnId: COUNTERPART_ID });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Transfer could not be recorded.',
      code: 'TRANSFER_FAILED',
    });
    const exposed = JSON.stringify({
      response: response.body,
      error: consoleError.mock.calls,
    });
    for (const sentinel of Object.values(SENTINELS)) {
      expect(exposed).not.toContain(sentinel);
    }
  });

  it('rejects extra or unbounded counterpart input before the shared boundary', async () => {
    const extra = await request(testApp())
      .post(`/api/transactions/${SOURCE_ID}/transfer`)
      .set(sessionHeaders)
      .send({ counterpartTxnId: COUNTERPART_ID, unexpected: true });
    const unbounded = await request(testApp())
      .post(`/api/transactions/${SOURCE_ID}/transfer`)
      .set(sessionHeaders)
      .send({ counterpartTxnId: 'x'.repeat(1_000) });

    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('VALIDATION');
    expect(unbounded.status).toBe(400);
    expect(unbounded.body.code).toBe('VALIDATION');
    expect(mocks.prepareTransfer).not.toHaveBeenCalled();
    expect(mocks.commitTransfer).not.toHaveBeenCalled();
  });
});
