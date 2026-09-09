import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreparedOperation, type CreatePreparedOperationInput } from './operations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const now = new Date('2026-08-01T12:00:00.000Z');
const expiresAt = new Date('9999-12-31T23:59:59.999Z');

function input(): CreatePreparedOperationInput {
  return {
    principal: { tokenId: randomUUID(), tokenPrefix: 'rct_refund', userId: randomUUID() },
    companyId: randomUUID(), transactionId: randomUUID(),
    toolName: 'prepare_tax_refund', kind: 'tax_refund', idempotencyKey: randomUUID(),
    payload: { capability: 'manual_required', preview: { source: 'synthetic-deposit' } },
    sourceRevision: 2, preparedRevision: 2, qboType: 'Deposit',
    qboId: 'synthetic-deposit', qboSyncToken: '4',
  };
}

describePostgres('manual refund reservation and attestation durability', () => {
  let first: PrismaClient;
  let second: PrismaClient;
  beforeAll(() => {
    first = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    second = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  });
  afterAll(async () => { await Promise.all([first?.$disconnect(), second?.$disconnect()]); });
  const prepare = (value: CreatePreparedOperationInput, store = first) =>
    createPreparedOperation(value, { store, now: () => now, expiresAt: () => expiresAt });

  it('reserves one source under concurrent preparations with distinct idempotency keys', async () => {
    const value = input();
    const results = await Promise.allSettled([
      prepare(value), prepare({ ...value, idempotencyKey: randomUUID() }, second),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      status: 'rejected', reason: { code: 'OPERATION_CONFLICT' },
    });
    expect(await first.mcpOperation.count({ where: {
      companyId: value.companyId, transactionId: value.transactionId, cancelledAt: null,
    } })).toBe(1);
  });

  it('replays the same envelope and persists its manual lifetime', async () => {
    const value = input();
    const prepared = await prepare(value);
    expect(prepared.expiresAt).toEqual(expiresAt);
    expect(prepared.manualRecordedAt).toBeNull();
    expect(await prepare(value, second)).toEqual(prepared);
  });

  it('retains a manually recorded reservation and rejects changed or erased attestation', async () => {
    const value = input();
    const prepared = await prepare(value);
    const recordedAt = new Date(now.getTime() + 1_000);
    const recorded = await first.mcpOperation.update({
      where: { id: prepared.id }, data: { manualRecordedAt: recordedAt },
    });
    expect(recorded.manualRecordedAt).toEqual(recordedAt);
    await expect(prepare({ ...value, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    for (const data of [
      { manualRecordedAt: null },
      { manualRecordedAt: new Date(recordedAt.getTime() + 1_000) },
      { payload: { changed: true } },
    ]) {
      await expect(first.mcpOperation.update({ where: { id: prepared.id }, data }))
        .rejects.toThrow('McpOperation immutable fields cannot be changed');
    }
    await expect(first.mcpOperation.delete({ where: { id: prepared.id } }))
      .rejects.toThrow('McpOperation immutable fields cannot be changed');
  });

  it('releases a cancelled source without erasing its original envelope or attestation', async () => {
    const value = input();
    const prepared = await prepare(value);
    const recordedAt = new Date(now.getTime() + 1_000);
    await first.mcpOperation.update({ where: { id: prepared.id }, data: { manualRecordedAt: recordedAt } });
    const cancelled = await first.mcpOperation.update({
      where: { id: prepared.id }, data: { cancelledAt: new Date(now.getTime() + 2_000) },
    });
    expect(cancelled.manualRecordedAt).toEqual(recordedAt);
    expect(cancelled.payloadHash).toBe(prepared.payloadHash);
    const replacement = await prepare({ ...value, idempotencyKey: randomUUID() });
    expect(replacement.id).not.toBe(prepared.id);
    expect(replacement.manualRecordedAt).toBeNull();
    expect(await first.mcpOperation.count({ where: { companyId: value.companyId, transactionId: value.transactionId } })).toBe(2);
  });
});
