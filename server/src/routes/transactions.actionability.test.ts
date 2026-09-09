import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { QboRateLimitError } from '../lib/qbo/types.js';
import { companyTransactionsRouter } from './transactions.js';

const mocks = vi.hoisted(() => ({
  company: vi.fn(), membership: vi.fn(), session: vi.fn(), refresh: vi.fn(),
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  company: { findUnique: mocks.company }, membership: { findUnique: mocks.membership },
  session: { findUnique: mocks.session },
} }));
vi.mock('../services/providerActionabilityRefresh.js', () => ({
  MAX_ACTIONABILITY_REFRESH_LIMIT: 1, refreshProviderActionability: mocks.refresh,
}));

const endpoint = '/api/companies/company-fixture/transactions/actionability/refresh';
const page = {
  companyId: 'company-fixture', processed: 1, persisted: 1, failed: 0,
  nextCursor: 'transaction-fixture', partial: true, complete: false,
  items: [{ transactionId: 'transaction-fixture', persisted: true, disposition: 'WRITABLE', errorCode: null }],
};
function app() {
  const server = express();
  server.use(cookieParser(), express.json());
  server.use('/api/companies/:companyId/transactions', companyTransactionsRouter);
  server.use(errorMiddleware);
  return server;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.company.mockResolvedValue({ id: 'company-fixture', disconnectedAt: null });
  mocks.membership.mockResolvedValue({ role: 'categorizer' });
  mocks.session.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: 'user-fixture', isInstanceAdmin: false, memberships: [] },
  });
  mocks.refresh.mockResolvedValue(page);
});

describe('bounded QuickBooks status refresh route', () => {
  it('forwards the authorized company and cursor and returns the shared page shape', async () => {
    const response = await request(app()).post(endpoint).query({ limit: 1, cursor: 'previous-fixture' })
      .set('Cookie', 'recat_session=synthetic-session');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(mocks.refresh).toHaveBeenCalledWith('user-fixture', 'company-fixture', { limit: 1, cursor: 'previous-fixture' });
  });

  it.each([{ limit: 2 }, { cursor: 'x'.repeat(129) }])('rejects an unbounded request %j before reading QBO', async (query) => {
    const response = await request(app()).post(endpoint).query(query).set('Cookie', 'recat_session=synthetic-session');
    expect(response.status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('rejects a user without membership before reading QBO', async () => {
    mocks.membership.mockResolvedValue(null);
    const response = await request(app()).post(endpoint).set('Cookie', 'recat_session=synthetic-session');
    expect(response.status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('returns a sanitized bounded 429 without fabricating cursor progress', async () => {
    mocks.refresh.mockRejectedValue(new QboRateLimitError(999_999, 'Synthetic upstream body must stay private'));
    const response = await request(app()).post(endpoint).query({ limit: 1, cursor: 'retry-this-fixture' })
      .set('Cookie', 'recat_session=synthetic-session');
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.body).toEqual({ error: 'QuickBooks is temporarily rate limited. Retry this status check.', code: 'RATE_LIMITED' });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
