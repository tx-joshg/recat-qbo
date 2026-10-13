import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type McpTokenStore,
} from './tokens.js';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const USER_ID = '10000000-0000-4000-8000-000000000001';
const TOKEN_ID = '20000000-0000-4000-8000-000000000001';

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TOKEN_ID,
    userId: USER_ID,
    digest: 'digest-is-never-returned',
    prefix: 'rct_example',
    label: 'Automation',
    createdAt: new Date('2026-07-28T11:00:00.000Z'),
    expiresAt: new Date('2026-10-26T12:00:00.000Z'),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function store() {
  const transaction = {
    mcpToken: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) =>
        tokenRow(args.data),
      ),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ prefix: 'rct_example' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    securityAuditEvent: {
      create: vi.fn(async () => ({ id: 'audit-event' })),
    },
  };
  const db: McpTokenStore = {
    mcpToken: transaction.mcpToken,
    $transaction: vi.fn(async (callback) => callback(transaction)),
  };
  return { db, transaction };
}

describe('createMcpToken', () => {
  it('returns cryptographic opaque plaintext once while persisting only its SHA-256 digest', async () => {
    const { db, transaction } = store();

    const first = await createMcpToken(
      { userId: USER_ID, label: ' Automation ' },
      { db, now: () => NOW },
    );
    const second = await createMcpToken(
      { userId: USER_ID, label: 'Second token' },
      { db, now: () => NOW },
    );

    expect(first.token).toMatch(/^rct_[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.mcpToken).toEqual({
      id: TOKEN_ID,
      prefix: first.token.slice(0, 12),
      label: 'Automation',
      status: 'active',
      createdAt: '2026-07-28T11:00:00.000Z',
      expiresAt: '2026-10-26T12:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    });

    const persisted = transaction.mcpToken.create.mock.calls[0]?.[0];
    expect(persisted).toEqual({
      data: {
        userId: USER_ID,
        digest: createHash('sha256').update(first.token).digest('hex'),
        prefix: first.token.slice(0, 12),
        label: 'Automation',
        expiresAt: new Date('2026-10-26T12:00:00.000Z'),
        viaExposedSession: false,
      },
    });
    expect(JSON.stringify(persisted)).not.toContain(first.token);
    expect(JSON.stringify(transaction.securityAuditEvent.create.mock.calls)).not.toContain(
      first.token,
    );
    expect(JSON.stringify(transaction.securityAuditEvent.create.mock.calls)).not.toContain(
      persisted?.data.digest,
    );
  });

  it('defaults to 90 days and enforces bounded labels and a 1–365 day integer expiry', async () => {
    const { db, transaction } = store();

    await createMcpToken({ userId: USER_ID, label: 'Default expiry' }, { db, now: () => NOW });
    expect(transaction.mcpToken.create.mock.calls[0]?.[0].data.expiresAt).toEqual(
      new Date('2026-10-26T12:00:00.000Z'),
    );

    for (const expiresInDays of [0, 1.5, 366]) {
      await expect(
        createMcpToken(
          { userId: USER_ID, label: 'Invalid expiry', expiresInDays },
          { db, now: () => NOW },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    for (const label of ['', ' ', 'x'.repeat(81), 'unsafe\nlabel']) {
      await expect(
        createMcpToken({ userId: USER_ID, label }, { db, now: () => NOW }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });

  it('retries a digest collision atomically before exposing any plaintext', async () => {
    const { db, transaction } = store();
    transaction.mcpToken.create
      .mockRejectedValueOnce(Object.assign(new Error('unique collision'), { code: 'P2002' }))
      .mockResolvedValueOnce(tokenRow({ prefix: 'rct_second_' }));
    const generated = ['rct_first_collision_value', 'rct_second_unique_value'];

    const result = await createMcpToken(
      { userId: USER_ID, label: 'Retry token', expiresInDays: 1 },
      { db, now: () => NOW, generateToken: () => generated.shift()! },
    );

    expect(result.token).toBe('rct_second_unique_value');
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(transaction.securityAuditEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe('listMcpTokens and revokeMcpToken', () => {
  it('defaults to 20 items, fetches one extra, and returns a next cursor without loading digests', async () => {
    const { db } = store();
    db.mcpToken.findMany = vi.fn(async () =>
      Array.from({ length: 21 }, (_, index) =>
        tokenRow({
          id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          createdAt: new Date(NOW.getTime() - index * 1000),
        }),
      ),
    );

    const result = await listMcpTokens(USER_ID, {}, { db, now: () => NOW });

    expect(db.mcpToken.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: {
        id: true,
        prefix: true,
        label: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
    });
    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(result)).not.toMatch(/digest-is-never-returned|digest/);
  });

  it('allows 100 items, rejects 101, and computes active, expired, and revoked status', async () => {
    const { db } = store();
    db.mcpToken.findMany = vi.fn(async () => [
      tokenRow(),
      tokenRow({
        id: '20000000-0000-4000-8000-000000000002',
        expiresAt: new Date('2026-07-28T11:59:59.000Z'),
      }),
      tokenRow({
        id: '20000000-0000-4000-8000-000000000003',
        revokedAt: new Date('2026-07-28T11:30:00.000Z'),
      }),
    ]);

    const result = await listMcpTokens(
      USER_ID,
      { limit: 100 },
      { db, now: () => NOW },
    );

    expect(db.mcpToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, take: 101 }),
    );
    expect(result.items.map((token) => token.status)).toEqual([
      'active',
      'expired',
      'revoked',
    ]);
    await expect(
      listMcpTokens(USER_ID, { limit: 101 }, { db, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('continues from an opaque position within the same owner without duplicate items', async () => {
    const { db } = store();
    const first = tokenRow({
      id: '20000000-0000-4000-8000-000000000001',
      createdAt: new Date('2026-07-28T11:59:00.000Z'),
    });
    const second = tokenRow({
      id: '20000000-0000-4000-8000-000000000002',
      createdAt: new Date('2026-07-28T11:58:00.000Z'),
    });
    const third = tokenRow({
      id: '20000000-0000-4000-8000-000000000003',
      createdAt: new Date('2026-07-28T11:57:00.000Z'),
    });
    db.mcpToken.findMany = vi
      .fn()
      .mockResolvedValueOnce([first, second, third])
      .mockResolvedValueOnce([third]);

    const pageOne = await listMcpTokens(
      USER_ID,
      { limit: 2 },
      { db, now: () => NOW },
    );
    const pageTwo = await listMcpTokens(
      USER_ID,
      { limit: 2, cursor: pageOne.nextCursor! },
      { db, now: () => NOW },
    );

    expect(db.mcpToken.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: USER_ID,
          OR: [
            { createdAt: { lt: second.createdAt } },
            { createdAt: second.createdAt, id: { lt: second.id } },
          ],
        },
        take: 3,
      }),
    );
    expect([...pageOne.items, ...pageTwo.items].map((token) => token.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it('rejects malformed and oversized cursors before querying storage', async () => {
    const { db } = store();

    for (const cursor of ['not-valid-encoded-json', 'x'.repeat(513)]) {
      await expect(
        listMcpTokens(USER_ID, { cursor }, { db, now: () => NOW }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(db.mcpToken.findMany).not.toHaveBeenCalled();
  });

  it('scopes revocation to the owner and is indistinguishable for missing or foreign IDs', async () => {
    const { db, transaction } = store();
    transaction.mcpToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(revokeMcpToken(USER_ID, TOKEN_ID, { db, now: () => NOW })).resolves.toBeUndefined();

    expect(transaction.mcpToken.updateMany).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, userId: USER_ID, revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(transaction.securityAuditEvent.create).not.toHaveBeenCalled();
  });

  it('audits a successful revocation with only the persisted safe prefix', async () => {
    const { db, transaction } = store();

    await revokeMcpToken(USER_ID, TOKEN_ID, { db, now: () => NOW });

    expect(transaction.mcpToken.findFirst).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, userId: USER_ID, revokedAt: null },
      select: { prefix: true },
    });
    expect(transaction.securityAuditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER_ID,
        action: 'mcp_token.revoked',
        subjectId: TOKEN_ID,
        subjectPrefix: 'rct_example',
      },
    });
  });
});
