import type { ClassificationMatchReason } from '@recat/shared';

export const CLASSIFICATION_RRF_K = 60;

export interface RankedDocument {
  id: string;
  revisedAt: string | null;
}

export interface RankedDocumentList {
  matchedIn: ClassificationMatchReason;
  hits: readonly RankedDocument[];
}

export interface FusedDocument extends RankedDocument {
  score: number;
  matchedIn: ClassificationMatchReason[];
}

export interface SemanticChunkHit {
  documentId: string;
  similarity: number;
  revisedAt: string | null;
}

export interface RolledUpSemanticDocument extends RankedDocument {
  similarity: number;
}

function timeValue(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newest(left: string | null, right: string | null): string | null {
  return timeValue(left) >= timeValue(right) ? left : right;
}

function compareRanked(
  left: { id: string; score: number; revisedAt: string | null },
  right: { id: string; score: number; revisedAt: string | null },
): number {
  return right.score - left.score
    || timeValue(right.revisedAt) - timeValue(left.revisedAt)
    || left.id.localeCompare(right.id);
}

/**
 * Fuses already-ranked canonical document lists. A document contributes at
 * most once per leg, so duplicate chunks must be rolled up before this call.
 */
export function reciprocalRankFuse(
  lists: readonly RankedDocumentList[],
  options: { limit: number; k?: number },
): FusedDocument[] {
  const limit = Math.max(0, Math.trunc(options.limit));
  const k = options.k ?? CLASSIFICATION_RRF_K;
  if (!Number.isFinite(k) || k <= 0 || limit === 0) return [];

  const byId = new Map<string, FusedDocument>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const [offset, hit] of list.hits.entries()) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      const contribution = 1 / (k + offset + 1);
      const current = byId.get(hit.id);
      if (current === undefined) {
        byId.set(hit.id, {
          id: hit.id,
          score: contribution,
          revisedAt: hit.revisedAt,
          matchedIn: [list.matchedIn],
        });
        continue;
      }
      current.score += contribution;
      current.revisedAt = newest(current.revisedAt, hit.revisedAt);
      if (!current.matchedIn.includes(list.matchedIn)) current.matchedIn.push(list.matchedIn);
    }
  }
  return [...byId.values()].sort(compareRanked).slice(0, limit);
}

/** Applies the cosine floor per chunk, then keeps one strongest chunk per document. */
export function rollupSemanticChunks(
  chunks: readonly SemanticChunkHit[],
  options: { cosineFloor: number; limit: number },
): RolledUpSemanticDocument[] {
  const byDocument = new Map<string, RolledUpSemanticDocument>();
  for (const hit of chunks) {
    if (!Number.isFinite(hit.similarity) || hit.similarity < options.cosineFloor) continue;
    const current = byDocument.get(hit.documentId);
    if (
      current === undefined
      || hit.similarity > current.similarity
      || (
        hit.similarity === current.similarity
        && timeValue(hit.revisedAt) > timeValue(current.revisedAt)
      )
    ) {
      byDocument.set(hit.documentId, {
        id: hit.documentId,
        similarity: hit.similarity,
        revisedAt: hit.revisedAt,
      });
    }
  }
  return [...byDocument.values()]
    .sort((left, right) => compareRanked(
      { ...left, score: left.similarity },
      { ...right, score: right.similarity },
    ))
    .slice(0, Math.max(0, Math.trunc(options.limit)));
}
