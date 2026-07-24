import { describe, expect, it, vi } from 'vitest';
import { CodexAuthError } from '../ai/codexAuth.js';
import { CodexResponseError, type CodexResponseOptions } from '../ai/codexResponses.js';
import {
  AGENT_DECISION_JSON_SCHEMA,
  CodexAgentModel,
} from './codexModel.js';
import type { AgentModelInput } from './model.js';

const baseInput: AgentModelInput = {
  systemPrompt: 'Categorize one Purchase.',
  transaction: { id: 'txn-1', amount: -29, payee: 'WEBFLOW' },
  tools: [
    {
      name: 'list_allowed_accounts',
      description: 'List accounts',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  history: [],
};

const decision = {
  kind: 'categorize',
  taxCalculation: 'TaxInclusive',
  lines: [{ grossAmount: -29, categoryQboId: 'acct-1', taxCodeQboId: 'gst' }],
  rationale: 'Recurring software.',
  evidence: ['history'],
  confidence: 0.98,
};

function deps(completeTurn: (options: CodexResponseOptions) => Promise<any>) {
  return {
    getAccess: vi.fn(async () => ({ accessToken: 'access-1', accountId: 'account-1' })),
    markReconnectRequired: vi.fn(async () => undefined),
    completeTurn: vi.fn(completeTurn),
  };
}

describe('CodexAgentModel', () => {
  it('defines gross amounts as signed transaction amounts', () => {
    const decisionSchema = AGENT_DECISION_JSON_SCHEMA.properties as {
      decision: {
        anyOf: Array<{
          properties?: {
            lines?: {
              items?: {
                properties?: {
                  grossAmount?: { description?: string };
                };
              };
            };
          };
        }>;
      };
    };
    expect(
      decisionSchema.decision.anyOf[0]?.properties?.lines?.items?.properties?.grossAmount
        ?.description,
    ).toContain('purchases are negative');
  });

  it('preserves chronological tool-call continuations across multiple rounds', async () => {
    const implementation = deps(
      vi
        .fn()
        .mockResolvedValueOnce({
          text: '',
          functionCalls: [
            {
              itemId: 'item-1',
              callId: 'call-1',
              name: 'list_allowed_accounts',
              arguments: '{}',
              outputIndex: 0,
            },
          ],
          outputItems: [
            {
              type: 'function_call',
              id: 'item-1',
              call_id: 'call-1',
              name: 'list_allowed_accounts',
              arguments: '{}',
              status: 'completed',
            },
          ],
        })
        .mockResolvedValueOnce({
          text: '',
          functionCalls: [
            {
              itemId: 'item-2',
              callId: 'call-2',
              name: 'list_allowed_accounts',
              arguments: '{}',
              outputIndex: 0,
            },
          ],
          outputItems: [
            {
              type: 'function_call',
              id: 'item-2',
              call_id: 'call-2',
              name: 'list_allowed_accounts',
              arguments: '{}',
              status: 'completed',
            },
          ],
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ decision }),
          functionCalls: [],
          outputItems: [],
        }),
    );
    const model = new CodexAgentModel('gpt-5.6-luna', implementation);
    const signal = new AbortController().signal;

    await expect(model.nextTurn(baseInput, signal)).resolves.toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'call-1', name: 'list_allowed_accounts', arguments: {} }],
    });
    const result1 = {
      kind: 'tool_result' as const,
      callId: 'call-1',
      name: 'list_allowed_accounts',
      result: {
        ok: true as const,
        schemaVersion: 'recat-tool-result-v1' as const,
        truncated: false,
        hasMore: false,
        data: [{ qboId: 'acct-1' }],
      },
    };
    await expect(
      model.nextTurn({ ...baseInput, history: [result1] }, signal),
    ).resolves.toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'call-2', name: 'list_allowed_accounts', arguments: {} }],
    });
    const result2 = {
      ...result1,
      callId: 'call-2',
      result: { ...result1.result, data: [{ qboId: 'acct-2' }] },
    };
    await expect(
      model.nextTurn({ ...baseInput, history: [result1, result2] }, signal),
    ).resolves.toEqual({ kind: 'decision', value: decision });

    const second = implementation.completeTurn.mock.calls[1]![0];
    expect(second.inputItems?.map((item) => [item.type, item.call_id])).toEqual([
      ['function_call', 'call-1'],
      ['function_call_output', 'call-1'],
    ]);
    const third = implementation.completeTurn.mock.calls[2]![0];
    expect(third.inputItems?.map((item) => [item.type, item.call_id])).toEqual([
      ['function_call', 'call-1'],
      ['function_call_output', 'call-1'],
      ['function_call', 'call-2'],
      ['function_call_output', 'call-2'],
    ]);
    expect(second).toMatchObject({
      tools: [expect.objectContaining({ name: 'list_allowed_accounts' })],
      textFormat: { name: 'recat_agent_decision' },
      signal,
    });
  });

  it('uses an object-root strict schema for the primary decision wrapper', () => {
    expect(AGENT_DECISION_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      properties: { decision: { anyOf: expect.any(Array) } },
    });
  });

  it('declares a type for every strict-schema decision discriminator', () => {
    const properties = AGENT_DECISION_JSON_SCHEMA.properties as Record<string, unknown>;
    const decisionSchema = properties.decision as {
      anyOf: Array<{ properties: { kind: Record<string, unknown> } }>;
    };

    expect(decisionSchema.anyOf.map((branch) => branch.properties.kind)).toEqual([
      { type: 'string', const: 'categorize' },
      { type: 'string', const: 'transfer' },
      { type: 'string', const: 'skip' },
    ]);
  });

  it('rejects provider continuation items that exceed the runner context cap', async () => {
    const implementation = deps(async () => ({
      text: '',
      functionCalls: [
        {
          itemId: 'item-1',
          callId: 'call-1',
          name: 'list_allowed_accounts',
          arguments: '{}',
          outputIndex: 0,
        },
      ],
      outputItems: [
        {
          type: 'reasoning',
          id: 'reasoning-1',
          encrypted_content: 'x'.repeat(4096),
        },
      ],
    }));
    const model = new CodexAgentModel('gpt-5.6-luna', implementation);

    await expect(
      model.nextTurn(
        { ...baseInput, maxContextBytes: 1024 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT', retryable: false });
  });

  it('refreshes once on 401 and marks reconnect-required after a repeated 401', async () => {
    const getAccess = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'old', accountId: 'account' })
      .mockResolvedValueOnce({ accessToken: 'new', accountId: 'account' });
    const markReconnectRequired = vi.fn(async () => undefined);
    const completeTurn = vi
      .fn()
      .mockRejectedValueOnce(new CodexResponseError('unauthorized', { status: 401 }))
      .mockRejectedValueOnce(new CodexResponseError('unauthorized', { status: 401 }));
    const model = new CodexAgentModel('gpt-5.6-luna', {
      getAccess,
      markReconnectRequired,
      completeTurn,
    });

    await expect(
      model.nextTurn(baseInput, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH', retryable: false });
    expect(getAccess).toHaveBeenNthCalledWith(2, 'old');
    expect(markReconnectRequired).toHaveBeenCalledWith('new');
  });

  it('treats disconnected credentials as terminal auth rather than retryable network failure', async () => {
    const implementation = deps(async () => {
      throw new Error('not reached');
    });
    implementation.getAccess.mockRejectedValue(
      new CodexAuthError('ChatGPT is not connected', { status: 503 }),
    );
    const model = new CodexAgentModel('gpt-5.6-luna', implementation);

    await expect(
      model.nextTurn(baseInput, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH', retryable: false });
    expect(implementation.completeTurn).not.toHaveBeenCalled();
  });

  it('classifies provider rate limits and malformed function JSON', async () => {
    const limited = new CodexAgentModel(
      'gpt-5.6-luna',
      deps(async () => {
        throw new CodexResponseError('limited', { status: 429 });
      }),
    );
    await expect(
      limited.nextTurn(baseInput, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AGENT_RATE_LIMIT', retryable: true });

    const malformed = new CodexAgentModel(
      'gpt-5.6-luna',
      deps(async () => ({
        text: '',
        functionCalls: [
          {
            itemId: 'item-1',
            callId: 'call-1',
            name: 'list_allowed_accounts',
            arguments: '{not-json',
            outputIndex: 0,
          },
        ],
        outputItems: [],
      })),
    );
    await expect(
      malformed.nextTurn(baseInput, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AGENT_MALFORMED_OUTPUT', retryable: false });
  });
});
