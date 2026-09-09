import { describe, expect, it, vi } from 'vitest';
import type { CategorizationProposal, StageCategorizationInput } from '@recat/shared';
import type { McpPrincipal } from '../../mcp/auth.js';
import type {
  CategorizationStageReceipt,
  CategorizationStagingWorkflow,
} from '../categorization.js';
import {
  createPreparedOperation,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';
import {
  prepareMcpCategorization,
  type McpCategorizationDeps,
  type PrepareMcpCategorizationInput,
} from './categorization.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const TRANSACTION_ID = '44444444-4444-4444-8444-444444444444';

const principal: McpPrincipal = {
  tokenId: TOKEN_ID,
  tokenPrefix: 'rct_example1',
  userId: USER_ID,
  isInstanceAdmin: false,
  memberships: [{ companyId: COMPANY_ID, role: 'categorizer' }],
};

const proposal: CategorizationProposal = {
  taxCalculation: 'NotApplicable',
  lines: [{
    grossCents: -1050,
    categoryQboId: 'EXPENSE_ACCOUNT',
    memo: 'Cafe\u0301 supplies',
    tagIds: [],
  }],
  tagIds: [],
};

function prepareInput(
  overrides: Partial<PrepareMcpCategorizationInput> = {},
): PrepareMcpCategorizationInput {
  return {
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    expectedRevision: 0,
    idempotencyKey: ' prepare-1 ',
    proposal,
    ...overrides,
  };
}

function matches(
  row: McpOperationRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => (
    row[key as keyof McpOperationRecord] === value
  ));
}

interface HarnessOptions {
  tokenRevokedAt?: Date | null;
  tokenExpiresAt?: Date;
  currentRole?: 'viewer' | 'categorizer' | 'admin' | null;
  currentInstanceAdmin?: boolean;
  disconnectedAt?: Date | null;
}

function harness(options: HarnessOptions = {}) {
  const rows = new Map<string, McpOperationRecord>();
  let revision = 0;
  let validationCalls = 0;
  let mutableValidationAllowed = true;
  let insideTransaction = false;
  const authReadTransactionStates: boolean[] = [];
  const tokenRevokedAt = options.tokenRevokedAt ?? null;
  const tokenExpiresAt = options.tokenExpiresAt
    ?? new Date(NOW.getTime() + 60_000);
  const currentRole = options.currentRole === undefined
    ? 'categorizer'
    : options.currentRole;
  const currentInstanceAdmin = options.currentInstanceAdmin ?? false;
  const disconnectedAt = options.disconnectedAt ?? null;

  const mcpOperation: McpOperationStore['mcpOperation'] = {
    async findFirst({ where }) {
      expect(insideTransaction).toBe(true);
      const row = [...rows.values()].find((candidate) => matches(candidate, where));
      return row === undefined ? null : structuredClone(row);
    },
    async createMany({ data, skipDuplicates }) {
      expect(insideTransaction).toBe(true);
      expect(skipDuplicates).toBe(true);
      const duplicate = (
        data.idempotencyKey !== null
        && [...rows.values()].some((row) => (
          row.tokenId === data.tokenId
          && row.toolName === data.toolName
          && row.transactionId === data.transactionId
          && row.idempotencyKey === data.idempotencyKey
        ))
      );
      if (duplicate) return { count: 0 };
      const createdAt = new Date(NOW.getTime() + rows.size + 1);
      rows.set(data.id, {
        ...structuredClone(data),
        createdAt,
        updatedAt: createdAt,
      });
      return { count: 1 };
    },
  };
  const mcpToken = {
    findFirst: vi.fn(async (args: {
      where: {
        id: string;
        userId: string;
        prefix: string;
        revokedAt: null;
        expiresAt: { gt: Date };
      };
    }) => {
      authReadTransactionStates.push(insideTransaction);
      const valid = (
        args.where.id === TOKEN_ID
        && args.where.userId === USER_ID
        && args.where.prefix === principal.tokenPrefix
        && tokenRevokedAt === null
        && tokenExpiresAt.getTime() > args.where.expiresAt.gt.getTime()
      );
      return valid
        ? { id: TOKEN_ID, user: { isInstanceAdmin: currentInstanceAdmin } }
        : null;
    }),
  };
  const company = {
    findUnique: vi.fn(async () => {
      return { disconnectedAt };
    }),
  };
  const membership = {
    findUnique: vi.fn(async () => {
      return currentRole === null ? null : { role: currentRole };
    }),
  };
  const transactionStore = {
    mcpOperation,
    mcpToken,
    company,
    membership,
  };

  const stagedPreview = {
    transactionId: TRANSACTION_ID,
    revision: 1,
    taxCalculation: 'NotApplicable' as const,
    totals: { subtotalCents: -1050, taxCents: 0, totalCents: -1050 },
    lines: [{
      idx: 0,
      subtotalCents: -1050,
      taxCents: 0,
      totalCents: -1050,
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCodeQboId: null,
      memo: 'Café supplies',
      tagIds: [],
    }],
    tagIds: [],
  };

  const stage = vi.fn(async <T>(
    input: StageCategorizationInput,
    workflow: CategorizationStagingWorkflow<T>,
  ): Promise<T> => {
    const beforeRevision = revision;
    const beforeRows = new Map(
      [...rows].map(([id, row]) => [id, structuredClone(row)]),
    );
    insideTransaction = true;
    try {
      const decision = await workflow.beforeValidation(
        transactionStore as never,
        input,
      );
      if (decision.kind === 'return') return decision.value;
      validationCalls += 1;
      if (!mutableValidationAllowed) {
        throw Object.assign(new Error('stale revision'), {
          name: 'CategorizationError',
          code: 'STALE_REVISION',
        });
      }
      revision += 1;
      const receipt: CategorizationStageReceipt = {
        normalizedProposal: input.proposal,
        sourceRevision: input.expectedRevision,
        preparedRevision: revision,
        qboType: 'Purchase',
        qboId: 'QBO_PURCHASE_1',
        qboSyncToken: '7',
        staged: { ...stagedPreview, revision },
      };
      return await workflow.afterStage(transactionStore as never, receipt);
    } catch (error) {
      revision = beforeRevision;
      rows.clear();
      for (const [id, row] of beforeRows) rows.set(id, row);
      throw error;
    } finally {
      insideTransaction = false;
    }
  });

  const deps: McpCategorizationDeps = {
    stage,
    authorizationStore: transactionStore,
    now: () => NOW,
    createOperation: createPreparedOperation,
  };
  return {
    deps,
    rows,
    mcpToken,
    company,
    membership,
    authReadTransactionStates,
    get revision() {
      return revision;
    },
    get validationCalls() {
      return validationCalls;
    },
    blockMutableValidation() {
      mutableValidationAllowed = false;
    },
    transactionStore,
  };
}

describe('prepareMcpCategorization', () => {
  it('atomically stages and stores a bounded immutable receipt without any QBO call', async () => {
    const context = harness();
    const getQboClient = vi.fn(() => {
      throw new Error('prepare must not construct a QBO client');
    });

    const result = await prepareMcpCategorization(
      principal,
      prepareInput(),
      { ...context.deps, getQboClient } as never,
    );

    expect(result).toEqual({
      operationId: expect.any(String),
      expiresAt: '2026-07-29T12:15:00.000Z',
      sourceRevision: 0,
      preparedRevision: 1,
      preview: {
        transactionId: TRANSACTION_ID,
        revision: 1,
        taxDisposition: 'set',
        taxCalculation: 'NotApplicable',
        totals: { subtotalCents: -1050, taxCents: 0, totalCents: -1050 },
        lines: [{
          idx: 0,
          subtotalCents: -1050,
          taxCents: 0,
          totalCents: -1050,
          categoryQboId: 'EXPENSE_ACCOUNT',
          taxCodeQboId: null,
        }],
        transactionTagCount: 0,
        lineTagCount: 0,
      },
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/Café supplies|QBO_PURCHASE_1/);
    expect(context.revision).toBe(1);
    expect(context.rows.size).toBe(1);
    expect([...context.rows.values()][0]).toMatchObject({
      tokenId: TOKEN_ID,
      tokenPrefix: 'rct_example1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      toolName: 'prepare_categorization',
      kind: 'categorization',
      idempotencyKey: 'prepare-1',
      sourceRevision: 0,
      preparedRevision: 1,
      qboType: 'Purchase',
      qboId: 'QBO_PURCHASE_1',
      qboSyncToken: '7',
      payload: {
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1050,
            categoryQboId: 'EXPENSE_ACCOUNT',
            memo: 'Café supplies',
            tagIds: [],
          }],
          tagIds: [],
        },
        preview: {
          transactionId: TRANSACTION_ID,
          revision: 1,
          taxCalculation: 'NotApplicable',
          totals: { subtotalCents: -1050, taxCents: 0, totalCents: -1050 },
          lines: [{
            idx: 0,
            subtotalCents: -1050,
            taxCents: 0,
            totalCents: -1050,
            categoryQboId: 'EXPENSE_ACCOUNT',
            taxCodeQboId: null,
            memo: 'Café supplies',
            tagIds: [],
          }],
          tagIds: [],
        },
        warnings: [],
      },
    });
    expect(context.mcpToken.findFirst).toHaveBeenCalledWith({
      where: {
        id: TOKEN_ID,
        userId: USER_ID,
        prefix: 'rct_example1',
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      select: {
        id: true,
        user: { select: { isInstanceAdmin: true } },
      },
    });
    expect(context.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_companyId: { userId: USER_ID, companyId: COMPANY_ID } },
      select: { role: true },
    });
    expect(context.authReadTransactionStates).toEqual([false, true]);
    expect(getQboClient).not.toHaveBeenCalled();
  });

  it.each([
    ['viewer', { currentRole: 'viewer' as const }, 'MCP_FORBIDDEN'],
    ['removed role', { currentRole: null }, 'MCP_FORBIDDEN'],
    ['revoked token', { tokenRevokedAt: NOW }, 'MCP_UNAUTHORIZED'],
    ['expired token', { tokenExpiresAt: NOW }, 'MCP_UNAUTHORIZED'],
  ])('rejects a current %s inside the staging transaction', async (_name, options, code) => {
    const context = harness(options);

    await expect(
      prepareMcpCategorization(principal, prepareInput(), context.deps),
    ).rejects.toMatchObject({ code });
    expect(context.revision).toBe(0);
    expect(context.rows.size).toBe(0);
  });

  it.each([
    ['viewer', { currentRole: 'viewer' as const }],
    ['removed role', { currentRole: null }],
  ])(
    'denies a current %s before target lookup without disclosing target or company state',
    async (_name, roleOptions) => {
      for (const target of [
        { transactionId: TRANSACTION_ID, disconnectedAt: null },
        {
          transactionId: '55555555-5555-4555-8555-555555555555',
          disconnectedAt: null,
        },
        { transactionId: TRANSACTION_ID, disconnectedAt: NOW },
      ]) {
        const context = harness({ ...roleOptions, disconnectedAt: target.disconnectedAt });

        await expect(prepareMcpCategorization(
          principal,
          prepareInput({ transactionId: target.transactionId }),
          context.deps,
        )).rejects.toMatchObject({
          code: 'MCP_FORBIDDEN',
            message: 'Current company role cannot use categorization operations.',
        });
        expect(context.deps.stage).not.toHaveBeenCalled();
        expect(context.company.findUnique).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects a revoked token before target lookup', async () => {
    const context = harness({ tokenRevokedAt: NOW });

    await expect(prepareMcpCategorization(
      principal,
      prepareInput({
        transactionId: '55555555-5555-4555-8555-555555555555',
      }),
      context.deps,
    )).rejects.toMatchObject({
      code: 'MCP_UNAUTHORIZED',
      message: 'MCP token is no longer authorized.',
    });
    expect(context.deps.stage).not.toHaveBeenCalled();
    expect(context.membership.findUnique).not.toHaveBeenCalled();
    expect(context.company.findUnique).not.toHaveBeenCalled();
  });

  it('uses current instance-admin authority and rejects a disconnected company', async () => {
    const admin = harness({
      currentInstanceAdmin: true,
      currentRole: null,
    });
    await expect(
      prepareMcpCategorization(principal, prepareInput(), admin.deps),
    ).resolves.toMatchObject({ preparedRevision: 1 });
    expect(admin.membership.findUnique).not.toHaveBeenCalled();

    const disconnected = harness({ disconnectedAt: NOW });
    await expect(
      prepareMcpCategorization(principal, prepareInput(), disconnected.deps),
    ).rejects.toMatchObject({
      code: 'COMPANY_DISCONNECTED',
      message: 'This company is disconnected from QuickBooks.',
    });
    expect(disconnected.revision).toBe(0);
    expect(disconnected.rows.size).toBe(0);
  });

  it('returns an identical exact replay before mutable validation or CAS', async () => {
    const context = harness();
    const first = await prepareMcpCategorization(
      principal,
      prepareInput(),
      context.deps,
    );
    context.blockMutableValidation();

    const replay = await prepareMcpCategorization(
      principal,
      prepareInput({
        proposal: {
          tagIds: [],
          lines: [{
            tagIds: [],
            memo: 'Café supplies',
            categoryQboId: 'EXPENSE_ACCOUNT',
            grossCents: -1050,
          }],
          taxCalculation: 'NotApplicable',
        },
      }),
      context.deps,
    );

    expect(replay).toEqual(first);
    expect(context.validationCalls).toBe(1);
    expect(context.revision).toBe(1);
    expect(context.rows.size).toBe(1);
  });

  it('returns a stable conflict for changed payload or revision without restaging', async () => {
    const context = harness();
    await prepareMcpCategorization(principal, prepareInput(), context.deps);
    context.blockMutableValidation();

    for (const changed of [
      prepareInput({
        proposal: {
          ...proposal,
          lines: [{ ...proposal.lines[0]!, memo: 'Changed memo' }],
        },
      }),
      prepareInput({ expectedRevision: 1 }),
    ]) {
      await expect(
        prepareMcpCategorization(principal, changed, context.deps),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key conflicts with an existing operation.',
      });
    }
    expect(context.validationCalls).toBe(1);
    expect(context.revision).toBe(1);
    expect(context.rows.size).toBe(1);
  });

  it('rolls back staging when immutable operation persistence fails', async () => {
    const context = harness();
    const persistenceError = new Error('operation persistence failed');
    const createOperation = vi.fn(async () => {
      throw persistenceError;
    });

    await expect(prepareMcpCategorization(
      principal,
      prepareInput(),
      { ...context.deps, createOperation },
    )).rejects.toBe(persistenceError);

    expect(createOperation).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        store: context.transactionStore,
      }),
    );
    expect(context.revision).toBe(0);
    expect(context.rows.size).toBe(0);
  });

  it('turns an overlapping entity lease into safe same-key retry guidance', async () => {
    const context = harness();
    context.deps.stage = vi.fn(async () => {
      throw Object.assign(new Error('entity busy'), {
        name: 'EntityLeaseError',
        code: 'ENTITY_BUSY',
      });
    }) as never;

    await expect(
      prepareMcpCategorization(principal, prepareInput(), context.deps),
    ).rejects.toMatchObject({
      name: 'McpCategorizationError',
      code: 'ENTITY_BUSY',
      message: 'Another write is in progress. Retry with the same idempotency key.',
    });
  });
});
