import { describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  createPreparedOperation,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';
import {
  prepareMcpUndo,
  parseStoredMcpUndoPayload,
  type McpUndoStore,
} from './undo.js';

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

function matches(
  row: McpOperationRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => (
    row[key as keyof McpOperationRecord] === value
  ));
}

function createStore() {
  const rows = new Map<string, McpOperationRecord>();
  const store: McpUndoStore = {
    mcpOperation: {
      async findFirst({ where }) {
        const row = [...rows.values()].find((candidate) => matches(candidate, where));
        return row === undefined ? null : structuredClone(row);
      },
      async createMany({ data }) {
        const duplicate = [...rows.values()].some((row) => (
          data.idempotencyKey !== null
          && row.tokenId === data.tokenId
          && row.toolName === data.toolName
          && row.transactionId === data.transactionId
          && row.idempotencyKey === data.idempotencyKey
        ));
        if (duplicate) return { count: 0 };
        const row: McpOperationRecord = {
          ...structuredClone(data),
          createdAt: NOW,
          updatedAt: NOW,
        };
        rows.set(row.id, row);
        return { count: 1 };
      },
    },
    mcpToken: {
      async findFirst() {
        return { id: TOKEN_ID, user: { isInstanceAdmin: false } };
      },
    },
    membership: {
      async findUnique() {
        return { role: 'categorizer' };
      },
    },
    company: {
      async findUnique() {
        return { disconnectedAt: null };
      },
    },
    user: {
      async findUnique() {
        return { name: ' Generic User ' };
      },
    },
  };
  return { store, rows };
}

async function seedSource(
  store: McpOperationStore,
  overrides: Partial<Parameters<typeof createPreparedOperation>[0]> = {},
): Promise<McpOperationRecord> {
  return createPreparedOperation({
    principal,
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    toolName: 'prepare_categorization',
    kind: 'categorization',
    idempotencyKey: 'source-key',
    payload: {
      proposal: { taxCalculation: 'NotApplicable', lines: [], tagIds: [] },
      preview: {
        transactionId: TRANSACTION_ID,
        revision: 4,
        taxCalculation: 'NotApplicable',
        totals: { subtotalCents: -1234, taxCents: 0, totalCents: -1234 },
        lines: [{
          idx: 0,
          subtotalCents: -1234,
          taxCents: 0,
          totalCents: -1234,
          categoryQboId: 'expense-secret',
          taxCodeQboId: null,
          memo: 'private memo',
          tagIds: [],
        }],
        tagIds: [],
      },
      warnings: [],
    },
    sourceRevision: 3,
    preparedRevision: 4,
    qboType: 'Purchase',
    qboId: 'purchase-secret',
    qboSyncToken: '7',
    ...overrides,
  }, { store, now: () => NOW });
}

function preparedUndo() {
  return {
    transactionId: TRANSACTION_ID,
    companyId: COMPANY_ID,
    revision: 4,
    qboType: 'Purchase' as const,
    qboId: 'purchase-secret',
    qboSyncToken: '8',
    sourcePreparedHash: 'a'.repeat(64),
    currentPostHash: 'b'.repeat(64),
    restoreHash: 'c'.repeat(64),
    preview: {
      action: 'restore_purchase_categorization' as const,
      resultingStatus: 'PENDING' as const,
      direction: 'purchase' as const,
      totalCents: -1234,
      totalTaxCents: null,
      lineCount: 1,
      restorationDigest: 'c'.repeat(64),
    },
  };
}

describe('prepareMcpUndo', () => {
  it('normalizes a pre-upgrade stored REVERTED preview to the PENDING queue state', () => {
    const parsed = parseStoredMcpUndoPayload({
      sourceOperationId: '10000000-0000-4000-8000-000000000001',
      sourcePreparedHash: 'a'.repeat(64),
      currentPostHash: 'b'.repeat(64),
      restoreHash: 'c'.repeat(64),
      preview: {
        ...preparedUndo().preview,
        resultingStatus: 'REVERTED',
      },
      warnings: [],
    });

    expect(parsed.preview.resultingStatus).toBe('PENDING');
  });

  it('creates an attributed undo operation containing only hashes, a source reference, and redacted summary', async () => {
    const { store, rows } = createStore();
    const source = await seedSource(store);
    const prepareUndo = vi.fn(async () => preparedUndo());

    const result = await prepareMcpUndo(
      principal,
      { operationId: source.id, idempotencyKey: ' undo-key ' },
      { store, now: () => NOW, prepareUndo },
    );

    expect(prepareUndo).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      sourceRequestId: source.id,
      expectedRevision: 4,
      expectedSourceSyncToken: '7',
      expectedQboBinding: {
        qboType: 'Purchase',
        qboId: 'purchase-secret',
      },
      actor: {
        id: USER_ID,
        label: 'Generic User (MCP rct_example1)',
      },
      authorization: {
        kind: 'mcp',
        tokenId: TOKEN_ID,
        tokenPrefix: 'rct_example1',
      },
    }));
    expect(result).toMatchObject({
      sourceOperationId: source.id,
      preview: preparedUndo().preview,
      warnings: [],
    });

    const created = [...rows.values()].find((row) => row.kind === 'undo');
    expect(created).toMatchObject({
      tokenId: TOKEN_ID,
      tokenPrefix: 'rct_example1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      toolName: 'prepare_undo',
      kind: 'undo',
      idempotencyKey: 'undo-key',
      sourceRevision: 4,
      preparedRevision: 4,
      qboType: 'Purchase',
      qboId: 'purchase-secret',
      qboSyncToken: '8',
      retryOfId: null,
      payload: {
        sourceOperationId: source.id,
        sourcePreparedHash: 'a'.repeat(64),
        currentPostHash: 'b'.repeat(64),
        restoreHash: 'c'.repeat(64),
        preview: preparedUndo().preview,
        warnings: [],
      },
    });
    expect(JSON.stringify(created?.payload)).not.toMatch(
      /purchase-secret|expense-secret|private memo|SyncToken|requestPayload|beforeSnapshot|body/i,
    );
  });

  it('replays the same source and idempotency key without another authoritative QBO preparation', async () => {
    const { store } = createStore();
    const source = await seedSource(store);
    const prepareUndo = vi.fn(async () => preparedUndo());
    const input = { operationId: source.id, idempotencyKey: 'undo-key' };

    const first = await prepareMcpUndo(
      principal,
      input,
      { store, now: () => NOW, prepareUndo },
    );
    const replay = await prepareMcpUndo(
      principal,
      input,
      { store, now: () => new Date(NOW.getTime() + 1_000), prepareUndo },
    );

    expect(replay).toEqual(first);
    expect(prepareUndo).toHaveBeenCalledOnce();
  });

  it('rejects reuse of the same idempotency key for a different owned source operation', async () => {
    const { store } = createStore();
    const firstSource = await seedSource(store);
    const secondSource = await seedSource(store, {
      idempotencyKey: 'second-source-key',
    });
    const prepareUndo = vi.fn(async () => preparedUndo());

    await prepareMcpUndo(
      principal,
      { operationId: firstSource.id, idempotencyKey: 'same-key' },
      { store, now: () => NOW, prepareUndo },
    );
    await expect(prepareMcpUndo(
      principal,
      { operationId: secondSource.id, idempotencyKey: 'same-key' },
      { store, now: () => NOW, prepareUndo },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects foreign, non-categorization, corrupt, or unverified source operations without preparing QBO restore work', async () => {
    const { store, rows } = createStore();
    const source = await seedSource(store);
    const prepareUndo = vi.fn(async () => preparedUndo());

    await expect(prepareMcpUndo(
      { ...principal, tokenId: '99999999-9999-4999-8999-999999999999' },
      { operationId: source.id, idempotencyKey: 'foreign-key' },
      { store, now: () => NOW, prepareUndo },
    )).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });

    const undoSource = await seedSource(store, {
      idempotencyKey: 'wrong-kind-source',
      kind: 'undo',
      toolName: 'prepare_undo',
    });
    await expect(prepareMcpUndo(
      principal,
      { operationId: undoSource.id, idempotencyKey: 'wrong-kind-key' },
      { store, now: () => NOW, prepareUndo },
    )).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });

    const corrupt = rows.get(source.id)!;
    corrupt.payload = { tampered: true };
    await expect(prepareMcpUndo(
      principal,
      { operationId: source.id, idempotencyKey: 'corrupt-key' },
      { store, now: () => NOW, prepareUndo },
    )).rejects.toMatchObject({ code: 'UNDO_NOT_ALLOWED' });

    expect(prepareUndo).not.toHaveBeenCalled();
  });
});
