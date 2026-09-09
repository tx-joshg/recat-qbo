import {
  VOYAGE_EMBEDDING_DIMENSIONS,
  VOYAGE_EMBEDDING_MODEL,
  VOYAGE_EMBEDDING_PROVIDER,
} from './client.js';
import type { ClassificationEmbeddingGeneration } from './recipe.js';
import type {
  PgClassificationVectorStore,
  VectorCapability,
  VectorGenerationHealth,
} from './vectorStore.js';

export interface ClassificationSemanticHealth {
  configured: boolean;
  provider: typeof VOYAGE_EMBEDDING_PROVIDER;
  model: typeof VOYAGE_EMBEDDING_MODEL;
  dimensions: typeof VOYAGE_EMBEDDING_DIMENSIONS;
  vectorAvailable: boolean;
  expectedGeneration: string | null;
  indexedGeneration: string | null;
  activeGeneration: string | null;
  expectedState: string | null;
  embedded: number;
  skipped: number;
  backlog: number;
  progress: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  latestAttemptGeneration: string | null;
  latestAttemptState: string | null;
  latestAttemptAt: string | null;
  latestAttemptError: string | null;
  currentCorpusRevision: string | null;
  indexedCorpusRevision: string | null;
  expectedCorpusRevision: string | null;
  latestAttemptCorpusRevision: string | null;
}

type HealthVectorStore = Pick<PgClassificationVectorStore, 'ensureAvailable' | 'health'>;

const EMPTY_STATE: VectorGenerationHealth = {
  activeGeneration: null,
  expectedGeneration: null,
  expectedState: null,
  embedded: 0,
  skipped: 0,
  backlog: 0,
  progress: 0,
  lastSuccessAt: null,
  lastError: null,
  latestAttemptGeneration: null,
  latestAttemptState: null,
  latestAttemptAt: null,
  latestAttemptError: null,
  currentCorpusRevision: null,
  indexedCorpusRevision: null,
  expectedCorpusRevision: null,
  latestAttemptCorpusRevision: null,
};

export async function classificationSemanticHealth(
  companyId: string,
  input: {
    generation: ClassificationEmbeddingGeneration | null;
    store: HealthVectorStore;
  },
): Promise<ClassificationSemanticHealth> {
  const base = {
    provider: VOYAGE_EMBEDDING_PROVIDER,
    model: VOYAGE_EMBEDDING_MODEL,
    dimensions: VOYAGE_EMBEDDING_DIMENSIONS,
  };
  if (input.generation === null) {
    return {
      configured: false,
      ...base,
      vectorAvailable: false,
      ...EMPTY_STATE,
      expectedGeneration: null,
      indexedGeneration: null,
    };
  }
  let capability: VectorCapability;
  try {
    capability = await input.store.ensureAvailable();
  } catch {
    capability = { available: false, reason: 'vector_capability_unavailable' };
  }
  if (!capability.available) {
    return {
      configured: true,
      ...base,
      vectorAvailable: false,
      ...EMPTY_STATE,
      expectedGeneration: input.generation.fingerprint,
      indexedGeneration: null,
      lastError: capability.reason,
    };
  }
  let state: VectorGenerationHealth;
  try {
    state = await input.store.health(companyId, input.generation.fingerprint);
  } catch {
    state = { ...EMPTY_STATE, lastError: 'semantic_error' };
  }
  return {
    configured: true,
    ...base,
    vectorAvailable: true,
    expectedGeneration: input.generation.fingerprint,
    indexedGeneration: state.activeGeneration,
    activeGeneration: state.activeGeneration,
    expectedState: state.expectedState,
    embedded: state.embedded,
    skipped: state.skipped,
    backlog: state.backlog,
    progress: state.progress,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    latestAttemptGeneration: state.latestAttemptGeneration,
    latestAttemptState: state.latestAttemptState,
    latestAttemptAt: state.latestAttemptAt,
    latestAttemptError: state.latestAttemptError,
    currentCorpusRevision: state.currentCorpusRevision,
    indexedCorpusRevision: state.indexedCorpusRevision,
    expectedCorpusRevision: state.expectedCorpusRevision,
    latestAttemptCorpusRevision: state.latestAttemptCorpusRevision,
  };
}
