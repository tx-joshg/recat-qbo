import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { VOYAGE_EMBEDDING_DIMENSIONS } from '../services/classification/embedding/client.js';

export type AccountingTopic = 'fuel' | 'personal' | 'inventory' | 'meals' | 'unknown';

export interface DeterministicEmbeddingRequest {
  method: string;
  path: string;
  inputType: 'document' | 'query';
  inputs: string[];
  topics: AccountingTopic[];
}

export interface DeterministicEmbeddingFixture {
  baseUrl: string;
  requests: DeterministicEmbeddingRequest[];
  close(): Promise<void>;
}

function topicFor(text: string): AccountingTopic {
  const normalized = text.normalize('NFC').toLocaleLowerCase('en-US');
  if (/expenses?\s*[·:]?\s*personal reimbursement|personal reimbursement/u.test(normalized)) {
    return 'personal';
  }
  if (/expenses?\s*[·:]?\s*(fleet )?fuel|fuel expense/u.test(normalized)) return 'fuel';
  if (/gift.card|owner reimbursement|personal convenience/u.test(normalized)) return 'personal';
  if (/fleet propellant|motor fuel|refuel|road.trip/u.test(normalized)) return 'fuel';
  if (/inventory|wholesale stock|resale goods/u.test(normalized)) return 'inventory';
  if (/meal|restaurant|lunch|dinner/u.test(normalized)) return 'meals';
  return 'unknown';
}

function topicVector(topic: AccountingTopic, release: 'a' | 'b'): number[] {
  const topicIndex: Record<AccountingTopic, number> = {
    fuel: 0,
    personal: 1,
    inventory: 2,
    meals: 3,
    unknown: 4,
  };
  const activeIndex = topicIndex[topic] + (release === 'b' ? 16 : 0);
  return Array.from(
    { length: VOYAGE_EMBEDDING_DIMENSIONS },
    (_unused, index) => index === activeIndex ? 1 : 0,
  );
}

export async function startDeterministicEmbeddingFixture(
  release: 'a' | 'b' = 'a',
): Promise<DeterministicEmbeddingFixture> {
  const requests: DeterministicEmbeddingRequest[] = [];
  let closed = false;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        input?: unknown;
        input_type?: unknown;
      };
      const inputs = Array.isArray(body.input) && body.input.every((value) => typeof value === 'string')
        ? body.input
        : [];
      const inputType = body.input_type === 'query' ? 'query' : 'document';
      const topics = inputs.map(topicFor);
      requests.push({ method: request.method ?? '', path: request.url ?? '', inputType, inputs, topics });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        model: 'voyage-4-large',
        data: topics.map((topic, index) => ({
          object: 'embedding',
          index,
          embedding: topicVector(topic, release),
        })),
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Embedding fixture did not listen.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      if (closed) return;
      closed = true;
      server.close();
      await once(server, 'close');
    },
  };
}
