import {
  CodexAuthError,
  getCodexAccess,
  markCodexReconnectRequired,
} from '../ai/codexAuth.js';
import {
  CodexResponseError,
  completeCodexTurn,
  type CodexResponseOptions,
  type CodexTurnResponse,
} from '../ai/codexResponses.js';
import { AgentError } from './errors.js';
import type { AgentModel, AgentModelInput, AgentModelTurn } from './model.js';

type CodexAccess = Awaited<ReturnType<typeof getCodexAccess>>;
const DEFAULT_MAX_CONTEXT_BYTES = 96 * 1024;

export const AGENT_DECISION_VALUE_JSON_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taxCalculation', 'lines', 'rationale', 'evidence', 'confidence'],
      properties: {
        kind: { type: 'string', const: 'categorize' },
        taxCalculation: {
          type: 'string',
          enum: ['TaxInclusive', 'TaxExcluded', 'NotApplicable'],
        },
        lines: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['grossAmount', 'categoryQboId', 'taxCodeQboId'],
            properties: {
              grossAmount: {
                type: 'number',
                description:
                  'Signed line amount. All lines must sum exactly to the signed transaction amount; purchases are negative.',
              },
              categoryQboId: { type: 'string', minLength: 1, maxLength: 120 },
              taxCodeQboId: {
                anyOf: [
                  { type: 'string', minLength: 1, maxLength: 120 },
                  { type: 'null' },
                ],
              },
            },
          },
        },
        rationale: { type: 'string', minLength: 1, maxLength: 2_000 },
        evidence: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'counterpartTransactionId', 'rationale', 'evidence', 'confidence'],
      properties: {
        kind: { type: 'string', const: 'transfer' },
        counterpartTransactionId: { type: 'string', minLength: 1, maxLength: 120 },
        rationale: { type: 'string', minLength: 1, maxLength: 2_000 },
        evidence: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'reasonCode', 'rationale'],
      properties: {
        kind: { type: 'string', const: 'skip' },
        reasonCode: { type: 'string', minLength: 1, maxLength: 100 },
        rationale: { type: 'string', minLength: 1, maxLength: 2_000 },
      },
    },
  ],
};

export const AGENT_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: AGENT_DECISION_VALUE_JSON_SCHEMA,
  },
};

interface CodexModelDeps {
  getAccess: (forceRefreshToken?: string) => Promise<CodexAccess>;
  markReconnectRequired: (failedAccessToken: string) => Promise<void>;
  completeTurn: (options: CodexResponseOptions) => Promise<CodexTurnResponse>;
}

export interface CodexStructuredFormat {
  name: string;
  schema: Record<string, unknown>;
  unwrapKey?: string;
}

const defaultDeps: CodexModelDeps = {
  getAccess: (forceRefreshToken) =>
    getCodexAccess(
      forceRefreshToken
        ? { forceRefresh: { failedAccessToken: forceRefreshToken } }
        : undefined,
    ),
  markReconnectRequired: (failedAccessToken) =>
    markCodexReconnectRequired({
      failedAccessToken,
      failureCode: 'agent_inference_unauthorized',
    }),
  completeTurn: completeCodexTurn,
};

function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof CodexAuthError) {
    if (error.transient) {
      return new AgentError('AGENT_NETWORK', 'ChatGPT is temporarily unavailable.', true);
    }
    return new AgentError('AGENT_AUTH', 'ChatGPT reconnect is required.', false);
  }
  if (error instanceof CodexResponseError) {
    if (error.status === 401 || error.status === 403) {
      return new AgentError('AGENT_AUTH', 'ChatGPT reconnect is required.', false);
    }
    if (error.status === 429) {
      return new AgentError('AGENT_RATE_LIMIT', 'ChatGPT rate limit reached.', true);
    }
    if (/timed out/i.test(error.message)) {
      return new AgentError('AGENT_TIMEOUT', 'ChatGPT request timed out.', true);
    }
    if (/aborted/i.test(error.message)) {
      return new AgentError('AGENT_CANCELLED', 'ChatGPT request was cancelled.', false);
    }
    if (error.status === undefined || error.status >= 500) {
      return new AgentError('AGENT_NETWORK', 'ChatGPT is temporarily unavailable.', true);
    }
    return new AgentError('AGENT_PROVIDER', 'ChatGPT rejected the agent request.', false);
  }
  return new AgentError('AGENT_NETWORK', 'ChatGPT could not complete the request.', true);
}

function responseInputItems(input: AgentModelInput): Record<string, unknown>[] {
  return input.history.map((item) => {
    if (item.kind === 'correction') {
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: item.message }],
      };
    }
    return {
      type: 'function_call_output',
      call_id: item.callId,
      output: JSON.stringify(item.result),
    };
  });
}

function contextBytes(
  input: AgentModelInput,
  inputItems: Record<string, unknown>[],
): number {
  return Buffer.byteLength(
    JSON.stringify({
      systemPrompt: input.systemPrompt,
      transaction: input.transaction,
      tools: input.tools,
      inputItems,
    }),
    'utf8',
  );
}

function assertContextLimit(
  input: AgentModelInput,
  inputItems: Record<string, unknown>[],
): void {
  const limit = input.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  if (contextBytes(input, inputItems) > limit) {
    throw new AgentError(
      'AGENT_LIMIT',
      'Agent context exceeded the configured byte limit.',
      false,
    );
  }
}

export class CodexAgentModel implements AgentModel {
  readonly provider = 'codex';
  private continuationItems: Record<string, unknown>[] = [];
  private consumedHistoryItems = 0;

  constructor(
    readonly model: string,
    private readonly deps: CodexModelDeps = defaultDeps,
    private readonly structuredFormat: CodexStructuredFormat = {
      name: 'recat_agent_decision',
      schema: AGENT_DECISION_JSON_SCHEMA,
      unwrapKey: 'decision',
    },
  ) {}

  private async request(
    access: CodexAccess,
    input: AgentModelInput,
    inputItems: Record<string, unknown>[],
    signal: AbortSignal,
  ): Promise<CodexTurnResponse> {
    return this.deps.completeTurn({
      ...access,
      model: this.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: JSON.stringify(input.transaction) },
      ],
      tools: input.tools,
      inputItems,
      textFormat: {
        name: this.structuredFormat.name,
        schema: this.structuredFormat.schema,
      },
      signal,
    });
  }

  async nextTurn(input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn> {
    const newHistory = input.history.slice(this.consumedHistoryItems);
    const inputItems = [
      ...this.continuationItems,
      ...responseInputItems({ ...input, history: newHistory }),
    ];
    assertContextLimit(input, inputItems);
    let access: CodexAccess;
    try {
      access = await this.deps.getAccess();
    } catch (err) {
      throw toAgentError(err);
    }

    let response: CodexTurnResponse;
    try {
      response = await this.request(access, input, inputItems, signal);
    } catch (err) {
      if (!(err instanceof CodexResponseError) || err.status !== 401) {
        throw toAgentError(err);
      }
      try {
        access = await this.deps.getAccess(access.accessToken);
        response = await this.request(access, input, inputItems, signal);
      } catch (retryError) {
        if (retryError instanceof CodexResponseError && retryError.status === 401) {
          await this.deps.markReconnectRequired(access.accessToken).catch(() => undefined);
        }
        throw toAgentError(retryError);
      }
    }

    const nextContinuationItems = [...inputItems, ...response.outputItems];
    assertContextLimit(input, nextContinuationItems);
    this.continuationItems = nextContinuationItems;
    this.consumedHistoryItems = input.history.length;
    if (response.functionCalls.length > 0) {
      return {
        kind: 'tool_calls',
        calls: response.functionCalls.map((call) => {
          let args: unknown;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            throw new AgentError(
              'AGENT_MALFORMED_OUTPUT',
              'ChatGPT returned malformed function arguments.',
              false,
            );
          }
          return { id: call.callId, name: call.name, arguments: args };
        }),
      };
    }
    if (!response.text.trim()) {
      throw new AgentError(
        'AGENT_MALFORMED_OUTPUT',
        'ChatGPT returned neither a decision nor a tool call.',
        false,
      );
    }
    try {
      const value = JSON.parse(response.text) as unknown;
      const unwrapKey = this.structuredFormat.unwrapKey;
      if (!unwrapKey) return { kind: 'decision', value };
      if (
        value === null ||
        typeof value !== 'object' ||
        !Object.prototype.hasOwnProperty.call(value, unwrapKey)
      ) {
        throw new Error('Missing structured output wrapper.');
      }
      return {
        kind: 'decision',
        value: (value as Record<string, unknown>)[unwrapKey],
      };
    } catch {
      throw new AgentError(
        'AGENT_MALFORMED_OUTPUT',
        'ChatGPT returned malformed decision JSON.',
        false,
      );
    }
  }
}
