import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_RESPONSES_URL,
  buildCodexRequest,
  completeCodexText,
  parseCodexSse,
  streamCodexResponses,
} from './codexResponses.js';

const encoder = new TextEncoder();

function streamResponse(
  chunks: string[],
  { status = 200, close = true, onCancel }: { status?: number; close?: boolean; onCancel?: () => void } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (close) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } },
  );
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('buildCodexRequest', () => {
  it('translates messages into a stateless streaming Responses request', () => {
    expect(
      buildCodexRequest({
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'system', content: 'Return one category.' },
          { role: 'user', content: 'Office Depot' },
          { role: 'assistant', content: 'Office supplies' },
        ],
      }),
    ).toEqual({
      model: 'gpt-5.6-luna',
      instructions: 'You are Recat QBO, a helpful bookkeeping category assistant.',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Return one category.' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Office Depot' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Office supplies' }],
        },
      ],
      store: false,
      stream: true,
    });
  });

  it('rejects unsupported roles and non-string content', () => {
    expect(() =>
      buildCodexRequest({ model: 'm', messages: [{ role: 'tool' as 'user', content: 'x' }] }),
    ).toThrow(/role/i);
    expect(() =>
      buildCodexRequest({ model: 'm', messages: [{ role: 'user', content: {} as string }] }),
    ).toThrow(/content/i);
  });
});

describe('Codex Responses transport', () => {
  it('uses the pinned endpoint, account ID, exact subscription headers, and truthful originator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([
        event({ type: 'response.output_text.delta', delta: 'Office supplies' }),
        event({ type: 'response.completed' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      collect(
        streamCodexResponses({
          accessToken: 'access-secret',
          accountId: 'acct_123',
          model: 'gpt-5.6-luna',
          messages: [{ role: 'user', content: 'choose one' }],
        }),
      ),
    ).resolves.toEqual(['Office supplies']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CODEX_RESPONSES_URL);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-secret',
        'chatgpt-account-id': 'acct_123',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'recat-qbo',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(init.body))).toMatchObject({ store: false, stream: true });
  });

  it('parses split CRLF and multi-line SSE data fields', async () => {
    const response = streamResponse([
      'data: {"type":\r\n',
      'data: "response.output_text.delta","delta":"Hel"}\r\n\r\n',
      'data: {"type":"response.output_text.delta",',
      '"delta":"lo"}\n\n',
      event({ type: 'response.completed' }),
    ]);

    await expect(collect(parseCodexSse(response))).resolves.toEqual(['Hel', 'lo']);
  });

  it.each([
    [{ type: 'response.failed', response: { error: { message: 'model unavailable' } } }, /failed/i],
    [{ type: 'response.incomplete' }, /incomplete/i],
    [{ type: 'error', error: { message: 'rate limited' } }, /stream error/i],
  ])('rejects terminal failure event %j', async (terminal, message) => {
    await expect(collect(parseCodexSse(streamResponse([event(terminal)])))).rejects.toThrow(message);
  });

  it('rejects malformed and unterminated SSE without reflecting raw data', async () => {
    const malformed = await collect(
      parseCodexSse(streamResponse(['data: {"access_token":"do-not-reflect"\n\n'])),
    ).catch((error: unknown) => error as Error);
    expect(malformed).toBeInstanceOf(Error);
    expect((malformed as Error).message).toMatch(/malformed/i);
    expect((malformed as Error).message).not.toContain('do-not-reflect');

    await expect(
      collect(parseCodexSse(streamResponse([event({ type: 'response.output_text.delta', delta: 'x' })]))),
    ).rejects.toThrow(/before completion/i);
  });

  it('bounds individual SSE events and accumulated output', async () => {
    await expect(
      collect(parseCodexSse(streamResponse([`data: ${'x'.repeat(256 * 1024 + 1)}\n\n`]))),
    ).rejects.toThrow(/event.*large/i);

    const chunk = 'x'.repeat(240 * 1024);
    await expect(
      collect(
        parseCodexSse(
          streamResponse(Array.from({ length: 9 }, () => event({ type: 'response.output_text.delta', delta: chunk }))),
        ),
      ),
    ).rejects.toThrow(/output.*large/i);
  });

  it('bounds accumulated output by UTF-8 bytes rather than UTF-16 code units', async () => {
    const multibyteChunk = '€'.repeat(80 * 1024);
    expect(multibyteChunk.length * 9).toBeLessThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(multibyteChunk, 'utf8') * 9).toBeGreaterThan(2 * 1024 * 1024);

    await expect(
      collect(
        parseCodexSse(
          streamResponse(
            Array.from({ length: 9 }, () =>
              event({ type: 'response.output_text.delta', delta: multibyteChunk }),
            ),
          ),
        ),
      ),
    ).rejects.toThrow(/output.*large/i);
  });

  it('bounds error bodies without leaking the access token or unread tail', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse(
          [JSON.stringify({ error: { message: `access-secret temporary outage ${'x'.repeat(20_000)} secret-tail` } })],
          { status: 503, close: false, onCancel: () => (cancelled = true) },
        ),
      ),
    );

    const error = await collect(
      streamCodexResponses({
        accessToken: 'access-secret',
        accountId: 'acct_123',
        model: 'm',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).catch((cause: unknown) => cause as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/503/);
    expect((error as Error).message.length).toBeLessThan(9_000);
    expect((error as Error).message).not.toMatch(/access-secret|secret-tail/);
    expect(cancelled).toBe(true);
  });

  it('propagates caller aborts and request timeouts', async () => {
    let cancelled = false;
    const abort = new AbortController();
    const iterator = parseCodexSse(
      streamResponse([event({ type: 'response.output_text.delta', delta: 'one' })], {
        close: false,
        onCancel: () => (cancelled = true),
      }),
      { signal: abort.signal },
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 'one', done: false });
    abort.abort();
    await expect(iterator.next()).rejects.toThrow(/aborted/i);
    expect(cancelled).toBe(true);

    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      ),
    );
    const pending = collect(
      streamCodexResponses({
        accessToken: 'token',
        accountId: 'account',
        model: 'm',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 25,
      }),
    );
    const rejection = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it('reduces streamed deltas to one final text result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([
          event({ type: 'response.output_text.delta', delta: 'Office ' }),
          event({ type: 'response.output_text.delta', delta: 'supplies' }),
          event({ type: 'response.completed' }),
        ]),
      ),
    );

    await expect(
      completeCodexText({
        accessToken: 'token',
        accountId: 'account',
        model: 'm',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).resolves.toBe('Office supplies');
  });
});
