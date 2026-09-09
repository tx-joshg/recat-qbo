import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from '../agent/evaluation.js';
import {
  recordVerifiedRuleCandidateOutcome,
} from '../agent/ruleCandidatePersistence.js';
import { candidateContextFor } from '../agent/ruleCandidates.js';
import {
  invalidateClassificationCase,
  recordVerifiedClassificationCase,
} from '../classification/cases.js';
import {
  createPreparedRuleOperation,
  hashOperationPayload,
  loadOwnedRuleOperation,
  type CreatePreparedRuleOperationInput,
  type McpRuleOperationRecord,
  type McpRuleOperationStore,
} from './operations.js';
import {
  commitMcpRuleChange,
  prepareMcpRuleChange,
  type PrepareMcpRuleChangeInput,
} from './rules.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-08-31T12:00:00.000Z');

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function operationInput(
  overrides: Partial<CreatePreparedRuleOperationInput> = {},
): CreatePreparedRuleOperationInput {
  const principal: McpPrincipal = {
    tokenId: randomUUID(),
    tokenPrefix: 'rct_rulepg1',
    userId: randomUUID(),
    isInstanceAdmin: false,
    memberships: [],
  };
  return {
    principal,
    companyId: randomUUID(),
    resourceType: 'rule',
    resourceId: randomUUID(),
    mutation: 'update',
    idempotencyKey: `rule-${randomUUID()}`,
    payload: { proposedSnapshot: { matchText: 'PostgreSQL Vendor' } },
    sourceRevision: 4,
    proposedRevision: 5,
    proposedSnapshotHash: hashOperationPayload({ matchText: 'PostgreSQL Vendor' }),
    retryOfId: null,
    ...overrides,
  };
}

function barrierStore(
  transaction: Prisma.TransactionClient,
  reachedPreflight: Deferred,
  releasePreflight: Deferred,
): McpRuleOperationStore {
  let paused = false;
  const model = (transaction as any).mcpRuleOperation;
  return {
    mcpRuleOperation: {
      async findFirst({ where }) {
        const row = await model.findFirst({ where });
        if (!paused && row === null && where.idempotencyKey !== undefined) {
          paused = true;
          reachedPreflight.resolve();
          await releasePreflight.promise;
        }
        return row as McpRuleOperationRecord | null;
      },
      async createMany({ data, skipDuplicates }) {
        return model.createMany({ data, skipDuplicates });
      },
    },
  };
}

describePostgres('MCP rule operation PostgreSQL durability', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;

  beforeAll(() => {
    firstClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    secondClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterAll(async () => {
    await Promise.all([firstClient?.$disconnect(), secondClient?.$disconnect()]);
  });

  it('returns one exact company-resource replay for a concurrent idempotency race', async () => {
    expect((firstClient as any).mcpRuleOperation).toBeDefined();
    const input = operationInput();
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();

    const first = firstClient.$transaction(
      (tx) => createPreparedRuleOperation(input, {
        store: barrierStore(tx, firstReady, release),
        now: () => NOW,
      }),
      { timeout: 30_000 },
    );
    const second = secondClient.$transaction(
      (tx) => createPreparedRuleOperation(input, {
        store: barrierStore(tx, secondReady, release),
        now: () => new Date(NOW.getTime() + 1_000),
      }),
      { timeout: 30_000 },
    );

    await Promise.all([firstReady.promise, secondReady.promise]);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    await expect((firstClient as any).mcpRuleOperation.count({
      where: {
        tokenId: input.principal.tokenId,
        companyId: input.companyId,
        idempotencyKey: input.idempotencyKey,
      },
    })).resolves.toBe(1);
  }, 30_000);

  it('allows exactly one atomic commit receipt and rejects later mutation or deletion', async () => {
    const input = operationInput();
    const operation = await createPreparedRuleOperation(input, {
      store: firstClient as unknown as McpRuleOperationStore,
      now: () => NOW,
    });
    const commitResult = {
      ok: true,
      operationId: operation.id,
      companyId: input.companyId,
      mutation: 'update',
      status: 'COMMITTED',
    };

    await expect((firstClient as any).mcpRuleOperation.update({
      where: { id: operation.id },
      data: {
        committedAt: new Date(NOW.getTime() + 1_000),
        commitResult,
        commitResultHash: hashOperationPayload(commitResult),
      },
    })).resolves.toMatchObject({ committedAt: expect.any(Date), commitResult });

    await expect((firstClient as any).mcpRuleOperation.update({
      where: { id: operation.id },
      data: { resourceId: randomUUID() },
    })).rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
    await expect((firstClient as any).mcpRuleOperation.update({
      where: { id: operation.id },
      data: { committedAt: new Date(NOW.getTime() + 2_000) },
    })).rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
    await expect((firstClient as any).mcpRuleOperation.delete({
      where: { id: operation.id },
    })).rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
  });

  it('keeps actor and token ownership isolated without foreign-key deletion cascades', async () => {
    const input = operationInput();
    const operation = await createPreparedRuleOperation(input, {
      store: firstClient as unknown as McpRuleOperationStore,
      now: () => NOW,
    });

    await expect(loadOwnedRuleOperation(operation.id, {
      tokenId: randomUUID(),
      userId: input.principal.userId,
    }, { store: firstClient as unknown as McpRuleOperationStore }))
      .rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    await expect(loadOwnedRuleOperation(operation.id, input.principal, {
      store: firstClient as unknown as McpRuleOperationStore,
    })).resolves.toMatchObject({ id: operation.id });
  });
});

describePostgres('MCP rule lifecycle PostgreSQL behavior', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function seed() {
    const suffix = randomUUID();
    const user = await db.user.create({
      data: {
        email: `mcp-rules-${suffix}@example.invalid`,
        name: 'Rule Reviewer',
      },
    });
    const company = await db.company.create({
      data: {
        realmId: `mcp-rules-${suffix}`,
        legalName: 'MCP Rule Fixture',
        nickname: `rule-${suffix.slice(0, 8)}`,
        ruleRuntimeMode: 'canonical',
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    await db.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'categorizer' },
    });
    const token = await db.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(suffix).digest('hex'),
        prefix: 'rct_rulepg2',
        label: 'MCP Rule Fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      },
    });
    const account = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `expense-${suffix}`,
        name: 'Operating expense',
        fullName: 'Expenses · Operating expense',
        classification: 'Expenses',
      },
    });
    const tag = await db.tag.create({
      data: { companyId: company.id, name: 'Operations', color: '#445566' },
    });
    await db.transaction.createMany({
      data: [
        {
          companyId: company.id,
          qboId: `pending-${suffix}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-08-30T00:00:00.000Z'),
          payee: 'Harbour Supply Vancouver',
          amount: '-12.34',
          bankAccount: 'Operating',
          status: 'PENDING',
        },
        {
          companyId: company.id,
          qboId: `posted-${suffix}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-08-29T00:00:00.000Z'),
          payee: 'Harbour Supply Burnaby',
          amount: '-56.78',
          bankAccount: 'Operating',
          status: 'POSTED',
        },
      ],
    });
    const principal: McpPrincipal = {
      tokenId: token.id,
      tokenPrefix: token.prefix,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    return { user, company, account, tag, principal };
  }

  it.each(['legacy', 'bridge', 'paused'] as const)(
    'does not prepare canonical rule changes in %s runtime',
    async (ruleRuntimeMode) => {
      const fixture = await seed();
      await db.company.update({ where: { id: fixture.company.id }, data: { ruleRuntimeMode } });
      await expect(prepareMcpRuleChange(fixture.principal, {
        companyId: fixture.company.id,
        mutation: 'create', expectedRevision: 0, idempotencyKey: `runtime-${randomUUID()}`,
        proposal: {
          matchText: 'Harbour Supply', direction: 'Purchase',
          categoryQboId: fixture.account.qboId, taxCalculation: 'NotApplicable',
          taxCodeQboId: null, tagIds: [], autoPost: false,
        },
      }, { db, now: () => NOW })).rejects.toMatchObject({
        code: 'RULE_CHANGES_READ_ONLY',
        message: 'Rule changes are currently read-only for this company. Ask an administrator to complete the rule migration or resume rule editing.',
      });
      expect(await db.mcpRuleOperation.count({ where: { companyId: fixture.company.id } })).toBe(0);
      expect(await db.rule.count({ where: { companyId: fixture.company.id } })).toBe(0);
    },
  );

  it.each(['legacy', 'bridge', 'paused'] as const)(
    'rejects an uncommitted canonical operation after runtime changes to %s',
    async (ruleRuntimeMode) => {
      const fixture = await seed();
      const idempotencyKey = `runtime-commit-${randomUUID()}`;
      const prepared = await prepareMcpRuleChange(fixture.principal, {
        companyId: fixture.company.id,
        mutation: 'create', expectedRevision: 0, idempotencyKey,
        proposal: {
          matchText: 'Harbour Supply', direction: 'Purchase',
          categoryQboId: fixture.account.qboId, taxCalculation: 'NotApplicable',
          taxCodeQboId: null, tagIds: [], autoPost: false,
        },
      }, { db, now: () => NOW });
      await db.company.update({ where: { id: fixture.company.id }, data: { ruleRuntimeMode } });
      await expect(commitMcpRuleChange(fixture.principal, {
        operationId: prepared.operationId, idempotencyKey,
      }, { db, now: () => NOW })).rejects.toMatchObject({
        code: 'RULE_CHANGES_READ_ONLY',
        message: 'Rule changes are currently read-only for this company. Ask an administrator to complete the rule migration or resume rule editing.',
      });
      expect(await db.rule.count({ where: { companyId: fixture.company.id } })).toBe(0);
      expect(await db.ruleRevision.count({ where: { companyId: fixture.company.id } })).toBe(0);
      expect(await db.auditEntry.count({ where: { companyId: fixture.company.id } })).toBe(0);
      expect(await db.mcpRuleOperation.findUniqueOrThrow({ where: { id: prepared.operationId } }))
        .toMatchObject({ committedAt: null, commitResult: null });
    },
  );

  it('prepares without changing rules, then commits and replays one canonical revision', async () => {
    const fixture = await seed();
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'create',
      expectedRevision: 0,
      idempotencyKey: `create-${randomUUID()}`,
      proposal: {
        matchText: 'Harbour Supply',
        direction: 'Purchase',
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [fixture.tag.id],
        autoPost: false,
      },
    };

    const prepared = await prepareMcpRuleChange(fixture.principal, input, {
      db,
      now: () => NOW,
    });

    expect(prepared).toMatchObject({
      ok: true,
      status: 'PREPARED',
      mutation: 'create',
      revision: 1,
      preview: {
        currentRevision: 0,
        proposedRevision: 1,
        autoPost: false,
        affectedPendingCount: 1,
        affectedProcessedCount: 1,
      },
    });
    await expect(db.rule.count({ where: { companyId: fixture.company.id } }))
      .resolves.toBe(0);

    const committed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    const preparedReplay = await prepareMcpRuleChange(fixture.principal, input, {
      db, now: () => new Date(NOW.getTime() + 1_500),
    });
    expect(preparedReplay).toMatchObject({ ...committed, status: 'REPLAYED', preview: null });
    // Reading a durable receipt is safe during a pause; it must not execute again.
    await db.company.update({ where: { id: fixture.company.id }, data: { ruleRuntimeMode: 'paused' } });
    expect(await prepareMcpRuleChange(fixture.principal, input, {
      db, now: () => new Date(NOW.getTime() + 2_000),
    })).toMatchObject({ ...committed, status: 'REPLAYED', preview: null });
    const replayed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 2_000) });

    expect(committed).toMatchObject({
      ok: true,
      status: 'COMMITTED',
      rule: {
        revision: 1,
        state: 'enabled',
        action: { version: 2, direction: 'Purchase', categoryQboId: fixture.account.qboId },
        autoPost: false,
        originIntent: 'make_recurring',
      },
    });
    await expect(db.rule.findUniqueOrThrow({ where: { id: committed.ruleId! } }))
      .resolves.toMatchObject({ canonicalVersion: 2, direction: 'Purchase' });
    expect(replayed).toMatchObject({
      ...committed,
      status: 'REPLAYED',
    });
    await expect(db.ruleRevision.findMany({
      where: { companyId: fixture.company.id, ruleId: committed.ruleId! },
      select: { revision: true },
      orderBy: { revision: 'asc' },
    })).resolves.toEqual([{ revision: 0 }, { revision: 1 }]);
    await expect(db.auditEntry.count({
      where: { companyId: fixture.company.id, action: 'rule-created' },
    })).resolves.toBe(1);
  });

  it('makes false-to-true autoPost a standalone prepared change with pending impact', async () => {
    const fixture = await seed();
    const rule = await db.rule.create({
      data: {
        companyId: fixture.company.id,
        matchText: 'Harbour Supply',
        category: fixture.account.name,
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        autoPost: false,
        revision: 2,
        direction: 'Purchase', canonicalVersion: 2,
        originIntent: 'make_recurring',
        createdById: fixture.user.id,
        updatedById: fixture.user.id,
      },
      include: { ruleTags: true },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id,
        companyId: fixture.company.id,
        revision: 2,
        state: 'enabled',
        direction: 'Purchase', canonicalVersion: 2,
        matchText: rule.matchText,
        category: rule.category,
        categoryQboId: rule.categoryQboId,
        taxCalculation: 'NotApplicable',
        tagIds: [],
        priority: rule.priority,
        autoPost: false,
        originIntent: 'make_recurring',
        changedBy: fixture.user.id,
      },
    });
    await db.rule.createMany({
      data: [
        {
          companyId: fixture.company.id,
          matchText: 'Vancouver',
          direction: 'Purchase', canonicalVersion: 2,
          category: fixture.account.name,
          categoryQboId: fixture.account.qboId,
          taxCalculation: 'NotApplicable',
          autoPost: false,
          priority: -1,
          originIntent: 'make_recurring',
        },
        {
          companyId: fixture.company.id,
          matchText: 'Victoria',
          direction: 'Purchase', canonicalVersion: 2,
          category: fixture.account.name,
          categoryQboId: fixture.account.qboId,
          taxCalculation: 'NotApplicable',
          autoPost: false,
          priority: 10,
          originIntent: 'make_recurring',
        },
      ],
    });
    await db.transaction.create({
      data: {
        companyId: fixture.company.id,
        qboId: `pending-victoria-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-08-31T00:00:00.000Z'),
        payee: 'Harbour Supply Victoria',
        amount: '-90.00',
        bankAccount: 'Operating',
        status: 'PENDING',
      },
    });

    const prepared = await prepareMcpRuleChange(fixture.principal, {
      companyId: fixture.company.id,
      mutation: 'update',
      ruleId: rule.id,
      expectedRevision: 2,
      idempotencyKey: `autopost-${randomUUID()}`,
      proposal: { autoPost: true },
    }, { db, now: () => NOW });
    expect(prepared.preview).toMatchObject({
      autoPost: true,
      affectedPendingCount: 1,
      affectedProcessedCount: 1,
      warnings: expect.arrayContaining([
        'Enabling auto-post affects matching pending transactions.',
      ]),
    });
    expect(prepared.preview.sampleTransactions.map(({ payee }) => payee)).toEqual(
      expect.arrayContaining(['Harbour Supply Victoria', 'Harbour Supply Burnaby']),
    );
    expect(prepared.preview.sampleTransactions.map(({ payee }) => payee)).not.toContain(
      'Harbour Supply Vancouver',
    );

    await expect(prepareMcpRuleChange(fixture.principal, {
      companyId: fixture.company.id,
      mutation: 'update',
      ruleId: rule.id,
      expectedRevision: 2,
      idempotencyKey: `autopost-mixed-${randomUUID()}`,
      proposal: { autoPost: true, matchText: 'Changed at the same time' },
    }, { db, now: () => NOW })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const committed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: `wrong-${randomUUID()}`,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) }).catch((error) => error);
    expect(committed).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(db.rule.findUniqueOrThrow({ where: { id: rule.id } }))
      .resolves.toMatchObject({ revision: 2, autoPost: false });
  });

  it('fails closed for a foreign-company executable rule identifier', async () => {
    const current = await seed();
    const foreign = await seed();
    const foreignRule = await db.rule.create({
      data: {
        companyId: foreign.company.id,
        matchText: 'Foreign payee',
        category: foreign.account.name,
        categoryQboId: foreign.account.qboId,
        taxCalculation: 'NotApplicable',
        revision: 4,
      },
    });

    await expect(prepareMcpRuleChange(current.principal, {
      companyId: current.company.id,
      mutation: 'disable',
      ruleId: foreignRule.id,
      expectedRevision: 4,
      idempotencyKey: `foreign-${randomUUID()}`,
    }, { db, now: () => NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(db.mcpRuleOperation.count({
      where: { companyId: current.company.id },
    })).resolves.toBe(0);
  });

  it('commits update, disable, enable, and review through one revision path', async () => {
    const fixture = await seed();
    async function canonicalRule(matchText: string, priority: number, revision: number) {
      const rule = await db.rule.create({
        data: {
          companyId: fixture.company.id,
          matchText,
          direction: 'Purchase', canonicalVersion: 2,
          category: fixture.account.name,
          categoryQboId: fixture.account.qboId,
          taxCalculation: 'NotApplicable',
          priority,
          revision,
          originIntent: 'make_recurring',
          updatedById: fixture.user.id,
        },
        include: { ruleTags: true },
      });
      await db.ruleRevision.create({
        data: {
          ruleId: rule.id, companyId: fixture.company.id, revision,
          state: 'enabled', matchText, category: fixture.account.name,
          direction: 'Purchase', canonicalVersion: 2,
          categoryQboId: fixture.account.qboId, taxCalculation: 'NotApplicable',
          tagIds: [], priority, autoPost: false, originIntent: 'make_recurring',
          changedBy: fixture.user.id,
        },
      });
      return rule;
    }
    const first = await canonicalRule('Harbour Supply', 0, 2);

    async function run(input: PrepareMcpRuleChangeInput) {
      const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
      return commitMcpRuleChange(fixture.principal, {
        operationId: prepared.operationId,
        idempotencyKey: input.idempotencyKey,
      }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    }

    const updated = await run({
      companyId: fixture.company.id, mutation: 'update', ruleId: first.id,
      expectedRevision: 2, idempotencyKey: `update-${randomUUID()}`,
      proposal: { matchText: 'Harbour Supply Co' },
    });
    expect(updated.rule).toMatchObject({ revision: 3, condition: { matchText: 'Harbour Supply Co' } });
    const disabled = await run({
      companyId: fixture.company.id, mutation: 'disable', ruleId: first.id,
      expectedRevision: 3, idempotencyKey: `disable-${randomUUID()}`,
    });
    expect(disabled.rule).toMatchObject({ revision: 4, state: 'disabled' });
    const enabled = await run({
      companyId: fixture.company.id, mutation: 'enable', ruleId: first.id,
      expectedRevision: 4, idempotencyKey: `enable-${randomUUID()}`,
    });
    expect(enabled.rule).toMatchObject({ revision: 5, state: 'enabled' });

    const reviewed = await run({
      companyId: fixture.company.id, mutation: 'review', ruleId: first.id,
      expectedRevision: 5, idempotencyKey: `review-${randomUUID()}`,
      proposal: { reviewReason: 'Confirmed vendor and action.' },
    });
    expect(reviewed.rule).toMatchObject({ ruleId: first.id, revision: 6, state: 'disabled', autoPost: false });
    await expect(db.ruleRevision.findMany({
      where: { companyId: fixture.company.id, ruleId: first.id },
      select: { revision: true, state: true },
      orderBy: { revision: 'asc' },
    })).resolves.toEqual([
      { revision: 0, state: 'enabled' },
      { revision: 2, state: 'enabled' },
      { revision: 3, state: 'enabled' },
      { revision: 4, state: 'disabled' },
      { revision: 5, state: 'enabled' },
      { revision: 6, state: 'disabled' },
    ]);
  });

  it('dismisses a candidate without deleting its counterexample provenance', async () => {
    const fixture = await seed();
    const transaction = await db.transaction.findFirstOrThrow({
      where: { companyId: fixture.company.id },
    });
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: fixture.company.id,
        conditionFingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
        schemaVersion: 'classification-rule-v2',
        configVersion: 'verified-writeback-v1',
        matchText: 'Harbour Supply',
        state: 'conflict',
        winningActionFingerprint: 'a'.repeat(64),
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        tagIds: [],
        evidenceCount: 1,
        conflictingEvidenceCount: 1,
      },
    });
    const evidence = await db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: fixture.company.id,
        candidateId: candidate.id,
        transactionId: transaction.id,
        inputRevision: transaction.revision,
        requestId: `counterexample-${randomUUID()}`,
        source: 'mcp',
        polarity: 'negative',
        actionFingerprint: 'b'.repeat(64),
        pattern: { matchText: candidate.matchText },
      },
    });
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'dismiss_candidate',
      candidateId: candidate.id,
      expectedRevision: 0,
      idempotencyKey: `dismiss-${randomUUID()}`,
    };

    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    const committed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });

    expect(committed).toMatchObject({
      status: 'COMMITTED',
      rule: null,
      candidate: { candidateId: candidate.id, state: 'dismissed', ruleId: null },
    });
    await expect(db.autopilotRuleCandidateEvidence.findUnique({
      where: { id: evidence.id },
    })).resolves.toMatchObject({ id: evidence.id, active: true, polarity: 'negative' });
  });

  it('rejects a stale prepared revision without consuming its commit receipt', async () => {
    const fixture = await seed();
    const rule = await db.rule.create({
      data: {
        companyId: fixture.company.id,
        matchText: 'Harbour Supply',
        category: fixture.account.name,
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        revision: 2,
        originIntent: 'make_recurring',
      },
      include: { ruleTags: true },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id, companyId: fixture.company.id, revision: 2,
        state: 'enabled', matchText: rule.matchText, category: rule.category,
        categoryQboId: rule.categoryQboId, taxCalculation: 'NotApplicable',
        tagIds: [], priority: 0, autoPost: false, originIntent: 'make_recurring',
      },
    });
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'update',
      ruleId: rule.id,
      expectedRevision: 2,
      idempotencyKey: `stale-${randomUUID()}`,
      proposal: { matchText: 'Prepared condition' },
    };
    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    const changed = await db.rule.update({
      where: { id: rule.id },
      data: { matchText: 'Concurrent condition', revision: 3 },
      include: { ruleTags: true },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: changed.id, companyId: fixture.company.id, revision: 3,
        state: 'enabled', matchText: changed.matchText, category: changed.category,
        categoryQboId: changed.categoryQboId, taxCalculation: 'NotApplicable',
        tagIds: [], priority: 0, autoPost: false, originIntent: 'make_recurring',
      },
    });

    await expect(commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(db.mcpRuleOperation.findUniqueOrThrow({
      where: { id: prepared.operationId },
    })).resolves.toMatchObject({ committedAt: null, commitResult: null });
  });

  it('serializes concurrent commits into one mutation and one replay receipt', async () => {
    const fixture = await seed();
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'create',
      expectedRevision: 0,
      idempotencyKey: `concurrent-commit-${randomUUID()}`,
      proposal: {
        matchText: 'Concurrent Harbour',
        direction: 'Purchase',
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [],
        autoPost: false,
      },
    };
    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    const second = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    try {
      const results = await Promise.all([
        commitMcpRuleChange(fixture.principal, {
          operationId: prepared.operationId,
          idempotencyKey: input.idempotencyKey,
        }, { db, now: () => new Date(NOW.getTime() + 1_000) }),
        commitMcpRuleChange(fixture.principal, {
          operationId: prepared.operationId,
          idempotencyKey: input.idempotencyKey,
        }, { db: second, now: () => new Date(NOW.getTime() + 1_000) }),
      ]);
      expect(results.map(({ status }) => status).sort()).toEqual(['COMMITTED', 'REPLAYED']);
      await expect(db.rule.count({ where: { id: prepared.ruleId! } })).resolves.toBe(1);
      await expect(db.ruleRevision.count({
        where: { companyId: fixture.company.id, ruleId: prepared.ruleId! },
      })).resolves.toBe(2);
    } finally {
      await second.$disconnect();
    }
  });

  it('counts the complete matching population while bounding returned samples', async () => {
    const fixture = await seed();
    await db.transaction.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        companyId: fixture.company.id,
        qboId: `bulk-pending-${index}-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date(2026, 6, 1, 0, index),
        payee: `Harbour Supply bulk ${index}`,
        amount: '-1.00',
        bankAccount: 'Operating',
        status: 'PENDING',
      })),
    });

    const prepared = await prepareMcpRuleChange(fixture.principal, {
      companyId: fixture.company.id,
      mutation: 'create',
      expectedRevision: 0,
      idempotencyKey: `complete-count-${randomUUID()}`,
      proposal: {
        matchText: 'Harbour Supply',
        direction: 'Purchase',
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [],
        autoPost: false,
      },
    }, { db, now: () => NOW });

    expect(prepared.preview).toMatchObject({
      affectedPendingCount: 206,
      affectedProcessedCount: 1,
    });
    expect(prepared.preview?.sampleTransactions).toHaveLength(20);
  });

  it('allows dismiss and disable when stored references are no longer ready', async () => {
    const fixture = await seed();
    await db.qboAccount.update({
      where: { companyId_qboId: { companyId: fixture.company.id, qboId: fixture.account.qboId } },
      data: { active: false },
    });
    const makeRule = (matchText: string, priority: number) => db.rule.create({
      data: {
        companyId: fixture.company.id,
        matchText,
        category: fixture.account.name,
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        priority,
        revision: 2,
        originIntent: 'make_recurring',
      },
    });
    const disableRule = await makeRule('Legacy disable', 0);
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: fixture.company.id,
        conditionFingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
        schemaVersion: 'classification-rule-v2',
        configVersion: 'verified-writeback-v1',
        matchText: 'Legacy candidate',
        state: 'stale',
        winningActionFingerprint: 'a'.repeat(64),
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        tagIds: [],
      },
    });

    const run = async (input: PrepareMcpRuleChangeInput) => {
      const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
      return commitMcpRuleChange(fixture.principal, {
        operationId: prepared.operationId,
        idempotencyKey: input.idempotencyKey,
      }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    };
    await expect(run({
      companyId: fixture.company.id,
      mutation: 'disable',
      ruleId: disableRule.id,
      expectedRevision: 2,
      idempotencyKey: `legacy-disable-${randomUUID()}`,
    })).resolves.toMatchObject({ rule: { state: 'disabled', revision: 3 } });
    await expect(run({
      companyId: fixture.company.id,
      mutation: 'dismiss_candidate',
      candidateId: candidate.id,
      expectedRevision: 0,
      idempotencyKey: `legacy-dismiss-${randomUUID()}`,
    })).resolves.toMatchObject({
      candidate: { candidateId: candidate.id, state: 'dismissed' },
    });
  });

  it('reduces authority for structurally incomplete legacy rules and candidates', async () => {
    const fixture = await seed();
    const makeLegacyRule = (matchText: string, priority: number) => db.rule.create({
      data: {
        companyId: fixture.company.id,
        matchText,
        category: 'Legacy category label',
        categoryQboId: null,
        taxCalculation: null,
        taxCode: 'Legacy tax label',
        taxCodeQboId: null,
        priority,
        revision: 2,
        originIntent: 'make_recurring',
        createdById: fixture.user.id,
      },
    });
    const disableRule = await makeLegacyRule('Incomplete disable', 0);
    const legacyTagShape = { legacy: true, retained: ['historical-label'] };
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: fixture.company.id,
        conditionFingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
        schemaVersion: 'classification-rule-v1',
        configVersion: 'legacy-import',
        matchText: 'Incomplete candidate',
        state: 'stale',
        winningActionFingerprint: null,
        categoryQboId: null,
        taxCalculation: null,
        taxCodeQboId: null,
        tagIds: legacyTagShape,
      },
    });
    const run = async (input: PrepareMcpRuleChangeInput) => {
      const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
      const committed = await commitMcpRuleChange(fixture.principal, {
        operationId: prepared.operationId,
        idempotencyKey: input.idempotencyKey,
      }, { db, now: () => new Date(NOW.getTime() + 1_000) });
      return { prepared, committed };
    };

    const disabled = await run({
      companyId: fixture.company.id,
      mutation: 'disable',
      ruleId: disableRule.id,
      expectedRevision: 2,
      idempotencyKey: `incomplete-disable-${randomUUID()}`,
    });
    expect(disabled.prepared.preview).toMatchObject({
      action: null,
      categoryName: 'Legacy category label',
      taxCodeName: 'Legacy tax label',
    });
    expect(disabled.committed.rule).toMatchObject({
      ruleId: disableRule.id,
      state: 'disabled',
      revision: 3,
      action: null,
      taxCodeName: 'Legacy tax label',
      changedBy: fixture.user.id,
    });

    const dismissed = await run({
      companyId: fixture.company.id,
      mutation: 'dismiss_candidate',
      candidateId: candidate.id,
      expectedRevision: 0,
      idempotencyKey: `incomplete-dismiss-${randomUUID()}`,
    });
    expect(dismissed.prepared.preview).toMatchObject({
      action: null,
      categoryName: 'Unavailable category',
    });
    expect(dismissed.committed.candidate).toEqual({
      candidateId: candidate.id,
      state: 'dismissed',
      ruleId: null,
    });
    await expect(db.autopilotRuleCandidate.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({
        state: 'dismissed',
        categoryQboId: null,
        taxCalculation: null,
        tagIds: legacyTagShape,
        dismissedByUserId: fixture.user.id,
      });
    const revisions = await db.ruleRevision.findMany({
      where: { ruleId: disableRule.id, revision: 3 },
      orderBy: { ruleId: 'asc' },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions.every((revision) => (
      revision.categoryQboId === null
      && revision.taxCalculation === null
      && revision.changedBy === fixture.user.id
    ))).toBe(true);
  });

  it('rejects invalidated or no-longer-verified source cases', async () => {
    const fixture = await seed();
    const transaction = await db.transaction.findFirstOrThrow({
      where: { companyId: fixture.company.id, status: 'POSTED' },
    });
    const createCase = async () => {
      const attempt = await db.qboMutationAttempt.create({
        data: {
          transactionId: transaction.id,
          requestId: `case-${randomUUID()}`,
          operation: 'recategorize',
          status: 'VERIFIED',
          expectedRevision: transaction.revision,
          expectedSyncToken: transaction.qboSyncToken,
          requestHash: `case-hash-${randomUUID()}`,
          requestPayload: {},
          beforeSnapshot: {},
          verification: { outcome: 'VERIFIED', status: 'POSTED' },
        },
      });
      const recorded = await recordVerifiedClassificationCase({
        companyId: fixture.company.id,
        transactionId: transaction.id,
        qboMutationAttemptId: attempt.id,
        action: {
          categoryQboId: fixture.account.qboId,
          taxCalculation: 'NotApplicable',
          taxCodeQboId: null,
          tagIds: [],
        },
        originIntent: 'make_recurring',
        rationale: 'Verified recurring decision.',
        requiredEvidence: [], examples: [], counterexamples: [], citations: [],
        reviewer: { userId: fixture.user.id, configVersion: 'fixture', decision: 'approved' },
        jurisdiction: 'unknown', currency: 'CAD',
        context: {
          transactionDirection: 'out', qboType: 'Purchase',
          sourceAccountName: 'Operating', businessPurpose: null,
        },
        provenance: {
          source: 'qbo_verified', sourceId: attempt.id,
          actorId: fixture.user.id, recordedAt: NOW.toISOString(),
        },
      }, db);
      return { attempt, recorded };
    };
    const invalidated = await createCase();
    await invalidateClassificationCase(
      fixture.company.id,
      invalidated.recorded.id,
      'Superseded by a corrected outcome.',
      db,
    );
    const noLongerVerified = await createCase();
    await db.qboMutationAttempt.update({
      where: { id: noLongerVerified.attempt.id },
      data: { status: 'RETRYABLE' },
    });
    const inputFor = (sourceCaseId: string): PrepareMcpRuleChangeInput => ({
      companyId: fixture.company.id,
      mutation: 'create', expectedRevision: 0,
      idempotencyKey: `source-case-${randomUUID()}`,
      proposal: {
        matchText: 'Source Case Vendor', categoryQboId: fixture.account.qboId,
        direction: 'Purchase',
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
        autoPost: false, sourceCaseId,
      },
    });

    await expect(prepareMcpRuleChange(
      fixture.principal,
      inputFor(invalidated.recorded.id),
      { db, now: () => NOW },
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(prepareMcpRuleChange(
      fixture.principal,
      inputFor(noLongerVerified.recorded.id),
      { db, now: () => NOW },
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const invalidatedAfterPrepare = await createCase();
    const invalidatedAfterPrepareInput = inputFor(invalidatedAfterPrepare.recorded.id);
    const prepared = await prepareMcpRuleChange(
      fixture.principal,
      invalidatedAfterPrepareInput,
      { db, now: () => NOW },
    );
    await invalidateClassificationCase(
      fixture.company.id,
      invalidatedAfterPrepare.recorded.id,
      'Superseded after preparation.',
      db,
    );
    await expect(commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: invalidatedAfterPrepareInput.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['reorder', 'retire'])('rejects obsolete %s requests without changing stored rules', async (mutation) => {
    const fixture = await seed();
    const createRule = (matchText: string, priority: number, revision: number) => db.rule.create({
      data: {
        companyId: fixture.company.id, matchText,
        category: fixture.account.name, categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable', priority, revision,
        originIntent: 'make_recurring',
      },
    });
    const representative = await createRule('Representative', 0, 7);
    const drifting = await createRule('Drifting', 1, 2);
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: mutation as PrepareMcpRuleChangeInput['mutation'], expectedRevision: 7,
      idempotencyKey: `reorder-drift-${randomUUID()}`,
    };
    await expect(prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(db.rule.findMany({
      where: { id: { in: [representative.id, drifting.id] } },
      select: { id: true, priority: true }, orderBy: { priority: 'asc' },
    })).resolves.toEqual([
      { id: representative.id, priority: 0 },
      { id: drifting.id, priority: 1 },
    ]);
  });

  it('reuses the resource identity when retrying an expired create', async () => {
    const fixture = await seed();
    const proposal = {
      matchText: 'Retry Harbour', categoryQboId: fixture.account.qboId,
      direction: 'Purchase' as const,
      taxCalculation: 'NotApplicable' as const, taxCodeQboId: null,
      tagIds: [] as string[], autoPost: false,
    };
    const firstInput: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id, mutation: 'create', expectedRevision: 0,
      idempotencyKey: `expired-create-${randomUUID()}`, proposal,
    };
    const first = await prepareMcpRuleChange(fixture.principal, firstInput, { db, now: () => NOW });
    const retry = await prepareMcpRuleChange(fixture.principal, {
      ...firstInput,
      idempotencyKey: `expired-create-retry-${randomUUID()}`,
      retryOfId: first.operationId,
    }, { db, now: () => new Date(NOW.getTime() + 16 * 60 * 1_000) });

    expect(retry).toMatchObject({
      status: 'PREPARED',
      ruleId: first.ruleId,
      preview: { ruleId: first.ruleId },
    });
    expect(retry.operationId).not.toBe(first.operationId);
  });

  it('aborts candidate activation when reconciliation changes the winning action', async () => {
    const fixture = await seed();
    const accountB = await db.qboAccount.create({
      data: {
        companyId: fixture.company.id, qboId: `corrected-${randomUUID()}`,
        name: 'Corrected expense', fullName: 'Expenses · Corrected expense',
        classification: 'Expenses',
      },
    });
    const transactions = await Promise.all([0, 1, 2].map((index) => db.transaction.create({
      data: {
        companyId: fixture.company.id, qboId: `candidate-drift-${index}-${randomUUID()}`,
        qboType: 'Purchase', qboSyncToken: '1', date: NOW,
        payee: 'Candidate Drift Vendor', amount: '-10.00', bankAccount: 'Operating',
        status: 'POSTED', revision: 1,
      },
    })));
    const context = candidateContextFor(
      'Candidate Drift Vendor',
      'verified-writeback-v1',
      'mcp',
    );
    if (context === null) throw new Error('Candidate fixture context is invalid.');
    const proposal = (categoryQboId: string): VerifiedCategorizationProposal => ({
      taxCalculation: 'NotApplicable',
      lines: [{
        idx: 0, subtotalCents: -1000, taxCents: 0, totalCents: -1000,
        categoryQboId, taxCodeQboId: null, memo: null, tagIds: [],
      }],
      tagIds: [],
    });
    for (const transaction of transactions) {
      const requestId = randomUUID();
      await db.qboMutationAttempt.create({
        data: {
          transactionId: transaction.id, requestId, operation: 'recategorize',
          status: 'VERIFIED', expectedRevision: 1, expectedSyncToken: '0',
          requestHash: `old-${requestId}`,
          requestPayload: {
            ruleCandidateFold: { version: 1 },
            categorizationEvidence: { version: 1, proposal: proposal(fixture.account.qboId) },
            ruleCandidateEvidence: { version: 1, ...context },
          },
          beforeSnapshot: {},
        },
      });
      const outcome: VerifiedCategorizationOutcome = {
        companyId: fixture.company.id, transactionId: transaction.id,
        inputRevision: 1, requestId, operation: 'posted',
        proposal: proposal(fixture.account.qboId), candidateContext: context,
      };
      await recordVerifiedRuleCandidateOutcome(outcome, { db, now: () => NOW });
    }
    const candidate = await db.autopilotRuleCandidate.findFirstOrThrow({
      where: { companyId: fixture.company.id, matchText: 'candidate drift vendor' },
    });
    expect(candidate).toMatchObject({ state: 'ready', categoryQboId: fixture.account.qboId });
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id, mutation: 'activate_candidate',
      candidateId: candidate.id, expectedRevision: 0,
      idempotencyKey: `candidate-drift-${randomUUID()}`,
    };
    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    for (const transaction of transactions) {
      const requestId = randomUUID();
      await db.qboMutationAttempt.create({
        data: {
          transactionId: transaction.id, requestId, operation: 'recategorize',
          status: 'VERIFIED', expectedRevision: 1, expectedSyncToken: '0',
          requestHash: `new-${requestId}`,
          requestPayload: {
            ruleCandidateFold: { version: 1 },
            categorizationEvidence: { version: 1, proposal: proposal(accountB.qboId) },
            ruleCandidateEvidence: { version: 1, ...context },
          },
          beforeSnapshot: {},
        },
      });
    }

    await expect(commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(db.rule.count({ where: { companyId: fixture.company.id } })).resolves.toBe(0);
    await expect(db.mcpRuleOperation.findUniqueOrThrow({ where: { id: prepared.operationId } }))
      .resolves.toMatchObject({ committedAt: null, commitResult: null });
    await expect(db.autopilotRuleCandidate.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({
        state: 'ready',
        categoryQboId: accountB.qboId,
        evidenceCount: 3,
        conflictingEvidenceCount: 0,
      });

    const correctedInput: PrepareMcpRuleChangeInput = {
      ...input,
      idempotencyKey: `candidate-corrected-${randomUUID()}`,
    };
    const corrected = await prepareMcpRuleChange(
      fixture.principal,
      correctedInput,
      { db, now: () => new Date(NOW.getTime() + 2_000) },
    );
    expect(corrected.preview?.action).toMatchObject({ categoryQboId: accountB.qboId });
    await expect(commitMcpRuleChange(fixture.principal, {
      operationId: corrected.operationId,
      idempotencyKey: correctedInput.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 3_000) })).resolves.toMatchObject({
      status: 'COMMITTED',
      rule: { action: { categoryQboId: accountB.qboId } },
      candidate: { candidateId: candidate.id, state: 'activated' },
    });
  });
});
