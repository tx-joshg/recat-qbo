import { describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  createPreparedRuleOperation,
  hasValidMcpRuleOperationIntegrity,
  hashOperationPayload,
  type CreatePreparedRuleOperationInput,
  type McpRuleOperationRecord,
  type McpRuleOperationStore,
  type RuleOperationPrincipal,
} from './operations.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const principal: McpPrincipal = {
  tokenId: '11111111-1111-4111-8111-111111111111',
  tokenPrefix: 'rct_ruleop1',
  userId: '22222222-2222-4222-8222-222222222222',
  isInstanceAdmin: false,
  memberships: [{
    companyId: '33333333-3333-4333-8333-333333333333',
    role: 'categorizer',
  }],
};

function input(
  overrides: Partial<CreatePreparedRuleOperationInput> = {},
): CreatePreparedRuleOperationInput {
  return {
    principal,
    companyId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'rule',
    resourceId: '44444444-4444-4444-8444-444444444444',
    mutation: 'update',
    idempotencyKey: ' update-cafe ',
    payload: {
      proposedSnapshot: {
        condition: { matchField: 'payee', matchText: 'Cafe\u0301' },
        action: {
          categoryQboId: 'expense-1',
          taxCalculation: 'NotApplicable',
          taxCodeQboId: null,
          tagIds: [],
        },
      },
    },
    sourceRevision: 3,
    proposedRevision: 4,
    proposedSnapshotHash: 'a'.repeat(64),
    retryOfId: null,
    ...overrides,
  };
}

function createStore(): McpRuleOperationStore {
  const rows = new Map<string, McpRuleOperationRecord>();
  return {
    mcpRuleOperation: {
      async findFirst({ where }) {
        return [...rows.values()].find((row) => Object.entries(where).every(
          ([key, value]) => row[key as keyof McpRuleOperationRecord] === value,
        )) ?? null;
      },
      async createMany({ data }) {
        const duplicate = [...rows.values()].some((row) => (
          row.tokenId === data.tokenId
          && row.companyId === data.companyId
          && row.idempotencyKey === data.idempotencyKey
        )) || (
          data.retryOfId !== null
          && [...rows.values()].some((row) => row.retryOfId === data.retryOfId)
        );
        if (duplicate) return { count: 0 };
        rows.set(data.id, {
          ...structuredClone(data),
          committedAt: null,
          commitResult: null,
          commitResultHash: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
        return { count: 1 };
      },
    },
  };
}

/** Exact pre-Task-6A input-hash validator copied from base 149749d. */
function baseMcpInputHash(operation: McpRuleOperationRecord): string {
  return hashOperationPayload({
    tokenId: operation.tokenId,
    tokenPrefix: operation.tokenPrefix,
    userId: operation.userId,
    companyId: operation.companyId,
    resourceType: operation.resourceType,
    resourceId: operation.resourceId,
    mutation: operation.mutation,
    idempotencyKey: operation.idempotencyKey,
    payloadHash: operation.payloadHash,
    sourceRevision: operation.sourceRevision,
    proposedRevision: operation.proposedRevision,
    proposedSnapshotHash: operation.proposedSnapshotHash,
    expiresAt: operation.expiresAt.toISOString(),
    retryOfId: operation.retryOfId,
  });
}

/** Exact pre-Task-6A integrity decision copied from base 149749d. */
function baseHasValidMcpRuleOperationIntegrity(operation: McpRuleOperationRecord): boolean {
  try {
    const payloadHash = hashOperationPayload(operation.payload);
    if (payloadHash !== operation.payloadHash || Number.isNaN(operation.expiresAt.getTime())) return false;
    if (operation.inputHash !== baseMcpInputHash(operation)) return false;
    const commitFields = [operation.committedAt, operation.commitResult, operation.commitResultHash];
    if (commitFields.every((value) => value === null)) return true;
    if (commitFields.some((value) => value === null)) return false;
    return !Number.isNaN(operation.committedAt!.getTime())
      && operation.commitResultHash === hashOperationPayload(operation.commitResult);
  } catch {
    return false;
  }
}

describe('dedicated MCP rule operation envelope', () => {
  it('binds a browser preparation to its real session without inventing MCP attribution', async () => {
    const sessionPrincipal: RuleOperationPrincipal = {
      kind: 'session',
      sessionId: '55555555-5555-4555-8555-555555555555',
      userId: principal.userId,
    };

    const operation = await createPreparedRuleOperation(input({
      principal: sessionPrincipal,
      idempotencyKey: 'browser-update',
    }), { store: createStore(), now: () => NOW });

    expect(operation).toMatchObject({
      authKind: 'session',
      sessionId: sessionPrincipal.sessionId,
      tokenId: null,
      tokenPrefix: null,
      userId: sessionPrincipal.userId,
    });
    expect(hasValidMcpRuleOperationIntegrity(operation)).toBe(true);
  });

  it('binds company resource, actor, token, revisions, proposed hash, expiry, and idempotency without QBO fields', async () => {
    const store = createStore();

    const operation = await createPreparedRuleOperation(input(), {
      store,
      now: () => NOW,
    });

    expect(operation).toMatchObject({
      tokenId: principal.tokenId,
      tokenPrefix: principal.tokenPrefix,
      userId: principal.userId,
      companyId: principal.memberships[0]!.companyId,
      resourceType: 'rule',
      resourceId: '44444444-4444-4444-8444-444444444444',
      mutation: 'update',
      idempotencyKey: 'update-cafe',
      sourceRevision: 3,
      proposedRevision: 4,
      proposedSnapshotHash: 'a'.repeat(64),
      retryOfId: null,
      committedAt: null,
    });
    expect(operation.payload).toEqual({
      proposedSnapshot: {
        action: {
          categoryQboId: 'expense-1',
          tagIds: [],
          taxCalculation: 'NotApplicable',
          taxCodeQboId: null,
        },
        condition: { matchField: 'payee', matchText: 'Café' },
      },
    });
    expect(operation.payloadHash).toBe(hashOperationPayload(operation.payload));
    expect(operation.inputHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(operation.expiresAt.toISOString()).toBe('2026-08-31T12:15:00.000Z');
    expect(Object.keys(operation)).not.toEqual(expect.arrayContaining([
      'transactionId',
      'qboType',
      'qboId',
      'qboSyncToken',
    ]));
    expect(hasValidMcpRuleOperationIntegrity(operation)).toBe(true);
  });

  it('emits an MCP hash accepted by the base committer while accepting both rolling writer formats', async () => {
    const operation = await createPreparedRuleOperation(input(), {
      store: createStore(),
      now: () => NOW,
    });

    expect(baseHasValidMcpRuleOperationIntegrity(operation)).toBe(true);
    expect(hasValidMcpRuleOperationIntegrity(operation)).toBe(true);

    const discriminatorAware = {
      ...operation,
      inputHash: hashOperationPayload({
        authKind: operation.authKind,
        tokenId: operation.tokenId,
        tokenPrefix: operation.tokenPrefix,
        sessionId: operation.sessionId,
        userId: operation.userId,
        companyId: operation.companyId,
        resourceType: operation.resourceType,
        resourceId: operation.resourceId,
        mutation: operation.mutation,
        idempotencyKey: operation.idempotencyKey,
        payloadHash: operation.payloadHash,
        sourceRevision: operation.sourceRevision,
        proposedRevision: operation.proposedRevision,
        proposedSnapshotHash: operation.proposedSnapshotHash,
        expiresAt: operation.expiresAt.toISOString(),
        retryOfId: operation.retryOfId,
      }),
    };
    expect(hasValidMcpRuleOperationIntegrity(discriminatorAware)).toBe(true);
  });

  it('returns one exact idempotent replay and rejects a changed resource or proposed snapshot', async () => {
    const store = createStore();
    const first = await createPreparedRuleOperation(input(), { store, now: () => NOW });

    await expect(createPreparedRuleOperation(input({
      payload: {
        proposedSnapshot: {
          action: {
            tagIds: [],
            taxCodeQboId: null,
            taxCalculation: 'NotApplicable',
            categoryQboId: 'expense-1',
          },
          condition: { matchText: 'Café', matchField: 'payee' },
        },
      },
    }), { store, now: () => new Date(NOW.getTime() + 10_000) })).resolves.toEqual(first);

    for (const changed of [
      input({ resourceId: '55555555-5555-4555-8555-555555555555' }),
      input({ proposedSnapshotHash: 'b'.repeat(64) }),
      input({ sourceRevision: 2, proposedRevision: 3 }),
      input({ payload: { proposedSnapshot: { changed: true } } }),
    ]) {
      await expect(createPreparedRuleOperation(changed, { store, now: () => NOW }))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
  });

  it('detects tampering in every committed-result and prepared-envelope hash boundary', async () => {
    const operation = await createPreparedRuleOperation(input(), {
      store: createStore(),
      now: () => NOW,
    });

    const changedPayload = structuredClone(operation);
    (changedPayload.payload as Record<string, unknown>).extra = true;
    expect(hasValidMcpRuleOperationIntegrity(changedPayload)).toBe(false);

    const partialCommit = structuredClone(operation);
    partialCommit.committedAt = NOW;
    expect(hasValidMcpRuleOperationIntegrity(partialCommit)).toBe(false);

    const committed = structuredClone(operation);
    committed.committedAt = NOW;
    committed.commitResult = { status: 'COMMITTED' };
    committed.commitResultHash = hashOperationPayload(committed.commitResult);
    expect(hasValidMcpRuleOperationIntegrity(committed)).toBe(true);

    (committed.commitResult as Record<string, unknown>).status = 'REPLAYED';
    expect(hasValidMcpRuleOperationIntegrity(committed)).toBe(false);
  });
});
