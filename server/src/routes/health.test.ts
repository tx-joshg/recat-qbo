import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({ session: vi.fn(), company: vi.fn(), membership: vi.fn(), config: vi.fn(), health: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company }, membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/classification/embedding/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../services/classification/embedding/client.js')>(), classificationEmbeddingRuntimeConfig: mocks.config }));
vi.mock('../services/classification/embedding/health.js', () => ({ classificationSemanticHealth: mocks.health }));
import { healthRouter } from './health.js';
function app() {
  const value = express(); value.use(cookieParser());
  value.use('/api/companies/:companyId/health', healthRouter); value.use(errorMiddleware); return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), user: { id: 'user-a', email: 'synthetic@example.invalid', isInstanceAdmin: false, memberships: [] } });
  mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: new Date() });
  mocks.membership.mockResolvedValue({ role: 'viewer' });
  mocks.config.mockReturnValue(null);
  mocks.health.mockResolvedValue({ available: false, reason: 'embedding_not_configured' });
});
it('requires a signed-in company viewer and reports unavailable embeddings explicitly', async () => {
  await request(app()).get('/api/companies/company-a/health/classification-search').expect(401);
  const response = await request(app()).get('/api/companies/company-a/health/classification-search').set('Cookie', 'recat_session=synthetic').expect(200);
  expect(response.body).toEqual({ available: false, reason: 'embedding_not_configured' });
  expect(mocks.health).toHaveBeenCalledWith('company-a', expect.objectContaining({ generation: null }));
  mocks.membership.mockResolvedValue(null);
  await request(app()).get('/api/companies/company-a/health/classification-search').set('Cookie', 'recat_session=synthetic').expect(403);
  expect(mocks.health).toHaveBeenCalledTimes(1);
});
it('keeps provider configuration and credentials out of the authenticated health response', async () => {
  const marker = 'synthetic-private-provider-config';
  mocks.config.mockReturnValue({ apiKey: marker, baseUrl: 'http://127.0.0.1:12345/v1', fingerprintSalt: marker });
  mocks.health.mockResolvedValue({ available: true, reason: null });
  const response = await request(app()).get('/api/companies/company-a/health/classification-search').set('Cookie', 'recat_session=synthetic').expect(200);
  expect(response.body).toEqual({ available: true, reason: null });
  expect(JSON.stringify(response.body)).not.toContain(marker);
});

it('reports invalid embedding configuration with a bounded diagnostic', async () => {
  mocks.config.mockImplementation(() => { throw new Error('synthetic-private-configuration'); });
  const response = await request(app()).get('/api/companies/company-a/health/classification-search').set('Cookie', 'recat_session=synthetic').expect(200);
  expect(response.body.lastError).toBe('invalid_configuration');
  expect(JSON.stringify(response.body)).not.toContain('synthetic-private-configuration');
});
