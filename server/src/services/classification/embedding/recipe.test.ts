import { describe, expect, it } from 'vitest';
import {
  classificationEmbeddingGeneration,
  createClassificationSearchDocument,
  SEARCH_DOCUMENT_CHUNK_CODE_POINTS,
} from './recipe.js';

describe('classification embedding recipe', () => {
  it('creates deterministic labelled chunks without silently truncating fields', () => {
    const longExample = Array.from({ length: SEARCH_DOCUMENT_CHUNK_CODE_POINTS + 50 }, () => 'x').join('');
    const document = createClassificationSearchDocument({
      companyId: 'company-a',
      kind: 'classification_case',
      sourceId: 'case-a',
      revisedAt: '2026-08-30T00:00:00.000Z',
      fields: [
        ['vendor', 'Synthetic Vendor'],
        ['examples', [longExample, 'Second example']],
        ['empty', null],
      ],
    });

    expect(document.id).toBe('classification_case:case-a');
    expect(document.text).toContain('vendor: Synthetic Vendor');
    expect(document.text).toContain(longExample);
    expect(document.text).not.toContain('empty:');
    expect(document.chunks.length).toBeGreaterThan(1);
    expect(document.chunks.every((chunk) => Array.from(chunk.text).length <= SEARCH_DOCUMENT_CHUNK_CODE_POINTS))
      .toBe(true);
    expect(document.chunks.map((chunk) => chunk.index)).toEqual(
      document.chunks.map((_chunk, index) => index),
    );
  });

  it('binds provider settings, input types, recipe, chunking, endpoint, and salt into generation identity', () => {
    const base = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'synthetic-salt-a',
    });
    const same = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1/',
      fingerprintSalt: 'synthetic-salt-a',
    });
    const changedSalt = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'synthetic-salt-b',
    });
    const changedEndpoint = classificationEmbeddingGeneration({
      baseUrl: 'https://synthetic.invalid/v1',
      fingerprintSalt: 'synthetic-salt-a',
    });

    expect(base.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(same.fingerprint).toBe(base.fingerprint);
    expect(changedSalt.fingerprint).not.toBe(base.fingerprint);
    expect(changedEndpoint.fingerprint).not.toBe(base.fingerprint);
    expect(base).toMatchObject({
      provider: 'voyage',
      model: 'voyage-4-large',
      dimensions: 1024,
      outputDtype: 'float',
      documentInputType: 'document',
      queryInputType: 'query',
    });
    expect(JSON.stringify(base)).not.toContain('synthetic-salt-a');
  });
});
