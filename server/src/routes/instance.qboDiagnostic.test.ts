import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware, HttpError } from '../lib/http.js';
import { QboAuthError } from '../lib/qbo/types.js';

const mocks = vi.hoisted(() => ({ session: vi.fn(), company: vi.fn(), verify: vi.fn(), preflight: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company },
} }));
vi.mock('../lib/qbo/factory.js', () => ({
  getIntuitCredentialPreflight: mocks.preflight, testStoredQboConnection: mocks.verify,
}));
import { instanceRouter } from './instance.js';

function app() {
  const result = express();
  result.use(express.json(), cookieParser());
  result.use('/api/instance', instanceRouter);
  result.use(errorMiddleware);
  return result;
}
const url = '/api/instance/settings/test-qbo';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ id: 'synthetic-session', expiresAt: new Date(Date.now() + 60_000),
    user: { id: 'synthetic-admin', isInstanceAdmin: true, memberships: [] } });
  mocks.company.mockResolvedValue({ id: 'synthetic-company' });
  mocks.verify.mockResolvedValue({ kind: 'verified' });
});

describe('stored QuickBooks diagnostic endpoint', () => {
  it('requires a signed-in instance administrator before any company or provider lookup', async () => {
    await request(app()).post(url).send({ companyId: 'synthetic-company' }).expect(401);
    mocks.session.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'synthetic-member', isInstanceAdmin: false,
        memberships: [{ companyId: 'synthetic-company', role: 'admin' }] } });
    await request(app()).post(url).set('Cookie', 'recat_session=synthetic-session')
      .send({ companyId: 'synthetic-company' }).expect(403);
    expect(mocks.company).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it.each([{}, { companyId: '' }, { companyId: 2 }, { companyId: 'synthetic-company', clientSecret: 'untrusted' }])(
    'rejects malformed or credential-bearing request bodies before provider work', async (body) => {
      await request(app()).post(url).set('Cookie', 'recat_session=synthetic-session').send(body).expect(400);
      expect(mocks.verify).not.toHaveBeenCalled();
    },
  );

  it('uses only the explicitly selected existing company and returns no credentials or provider detail', async () => {
    const response = await request(app()).post(url).set('Cookie', 'recat_session=synthetic-session')
      .send({ companyId: 'synthetic-company' }).expect(200);
    expect(response.body).toEqual({ ok: true });
    expect(mocks.company).toHaveBeenCalledWith({ where: { id: 'synthetic-company' }, select: { id: true } });
    expect(mocks.verify).toHaveBeenCalledWith('synthetic-company');
  });

  it('rejects a nonexistent company before provider work', async () => {
    mocks.company.mockResolvedValue(null);
    const response = await request(app()).post(url).set('Cookie', 'recat_session=synthetic-session')
      .send({ companyId: 'synthetic-missing' }).expect(404);
    expect(response.body.code).toBe('COMPANY_NOT_FOUND');
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('never labels demo credentials as verified', async () => {
    mocks.verify.mockResolvedValue({ kind: 'demo' });
    const response = await request(app()).post(url).set('Cookie', 'recat_session=synthetic-session')
      .send({ companyId: 'synthetic-company' }).expect(400);
    expect(response.body.code).toBe('QBO_DEMO_COMPANY');
  });

  it.each([
    new Error('synthetic-sensitive-provider-detail'),
    new HttpError(403, 'synthetic-sensitive-settings-detail', 'UNTRUSTED_CODE'),
    new QboAuthError('synthetic-sensitive-token-detail'),
  ])('returns only a fixed public diagnostic for provider or settings failures', async (error) => {
    mocks.verify.mockRejectedValue(error);
    const response = await request(app()).post(url).set('Cookie', 'recat_session=synthetic-session')
      .send({ companyId: 'synthetic-company' }).expect(502);
    expect(response.body).toEqual({ error: 'QuickBooks connection failed. Reconnect QuickBooks or verify the stored Intuit credentials.', code: 'QBO_CONNECTION_FAILED' });
  });

  it('bounds a failed current-settings preflight without returning a cached success', async () => {
    mocks.preflight.mockRejectedValue(new Error('synthetic-sensitive-settings-detail'));
    const response = await request(app()).post('/api/instance/qbo/preflight')
      .set('Cookie', 'recat_session=synthetic-session').send({}).expect(502);
    expect(response.body.code).toBe('QBO_CREDENTIALS_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('synthetic-sensitive');
  });
});
