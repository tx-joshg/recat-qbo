import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware, HttpError } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), company: vi.fn(), membership: vi.fn(),
  caseDetail: vi.fn(), currentCase: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company },
  membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/companyReads.js', () => ({
  getClassificationCase: mocks.caseDetail,
  getCurrentClassificationCase: mocks.currentCase,
}));

import { classificationRouter } from './classification.js';

function app() {
  const value = express();
  value.use(cookieParser()); value.use(express.json());
  value.use('/api/companies/:companyId/classification', classificationRouter);
  value.use(errorMiddleware);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: 'session-a', expiresAt: new Date(Date.now() + 60_000), user: {
    id: 'user-a', email: 'a@example.invalid', name: null, isInstanceAdmin: false, memberships: [],
  } });
  mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: new Date() });
  mocks.membership.mockResolvedValue({ role: 'viewer' });
  mocks.caseDetail.mockResolvedValue({ id: 'case-a' });
  mocks.currentCase.mockResolvedValue({ id: 'case-current' });
});

describe('session classification reads', () => {
  it('exposes historical case detail and the active verified case for a transaction', async () => {
    const historical = await request(app()).get('/api/companies/company-a/classification/cases/case-a')
      .set('Cookie', 'recat_session=test');
    const current = await request(app()).get('/api/companies/company-a/classification/cases/current')
      .query({ transactionId: 'txn-a' }).set('Cookie', 'recat_session=test');

    expect(historical.status).toBe(200);
    expect(current.status).toBe(200);
    expect(mocks.caseDetail).toHaveBeenCalledWith('user-a', 'company-a', 'case-a');
    expect(mocks.currentCase).toHaveBeenCalledWith('user-a', 'company-a', 'txn-a');
  });

  it('returns a missing current case without inventing recurring intent', async () => {
    mocks.currentCase.mockRejectedValueOnce(new HttpError(404, 'No verified case', 'CASE_NOT_FOUND'));
    const response = await request(app()).get('/api/companies/company-a/classification/cases/current')
      .query({ transactionId: 'txn-a' }).set('Cookie', 'recat_session=test');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('CASE_NOT_FOUND');
  });

  it('rejects missing transaction identity and nonmembers before reading cases', async () => {
    await request(app()).get('/api/companies/company-a/classification/cases/current')
      .set('Cookie', 'recat_session=test').expect(400);
    mocks.membership.mockResolvedValueOnce(null);
    await request(app()).get('/api/companies/company-a/classification/cases/current')
      .query({ transactionId: 'txn-a' }).set('Cookie', 'recat_session=test').expect(403);
    expect(mocks.currentCase).not.toHaveBeenCalled();
  });

});
