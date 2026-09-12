import { prisma } from '../../../lib/prisma.js';
import {
  PrismaClassificationSearchRepository,
  type ClassificationSearchCorpus,
} from '../search.js';
import {
  classificationEmbeddingRuntimeConfig,
  createVoyageEmbeddingClient,
  type ClassificationEmbeddingRuntimeConfig,
  type VoyageEmbeddingClient,
} from './client.js';
import type {
  ClassificationEmbeddingGeneration,
  ClassificationSearchDocument,
} from './recipe.js';
import { classificationEmbeddingGeneration } from './recipe.js';
import type {
  ClassificationEmbeddingStore,
  StoredEmbeddingChunk,
} from './vectorStore.js';
import { PgClassificationVectorStore } from './vectorStore.js';

const PROVIDER_CALL_INPUT_LIMIT = 512;
const MAX_RECONCILE_CHUNKS = 50_000;

export interface ClassificationEmbeddingReconcileResult {
  status: 'published' | 'unavailable' | 'failed';
  embedded: number;
  skipped: number;
  backlog: number;
  error: 'vector_capability_unavailable' | 'semantic_error' | null;
}

export interface ClassificationEmbeddingTickResult {
  configured: boolean;
  processed: number;
  published: number;
  failed: number;
  unavailable: number;
}

export interface ClassificationEmbeddingTickDependencies {
  runtimeConfig: () => ClassificationEmbeddingRuntimeConfig | null;
  listCompanyIds: () => Promise<readonly string[]>;
  documents: (companyId: string, expectedRevision?: string) => Promise<ClassificationSearchCorpus>;
  createClient: (config: ClassificationEmbeddingRuntimeConfig) => VoyageEmbeddingClient;
  createStore: () => ClassificationEmbeddingStore;
  reconcile: typeof reconcileClassificationEmbeddings;
}

function validDocumentSet(
  companyId: string,
  documents: readonly ClassificationSearchDocument[],
): boolean {
  let chunks = 0;
  const ids = new Set<string>();
  for (const document of documents) {
    chunks += document.chunks.length;
    if (
      document.companyId !== companyId
      || ids.has(document.id)
      || document.chunks.some((chunk, index) => chunk.index !== index)
    ) {
      return false;
    }
    ids.add(document.id);
  }
  return chunks <= MAX_RECONCILE_CHUNKS;
}

export async function reconcileClassificationEmbeddings(input: {
  companyId: string;
  documents: readonly ClassificationSearchDocument[];
  totalDocuments?: number;
  skippedDocuments?: number;
  generation: ClassificationEmbeddingGeneration;
  client: VoyageEmbeddingClient;
  store: ClassificationEmbeddingStore;
  targetRevision?: string;
  attemptToken?: string;
}): Promise<ClassificationEmbeddingReconcileResult> {
  const targetRevision = input.targetRevision ?? '0';
  const attemptToken = input.attemptToken ?? 'legacy-test-attempt';
  const totalDocuments = input.totalDocuments ?? input.documents.length;
  const skippedDocuments = input.skippedDocuments ?? 0;
  if (
    !validDocumentSet(input.companyId, input.documents)
    || totalDocuments !== input.documents.length + skippedDocuments
  ) {
    await input.store.recordFailure({
      companyId: input.companyId,
      fingerprint: input.generation.fingerprint,
      totalDocuments,
      embeddedDocuments: 0,
      skippedDocuments: 0,
      errorCode: 'semantic_error',
      targetRevision,
      attemptToken,
    }).catch(() => undefined);
    return {
      status: 'failed',
      embedded: 0,
      skipped: 0,
      backlog: totalDocuments,
      error: 'semantic_error',
    };
  }

  let capability;
  try {
    capability = await input.store.ensureAvailable();
  } catch {
    return {
      status: 'unavailable',
      embedded: 0,
      skipped: 0,
      backlog: totalDocuments,
      error: 'vector_capability_unavailable',
    };
  }
  if (!capability.available) {
    return {
      status: 'unavailable',
      embedded: 0,
      skipped: 0,
      backlog: totalDocuments,
      error: 'vector_capability_unavailable',
    };
  }

  let existing: StoredEmbeddingChunk[] = [];
  if (input.store.currentChunks !== undefined) {
    try {
      existing = await input.store.currentChunks(
        input.companyId,
        input.generation.fingerprint,
      );
    } catch {
      existing = [];
    }
  }
  const existingByDocument = new Map<string, StoredEmbeddingChunk[]>();
  for (const chunk of existing) {
    const bucket = existingByDocument.get(chunk.documentId) ?? [];
    bucket.push(chunk);
    existingByDocument.set(chunk.documentId, bucket);
  }
  const stored: StoredEmbeddingChunk[] = [];
  const changed: Array<{
    document: ClassificationSearchDocument;
    chunk: ClassificationSearchDocument['chunks'][number];
  }> = [];
  const changedDocumentIds = new Set<string>();
  for (const document of input.documents) {
    const old = existingByDocument.get(document.id) ?? [];
    const unchanged = old.length === document.chunks.length
      && document.chunks.every((chunk) => old.some((candidate) => (
        candidate.chunkIndex === chunk.index && candidate.contentHash === chunk.contentHash
      )));
    if (unchanged) {
      for (const chunk of document.chunks) {
        const previous = old.find((candidate) => candidate.chunkIndex === chunk.index)!;
        stored.push({
          documentId: document.id,
          companyId: document.companyId,
          kind: document.kind,
          sourceId: document.sourceId,
          revisedAt: document.revisedAt,
          chunkIndex: chunk.index,
          contentHash: chunk.contentHash,
          embedding: previous.embedding,
        });
      }
      continue;
    }
    changedDocumentIds.add(document.id);
    changed.push(...document.chunks.map((chunk) => ({ document, chunk })));
  }
  const expectedChunksByDocument = new Map(
    input.documents.map((document) => [document.id, document.chunks.length]),
  );
  const embeddedDocumentCount = () => {
    const storedChunksByDocument = new Map<string, number>();
    for (const chunk of stored) {
      storedChunksByDocument.set(
        chunk.documentId,
        (storedChunksByDocument.get(chunk.documentId) ?? 0) + 1,
      );
    }
    return [...expectedChunksByDocument].filter(([documentId, expectedChunks]) => (
      storedChunksByDocument.get(documentId) === expectedChunks
    )).length;
  };
  try {
    await input.store.recordProgress({
      companyId: input.companyId,
      fingerprint: input.generation.fingerprint,
      totalDocuments,
      embeddedDocuments: embeddedDocumentCount(),
      skippedDocuments,
      targetRevision,
      attemptToken,
    });
    for (let offset = 0; offset < changed.length; offset += PROVIDER_CALL_INPUT_LIMIT) {
      const batch = changed.slice(offset, offset + PROVIDER_CALL_INPUT_LIMIT);
      const embeddings = await input.client.embedDocuments(batch.map(({ chunk }) => chunk.text));
      if (embeddings.length !== batch.length) throw new Error('bounded-provider-response');
      for (const [index, { document, chunk }] of batch.entries()) {
        const embedding = embeddings[index];
        if (embedding === undefined) throw new Error('bounded-provider-response');
        stored.push({
          documentId: document.id,
          companyId: document.companyId,
          kind: document.kind,
          sourceId: document.sourceId,
          revisedAt: document.revisedAt,
          chunkIndex: chunk.index,
          contentHash: chunk.contentHash,
          embedding,
        });
      }
      await input.store.recordProgress({
        companyId: input.companyId,
        fingerprint: input.generation.fingerprint,
        totalDocuments,
        embeddedDocuments: embeddedDocumentCount(),
        skippedDocuments,
        targetRevision,
        attemptToken,
      });
    }
    await input.store.publishGeneration({
      companyId: input.companyId,
      generation: input.generation,
      chunks: stored,
      totalDocuments,
      skippedDocuments,
      targetRevision,
      attemptToken,
    });
    return {
      status: 'published',
      embedded: changedDocumentIds.size,
      skipped: skippedDocuments,
      backlog: 0,
      error: null,
    };
  } catch {
    await input.store.recordFailure({
      companyId: input.companyId,
      fingerprint: input.generation.fingerprint,
      totalDocuments,
      embeddedDocuments: embeddedDocumentCount(),
      skippedDocuments,
      errorCode: 'semantic_error',
      targetRevision,
      attemptToken,
    }).catch(() => undefined);
    return {
      status: 'failed',
      embedded: embeddedDocumentCount(),
      skipped: skippedDocuments,
      backlog: Math.max(0, totalDocuments - embeddedDocumentCount() - skippedDocuments),
      error: 'semantic_error',
    };
  }
}

const companyBatchCursors = new WeakMap<ClassificationEmbeddingTickDependencies, string>();

const defaultTickDependencies: ClassificationEmbeddingTickDependencies = {
  runtimeConfig: () => classificationEmbeddingRuntimeConfig(),
  async listCompanyIds() {
    const rows = await prisma.company.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  },
  async documents(companyId) {
    return new PrismaClassificationSearchRepository(prisma).documents(companyId);
  },
  createClient: (config) => createVoyageEmbeddingClient(config),
  createStore: () => new PgClassificationVectorStore(prisma),
  reconcile: reconcileClassificationEmbeddings,
};

/** One bounded background pass. It is a no-op unless the dedicated Voyage
 * key is present; companies are isolated so one bad generation cannot block
 * another company's exact/lexical or semantic state. */
export async function runClassificationEmbeddingTick(
  dependencies: ClassificationEmbeddingTickDependencies = defaultTickDependencies,
): Promise<ClassificationEmbeddingTickResult> {
  const config = dependencies.runtimeConfig();
  if (config === null) {
    return { configured: false, processed: 0, published: 0, failed: 0, unavailable: 0 };
  }
  const generation = classificationEmbeddingGeneration({
    baseUrl: config.baseUrl,
    fingerprintSalt: config.fingerprintSalt,
  });
  const allCompanyIds = [...new Set(await dependencies.listCompanyIds())].sort();
  const previous = companyBatchCursors.get(dependencies);
  const nextIndex = previous === undefined ? 0 : allCompanyIds.findIndex(id => id > previous);
  const start = Math.max(0, nextIndex);
  const companyIds = [...allCompanyIds.slice(start), ...allCompanyIds.slice(0, start)].slice(0, 10_000);
  const lastCompanyId = companyIds.at(-1);
  if (lastCompanyId !== undefined) companyBatchCursors.set(dependencies, lastCompanyId);
  const client = dependencies.createClient(config);
  const store = dependencies.createStore();
  const result: ClassificationEmbeddingTickResult = {
    configured: true,
    processed: 0,
    published: 0,
    failed: 0,
    unavailable: 0,
  };
  for (const companyId of companyIds) {
    result.processed += 1;
    let targetRevision: string | null = null;
    let attemptToken: string | null = null;
    try {
      const capability = await store.ensureAvailable();
      if (!capability.available) {
        result.unavailable += 1;
        continue;
      }
      if (store.health !== undefined) {
        const health = await store.health(companyId, generation.fingerprint);
        if (
          health.activeGeneration === generation.fingerprint
          && health.expectedGeneration === generation.fingerprint
          && health.expectedState === 'succeeded'
          && health.backlog === 0
          && health.progress === 1
          && health.lastError === null
          && health.currentCorpusRevision !== null
          && health.indexedCorpusRevision === health.currentCorpusRevision
          && health.expectedCorpusRevision === health.currentCorpusRevision
        ) {
          continue;
        }
      }
      if (store.beginAttempt === undefined) {
        result.failed += 1;
        continue;
      }
      const attempt = await store.beginAttempt({
        companyId,
        fingerprint: generation.fingerprint,
      });
      targetRevision = attempt.targetRevision;
      attemptToken = attempt.token;
      const corpus = await dependencies.documents(companyId, targetRevision);
      if (corpus.revision !== targetRevision) {
        throw new Error('classification-corpus-revision-changed');
      }
      const outcome = await dependencies.reconcile({
        companyId,
        documents: corpus.documents,
        totalDocuments: corpus.totalDocuments,
        skippedDocuments: corpus.skippedDocuments,
        generation,
        client,
        store,
        targetRevision,
        attemptToken,
      });
      if (outcome.status === 'published') result.published += 1;
      else if (outcome.status === 'unavailable') result.unavailable += 1;
      else result.failed += 1;
    } catch {
      if (targetRevision !== null && attemptToken !== null) {
        await store.recordFailure({
          companyId,
          fingerprint: generation.fingerprint,
          totalDocuments: 0,
          embeddedDocuments: 0,
          skippedDocuments: 0,
          errorCode: 'semantic_error',
          targetRevision,
          attemptToken,
        }).catch(() => undefined);
      }
      result.failed += 1;
    }
  }
  return result;
}
