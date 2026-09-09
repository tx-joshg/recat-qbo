import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({ groupBy: vi.fn(), session: vi.fn(), company: vi.fn(), membership: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  transaction: { groupBy: mocks.groupBy },
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company },
  membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/reports.js', () => ({
  balanceSheet: vi.fn(), customReport: vi.fn(), profitAndLoss: vi.fn(),
  setTransactionLogTags: vi.fn(), statementDrilldown: vi.fn(), transactionLog: vi.fn(),
}));
import { reportsRouter } from './reports.js';
const servers: Server[] = [];
async function request(companyId = 'company-a', signedIn = true) {
  const app = express();
  app.use(cookieParser());
  app.use('/api/companies/:companyId/reports', reportsRouter);
  app.use(errorMiddleware);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return fetch(`http://127.0.0.1:${address.port}/api/companies/${companyId}/reports/bank-accounts`, {
    headers: signedIn ? { cookie: 'recat_session=test-session' } : {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), user: { id: 'user-a', isInstanceAdmin: false } });
  mocks.company.mockImplementation(async ({ where }) => ({ id: where.id, disconnectedAt: null }));
  mocks.membership.mockResolvedValue({ role: 'viewer' });
  mocks.groupBy.mockResolvedValue([{ bankAccount: 'Example Bank A' }, { bankAccount: 'Example Bank B' }]);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});
describe('company bank account filters', () => {
  it('allows viewers to read only grouped bank names across all transaction states', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(['Example Bank A', 'Example Bank B']);
    expect(mocks.groupBy).toHaveBeenCalledWith({ by: ['bankAccount'], where: { companyId: 'company-a' }, orderBy: { bankAccount: 'asc' } });
    expect(mocks.membership).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_companyId: { userId: 'user-a', companyId: 'company-a' } } }));
  });
  it('keeps local account filters available after QuickBooks disconnects', async () => {
    mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: new Date() });
    mocks.groupBy.mockResolvedValue([]);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it('does not read another company without membership', async () => {
    mocks.membership.mockResolvedValue(null);
    expect((await request('company-b')).status).toBe(403);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
  it('requires a signed-in session before reading accounts', async () => {
    expect((await request('company-a', false)).status).toBe(401);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
});
