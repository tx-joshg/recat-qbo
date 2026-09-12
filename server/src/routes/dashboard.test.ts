import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  dashboardData: vi.fn(),
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
  dashboardData: mocks.dashboardData,
}));

import { dashboardRouter } from './dashboard.js';

const servers: Server[] = [];

function testApp(): Express {
  const app = express();
  app.use('/api/companies/:companyId/dashboard', dashboardRouter);
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

describe('GET /api/companies/:companyId/dashboard', () => {
  it('returns safe terminal dashboard failure without internal payload', async () => {
    mocks.dashboardData.mockRejectedValue(new Error('LOCAL_DATABASE_SENTINEL'));

    const response = await request(testApp(), '/api/companies/company-1/dashboard');
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: 'DASHBOARD_UNAVAILABLE',
      error: 'Dashboard data is temporarily unavailable.',
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain('LOCAL_DATABASE_SENTINEL');
  });
});
