import { randomUUID, createHash } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { StagedCategorization } from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { errorMiddleware } from '../lib/http.js';
import { mapPurchaseTaxSnapshot, preparePurchaseRecategorization } from '../lib/qbo/purchaseTax.js';
import { QboHttpError, QboRequestTimeout, type QboClient, type QboPreparedWrite, type QboPurchaseSnapshot, type RawPurchase } from '../lib/qbo/types.js';
import { commitStagedCategorization } from '../services/writeback.js';

const provider = vi.hoisted(() => ({ forCompany: vi.fn() }));
vi.mock('../lib/qbo/factory.js', () => ({ qboFactory: provider }));
vi.mock('../services/publicUrl.js', () => ({ allowedOrigins: async () => new Set(['http://localhost:5173']) }));
vi.mock('../env.js', async (load) => {
  const actual = await load<typeof import('../env.js')>();
  return { ...actual, env: { ...actual.env, DRY_RUN: false } };
});
import { transactionActionsRouter } from './transactions.js';
import { classificationRouter } from './classification.js';
import { ruleOperationsRouter } from './ruleOperations.js';

const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describePostgres('browser approval to verified case and recurring rule on PostgreSQL', () => {
  const companies: string[] = [];
  const users: string[] = [];
  afterEach(async () => {
    await prisma.company.deleteMany({ where: { id: { in: companies.splice(0) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
    vi.clearAllMocks();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function fixture(mode: 'verified' | 'rejected' | 'uncertain' = 'verified') {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `approval-${suffix}@example.invalid`, name: 'Synthetic reviewer' } });
    users.push(user.id);
    const token = randomUUID();
    await prisma.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } });
    const company = await prisma.company.create({ data: { realmId: `approval-${suffix}`, legalName: 'Synthetic approval company', nickname: `approval-${suffix}`, dryRun: false, ruleRuntimeMode: 'canonical', holdingAccountIds: ['holding'], taxUsingSalesTax: false, taxSupportStatus: 'ready' } });
    companies.push(company.id);
    await prisma.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
    await prisma.qboAccount.createMany({ data: [
      { companyId: company.id, qboId: 'holding', name: 'Holding', fullName: 'Holding', classification: 'Expenses', active: true },
      { companyId: company.id, qboId: 'expense', name: 'Office supplies', fullName: 'Expenses · Office supplies', classification: 'Expenses', active: true },
    ] });
    let raw: RawPurchase = { Id: `purchase-${suffix}`, SyncToken: '1', TxnDate: '2026-09-01', TotalAmt: 10,
      AccountRef: { value: 'bank' }, CurrencyRef: { value: 'CAD' }, GlobalTaxCalculation: 'NotApplicable',
      Line: [{ Id: 'holding-line', Amount: 10, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding' } } }],
    };
    const txn = await prisma.transaction.create({ data: { companyId: company.id, qboId: raw.Id!, qboType: 'Purchase', qboSyncToken: '1', date: new Date('2026-09-01'), payee: 'Synthetic stationer', amount: '-10.00', bankAccount: 'Synthetic bank', rawData: raw as never } });
    let sent: QboPreparedWrite | undefined;
    const send = vi.fn(async (prepared: QboPreparedWrite) => {
      sent = prepared;
      if (mode === 'rejected') throw new QboHttpError(400, 'Synthetic rejection');
      if (mode === 'uncertain') throw new QboRequestTimeout();
      raw = { ...prepared.body, SyncToken: '2' } as RawPurchase;
      return { ok: true as const, newSyncToken: '2' };
    });
    const client = {
      fetchTxn: vi.fn(async () => ({ qboId: txn.qboId, qboType: 'Purchase', syncToken: raw.SyncToken!, date: '2026-09-01', payee: txn.payee, amount: -10, bankAccount: txn.bankAccount, lines: [], raw })),
      fetchPreparedSnapshot: vi.fn(async () => mapPurchaseTaxSnapshot(raw)),
      fetchWriteSafety: vi.fn(async () => ({ bookCloseDate: null, cleared: false, reconciled: false })),
      prepareRecategorization: vi.fn(async (_fresh: unknown, staged: StagedCategorization, before: QboPurchaseSnapshot, requestId: string) => preparePurchaseRecategorization({ current: raw, holdingAccountQboIds: ['holding'], staged, before, requestId })),
      sendPreparedWrite: send,
    } as unknown as QboClient;
    provider.forCompany.mockResolvedValue(client);
    const app = express(); app.use(cookieParser()); app.use(express.json());
    app.use('/api/transactions', transactionActionsRouter);
    app.use('/api/companies/:companyId/classification', classificationRouter);
    app.use('/api/companies/:companyId/rule-operations', ruleOperationsRouter);
    app.use(errorMiddleware);
    const auth = { Cookie: `recat_session=${token}`, Origin: 'http://localhost:5173' };
    const staged = await request(app).post(`/api/transactions/${txn.id}/categorization/stage`).set(auth).send({ expectedRevision: 0, taxCalculation: 'NotApplicable', lines: [{ grossCents: -1000, categoryQboId: 'expense', taxCodeQboId: null, tagIds: [] }], tagIds: [] });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    const requestId = randomUUID();
    const commit = () => request(app).post(`/api/transactions/${txn.id}/categorization/commit`).set(auth).send({ expectedRevision: staged.body.revision, requestId });
    const currentCase = () => request(app).get(`/api/companies/${company.id}/classification/cases/current`).query({ transactionId: txn.id }).set(auth);
    return { app, auth, txn, company, user, requestId, revision: staged.body.revision, commit, currentCase, send,
      applySentWrite: () => { raw = { ...sent!.body, SyncToken: '2' } as RawPurchase; },
    };
  }

  it('binds an actual REST approval to a verified case usable for two-phase recurring intent', async () => {
    const f = await fixture();
    expect((await f.currentCase()).status).toBe(404);
    const committed = await f.commit();
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body).toMatchObject({ ok: true, outcome: 'VERIFIED', status: 'POSTED' });
    const current = await f.currentCase();
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body).toMatchObject({ reviewer: { userId: f.user.id }, jurisdiction: 'unknown', currency: 'CAD', citations: [], originIntent: 'apply_once' });
    const preparation = await request(f.app).post(`/api/companies/${f.company.id}/rule-operations/from-case/${current.body.id}/prepare`).set(f.auth).send({ matchText: 'Synthetic stationer', idempotencyKey: 'make-recurring' });
    expect(preparation.status, JSON.stringify(preparation.body)).toBe(200);
    expect(preparation.body.status).toBe('PREPARED');
    const ruleCommit = await request(f.app).post(`/api/companies/${f.company.id}/rule-operations/${preparation.body.operationId}/commit`).set(f.auth).send({ idempotencyKey: 'make-recurring' });
    expect(ruleCommit.status, JSON.stringify(ruleCommit.body)).toBe(200);
    expect(ruleCommit.body.status).toBe('COMMITTED');
    expect(await prisma.rule.count({ where: { companyId: f.company.id, canonicalVersion: 2, enabled: true } })).toBe(1);
    await f.commit();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await prisma.classificationCase.count({ where: { companyId: f.company.id } })).toBe(1);
  });

  it.each(['rejected', 'uncertain'] as const)('does not produce a case for a %s provider result', async (mode) => {
    const f = await fixture(mode);
    const result = await f.commit();
    expect(result.body.outcome).toBe(mode === 'rejected' ? 'REJECTED' : 'UNCERTAIN');
    expect((await f.currentCase()).status).toBe(404);
    expect(await prisma.classificationCase.count({ where: { companyId: f.company.id } })).toBe(0);
  });

  it('creates the original approved case only after an uncertain write is verified by REST reconciliation', async () => {
    const f = await fixture('uncertain');
    expect((await f.commit()).body.outcome).toBe('UNCERTAIN');
    expect((await f.currentCase()).status).toBe(404);
    f.applySentWrite();
    const reconciled = await request(f.app).post(`/api/transactions/${f.txn.id}/categorization/reconcile`).set(f.auth).send({ requestId: f.requestId });
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    expect(reconciled.body).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect((await f.currentCase()).body).toMatchObject({ reviewer: { userId: f.user.id }, citations: [], originIntent: 'apply_once' });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret an older verified context-free attempt on browser replay', async () => {
    const f = await fixture();
    await commitStagedCategorization({ transactionId: f.txn.id, companyId: f.company.id, expectedRevision: f.revision, requestId: f.requestId, actor: { id: f.user.id, label: 'Synthetic reviewer' } });
    const before = await prisma.qboMutationAttempt.findUniqueOrThrow({ where: { requestId: f.requestId } });
    expect((await f.commit()).body.outcome).toBe('VERIFIED');
    const after = await prisma.qboMutationAttempt.findUniqueOrThrow({ where: { requestId: f.requestId } });
    expect(after.requestPayload).toEqual(before.requestPayload);
    expect((await f.currentCase()).status).toBe(404);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
