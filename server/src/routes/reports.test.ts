import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QboHttpError } from '../lib/qbo/types.js';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  balanceSheet: vi.fn(),
  profitAndLoss: vi.fn(),
  transactionLog: vi.fn(),
  transactionFindMany: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    transaction: { findMany: mocks.transactionFindMany },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireUser: ((_req, _res, next) => next()) satisfies RequestHandler,
  requireRole: () => ((_req, _res, next) => next()) satisfies RequestHandler,
}));

vi.mock('../middleware/company.js', () => ({
  withCompany: () =>
    ((req, _res, next) => {
      req.company = { id: 'company-1' } as NonNullable<typeof req.company>;
      next();
    }) satisfies RequestHandler,
}));

vi.mock('../services/reports.js', () => ({
  balanceSheet: mocks.balanceSheet,
  profitAndLoss: mocks.profitAndLoss,
  transactionLog: mocks.transactionLog,
}));

import { reportsRouter } from './reports.js';

const servers: Server[] = [];

function testApp(): Express {
  const app = express();
  app.use('/api/companies/:companyId/reports', reportsRouter);
  app.use(errorMiddleware);
  return app;
}

async function request(app: Express, path: string): Promise<Response> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return fetch(`http://127.0.0.1:${address.port}${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe('primary report read routes', () => {
  it('returns the P&L fixture', async () => {
    const fixture = { columns: [{ label: 'Total' }], rows: [{ label: 'Net Income', values: [125] }] };
    mocks.profitAndLoss.mockResolvedValue(fixture);

    const response = await request(
      testApp(),
      '/api/companies/company-1/reports/pl?period=0&columns=total&compare=none&basis=cash',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fixture);
  });

  it('returns safe retryable P&L failure without provider payload', async () => {
    mocks.profitAndLoss.mockRejectedValue(new QboHttpError(500, 'RAW_QBO_BODY_SENTINEL'));

    const response = await request(
      testApp(),
      '/api/companies/company-1/reports/pl?period=0&columns=total&compare=none&basis=cash',
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      code: 'QBO_REPORT_UNAVAILABLE',
      error: 'QuickBooks could not provide this report right now.',
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain('RAW_QBO_BODY_SENTINEL');
  });

  it('returns safe retryable balance sheet failure without provider payload', async () => {
    mocks.balanceSheet.mockRejectedValue(new QboHttpError(500, 'RAW_QBO_BODY_SENTINEL'));

    const response = await request(
      testApp(),
      '/api/companies/company-1/reports/bs?asOf=0&compare=none&basis=cash',
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      code: 'QBO_REPORT_UNAVAILABLE',
      error: 'QuickBooks could not provide this report right now.',
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain('RAW_QBO_BODY_SENTINEL');
  });

  it('returns safe retryable transaction-log failure without provider payload', async () => {
    mocks.transactionLog.mockRejectedValue(new QboHttpError(500, 'RAW_QBO_BODY_SENTINEL'));

    const response = await request(
      testApp(),
      '/api/companies/company-1/reports/transaction-log?start=2026-01-01&end=2026-01-31',
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      code: 'QBO_REPORT_UNAVAILABLE',
      error: 'QuickBooks could not provide this report right now.',
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain('RAW_QBO_BODY_SENTINEL');
  });

});
