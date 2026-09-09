import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, errorMiddleware } from '../lib/http.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

const mocks = vi.hoisted(() => {
  const company = {
    id: 'company-1',
    realmId: 'realm-1',
    legalName: 'Acme Books',
    nickname: 'Acme',
    env: 'sandbox',
    syncMode: 'polling',
    pollIntervalMin: 10,
    holdingAccountIds: ['holding-1'],
    dryRun: false,
    tagsRequired: false,
    accessToken: 'encrypted-access',
    refreshToken: 'encrypted-refresh',
    tokenExpiresAt: new Date('2026-07-29T13:00:00.000Z'),
    connectedAt: new Date('2026-07-01T00:00:00.000Z'),
    disconnectedAt: null as Date | null,
    lastSyncedAt: null,
    taxReferenceRefreshedAt: null,
    taxUsingSalesTax: null,
    taxSupportStatus: 'needs_setup',
    taxSupportReason: null,
  };
  const config = {
    liveRequested: true,
    liveAcceptedPolicyVersion: 'recat-live-purchase-v1' as string | null,
    liveAcceptedConfigVersion: 'config-current' as string | null,
    liveAcceptedProviderBinding: 'binding-current' as string | null,
    livePausedAt: null as Date | null,
    livePauseCode: null as string | null,
    livePauseMessage: null as string | null,
  };
  const rootCompanyUpdate = vi.fn();
  const transaction = vi.fn();
  const revoke = vi.fn();
  const qboForCompany = vi.fn();
  return { company, config, rootCompanyUpdate, transaction, revoke, qboForCompany,
    revocation: null as null | { id: string; realmId: string; encryptedRefreshToken: string } };

});

vi.mock('../lib/prisma.js', () => {
  const updateCompany = async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(mocks.company, data);
    return { ...mocks.company };
  };
  const transactionDb = {
    qboTokenRevocation: {
      create: async ({ data }: { data: { realmId: string; encryptedRefreshToken: string } }) => {
        mocks.revocation = { id: 'synthetic-revocation', ...data };
        return { id: mocks.revocation.id };
      },
      findFirst: async () => mocks.revocation,
    },
    company: {
      findUnique: async () => ({ ...mocks.company }),
      update: vi.fn(updateCompany),
    },
    agentCompanyConfig: {
      updateMany: vi.fn(async ({ where, data }: {
        where: { companyId: string; liveRequested: boolean };
        data: Record<string, unknown>;
      }) => {
        if (where.companyId === mocks.company.id && where.liveRequested === mocks.config.liveRequested) {
          Object.assign(mocks.config, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };
  mocks.rootCompanyUpdate.mockImplementation(updateCompany);
  mocks.transaction.mockImplementation(async (callback) => callback(transactionDb));
  return {
    prisma: {
      $transaction: mocks.transaction,
      company: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(async () => ({ ...mocks.company })),
        update: mocks.rootCompanyUpdate,
      },
    },
  };
});

vi.mock('../lib/qbo/factory.js', () => ({
  hasIntuitCredentials: vi.fn().mockResolvedValue(true),
  qboFactory: {
    authorizeUrl: vi.fn(),
    forCompany: mocks.qboForCompany,
  },
  revokeCapturedQboToken: mocks.revoke,
  testCompanyConnection: vi.fn(),
}));

vi.mock('../services/qboTokenRevocation.js', () => ({
  processQboTokenRevocation: async (id: string) => {
    const record = mocks.revocation;
    if (record === null || record.id !== id) return;
    await mocks.revoke({ realmId: record.realmId, refreshToken: record.encryptedRefreshToken });
    mocks.revocation = null;
  },
}));

vi.mock('../middleware/auth.js', () => {
  const requireUser: RequestHandler = (req, _res, next) => {
    if (req.header('x-test-admin') !== 'true') {
      next(new HttpError(401, 'Not signed in', 'UNAUTHENTICATED'));
      return;
    }
    req.user = {
      id: 'admin-1',
      isInstanceAdmin: true,
      memberships: [],
    } as NonNullable<typeof req.user>;
    next();
  };
  return {
    requireUser,
    requireInstanceAdmin: ((_req, _res, next) => next()) satisfies RequestHandler,
    requireRole: () => ((_req, _res, next) => next()) satisfies RequestHandler,
  };
});

vi.mock('../services/sync.js', () => ({
  syncCompany: vi.fn(),
}));

import { companiesRouter } from './companies.js';

function app() {
  const application = express();
  application.use(express.json());
  application.use('/api/companies', companiesRouter);
  application.use(errorMiddleware);
  return application;
}

beforeEach(() => {
  mocks.revocation = null;
  mocks.company.dryRun = false;
  mocks.company.disconnectedAt = null;
  mocks.company.accessToken = 'encrypted-access';
  mocks.company.refreshToken = 'encrypted-refresh';
  mocks.company.tokenExpiresAt = new Date('2026-07-29T13:00:00.000Z');
  Object.assign(mocks.config, {
    liveRequested: true,
    liveAcceptedPolicyVersion: 'recat-live-purchase-v1',
    liveAcceptedConfigVersion: 'config-current',
    liveAcceptedProviderBinding: 'binding-current',
    livePausedAt: null,
    livePauseCode: null,
    livePauseMessage: null,
  });
  vi.clearAllMocks();
  mocks.revoke.mockResolvedValue(undefined);
  vi.setSystemTime(NOW);
});

describe('holding account options', () => {
  it('returns and counts a localized Uncategorised holding account', async () => {
    const listAccounts = vi.fn().mockResolvedValue([
      {
        qboId: 'localized-expense',
        name: 'Localized expense | Uncategorised Expense',
        fullName: 'Localized expense | Uncategorised Expense',
        classification: 'Expenses',
        active: true,
      },
    ]);
    const listTxnsInAccounts = vi.fn().mockResolvedValue([
      { lines: [{ accountQboId: 'localized-expense' }] },
    ]);
    mocks.qboForCompany.mockResolvedValue({ listAccounts, listTxnsInAccounts });

    const response = await request(app())
      .get('/api/companies/company-1/holding-account-options')
      .set('x-test-admin', 'true');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{
      qboId: 'localized-expense',
      name: 'Localized expense | Uncategorised Expense',
      count: 1,
    }]);
  });
});

describe('company routes preserve live authority invariants', () => {
  it('atomically invalidates requested live acceptance when dry-run changes', async () => {
    const response = await request(app())
      .patch('/api/companies/company-1')
      .set('x-test-admin', 'true')
      .send({ dryRun: true });

    expect(response.status).toBe(200);
    expect(mocks.rootCompanyUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(mocks.company.dryRun).toBe(true);
    expect(mocks.config).toMatchObject({
      liveRequested: true,
      liveAcceptedPolicyVersion: null,
      liveAcceptedConfigVersion: null,
      liveAcceptedProviderBinding: null,
      livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
    });
  });

  it('atomically disconnects QBO and pauses requested live mode', async () => {
    const response = await request(app())
      .delete('/api/companies/company-1')
      .set('x-test-admin', 'true');

    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(expect.objectContaining({
      realmId: 'realm-1',
      refreshToken: 'encrypted-refresh',
    }));
    expect(mocks.rootCompanyUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(mocks.company).toMatchObject({
      disconnectedAt: NOW,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
    });
    expect(mocks.config).toMatchObject({
      liveRequested: true,
      liveAcceptedPolicyVersion: null,
      liveAcceptedConfigVersion: null,
      liveAcceptedProviderBinding: null,
      livePauseCode: 'QBO_DISCONNECTED',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/encrypted-refresh|capability/i);
  });

  it('makes the local disconnect and live pause visible before a delayed external revoke resolves', async () => {
    let releaseRevoke: (() => void) | undefined;
    const delayedRevoke = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    mocks.revoke.mockReturnValueOnce(delayedRevoke);

    const responsePromise = request(app())
      .delete('/api/companies/company-1')
      .set('x-test-admin', 'true')
      .then((response) => response);

    try {
      await vi.waitFor(() => {
        expect(mocks.revoke).toHaveBeenCalled();
      });
      expect(mocks.company).toMatchObject({
        disconnectedAt: NOW,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
      });
      expect(mocks.config).toMatchObject({
        liveRequested: true,
        liveAcceptedPolicyVersion: null,
        liveAcceptedConfigVersion: null,
        liveAcceptedProviderBinding: null,
        livePauseCode: 'QBO_DISCONNECTED',
      });
    } finally {
      releaseRevoke?.();
      await responsePromise;
    }
  });

  it('does not let provider-side revocation preparation failure prevent the local safety transition', async () => {
    mocks.revoke.mockRejectedValueOnce(new Error('REVOCATION_PREPARATION_SENTINEL'));

    const response = await request(app())
      .delete('/api/companies/company-1')
      .set('x-test-admin', 'true');

    expect(response.status).toBe(200);
    expect(mocks.company).toMatchObject({
      disconnectedAt: NOW,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
    });
    expect(mocks.config).toMatchObject({
      liveRequested: true,
      liveAcceptedPolicyVersion: null,
      liveAcceptedConfigVersion: null,
      liveAcceptedProviderBinding: null,
      livePauseCode: 'QBO_DISCONNECTED',
    });
    expect(JSON.stringify(response.body)).not.toContain('REVOCATION_PREPARATION_SENTINEL');
  });
});
