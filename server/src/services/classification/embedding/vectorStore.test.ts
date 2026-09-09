import { describe, expect, it } from 'vitest';
import {
  PgClassificationVectorStore,
  VectorStoreError,
} from './vectorStore.js';

describe('classification pgvector capability', () => {
  it('reports an unavailable extension without attempting to create tables', async () => {
    const calls: string[] = [];
    const db = {
      async $queryRaw(query: { strings: readonly string[] }) {
        calls.push(query.strings.join('?'));
        return [{ installed: false }];
      },
      async $executeRaw(query: { strings: readonly string[] }) {
        calls.push(query.strings.join('?'));
        return 0;
      },
    };

    const store = new PgClassificationVectorStore(db as never);

    await expect(store.ensureAvailable()).resolves.toEqual({
      available: false,
      reason: 'vector_capability_unavailable',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('pg_extension');
    expect(calls[0]).not.toContain('CREATE EXTENSION');
    expect(calls[0]).not.toContain('CREATE TABLE');
  });

  it('turns database details into a bounded vector-store error', async () => {
    const db = {
      async $queryRaw() {
        throw new Error('postgresql://private-host/recat secret-table');
      },
      async $executeRaw() {
        return 0;
      },
    };
    const store = new PgClassificationVectorStore(db as never);

    const failure = await store.ensureAvailable().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VectorStoreError);
    expect(failure).toMatchObject({ code: 'VECTOR_STORE_UNAVAILABLE' });
    expect(String(failure)).not.toContain('private-host');
    expect(JSON.stringify(failure)).not.toContain('secret-table');
  });

  it('shares installation across concurrent stores and retries after a failed install', async () => {
    let statements = 0; let fail = true;
    const db = {
      async $queryRaw() { return [{ installed: true }]; },
      async $executeRaw() { statements += 1; if (fail) { fail = false; throw new Error('Synthetic install failure'); } return 0; },
    };
    await expect(new PgClassificationVectorStore(db as never).ensureAvailable()).rejects.toMatchObject({ code: 'VECTOR_STORE_UNAVAILABLE' });
    await new PgClassificationVectorStore(db as never).ensureAvailable();
    const installedStatements = statements;
    await Promise.all(Array.from({ length: 8 }, () => new PgClassificationVectorStore(db as never).ensureAvailable()));
    expect(statements).toBe(installedStatements);
    const concurrentDb = { ...db, async $executeRaw() { statements += 1; await Promise.resolve(); return 0; } };
    const before = statements;
    await Promise.all(Array.from({ length: 8 }, () => new PgClassificationVectorStore(concurrentDb as never).ensureAvailable()));
    expect(statements - before).toBe(installedStatements - 1);
  });

  it('does not misreport a failed build fingerprint as an active generation', async () => {
    const db = {
      async $queryRaw() {
        return [{
          companyId: 'company-a',
          expectedFingerprint: 'a'.repeat(64),
          activeFingerprint: null,
          expectedState: 'failed',
          embeddedDocuments: 0,
          skippedDocuments: 0,
          backlogDocuments: 2,
          totalDocuments: 2,
          lastSuccessAt: null,
          lastErrorCode: 'semantic_error',
          latestAttemptFingerprint: 'a'.repeat(64),
          latestAttemptState: 'failed',
          latestAttemptAt: new Date('2026-08-31T00:00:00.000Z'),
          latestAttemptErrorCode: 'semantic_error',
        }];
      },
      async $executeRaw() {
        return 0;
      },
    };

    await expect(new PgClassificationVectorStore(db as never).health('company-a', 'a'.repeat(64)))
      .resolves.toMatchObject({
        activeGeneration: null,
        backlog: 2,
        lastError: 'semantic_error',
      });
  });

  it('reports expected-generation health separately from a newer failed attempt', async () => {
    const expected = 'a'.repeat(64);
    const failed = 'b'.repeat(64);
    const db = {
      async $queryRaw() {
        return [{
          companyId: 'company-a',
          expectedFingerprint: expected,
          activeFingerprint: expected,
          expectedState: 'active',
          embeddedDocuments: 4,
          skippedDocuments: 0,
          backlogDocuments: 0,
          totalDocuments: 4,
          lastSuccessAt: new Date('2026-08-31T00:00:00.000Z'),
          lastErrorCode: null,
          latestAttemptFingerprint: failed,
          latestAttemptState: 'failed',
          latestAttemptAt: new Date('2026-08-31T01:00:00.000Z'),
          latestAttemptErrorCode: 'semantic_error',
        }];
      },
      async $executeRaw() { return 0; },
    };

    await expect(new PgClassificationVectorStore(db as never).health('company-a', expected))
      .resolves.toMatchObject({
        activeGeneration: expected,
        expectedGeneration: expected,
        embedded: 4,
        backlog: 0,
        progress: 1,
        lastError: null,
        latestAttemptGeneration: failed,
        latestAttemptState: 'failed',
        latestAttemptError: 'semantic_error',
      });
  });
});
