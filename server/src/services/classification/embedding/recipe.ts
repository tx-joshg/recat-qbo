import { createHash } from 'node:crypto';
import type { ClassificationKnowledgeKind } from '@recat/shared';
import {
  VOYAGE_EMBEDDING_DIMENSIONS,
  VOYAGE_EMBEDDING_MODEL,
  VOYAGE_EMBEDDING_OUTPUT_DTYPE,
  VOYAGE_EMBEDDING_PROVIDER,
} from './client.js';

export const CLASSIFICATION_EMBEDDING_RECIPE_VERSION = 'classification-memory/v1';
export const CLASSIFICATION_EMBEDDING_CHUNKING_VERSION = 'codepoint-lines/v1';
export const SEARCH_DOCUMENT_CHUNK_CODE_POINTS = 1_800;

const MAX_DOCUMENT_CODE_POINTS = 32_000;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export class ClassificationEmbeddingRecipeError extends Error {
  constructor() {
    super('Classification search document is invalid.');
    this.name = 'ClassificationEmbeddingRecipeError';
  }
}

export interface ClassificationEmbeddingGeneration {
  fingerprint: string;
  provider: typeof VOYAGE_EMBEDDING_PROVIDER;
  endpoint: string;
  model: typeof VOYAGE_EMBEDDING_MODEL;
  dimensions: typeof VOYAGE_EMBEDDING_DIMENSIONS;
  outputDtype: typeof VOYAGE_EMBEDDING_OUTPUT_DTYPE;
  documentInputType: 'document';
  queryInputType: 'query';
  recipeVersion: typeof CLASSIFICATION_EMBEDDING_RECIPE_VERSION;
  chunkingVersion: typeof CLASSIFICATION_EMBEDDING_CHUNKING_VERSION;
}

export interface ClassificationSearchDocumentChunk {
  index: number;
  text: string;
  contentHash: string;
}

export interface ClassificationSearchDocument {
  id: string;
  companyId: string;
  kind: ClassificationKnowledgeKind;
  sourceId: string;
  revisedAt: string;
  text: string;
  contentHash: string;
  chunks: ClassificationSearchDocumentChunk[];
}

export type ClassificationDocumentField = readonly [
  label: string,
  value: string | readonly string[] | null | undefined,
];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedText(value: string): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new ClassificationEmbeddingRecipeError();
  }
  const normalized = value.normalize('NFC').trim();
  if (normalized === '') throw new ClassificationEmbeddingRecipeError();
  return normalized;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const line of text.split('\n')) {
    const characters = Array.from(line);
    let offset = 0;
    while (offset < characters.length) {
      const separatorLength = currentLength === 0 ? 0 : 1;
      const remaining = SEARCH_DOCUMENT_CHUNK_CODE_POINTS - currentLength - separatorLength;
      if (remaining === 0) {
        chunks.push(current.join('\n'));
        current = [];
        currentLength = 0;
        continue;
      }
      const segment = characters.slice(offset, offset + remaining).join('');
      current.push(segment);
      currentLength += separatorLength + Array.from(segment).length;
      offset += Array.from(segment).length;
      if (offset < characters.length || currentLength === SEARCH_DOCUMENT_CHUNK_CODE_POINTS) {
        chunks.push(current.join('\n'));
        current = [];
        currentLength = 0;
      }
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

export function createClassificationSearchDocument(input: {
  companyId: string;
  kind: ClassificationKnowledgeKind;
  sourceId: string;
  revisedAt: string;
  fields: readonly ClassificationDocumentField[];
}): ClassificationSearchDocument {
  const companyId = boundedText(input.companyId);
  const sourceId = boundedText(input.sourceId);
  const revisedAt = boundedText(input.revisedAt);
  if (Number.isNaN(Date.parse(revisedAt))) throw new ClassificationEmbeddingRecipeError();
  const lines: string[] = [];
  for (const [rawLabel, rawValue] of input.fields) {
    if (rawValue === null || rawValue === undefined) continue;
    const label = boundedText(rawLabel);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      lines.push(`${label}: ${boundedText(value)}`);
    }
  }
  if (lines.length === 0) throw new ClassificationEmbeddingRecipeError();
  const text = lines.join('\n');
  if (Array.from(text).length > MAX_DOCUMENT_CODE_POINTS) {
    throw new ClassificationEmbeddingRecipeError();
  }
  const chunks = chunkText(text).map((chunk, index) => ({
    index,
    text: chunk,
    contentHash: sha256(chunk),
  }));
  return {
    id: `${input.kind}:${sourceId}`,
    companyId,
    kind: input.kind,
    sourceId,
    revisedAt,
    text,
    contentHash: sha256(text),
    chunks,
  };
}

export function classificationEmbeddingGeneration(input: {
  baseUrl: string;
  fingerprintSalt: string;
}): ClassificationEmbeddingGeneration {
  let endpoint: string;
  try {
    endpoint = new URL(input.baseUrl).toString().replace(/\/+$/u, '');
  } catch {
    throw new ClassificationEmbeddingRecipeError();
  }
  if (typeof input.fingerprintSalt !== 'string') throw new ClassificationEmbeddingRecipeError();
  const identity = {
    provider: VOYAGE_EMBEDDING_PROVIDER,
    endpoint,
    model: VOYAGE_EMBEDDING_MODEL,
    dimensions: VOYAGE_EMBEDDING_DIMENSIONS,
    outputDtype: VOYAGE_EMBEDDING_OUTPUT_DTYPE,
    documentInputType: 'document' as const,
    queryInputType: 'query' as const,
    recipeVersion: CLASSIFICATION_EMBEDDING_RECIPE_VERSION as typeof CLASSIFICATION_EMBEDDING_RECIPE_VERSION,
    chunkingVersion: CLASSIFICATION_EMBEDDING_CHUNKING_VERSION as typeof CLASSIFICATION_EMBEDDING_CHUNKING_VERSION,
  };
  return {
    fingerprint: sha256(JSON.stringify({ ...identity, fingerprintSalt: input.fingerprintSalt })),
    ...identity,
  };
}
