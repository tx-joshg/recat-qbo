import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAgentDecision,
  agentDecisionJsonSchema,
  agentDecisionSchemaName,
} from './core/decision.js';
import { FakeAgentModel } from './core/fakeModel.js';
import {
  AGENT_MODEL_PROMPT_VERSION,
  AgentModelError,
  type AgentModelInput,
  type AgentModelTurn,
} from './core/model.js';
import { buildAgentSnapshot } from './core/snapshot.js';
import { TOOL_DEFINITIONS } from './core/tools.js';
import {
  agentLiveReviewJsonSchema,
  agentLiveReviewSchemaName,
} from './core/verifier.js';
import { OpenAiCompatibleAgentModel } from './openAiCompatibleModel.js';

const MAX_RESPONSE_BYTES = 32 * 1024;
const UUID_1 = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';

function modelInput(): AgentModelInput {
  return {
    kind: 'decision',
    snapshot: buildAgentSnapshot({
      transaction: { id: UUID_1, revision: 3 },
      date: '2026-01-15',
      signedAmountCents: -4250,
      currency: 'CAD',
      sourceAccount: { displayName: 'Operating', type: 'BANK' },
      payee: 'Example Vendor',
      memo: 'Office supplies',
      candidateCategories: [{ qboId: 'cat.office', name: 'Office supplies' }],
      tax: {
        status: 'ready',
        supportedCalculationModes: ['TaxExcluded'],
        eligibleReferences: [{ qboId: 'tax.standard', label: 'Standard tax' }],
      },
      tags: [{ id: UUID_2, name: 'Operations' }],
      rules: [],
      similarVerifiedTransactions: [],
      featureVersion: 'agent-v1',
      configurationVersion: 'config-v1',
    }),
    history: [],
  };
}

function decisionEnvelope() {
  return {
    decision: {
      kind: 'abstain',
      reasonCode: 'INSUFFICIENT_CONTEXT',
      rationale: 'More evidence is required',
    },
  };
}

function completionResponse(
  content: unknown = JSON.stringify(decisionEnvelope()),
  options: {
    finishReason?: unknown;
    message?: unknown;
    usage?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    choices: [{
      finish_reason: options.finishReason ?? 'stop',
      message: options.message ?? { content },
    }],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...options.extra,
  });
}

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
}

async function capturedRequest(
  model: OpenAiCompatibleAgentModel,
  input: AgentModelInput = modelInput(),
): Promise<{ url: string; init: RequestInit; body: Record<string, unknown> }> {
  let capturedUrl = '';
  let capturedInit: RequestInit = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init ?? {};
    return jsonResponse(completionResponse());
  }));
  await model.nextTurn(input, new AbortController().signal);
  return {
    url: capturedUrl,
    init: capturedInit,
    body: JSON.parse(String(capturedInit.body)) as Record<string, unknown>,
  };
}

function errorDetails(error: unknown): Pick<AgentModelError, 'code' | 'classification' | 'message'> {
  expect(error).toBeInstanceOf(AgentModelError);
  return error as AgentModelError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiCompatibleAgentModel requests', () => {
  it('uses a credential-backed non-accounting structured probe and returns provider identity', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      capturedInit = init;
      return jsonResponse(completionResponse(JSON.stringify({ ok: true }), {
        extra: { model: 'Resolved/Model' },
      }));
    }));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'requested-alias',
      baseUrl: 'https://models.invalid/v1',
      apiKey: 'synthetic-health-key',
    });

    await expect(model.probe(new AbortController().signal)).resolves.toEqual({
      identity: { provider: 'custom', model: 'Resolved/Model' },
    });
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'requested-alias',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'recat_model_health_v1',
          strict: true,
        },
      },
    });
    const messages = body.messages as Array<{ content: string }>;
    expect(JSON.parse(messages[1]!.content)).toEqual({
      purpose: 'credential_and_model_health',
      accountingData: false,
    });
    expect(messages[1]!.content).not.toMatch(/transaction|category|taxCode|counterparty/i);
    expect(String(capturedInit?.body)).not.toContain('synthetic-health-key');
  });

  it('refuses live probes without a credential before transport', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'requested-alias',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.probe(new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_CONFIG_INVALID',
      message: 'Invalid agent model configuration.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends exact snapshot and decision under the explicit live approval schema', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      capturedInit = init;
      return jsonResponse(completionResponse(JSON.stringify({
        approved: true,
        issues: [],
      }), {
        extra: { model: 'resolved/reviewer' },
      }));
    }));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'openrouter',
      model: 'review-alias',
      apiKey: 'synthetic-review-key',
    });
    const input = modelInput();
    const candidateDecision = parseAgentDecision(decisionEnvelope());

    await expect(model.reviewLiveDecision({
      snapshot: input.snapshot,
      candidateDecision,
    }, new AbortController().signal)).resolves.toEqual({
      identity: { provider: 'openrouter', model: 'resolved/reviewer' },
      rawReview: { approved: true, issues: [] },
    });
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'review-alias',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: agentLiveReviewSchemaName,
          strict: true,
          schema: agentLiveReviewJsonSchema,
        },
      },
    });
    const messages = body.messages as Array<{ content: string }>;
    const reviewPayload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    expect(reviewPayload).toMatchObject({
      purpose: 'distinct_live_review',
      snapshot: { transaction: { id: UUID_1, revision: 3 } },
      candidateDecision,
    });
    expect(JSON.stringify(body)).not.toContain('synthetic-review-key');
  });

  it.each([
    completionResponse(JSON.stringify({ ok: true })),
    completionResponse(JSON.stringify({ ok: true }), { extra: { model: '' } }),
    completionResponse(JSON.stringify({ ok: false }), { extra: { model: 'resolved/model' } }),
  ])('fails closed for an unresolved or invalid health response %#', async (response) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'requested-alias',
      baseUrl: 'https://models.invalid/v1',
      apiKey: 'synthetic-health-key',
    });

    await expect(model.probe(new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_RESPONSE_INVALID',
      message: 'Invalid agent model response.',
    });
  });

  it('sends the exact fixed OpenRouter request using only the snapshot and bounded history', async () => {
    const input = modelInput();
    const model = new OpenAiCompatibleAgentModel({
      provider: 'openrouter',
      model: 'openai/example-model',
      apiKey: 'synthetic-api-key',
      referer: 'https://app.invalid',
      title: 'Synthetic Recat',
    });

    const { url, init, body } = await capturedRequest(model, input);

    expect(model.identity).toEqual({ provider: 'openrouter', model: 'openai/example-model' });
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer synthetic-api-key',
      'HTTP-Referer': 'https://app.invalid',
      'X-Title': 'Synthetic Recat',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).toMatchObject({
      model: 'openai/example-model',
      temperature: 0,
      tools: TOOL_DEFINITIONS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: agentDecisionSchemaName,
          strict: true,
          schema: agentDecisionJsonSchema,
        },
      },
    });
    expect(Object.keys(body).sort()).toEqual([
      'messages',
      'model',
      'response_format',
      'temperature',
      'tools',
    ]);
    expect(body.messages).toEqual([
      {
        role: 'system',
        content: expect.stringMatching(new RegExp(AGENT_MODEL_PROMPT_VERSION)),
      },
      {
        role: 'user',
        content: expect.stringMatching(/"purpose":"decision".*"snapshot":\{"candidateCategories"/),
      },
    ]);

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'company-id-sentinel',
      'full-account-987654321',
      'oauth-token-sentinel',
      'raw-qbo-fixture-sentinel',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(String(init.body)).not.toContain('synthetic-api-key');
  });

  it('uses a distinct fixed review instruction and includes only the bounded candidate decision', async () => {
    const input: AgentModelInput = {
      ...modelInput(),
      kind: 'review',
      candidateDecision: parseAgentDecision(decisionEnvelope()),
    };
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'review-model',
      baseUrl: 'https://models.invalid/v1',
    });

    const { body } = await capturedRequest(model, input);
    const messages = body.messages as { role: string; content: string }[];

    expect(messages[0]).toEqual({
      role: 'system',
      content: expect.stringMatching(/review/i),
    });
    expect(messages[0]!.content).toContain(AGENT_MODEL_PROMPT_VERSION);
    expect(JSON.parse(messages[1]!.content)).toMatchObject({
      promptVersion: AGENT_MODEL_PROMPT_VERSION,
      purpose: 'review',
      candidateDecision: decisionEnvelope().decision,
      snapshot: { schemaVersion: 2 },
    });
    expect(messages[1]!.content).not.toContain('company-id-sentinel');
  });

  it('normalizes a custom base URL and includes only the optional custom bearer header', async () => {
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1///',
      apiKey: 'custom-key',
    });

    const { url, init } = await capturedRequest(model);

    expect(model.identity).toEqual({ provider: 'custom', model: 'local-model' });
    expect(url).toBe('https://models.invalid/v1/chat/completions');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer custom-key',
    });
  });

  it('maps bounded assistant/tool history without adding unrelated provider context', async () => {
    const input: AgentModelInput = {
      ...modelInput(),
      history: [
      {
        role: 'assistant',
        toolCalls: [{ id: 'call-1', name: 'search_categories', arguments: { query: 'office', limit: 4 } }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'search_categories',
        result: { items: [{ qboId: 'cat.office', name: 'Office supplies' }] },
      },
      ],
    };
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    const { body } = await capturedRequest(model, input);

    expect(body.messages).toEqual([
      { role: 'system', content: expect.stringMatching(/decision/i) },
      { role: 'user', content: expect.any(String) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'search_categories',
            arguments: '{"limit":4,"query":"office"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'search_categories',
        content: '{"items":[{"name":"Office supplies","qboId":"cat.office"}]}',
      },
    ]);
  });

  it.each([
    '',
    '   ',
    'not a URL',
    'ftp://models.invalid/v1',
    'https://user:password@models.invalid/v1',
  ])('rejects an unsafe custom endpoint before fetch: %j', async (baseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let thrown: unknown;
    try {
      const model = new OpenAiCompatibleAgentModel({
        provider: 'custom',
        model: 'local-model',
        baseUrl,
      });
      await model.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      thrown = error;
    }

    expect(errorDetails(thrown)).toMatchObject({
      code: 'AGENT_MODEL_CONFIG_INVALID',
      classification: 'terminal',
      message: 'Invalid agent model configuration.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unrelated tenant, credential, account-number, and raw-provider context before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });
    const base = modelInput();
    const unsafeInputs = [
      { ...base, companyId: 'company-id-sentinel' },
      { ...base, accessToken: 'oauth-token-sentinel' },
      { ...base, rawQboFixture: { secret: 'raw-qbo-fixture-sentinel' } },
      {
        ...base,
        snapshot: {
          ...base.snapshot,
          sourceAccount: {
            ...base.snapshot.sourceAccount,
            accountNumber: '987654321',
          },
        },
      },
    ] as unknown as AgentModelInput[];

    for (const unsafeInput of unsafeInputs) {
      await expect(model.nextTurn(unsafeInput, new AbortController().signal)).rejects.toMatchObject({
        code: 'AGENT_MODEL_INPUT_INVALID',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unrelated or sensitive context hidden in fixed-tool history before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });
    const unsafeHistories = [
      [
        {
          role: 'assistant',
          toolCalls: [{
            id: 'call-1',
            name: 'search_categories',
            arguments: {
              query: 'office',
              limit: 4,
              accessToken: 'oauth-token-sentinel',
            },
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          name: 'search_categories',
          result: { items: [{ qboId: 'cat.office', name: 'Office supplies' }] },
        },
      ],
      [
        {
          role: 'assistant',
          toolCalls: [{
            id: 'call-2',
            name: 'search_categories',
            arguments: { query: 'office', limit: 4 },
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call-2',
          name: 'search_categories',
          result: {
            items: [{
              qboId: 'cat.office',
              name: 'Office supplies',
              accountNumber: '987654321',
            }],
          },
        },
      ],
      [
        {
          role: 'assistant',
          toolCalls: [{
            id: 'call-3',
            name: 'list_rules',
            arguments: {},
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call-3',
          name: 'list_rules',
          result: { items: [{ rawQboFixture: 'raw-qbo-fixture-sentinel' }] },
        },
      ],
      [
        {
          role: 'assistant',
          toolCalls: [{
            id: 'call-4',
            name: 'list_rules',
            arguments: {},
          }],
          companyId: 'company-id-sentinel',
        },
        {
          role: 'tool',
          toolCallId: 'call-4',
          name: 'list_rules',
          result: { items: [] },
        },
      ],
    ];

    for (const history of unsafeHistories) {
      const input = { ...modelInput(), history } as unknown as AgentModelInput;
      await expect(model.nextTurn(input, new AbortController().signal)).rejects.toMatchObject({
        code: 'AGENT_MODEL_INPUT_INVALID',
        classification: 'terminal',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unbounded conversation history before fetch', async () => {
    const input: AgentModelInput = {
      ...modelInput(),
      history: Array.from({ length: 41 }, (_, index) => ({
        role: 'tool' as const,
        toolCallId: `call-${index}`,
        name: 'list_rules' as const,
        result: { items: [] },
      })),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_INPUT_INVALID',
      classification: 'terminal',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'decision', candidateDecision: decisionEnvelope().decision },
    { kind: 'review' },
    { kind: 'other' },
  ])('rejects an invalid or ambiguous purpose shape before fetch: %#', async (invalidShape) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });
    const input = { ...modelInput(), ...invalidShape } as unknown as AgentModelInput;

    await expect(model.nextTurn(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_INPUT_INVALID',
      classification: 'terminal',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OpenAiCompatibleAgentModel response parsing', () => {
  it('returns decoded bounded tool calls and normalized usage', async () => {
    const response = completionResponse(null, {
      finishReason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'search_categories',
              arguments: '{"query":"office","limit":5}',
            },
          },
          {
            id: 'call-2',
            type: 'function',
            function: {
              name: 'list_tax_codes',
              arguments: '{}',
            },
          },
        ],
      },
      usage: { prompt_tokens: 101, completion_tokens: 22, total_tokens: 123 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).resolves.toEqual({
      kind: 'tool_calls',
      toolCalls: [
        { id: 'call-1', name: 'search_categories', arguments: { query: 'office', limit: 5 } },
        { id: 'call-2', name: 'list_tax_codes', arguments: {} },
      ],
      usage: { inputTokens: 101, outputTokens: 22, totalTokens: 123 },
    });
  });

  it('returns raw structured decision JSON without applying the decision parser', async () => {
    const rawEnvelope = { decision: { kind: 'future-shape-for-runner-validation' } };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(completionResponse(JSON.stringify(rawEnvelope)))));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).resolves.toEqual({
      kind: 'decision',
      rawDecision: rawEnvelope,
    });
  });

  it.each([
    ['missing choices', JSON.stringify({})],
    ['empty choices', JSON.stringify({ choices: [] })],
    ['missing message', JSON.stringify({ choices: [{ finish_reason: 'stop' }] })],
    ['empty content', completionResponse('')],
    ['whitespace content', completionResponse('   ')],
    ['malformed content JSON', completionResponse('{')],
    ['scalar content JSON', completionResponse('42')],
    ['unknown finish shape', completionResponse(JSON.stringify(decisionEnvelope()), { finishReason: 'length' })],
    [
      'mixed content and tools',
      completionResponse(JSON.stringify(decisionEnvelope()), {
        finishReason: 'tool_calls',
        message: {
          content: JSON.stringify(decisionEnvelope()),
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'list_rules', arguments: '{}' },
          }],
        },
      }),
    ],
    [
      'non-null tool-call content',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: 42,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'list_rules', arguments: '{}' },
          }],
        },
      }),
    ],
    [
      'empty tool calls',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: { content: null, tool_calls: [] },
      }),
    ],
    [
      'blank call id',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: ' ',
            type: 'function',
            function: { name: 'list_rules', arguments: '{}' },
          }],
        },
      }),
    ],
    [
      'duplicate call ids',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id: 'same', type: 'function', function: { name: 'list_rules', arguments: '{}' } },
            { id: 'same', type: 'function', function: { name: 'list_tax_codes', arguments: '{}' } },
          ],
        },
      }),
    ],
    [
      'unknown tool',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'provider_invented_tool', arguments: '{}' },
          }],
        },
      }),
    ],
    [
      'malformed tool arguments',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'list_rules', arguments: '{secret-argument}' },
          }],
        },
      }),
    ],
    [
      'array tool arguments',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'list_rules', arguments: '[]' },
          }],
        },
      }),
    ],
    [
      'duplicate tool argument keys',
      completionResponse(null, {
        finishReason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'search_categories',
              arguments: '{"query":"office","limit":1,"limit":2}',
            },
          }],
        },
      }),
    ],
  ])('rejects %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_RESPONSE_INVALID',
      classification: 'terminal',
      message: 'Invalid agent model response.',
    });
  });

  it.each([
    { prompt_tokens: Number.NaN },
    { completion_tokens: Number.POSITIVE_INFINITY },
    { total_tokens: -1 },
    { prompt_tokens: 1.5 },
    { prompt_tokens: '10' },
  ])('rejects invalid usage metadata %#', async (usage) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(completionResponse(undefined, { usage }))));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_RESPONSE_INVALID',
    });
  });
});

describe('OpenAiCompatibleAgentModel transport bounds and errors', () => {
  it('accepts a valid multibyte response at exactly 32 KiB', async () => {
    const base = completionResponse(undefined, { extra: { padding: 'é' } });
    const exact = completionResponse(undefined, {
      extra: { padding: `é${'x'.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(base, 'utf8'))}` },
    });
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_RESPONSE_BYTES);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(exact, {
      headers: { 'Content-Length': String(MAX_RESPONSE_BYTES) },
    })));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).resolves.toMatchObject({
      kind: 'decision',
    });
  });

  it('rejects one UTF-8 byte over the streaming response limit', async () => {
    const base = completionResponse(undefined, { extra: { padding: 'é' } });
    const oversized = completionResponse(undefined, {
      extra: { padding: `é${'x'.repeat(MAX_RESPONSE_BYTES + 1 - Buffer.byteLength(base, 'utf8'))}` },
    });
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(MAX_RESPONSE_BYTES + 1);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(oversized)));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_RESPONSE_TOO_LARGE',
      classification: 'terminal',
    });
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    let readerRequested = false;
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': String(MAX_RESPONSE_BYTES + 1) }),
      body: {
        cancel,
        getReader() {
          readerRequested = true;
          throw new Error('provider-body-secret');
        },
      },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_RESPONSE_TOO_LARGE',
    });
    expect(readerRequested).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted call without fetching', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), controller.signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_ABORTED',
      classification: 'terminal',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies an abort that occurs while fetch is resolving as an abort', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort();
      return new Response('provider-message-secret', { status: 500 });
    }));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), controller.signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_ABORTED',
      classification: 'terminal',
    });
  });

  it('honors abort during a streaming body read', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('{"choices":['));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });
    const controller = new AbortController();

    const pending = model.nextTurn(modelInput(), controller.signal);
    await vi.waitFor(() => expect(streamController).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'AGENT_MODEL_ABORTED',
      classification: 'terminal',
    });
  });

  it.each([
    [408, 'retryable'],
    [409, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
    [400, 'terminal'],
    [401, 'terminal'],
    [404, 'terminal'],
  ] as const)('classifies HTTP %i as %s without reading or reflecting the body', async (status, classification) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider-message-secret', { status })));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    let thrown: unknown;
    try {
      await model.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      thrown = error;
    }

    expect(errorDetails(thrown)).toMatchObject({
      code: 'AGENT_MODEL_HTTP_ERROR',
      classification,
      message: 'Agent model request failed.',
    });
    expect(String(thrown)).not.toContain('provider-message-secret');
  });

  it('treats a non-5xx status above 599 as terminal and cancels its unread body', async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: false,
      status: 600,
      body: { cancel },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    await expect(model.nextTurn(modelInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_HTTP_ERROR',
      classification: 'terminal',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('sanitizes network, response, argument, endpoint, and provider error details', async () => {
    const secrets = [
      'network-secret',
      'response-body-secret',
      'argument-secret',
      'credential-secret',
      'provider-message-secret',
    ];
    const model = new OpenAiCompatibleAgentModel({
      provider: 'custom',
      model: 'local-model',
      baseUrl: 'https://models.invalid/v1',
    });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network-secret');
    }));
    let networkError: unknown;
    try {
      await model.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      networkError = error;
    }

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('response-body-secret')));
    let responseError: unknown;
    try {
      await model.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      responseError = error;
    }

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(completionResponse(null, {
      finishReason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'list_rules', arguments: '{argument-secret}' },
        }],
      },
    }))));
    let argumentError: unknown;
    try {
      await model.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      argumentError = error;
    }

    let endpointError: unknown;
    try {
      const invalid = new OpenAiCompatibleAgentModel({
        provider: 'custom',
        model: 'local-model',
        baseUrl: 'https://user:credential-secret@models.invalid/v1',
      });
      await invalid.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      endpointError = error;
    }

    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider-message-secret', { status: 400 })));
    let providerError: unknown;
    try {
      await model.nextTurn(modelInput(), new AbortController().signal);
    } catch (error) {
      providerError = error;
    }

    for (const error of [networkError, responseError, argumentError, endpointError, providerError]) {
      const rendered = `${String(error)} ${error instanceof Error ? error.stack : ''}`;
      for (const secret of secrets) expect(rendered).not.toContain(secret);
    }
  });
});

describe('FakeAgentModel', () => {
  it('returns deterministic detached turns in order and then reports terminal exhaustion', async () => {
    const turns: AgentModelTurn[] = [
      {
        kind: 'tool_calls',
        toolCalls: [{ id: 'call-1', name: 'list_rules', arguments: {} }],
      },
      {
        kind: 'decision',
        rawDecision: decisionEnvelope(),
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      },
    ];
    const model = new FakeAgentModel(turns, 'fixture-model');
    const signal = new AbortController().signal;

    expect(model.identity).toEqual({ provider: 'fake', model: 'fixture-model' });
    const first = await model.nextTurn(modelInput(), signal);
    expect(first).toEqual(turns[0]);
    expect(first).not.toBe(turns[0]);
    await expect(model.nextTurn(modelInput(), signal)).resolves.toEqual(turns[1]);
    await expect(model.nextTurn(modelInput(), signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_EXHAUSTED',
      classification: 'terminal',
      message: 'Fake agent model sequence exhausted.',
    });
  });

  it('honors abort without consuming the next deterministic turn', async () => {
    const turn: AgentModelTurn = { kind: 'decision', rawDecision: decisionEnvelope() };
    const model = new FakeAgentModel([turn]);
    const controller = new AbortController();
    controller.abort();

    await expect(model.nextTurn(modelInput(), controller.signal)).rejects.toMatchObject({
      code: 'AGENT_MODEL_ABORTED',
    });
    await expect(model.nextTurn(modelInput(), new AbortController().signal)).resolves.toEqual(turn);
  });
});
