import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classificationEmbeddingRuntimeConfig,
  createVoyageEmbeddingClient,
  VOYAGE_EMBEDDING_DIMENSIONS,
  VoyageEmbeddingError,
} from './client.js';

interface CapturedRequest {
  headers: IncomingHttpHeaders;
  path: string;
  body: Record<string, unknown>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

function vector(seed: number): number[] {
  return Array.from({ length: VOYAGE_EMBEDDING_DIMENSIONS }, (_unused, index) => (
    index === seed ? 1 : 0
  ));
}

async function fakeVoyage(
  responder: (body: Record<string, unknown>) => { status?: number; body: unknown },
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ headers: request.headers, path: request.url ?? '', body });
      const result = responder(body);
      response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fake Voyage did not listen.');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe('Voyage embedding client', () => {
  it('is unconfigured without the dedicated runtime key and uses bounded safe defaults when present', () => {
    expect(classificationEmbeddingRuntimeConfig({})).toBeNull();
    expect(classificationEmbeddingRuntimeConfig({
      VOYAGE_API_KEY: 'synthetic-runtime-key',
    })).toEqual({
      apiKey: 'synthetic-runtime-key',
      baseUrl: 'https://api.voyageai.com/v1',
      batchSize: 32,
      timeoutMs: 10_000,
      fingerprintSalt: 'recat-classification-embeddings-v1',
    });
  });

  it('sends bounded document batches with the exact Voyage REST fields', async () => {
    const fake = await fakeVoyage((body) => ({
      body: {
        object: 'list',
        model: 'voyage-4-large',
        data: (body.input as string[]).map((_input, index) => ({
          object: 'embedding',
          index,
          embedding: vector(index),
        })),
        usage: { total_tokens: 3 },
      },
    }));
    const client = createVoyageEmbeddingClient({
      apiKey: 'synthetic-voyage-key',
      baseUrl: fake.baseUrl,
      batchSize: 2,
      timeoutMs: 2_000,
    });

    const embeddings = await client.embedDocuments(['first document', 'second document', 'third document']);

    expect(embeddings).toHaveLength(3);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((request) => request.path)).toEqual(['/v1/embeddings', '/v1/embeddings']);
    expect(fake.requests.map((request) => request.body)).toEqual([
      {
        input: ['first document', 'second document'],
        model: 'voyage-4-large',
        input_type: 'document',
        output_dimension: 1024,
        output_dtype: 'float',
        truncation: false,
      },
      {
        input: ['third document'],
        model: 'voyage-4-large',
        input_type: 'document',
        output_dimension: 1024,
        output_dtype: 'float',
        truncation: false,
      },
    ]);
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer synthetic-voyage-key');
  });

  it('uses query input type and validates response index ordering', async () => {
    const fake = await fakeVoyage(() => ({
      body: {
        object: 'list',
        model: 'voyage-4-large',
        data: [{ object: 'embedding', index: 0, embedding: vector(0) }],
        usage: { total_tokens: 1 },
      },
    }));
    const client = createVoyageEmbeddingClient({
      apiKey: 'synthetic-voyage-key',
      baseUrl: fake.baseUrl,
      batchSize: 8,
      timeoutMs: 2_000,
    });

    await expect(client.embedQuery('office meals')).resolves.toEqual(vector(0));
    expect(fake.requests[0]?.body).toMatchObject({
      input: ['office meals'],
      input_type: 'query',
      model: 'voyage-4-large',
      output_dimension: 1024,
      output_dtype: 'float',
      truncation: false,
    });
  });

  it('accepts recipe-produced multi-line documents while still rejecting other controls', async () => {
    const fake = await fakeVoyage((body) => ({
      body: {
        object: 'list',
        model: 'voyage-4-large',
        data: (body.input as string[]).map((_input, index) => ({
          object: 'embedding',
          index,
          embedding: vector(index),
        })),
      },
    }));
    const client = createVoyageEmbeddingClient({
      apiKey: 'synthetic-key',
      baseUrl: fake.baseUrl,
      batchSize: 8,
      timeoutMs: 2_000,
    });

    await expect(client.embedDocuments(['vendor: Samplewear\nrationale: Inventory resale']))
      .resolves.toHaveLength(1);
    await expect(client.embedDocuments(['vendor: Samplewear\u000bprivate']))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects missing or wrong response model and object discriminators', async () => {
    const malformed = [
      { object: 'list', data: [{ object: 'embedding', index: 0, embedding: vector(0) }] },
      { object: 'list', model: 'voyage-4-lite', data: [{ object: 'embedding', index: 0, embedding: vector(0) }] },
      { object: 'embedding-list', model: 'voyage-4-large', data: [{ object: 'embedding', index: 0, embedding: vector(0) }] },
      { object: 'list', model: 'voyage-4-large', data: [{ object: 'vector', index: 0, embedding: vector(0) }] },
    ];
    for (const body of malformed) {
      const fake = await fakeVoyage(() => ({ body }));
      const client = createVoyageEmbeddingClient({
        apiKey: 'synthetic-key',
        baseUrl: fake.baseUrl,
        batchSize: 8,
        timeoutMs: 2_000,
      });
      await expect(client.embedDocuments(['one'])).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_RESPONSE',
      });
    }
  });

  it('turns provider and malformed-body failures into bounded errors without leaking body or key', async () => {
    const secretBody = 'private provider body database://internal';
    const fake = await fakeVoyage(() => ({ status: 500, body: { error: secretBody } }));
    const client = createVoyageEmbeddingClient({
      apiKey: 'synthetic-secret-key',
      baseUrl: fake.baseUrl,
      batchSize: 8,
      timeoutMs: 2_000,
    });

    const failure = await client.embedQuery('bounded query').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VoyageEmbeddingError);
    expect(failure).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(failure)).not.toContain(secretBody);
    expect(JSON.stringify(failure)).not.toContain('synthetic-secret-key');
    expect(String(failure)).not.toContain(fake.baseUrl);
  });

  it('rejects wrong dimensions, non-finite values, count mismatches, and reordered indexes', async () => {
    const malformed = [
      [{ object: 'embedding', index: 0, embedding: [1, 2] }],
      [{ object: 'embedding', index: 0, embedding: [...vector(0).slice(0, -1), Number.NaN] }],
      [],
      [
        { object: 'embedding', index: 1, embedding: vector(0) },
        { object: 'embedding', index: 0, embedding: vector(1) },
      ],
    ];
    for (const data of malformed) {
      const fake = await fakeVoyage(() => ({ body: { object: 'list', model: 'voyage-4-large', data } }));
      const client = createVoyageEmbeddingClient({
        apiKey: 'synthetic-key',
        baseUrl: fake.baseUrl,
        batchSize: 8,
        timeoutMs: 2_000,
      });
      const inputs = data.length === 2 ? ['one', 'two'] : ['one'];
      await expect(client.embedDocuments(inputs)).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_RESPONSE',
      });
    }
  });
});
