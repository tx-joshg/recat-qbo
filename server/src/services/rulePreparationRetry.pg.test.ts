import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma as db } from '../lib/prisma.js';
import { acquireEntityLease, releaseEntityLease, type EntityLeaseDb } from './entityLease.js';
import { prepareRuleAutoPost, resumeRuleAutoPost } from './ruleAutoPost.js';
import { runCanonicalRuleAutoPosts } from './sync.js';
import { recoverRulePreparationRetries, rememberBusyRulePreparation } from './rulePreparationRetry.js';

const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describePostgres('deferred canonical rule preparation', () => {
  const companies: string[] = [];
  afterEach(async () => { await db.company.deleteMany({ where: { id: { in: companies.splice(0) } } }); });
  afterAll(async () => { await db.$disconnect(); });
  async function fixture() {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `retry-${suffix}`, legalName: 'Example Company', nickname: 'Example',
      ruleRuntimeMode: 'canonical', syncMode: 'webhook', dryRun: true,
      holdingAccountIds: ['holding-example'], taxSupportStatus: 'ready',
    } });
    companies.push(company.id);
    const category = await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'expense-example', name: 'Supplies', fullName: 'Expenses · Supplies',
      classification: 'Expenses', active: true,
    } });
    const transaction = await db.transaction.create({ data: {
      companyId: company.id, qboId: `purchase-${suffix}`, qboType: 'Purchase', qboSyncToken: '1',
      date: new Date('2026-01-15'), payee: 'Example supplier', amount: -25, bankAccount: 'Example bank',
      rawData: { Id: `purchase-${suffix}`, SyncToken: '1', TxnDate: '2026-01-15', TotalAmt: 25,
        AccountRef: { value: 'bank-example' }, GlobalTaxCalculation: 'NotApplicable', Line: [{ Id: '1', Amount: 25,
          DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding-example' } } }] },
    } });
    const rule = await db.rule.create({ data: {
      companyId: company.id, matchText: 'Example supplier', category: category.name, categoryQboId: category.qboId,
      taxCalculation: 'NotApplicable', canonicalVersion: 2, direction: 'Purchase', autoPost: true, enabled: true,
    } });
    const key = { companyId: company.id, qboType: transaction.qboType, qboId: transaction.qboId };
    const input = { companyId: company.id, transactionId: transaction.id, sourceRevision: 0, ruleId: rule.id, ruleRevision: rule.revision };
    return { company, transaction, rule, key, input };
  }
  it('persists an actual busy preparation and rediscovers it without another webhook', async () => {
    const f = await fixture();
    const lease = { db: db as unknown as EntityLeaseDb };
    await acquireEntityLease(f.key, 'other-writer', lease);
    try {
      await expect(prepareRuleAutoPost(f.input)).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
      expect(await runCanonicalRuleAutoPosts(f.company.id)).toMatchObject({ failed: 1, autoPosted: 0 });
      expect(await db.ruleAutoPostPreparation.count({ where: { companyId: f.company.id } })).toBe(0);
      const intent = await db.rulePreparationRetry.findFirstOrThrow({ where: { companyId: f.company.id } });
      expect(intent).toMatchObject({ sourceRevision: 0, attemptCount: 0, state: 'PENDING' });
      await db.rulePreparationRetry.update({ where: { id: intent.id }, data: { dueAt: new Date(0) } });
    } finally { await releaseEntityLease(f.key, 'other-writer', lease); }
    await recoverRulePreparationRetries();
    const prepared = await db.ruleAutoPostPreparation.findFirstOrThrow({ where: { companyId: f.company.id } });
    expect(prepared).toMatchObject({ sourceRevision: 0, state: 'PREPARED' });
    expect(await db.qboMutationAttempt.count({ where: { transactionId: f.transaction.id } })).toBe(0);
    await resumeRuleAutoPost(prepared.id);
    expect(await db.ruleAutoPostPreparation.findUniqueOrThrow({ where: { id: prepared.id } })).toMatchObject({ state: 'DRY_RUN' });
  });
  async function pending(f: Awaited<ReturnType<typeof fixture>>) {
    await rememberBusyRulePreparation(f.input);
    const intent = await db.rulePreparationRetry.findFirstOrThrow({ where: { companyId: f.company.id } });
    await db.rulePreparationRetry.update({ where: { id: intent.id }, data: { dueAt: new Date(0) } });
    return intent;
  }

  it('recovers due webhook work on literal process boot outside nightly sync', async () => {
    const f = await fixture();
    await pending(f);
    const code = `
      import { startJobs, stopJobs } from './src/jobs/scheduler.ts';
      import { prisma } from './src/lib/prisma.ts';
      // Boot recovery is independent of the nightly clock and polling mode.
      Date.prototype.getHours = () => 12;
      startJobs();
      try {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          const count = await prisma.ruleAutoPostPreparation.count({ where: { companyId: process.env.RETRY_TEST_COMPANY } });
          if (count === 1) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (await prisma.ruleAutoPostPreparation.count({ where: { companyId: process.env.RETRY_TEST_COMPANY } }) !== 1) throw new Error('boot did not recover preparation');
      } finally { stopJobs(); await prisma.$disconnect(); }
    `;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(), env: { ...process.env, RETRY_TEST_COMPANY: f.company.id }, timeout: 20000,
    });
    expect(await db.ruleAutoPostPreparation.findFirstOrThrow({ where: { companyId: f.company.id } }))
      .toMatchObject({ sourceRevision: 0, state: 'PREPARED' });
  }, 25000);

  it('shares one finite budget across repeated observations and concurrent ticks', async () => {
    const f = await fixture();
    const intent = await pending(f);
    const lease = { db: db as unknown as EntityLeaseDb };
    await acquireEntityLease(f.key, 'busy-budget', lease);
    try {
      for (let count = 1; count <= 3; count += 1) {
        await db.rulePreparationRetry.update({ where: { id: intent.id }, data: { dueAt: new Date(0) } });
        await Promise.all([recoverRulePreparationRetries(), recoverRulePreparationRetries()]);
        await rememberBusyRulePreparation(f.input);
        expect(await db.rulePreparationRetry.findUniqueOrThrow({ where: { id: intent.id } }))
          .toMatchObject({ attemptCount: count, state: count === 3 ? 'EXHAUSTED' : 'PENDING' });
      }
    } finally { await releaseEntityLease(f.key, 'busy-budget', lease); }
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 0, prepared: 0 });
    expect(await db.ruleAutoPostPreparation.count({ where: { companyId: f.company.id } })).toBe(0);
  }, 15000);

  it.each(['paused', 'disconnected', 'reconnected', 'revision', 'rule-revision', 'disabled', 'winner',
    'category', 'tax', 'split', 'tag', 'attempt', 'cancelled-job', 'attempted-job'])('cancels deferred work after %s changes', async (change) => {
    const f = await fixture();
    const intent = await pending(f);
    if (change === 'paused') {
      await db.company.update({ where: { id: f.company.id }, data: { ruleRuntimeMode: 'paused' } });
      await db.company.update({ where: { id: f.company.id }, data: { ruleRuntimeMode: 'canonical' } });
    } else if (change === 'disconnected') {
      await db.company.update({ where: { id: f.company.id }, data: { disconnectedAt: new Date() } });
      await db.company.update({ where: { id: f.company.id }, data: { disconnectedAt: null } });
    } else if (change === 'reconnected') {
      await db.company.update({ where: { id: f.company.id }, data: { connectedAt: new Date(Date.now() + 1000) } });
    } else if (change === 'revision') {
      await db.transaction.update({ where: { id: f.transaction.id }, data: { revision: 1 } });
    } else if (change === 'rule-revision' || change === 'disabled') {
      await db.rule.update({ where: { id: f.rule.id }, data: change === 'disabled' ? { enabled: false } : { revision: { increment: 1 } } });
    } else if (change === 'winner') {
      const { id: _id, createdAt: _created, updatedAt: _updated, ...rule } = f.rule;
      await db.rule.create({ data: { ...rule, autoPost: false, priority: f.rule.priority - 1 } });
    } else if (change === 'category' || change === 'tax') {
      await db.transaction.update({ where: { id: f.transaction.id }, data: change === 'tax'
        ? { taxCalculation: 'NotApplicable' } : { category: 'Manual choice', categoryQboId: 'expense-example' } });
    } else if (change === 'split') {
      await db.splitLine.create({ data: { txnId: f.transaction.id, idx: 0, amount: -25, category: 'Manual', categoryQboId: 'expense-example' } });
    } else if (change === 'tag') {
      const tag = await db.tag.create({ data: { companyId: f.company.id, name: 'Example', color: '#447799' } });
      await db.txnTag.create({ data: { txnId: f.transaction.id, tagId: tag.id } });
    } else if (change === 'attempt') {
      await db.qboMutationAttempt.create({ data: { transactionId: f.transaction.id, requestId: randomUUID(),
        operation: 'recategorize', status: 'RETRYABLE', expectedRevision: 0, expectedSyncToken: '1',
        requestHash: 'a'.repeat(64), requestPayload: {}, beforeSnapshot: {} } });
    } else {
      await db.agentJob.create({ data: { companyId: f.company.id, transactionId: f.transaction.id,
        revision: 0, configVersion: 'example-version', status: change === 'cancelled-job' ? 'cancelled' : 'retry',
        attemptCount: change === 'attempted-job' ? 1 : 0, dueAt: new Date() } });
    }
    await recoverRulePreparationRetries();
    expect(await db.ruleAutoPostPreparation.count({ where: { companyId: f.company.id } })).toBe(0);
    expect(await db.rulePreparationRetry.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ state: 'CANCELLED' });
  });

  it('cannot move an old retry claim onto a new source revision inside staging', async () => {
    const f = await fixture();
    await pending(f);
    await recoverRulePreparationRetries({ prepare: async (input) => {
      return prepareRuleAutoPost(input, { verify: async (tx, authority) => {
        const { verifyRuleApplicationInsideStageTransaction } = await import('./ruleSuggestionApplication.js');
        const proof = await verifyRuleApplicationInsideStageTransaction(tx, { ...authority, requireAutoPost: true });
        await (tx as unknown as typeof db).transaction.update({ where: { id: f.transaction.id }, data: { revision: 1 } });
        return proof;
      } });
    } });
    expect(await db.ruleAutoPostPreparation.count({ where: { companyId: f.company.id } })).toBe(0);
  });

  it('rejects stale completion tokens and exhausts an abandoned third claim', async () => {
    const f = await fixture();
    const intent = await pending(f);
    await recoverRulePreparationRetries({ prepare: async () => {
      await db.rulePreparationRetry.update({ where: { id: intent.id }, data: { claimToken: 'newer-worker', attemptCount: 3, dueAt: new Date(0) } });
      throw new Error('simulated process loss');
    } });
    expect(await db.rulePreparationRetry.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ state: 'PENDING', claimToken: 'newer-worker', attemptCount: 3 });
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 1, prepared: 0 });
    expect(await db.rulePreparationRetry.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ state: 'EXHAUSTED', attemptCount: 3, claimToken: null });
  });

  it('leaves an existing preparation on its original request and recovery path', async () => {
    const f = await fixture();
    await pending(f);
    const existing = await prepareRuleAutoPost(f.input);
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 1, prepared: 0 });
    const rows = await db.ruleAutoPostPreparation.findMany({ where: { companyId: f.company.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: existing.preparationId, requestId: existing.preparationId, state: 'PREPARED' });
    await resumeRuleAutoPost(existing.preparationId);
    expect(await db.qboMutationAttempt.count({ where: { transactionId: f.transaction.id } })).toBe(1);
  });

  it('keeps the remaining finite budget when the company authority fence is busy', async () => {
    const f = await fixture();
    const intent = await pending(f);
    const { PrismaClient } = await import('@prisma/client');
    const other = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = other.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 880217))::text', f.company.id);
      locked(); await held;
    }, { timeout: 15000 });
    try {
      await acquired;
      expect(await recoverRulePreparationRetries()).toEqual({ examined: 1, prepared: 0 });
      expect(await db.rulePreparationRetry.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ state: 'PENDING', attemptCount: 1 });
    } finally { release(); await holder; await other.$disconnect(); }
    await db.rulePreparationRetry.update({ where: { id: intent.id }, data: { dueAt: new Date(0) } });
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 1, prepared: 1 });
  }, 20000);

  it('allows untouched queued work while preserving its scheduling generation and identity', async () => {
    const f = await fixture();
    const job = await db.agentJob.create({ data: { companyId: f.company.id, transactionId: f.transaction.id,
      revision: 0, configVersion: 'example-version', schedulingGeneration: 7, status: 'queued', dueAt: new Date() } });
    await pending(f);
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 1, prepared: 1 });
    expect(await db.agentJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
  });

  it('remembers initial company-fence contention without waiting for that fence', async () => {
    const f = await fixture();
    const { PrismaClient } = await import('@prisma/client');
    const other = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = other.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 880217))::text', f.company.id);
      locked(); await held;
    }, { timeout: 15000 });
    try {
      await acquired;
      const started = Date.now();
      expect(await runCanonicalRuleAutoPosts(f.company.id)).toMatchObject({ autoPosted: 0, failed: 1 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await db.rulePreparationRetry.findFirstOrThrow({ where: { companyId: f.company.id } })).toMatchObject({ state: 'PENDING', attemptCount: 0 });
    } finally { release(); await holder; await other.$disconnect(); }
    await db.rulePreparationRetry.updateMany({ where: { companyId: f.company.id }, data: { dueAt: new Date(0) } });
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 1, prepared: 1 });
  }, 20000);

  it('prunes only obsolete terminal bindings and never renews a current exhausted budget', async () => {
    const current = await fixture();
    const obsolete = await fixture();
    const kept = await pending(current);
    const removed = await pending(obsolete);
    await db.rulePreparationRetry.updateMany({ where: { id: { in: [kept.id, removed.id] } },
      data: { state: 'EXHAUSTED', attemptCount: 3, claimToken: null, createdAt: new Date('2000-01-01') } });
    await db.transaction.update({ where: { id: obsolete.transaction.id }, data: { revision: 1 } });
    expect(await recoverRulePreparationRetries()).toEqual({ examined: 0, prepared: 0 });
    expect(await db.rulePreparationRetry.findUnique({ where: { id: removed.id } })).toBeNull();
    await rememberBusyRulePreparation(current.input);
    expect(await db.rulePreparationRetry.findUniqueOrThrow({ where: { id: kept.id } }))
      .toMatchObject({ state: 'EXHAUSTED', attemptCount: 3 });
  });

});
