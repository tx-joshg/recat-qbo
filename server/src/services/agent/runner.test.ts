import { describe, expect, it, vi } from 'vitest';
import type { AgentToolContext } from './context.js';
import { AgentError } from './errors.js';
import { FakeAgentModel } from './fakeModel.js';
import type { AgentModel } from './model.js';
import { runAgent } from './runner.js';
import type { AgentToolRegistry } from './tools.js';

const decision = {
  kind: 'categorize',
  taxCalculation: 'TaxInclusive',
  lines: [{ grossAmount: -29, categoryQboId: 'acct-1', taxCodeQboId: 'gst' }],
  rationale: 'Recurring software.',
  evidence: ['verified history'],
  confidence: 0.98,
} as const;

const context: AgentToolContext = {
  schemaVersion: 'recat-agent-context-v1',
  companyId: 'co-1',
  transactionId: 'txn-1',
  expectedUpdatedAt: new Date('2026-07-23T12:00:00Z'),
  transaction: {
    id: 'txn-1',
    qboType: 'Purchase',
    qboSyncToken: '1',
    date: '2026-07-23T00:00:00.000Z',
    payee: 'WEBFLOW',
    memo: null,
    amount: -29,
    bankAccount: 'Visa',
  },
  holdingAccountQboIds: ['holding-1'],
  originalLines: [],
};

function registry(
  execute = vi.fn(async () => ({
    ok: true as const,
    schemaVersion: 'recat-tool-result-v1' as const,
    truncated: false,
    hasMore: false,
    data: [{ qboId: 'acct-1' }],
  })),
): AgentToolRegistry {
  return {
    definitions: [
      {
        name: 'list_allowed_accounts',
        description: 'accounts',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    execute,
  };
}

describe('runAgent', () => {
  it('accepts a decision without tools', async () => {
    const model = new FakeAgentModel([{ kind: 'decision', value: decision }]);
    await expect(runAgent(model, registry(), context)).resolves.toMatchObject({
      decision,
      turnCount: 1,
      toolCallCount: 0,
      toolTrace: [],
    });
    expect(model.inputs[0]?.systemPrompt).toContain(
      'grossAmount lines must sum exactly to transaction.amount. Purchases are negative.',
    );
  });

  it('executes tools in call order and preserves call IDs in the next turn', async () => {
    const execute = vi.fn(async (name: string) => ({
      ok: true as const,
      schemaVersion: 'recat-tool-result-v1' as const,
      truncated: false,
      hasMore: false,
      data: name,
    }));
    const model = new FakeAgentModel([
      {
        kind: 'tool_calls',
        calls: [
          { id: 'call-a', name: 'get_transaction', arguments: {} },
          { id: 'call-b', name: 'list_allowed_accounts', arguments: {} },
        ],
      },
      { kind: 'decision', value: decision },
    ]);
    const result = await runAgent(model, registry(execute), context);
    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      'get_transaction',
      'list_allowed_accounts',
    ]);
    expect(model.inputs[1]!.history.map((item) => item.kind === 'tool_result' && item.callId)).toEqual([
      'call-a',
      'call-b',
    ]);
    expect(result).toMatchObject({ turnCount: 2, toolCallCount: 2 });
  });

  it('allows one corrective turn for a malformed decision', async () => {
    const model = new FakeAgentModel([
      { kind: 'decision', value: { kind: 'categorize', prose: 'Software' } },
      { kind: 'decision', value: decision },
    ]);
    const result = await runAgent(model, registry(), context);
    expect(result.turnCount).toBe(2);
    expect(model.inputs[1]!.history).toEqual([
      expect.objectContaining({ kind: 'correction' }),
    ]);
  });

  it('fails after a repeated malformed decision', async () => {
    const model = new FakeAgentModel([
      { kind: 'decision', value: {} },
      { kind: 'decision', value: {} },
    ]);
    await expect(runAgent(model, registry(), context)).rejects.toMatchObject({
      code: 'AGENT_MALFORMED_OUTPUT',
      retryable: false,
    });
  });

  it('rejects unknown tools and duplicate call IDs', async () => {
    const unknown = new FakeAgentModel([
      { kind: 'tool_calls', calls: [{ id: 'x', name: 'post_transaction', arguments: {} }] },
    ]);
    const unknownRegistry = registry(
      vi.fn(async () => ({
        ok: false as const,
        schemaVersion: 'recat-tool-result-v1' as const,
        error: { code: 'TOOL_UNKNOWN' as const, message: 'unknown' },
      })),
    );
    await expect(runAgent(unknown, unknownRegistry, context)).rejects.toMatchObject({
      code: 'AGENT_UNKNOWN_TOOL',
    });

    const duplicate = new FakeAgentModel([
      {
        kind: 'tool_calls',
        calls: [
          { id: 'same', name: 'get_transaction', arguments: {} },
          { id: 'same', name: 'get_transaction', arguments: {} },
        ],
      },
    ]);
    await expect(runAgent(duplicate, registry(), context)).rejects.toMatchObject({
      code: 'AGENT_TOOL_ARGS',
    });
  });

  it('feeds one structured tool-argument error back, then fails on repetition', async () => {
    const badArgs = {
      ok: false as const,
      schemaVersion: 'recat-tool-result-v1' as const,
      error: { code: 'TOOL_ARGS' as const, message: 'invalid' },
    };
    const model = new FakeAgentModel([
      { kind: 'tool_calls', calls: [{ id: 'a', name: 'get_transaction', arguments: { bad: true } }] },
      { kind: 'tool_calls', calls: [{ id: 'b', name: 'get_transaction', arguments: { bad: true } }] },
    ]);
    await expect(runAgent(model, registry(vi.fn(async () => badArgs)), context)).rejects.toMatchObject({
      code: 'AGENT_TOOL_ARGS',
    });
    expect(model.inputs[1]!.history[0]).toMatchObject({
      kind: 'tool_result',
      result: { ok: false, error: { code: 'TOOL_ARGS' } },
    });
  });

  it('enforces turn and tool-call limits', async () => {
    const turns = Array.from({ length: 3 }, (_, index) => ({
      kind: 'tool_calls' as const,
      calls: [{ id: `call-${index}`, name: 'get_transaction', arguments: {} }],
    }));
    await expect(
      runAgent(new FakeAgentModel(turns), registry(), context, {
        limits: { maxTurns: 2 },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' });
    await expect(
      runAgent(
        new FakeAgentModel([
          {
            kind: 'tool_calls',
            calls: [
              { id: 'a', name: 'get_transaction', arguments: {} },
              { id: 'b', name: 'get_transaction', arguments: {} },
            ],
          },
        ]),
        registry(),
        context,
        { limits: { maxToolCalls: 1 } },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' });
  });

  it('replaces an oversized tool result with a bounded error before continuation', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      schemaVersion: 'recat-tool-result-v1' as const,
      truncated: false,
      hasMore: false,
      data: 'x'.repeat(4_000),
    }));
    const model = new FakeAgentModel([
      { kind: 'tool_calls', calls: [{ id: 'large', name: 'get_transaction', arguments: {} }] },
      { kind: 'decision', value: decision },
    ]);
    await runAgent(model, registry(execute), context, {
      limits: { maxToolResultBytes: 500 },
    });
    expect(model.inputs[1]!.history[0]).toMatchObject({
      kind: 'tool_result',
      result: { ok: false, error: { code: 'TOOL_FAILED' } },
    });
  });

  it('enforces total context bytes', async () => {
    await expect(
      runAgent(
        new FakeAgentModel([{ kind: 'decision', value: decision }]),
        registry(),
        context,
        { limits: { maxContextBytes: 10 } },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' });
  });

  it('times out a provider that never resolves and supports external cancellation', async () => {
    const blocked: AgentModel = {
      provider: 'blocked',
      model: 'blocked',
      nextTurn: async (_input, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    await expect(
      runAgent(blocked, registry(), context, { limits: { timeoutMs: 5 } }),
    ).rejects.toMatchObject({ code: 'AGENT_TIMEOUT', retryable: true });

    const external = new AbortController();
    external.abort();
    await expect(
      runAgent(blocked, registry(), context, { signal: external.signal }),
    ).rejects.toMatchObject({ code: 'AGENT_CANCELLED', retryable: false });
  });

  it('preserves typed provider retryability without provider response bodies', async () => {
    const model: AgentModel = {
      provider: 'test',
      model: 'test',
      nextTurn: async () => {
        throw new AgentError('AGENT_RATE_LIMIT', 'Provider rate limit.', true);
      },
    };
    await expect(runAgent(model, registry(), context)).rejects.toEqual(
      expect.objectContaining({ code: 'AGENT_RATE_LIMIT', retryable: true }),
    );
  });
});
