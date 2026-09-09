import { describe, expect, it } from 'vitest';
import { reciprocalRankFuse, rollupSemanticChunks } from './rrf.js';

describe('classification reciprocal-rank fusion', () => {
  it('uses k=60 and combines support for the same canonical document', () => {
    const result = reciprocalRankFuse([
      {
        matchedIn: 'lexical',
        hits: [
          { id: 'document-a', revisedAt: '2026-08-30T10:00:00.000Z' },
          { id: 'document-b', revisedAt: '2026-08-30T11:00:00.000Z' },
        ],
      },
      {
        matchedIn: 'semantic',
        hits: [
          { id: 'document-b', revisedAt: '2026-08-30T11:00:00.000Z' },
          { id: 'document-c', revisedAt: '2026-08-30T12:00:00.000Z' },
        ],
      },
    ], { limit: 3 });

    expect(result).toEqual([
      {
        id: 'document-b',
        score: (1 / 62) + (1 / 61),
        revisedAt: '2026-08-30T11:00:00.000Z',
        matchedIn: ['lexical', 'semantic'],
      },
      {
        id: 'document-a',
        score: 1 / 61,
        revisedAt: '2026-08-30T10:00:00.000Z',
        matchedIn: ['lexical'],
      },
      {
        id: 'document-c',
        score: 1 / 62,
        revisedAt: '2026-08-30T12:00:00.000Z',
        matchedIn: ['semantic'],
      },
    ]);
  });

  it('breaks equal scores by newest revised time and then stable ID', () => {
    const result = reciprocalRankFuse([
      {
        matchedIn: 'lexical',
        hits: [
          { id: 'newer', revisedAt: '2026-08-31T00:00:00.000Z' },
          { id: 'older', revisedAt: '2026-08-29T00:00:00.000Z' },
        ],
      },
      {
        matchedIn: 'semantic',
        hits: [
          { id: 'older', revisedAt: '2026-08-29T00:00:00.000Z' },
          { id: 'newer', revisedAt: '2026-08-31T00:00:00.000Z' },
        ],
      },
      {
        matchedIn: 'alias',
        hits: [
          { id: 'same-time-z', revisedAt: '2026-08-30T00:00:00.000Z' },
          { id: 'same-time-a', revisedAt: '2026-08-30T00:00:00.000Z' },
        ],
      },
      {
        matchedIn: 'rule',
        hits: [
          { id: 'same-time-a', revisedAt: '2026-08-30T00:00:00.000Z' },
          { id: 'same-time-z', revisedAt: '2026-08-30T00:00:00.000Z' },
        ],
      },
    ], { limit: 4 });

    expect(result.map((hit) => hit.id)).toEqual([
      'newer',
      'same-time-a',
      'same-time-z',
      'older',
    ]);
  });

  it('rolls chunks up to documents after applying the cosine floor', () => {
    const result = rollupSemanticChunks([
      { documentId: 'document-a', similarity: 0.81, revisedAt: '2026-08-30T00:00:00.000Z' },
      { documentId: 'document-a', similarity: 0.93, revisedAt: '2026-08-30T00:00:00.000Z' },
      { documentId: 'document-b', similarity: 0.79, revisedAt: '2026-08-31T00:00:00.000Z' },
      { documentId: 'document-c', similarity: 0.93, revisedAt: '2026-08-29T00:00:00.000Z' },
    ], { cosineFloor: 0.8, limit: 2 });

    expect(result).toEqual([
      { id: 'document-a', similarity: 0.93, revisedAt: '2026-08-30T00:00:00.000Z' },
      { id: 'document-c', similarity: 0.93, revisedAt: '2026-08-29T00:00:00.000Z' },
    ]);
  });
});
