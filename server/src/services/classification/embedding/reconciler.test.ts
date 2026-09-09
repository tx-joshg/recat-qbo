import { describe, expect, it } from 'vitest';
import type { VoyageEmbeddingClient } from './client.js';
import { classificationEmbeddingGeneration, createClassificationSearchDocument } from './recipe.js';
import {
  reconcileClassificationEmbeddings,
  runClassificationEmbeddingTick,
} from './reconciler.js';
import type { ClassificationEmbeddingStore } from './vectorStore.js';

function document(sourceId: string, value: string) {
  return createClassificationSearchDocument({
    companyId: 'company-a',
    kind: 'classification_case',
    sourceId,
    revisedAt: '2026-08-31T00:00:00.000Z',
    fields: [['rationale', value]],
  });
}

function vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => index === seed ? 1 : 0);
}

const generation = classificationEmbeddingGeneration({
  baseUrl: 'https://api.voyageai.com/v1',
  fingerprintSalt: 'synthetic-current-generation',
});

describe('classification embedding reconciliation', () => {
  it('publishes one complete company generation only after every chunk is embedded', async () => {
    const events: string[] = [];
    const published: unknown[] = [];
    const client: VoyageEmbeddingClient = {
      async embedDocuments(inputs) {
        events.push(`embed:${inputs.length}`);
        return inputs.map((_input, index) => vector(index));
      },
      async embedQuery() {
        throw new Error('not used');
      },
    };
    const store: ClassificationEmbeddingStore = {
      async ensureAvailable() {
        events.push('available');
        return { available: true, reason: null };
      },
      async publishGeneration(input) {
        events.push('publish');
        published.push(input);
      },
      async recordProgress(input) {
        events.push(`progress:${input.embeddedDocuments}/${input.totalDocuments}`);
      },
      async recordFailure() {
        events.push('failure');
      },
    };

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [document('case-a', 'Office meals'), document('case-b', 'Inventory freight')],
      totalDocuments: 3,
      skippedDocuments: 1,
      generation: classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1',
        fingerprintSalt: 'synthetic',
      }),
      client,
      store,
    });

    expect(events).toEqual(['available', 'progress:0/3', 'embed:2', 'progress:2/3', 'publish']);
    expect(result).toMatchObject({ status: 'published', embedded: 2, skipped: 1, backlog: 0 });
    expect(published).toEqual([
      expect.objectContaining({
        companyId: 'company-a',
        totalDocuments: 3,
        skippedDocuments: 1,
        chunks: [
          expect.objectContaining({ documentId: 'classification_case:case-a', embedding: vector(0) }),
          expect.objectContaining({ documentId: 'classification_case:case-b', embedding: vector(1) }),
        ],
      }),
    ]);
  });

  it('keeps the prior generation active and records a bounded failure when embedding fails', async () => {
    const events: unknown[] = [];
    const client: VoyageEmbeddingClient = {
      async embedDocuments() {
        throw new Error('provider body with private tenant data');
      },
      async embedQuery() {
        throw new Error('not used');
      },
    };
    const store: ClassificationEmbeddingStore = {
      async ensureAvailable() {
        return { available: true, reason: null };
      },
      async publishGeneration() {
        events.push('published');
      },
      async recordProgress() {},
      async recordFailure(input) {
        events.push(input);
      },
    };

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [document('case-a', 'Office meals')],
      generation: classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1',
        fingerprintSalt: 'synthetic',
      }),
      client,
      store,
    });

    expect(result).toMatchObject({ status: 'failed', error: 'semantic_error' });
    expect(events).toEqual([
      expect.objectContaining({ errorCode: 'semantic_error', embeddedDocuments: 0 }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private tenant data');
  });

  it('does not contact Voyage when pgvector is unavailable', async () => {
    let providerCalls = 0;
    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [document('case-a', 'Office meals')],
      generation: classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1',
        fingerprintSalt: 'synthetic',
      }),
      client: {
        async embedDocuments() {
          providerCalls += 1;
          return [vector(0)];
        },
        async embedQuery() {
          return vector(0);
        },
      },
      store: {
        async ensureAvailable() {
          return { available: false, reason: 'vector_capability_unavailable' };
        },
        async publishGeneration() {},
        async recordProgress() {},
        async recordFailure() {},
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      embedded: 0,
      skipped: 0,
      backlog: 1,
      error: 'vector_capability_unavailable',
    });
    expect(providerCalls).toBe(0);
  });

  it('reuses active same-generation chunks and embeds only changed documents', async () => {
    const first = document('case-a', 'Unchanged office meals');
    const second = document('case-b', 'Changed inventory freight');
    const existing = [
      {
        companyId: 'company-a',
        documentId: first.id,
        kind: first.kind,
        sourceId: first.sourceId,
        revisedAt: first.revisedAt,
        chunkIndex: first.chunks[0]!.index,
        contentHash: first.chunks[0]!.contentHash,
        embedding: vector(7),
      },
      {
        companyId: 'company-a',
        documentId: second.id,
        kind: second.kind,
        sourceId: second.sourceId,
        revisedAt: second.revisedAt,
        chunkIndex: second.chunks[0]!.index,
        contentHash: '0'.repeat(64),
        embedding: vector(8),
      },
    ];
    const providerInputs: string[] = [];
    let published: readonly { documentId: string; embedding: readonly number[] }[] = [];

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [first, second],
      generation,
      client: {
        async embedDocuments(inputs) {
          providerInputs.push(...inputs);
          return inputs.map(() => vector(9));
        },
        async embedQuery() { return vector(0); },
      },
      store: {
        async ensureAvailable() { return { available: true, reason: null }; },
        async currentChunks() { return existing; },
        async recordProgress() {},
        async publishGeneration(input) { published = input.chunks; },
        async recordFailure() {},
      },
    });

    expect(result).toMatchObject({ status: 'published', embedded: 1, backlog: 0 });
    expect(providerInputs).toEqual([second.chunks[0]!.text]);
    expect(published).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: first.id, embedding: vector(7) }),
      expect.objectContaining({ documentId: second.id, embedding: vector(9) }),
    ]));
  });

  it('does not count a document as embedded until every one of its chunks is stored', async () => {
    const singleChunk = Array.from({ length: 511 }, (_unused, index) => (
      document(`single-${index}`, `single ${index}`)
    ));
    const splitBase = document('split', 'split');
    const split = {
      ...splitBase,
      chunks: [
        { ...splitBase.chunks[0]!, index: 0, contentHash: 'a'.repeat(64), text: 'split first' },
        { ...splitBase.chunks[0]!, index: 1, contentHash: 'b'.repeat(64), text: 'split second' },
      ],
    };
    const progress: number[] = [];

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [...singleChunk, split],
      generation,
      client: {
        async embedDocuments(inputs) { return inputs.map(() => vector(0)); },
        async embedQuery() { return vector(0); },
      },
      store: {
        async ensureAvailable() { return { available: true, reason: null }; },
        async recordProgress(input) { progress.push(input.embeddedDocuments); },
        async publishGeneration() {},
        async recordFailure() {},
      },
    });

    expect(result.status).toBe('published');
    expect(progress).toEqual([0, 511, 512]);
  });

  it('reports partial completed-document progress when a later provider batch fails', async () => {
    const documents = Array.from({ length: 513 }, (_unused, index) => (
      document(`partial-${index}`, `partial ${index}`)
    ));
    let calls = 0;
    let failureEmbedded = -1;

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents,
      generation,
      client: {
        async embedDocuments(inputs) {
          calls += 1;
          if (calls === 2) throw new Error('synthetic second-batch failure');
          return inputs.map(() => vector(0));
        },
        async embedQuery() { return vector(0); },
      },
      store: {
        async ensureAvailable() { return { available: true, reason: null }; },
        async recordProgress() {},
        async publishGeneration() {},
        async recordFailure(input) { failureEmbedded = input.embeddedDocuments; },
      },
    });

    expect(result).toMatchObject({ status: 'failed', embedded: 512, backlog: 1 });
    expect(failureEmbedded).toBe(512);
  });

  it('keeps the background tick inert when the dedicated provider is unconfigured', async () => {
    let companyReads = 0;
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => null,
      async listCompanyIds() { companyReads += 1; return ['company-a']; },
      async documents() { return { documents: [], totalDocuments: 0, skippedDocuments: 0, revision: '1' }; },
      createClient() { throw new Error('not called'); },
      createStore() { throw new Error('not called'); },
      reconcile: reconcileClassificationEmbeddings,
    });

    expect(result).toEqual({
      configured: false,
      processed: 0,
      published: 0,
      failed: 0,
      unavailable: 0,
    });
    expect(companyReads).toBe(0);
  });

  it('rotates bounded company batches so later companies are reached on the next tick', async () => {
    const seen: string[] = [];
    const ids = Array.from({ length: 10_001 }, (_, index) => `company-${String(index).padStart(5, '0')}`);
    const dependencies = {
      runtimeConfig: () => ({ apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:12345/v1', timeoutMs: 1000, batchSize: 2, fingerprintSalt: 'synthetic' }),
      async listCompanyIds() { return ids; },
      async documents(companyId: string) { seen.push(companyId); return { documents: [], totalDocuments: 0, skippedDocuments: 0, revision: '1' }; },
      createClient: () => ({ async embedDocuments() { return []; }, async embedQuery() { return vector(0); } }),
      createStore: () => ({ async ensureAvailable() { return { available: true, reason: null }; }, async beginAttempt() { return { targetRevision: '1', token: 'synthetic' }; }, async recordProgress() {}, async publishGeneration() {}, async recordFailure() {} }),
      reconcile: reconcileClassificationEmbeddings,
    };
    expect((await runClassificationEmbeddingTick(dependencies)).processed).toBe(10_000);
    expect(seen).not.toContain(ids[10_000]);
    await runClassificationEmbeddingTick(dependencies);
    expect(seen[10_000]).toBe(ids[10_000]);
    expect(new Set(seen).size).toBe(10_001);
  });

  it('processes configured companies independently so one failed build does not stop the rest', async () => {
    const seen: string[] = [];
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => ({
        apiKey: 'synthetic-key',
        baseUrl: 'https://api.voyageai.com/v1',
        timeoutMs: 1_000,
        batchSize: 2,
        fingerprintSalt: 'synthetic',
      }),
      async listCompanyIds() { return ['company-a', 'company-b']; },
      async documents(companyId) {
        return {
          documents: [document(`case-${companyId}`, companyId)],
          totalDocuments: 1,
          skippedDocuments: 0,
          revision: '1',
        };
      },
      createClient() {
        return {
          async embedDocuments() { return [vector(0)]; },
          async embedQuery() { return vector(0); },
        };
      },
      createStore() {
        return {
          async ensureAvailable() { return { available: true, reason: null }; },
          async beginAttempt() { return { targetRevision: '1', token: 'attempt-1' }; },
          async recordProgress() {},
          async publishGeneration() {},
          async recordFailure() {},
        };
      },
      async reconcile(input) {
        seen.push(input.companyId);
        return input.companyId === 'company-a'
          ? { status: 'published', embedded: 1, skipped: 0, backlog: 0, error: null }
          : { status: 'failed', embedded: 0, skipped: 0, backlog: 1, error: 'semantic_error' };
      },
    });

    expect(seen).toEqual(['company-a', 'company-b']);
    expect(result).toEqual({
      configured: true,
      processed: 2,
      published: 1,
      failed: 1,
      unavailable: 0,
    });
  });

  it('marks the target corpus revision before scanning documents', async () => {
    const events: string[] = [];
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => ({
        apiKey: 'synthetic-key', baseUrl: 'https://api.voyageai.com/v1',
        timeoutMs: 1_000, batchSize: 2, fingerprintSalt: 'synthetic',
      }),
      async listCompanyIds() { return ['company-a']; },
      async documents(_companyId, expectedRevision) {
        events.push(`documents:${expectedRevision}`);
        return { documents: [], totalDocuments: 0, skippedDocuments: 0, revision: '7' };
      },
      createClient() {
        return {
          async embedDocuments() { return []; },
          async embedQuery() { return vector(0); },
        };
      },
      createStore() {
        return {
          async ensureAvailable() { events.push('available'); return { available: true, reason: null }; },
          async beginAttempt() {
            events.push('begin:7');
            return { targetRevision: '7', token: 'attempt-7' };
          },
          async recordProgress() {},
          async publishGeneration() {},
          async recordFailure() {},
        };
      },
      async reconcile(input) {
        events.push(`reconcile:${input.targetRevision}`);
        return { status: 'published', embedded: 0, skipped: 0, backlog: 0, error: null };
      },
    } as never);

    expect(result.published).toBe(1);
    expect(events).toEqual(['available', 'begin:7', 'documents:7', 'reconcile:7']);
  });

  it('records a failed attempt when the corpus revision changes during scanning', async () => {
    const failures: unknown[] = [];
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => ({
        apiKey: 'synthetic-key', baseUrl: 'https://api.voyageai.com/v1',
        timeoutMs: 1_000, batchSize: 2, fingerprintSalt: 'synthetic',
      }),
      async listCompanyIds() { return ['company-a']; },
      async documents() { throw new Error('revision changed'); },
      createClient() {
        return {
          async embedDocuments() { return []; },
          async embedQuery() { return vector(0); },
        };
      },
      createStore() {
        return {
          async ensureAvailable() { return { available: true, reason: null }; },
          async beginAttempt() { return { targetRevision: '9', token: 'attempt-9' }; },
          async recordProgress() {},
          async publishGeneration() {},
          async recordFailure(input) { failures.push(input); },
        };
      },
      reconcile: reconcileClassificationEmbeddings,
    });

    expect(result).toMatchObject({ processed: 1, failed: 1, published: 0 });
    expect(failures).toEqual([expect.objectContaining({
      companyId: 'company-a', targetRevision: '9', errorCode: 'semantic_error',
    })]);
  });

  it('skips an atomically current succeeded generation without beginning or scanning', async () => {
    const events: string[] = [];
    const healthy = {
      activeGeneration: generation.fingerprint,
      expectedGeneration: generation.fingerprint,
      expectedState: 'succeeded',
      currentCorpusRevision: '14',
      indexedCorpusRevision: '14',
      expectedCorpusRevision: '14',
      latestAttemptCorpusRevision: '14',
      embedded: 9,
      skipped: 1,
      backlog: 0,
      progress: 1,
      lastSuccessAt: '2026-08-31T00:00:00.000Z',
      lastError: null,
      latestAttemptGeneration: generation.fingerprint,
      latestAttemptState: 'succeeded',
      latestAttemptAt: '2026-08-31T00:00:00.000Z',
      latestAttemptError: null,
    };
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => ({
        apiKey: 'synthetic-key', baseUrl: 'https://api.voyageai.com/v1',
        timeoutMs: 1_000, batchSize: 2,
        fingerprintSalt: 'synthetic-current-generation',
      }),
      async listCompanyIds() { return ['company-a']; },
      async documents() { events.push('documents'); throw new Error('must not scan'); },
      createClient() {
        return {
          async embedDocuments() { events.push('provider'); return []; },
          async embedQuery() { return vector(0); },
        };
      },
      createStore() {
        return {
          async ensureAvailable() { events.push('available'); return { available: true, reason: null }; },
          async health() { events.push('health'); return healthy; },
          async beginAttempt() { events.push('begin'); throw new Error('must not begin'); },
          async recordProgress() {},
          async publishGeneration() { events.push('publish'); },
          async recordFailure() {},
        };
      },
      async reconcile() { events.push('reconcile'); throw new Error('must not reconcile'); },
    } as never);

    expect(result).toEqual({
      configured: true, processed: 1, published: 0, failed: 0, unavailable: 0,
    });
    expect(events).toEqual(['available', 'health']);
    expect(healthy).toMatchObject({
      expectedState: 'succeeded', currentCorpusRevision: '14', indexedCorpusRevision: '14',
    });
  });
});
