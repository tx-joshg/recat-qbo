import { createHash } from 'node:crypto';
import {
  parseAgentDecision,
  agentDecisionJsonSchema,
  agentDecisionSchemaName,
} from './core/decision.js';
import {
  AGENT_MODEL_PROMPT_VERSION,
  AgentModelError,
  type AgentModel,
  type AgentModelHistoryEntry,
  type AgentModelIdentity,
  type AgentModelInput,
  type AgentModelTurn,
  type AgentModelUsage,
} from './core/model.js';
import {
  serializeAgentSnapshot,
  type AgentTransactionSnapshot,
} from './core/snapshot.js';
import {
  agentLiveReviewJsonSchema,
  agentLiveReviewSchemaName,
} from './core/verifier.js';
import {
  TOOL_DEFINITIONS,
  parseAgentClassificationToolResult,
  type AgentToolCall,
  type AgentToolName,
} from './core/tools.js';
import type {
  LiveAgentModel,
  LiveModelProbe,
  LiveModelReviewResponse,
} from './liveVerifier.js';

const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_HISTORY_ENTRIES = 40;
const MAX_HISTORY_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 32 * 1024;
const MAX_TOOL_CALLS = 20;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_MODEL_LENGTH = 200;
const MODEL_HEALTH_SCHEMA_NAME = 'recat_model_health_v1';
const MODEL_HEALTH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { const: true, type: 'boolean' } },
} as const;

type OpenRouterConfig = {
  readonly provider: 'openrouter';
  readonly model: string;
  readonly apiKey?: string;
  readonly referer?: string;
  readonly title?: string;
};

type CustomConfig = {
  readonly provider: 'custom';
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
};

export type OpenAiCompatibleAgentModelConfig = OpenRouterConfig | CustomConfig;

type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
    role: 'assistant';
    content: null;
    tool_calls: {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }[];
  }
  | {
    role: 'tool';
    tool_call_id: string;
    name: string;
    content: string;
  };

const TOOL_NAMES = new Set<string>(
  TOOL_DEFINITIONS.map((definition) => definition.function.name),
);
const DECISION_INSTRUCTION = [
  `Recat agent decision prompt ${AGENT_MODEL_PROMPT_VERSION}.`,
  'Use only the supplied immutable transaction snapshot and fixed tools.',
  'Return one schema-compliant decision envelope or call one or more fixed tools.',
].join(' ');
const REVIEW_INSTRUCTION = [
  `Recat agent review prompt ${AGENT_MODEL_PROMPT_VERSION}.`,
  'Review the supplied candidate only against the immutable transaction snapshot and fixed tools.',
  'Return one schema-compliant corrected decision envelope or call one or more fixed tools.',
].join(' ');

export class OpenAiCompatibleAgentModel implements AgentModel, LiveAgentModel {
  readonly identity: AgentModelIdentity;
  readonly healthAuthority: string;
  private readonly endpoint: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly hasCredential: boolean;

  constructor(config: OpenAiCompatibleAgentModelConfig) {
    const model = validModel(config.model);
    this.identity = Object.freeze({ provider: config.provider, model });
    if (config.provider === 'openrouter') {
      this.endpoint = OPENROUTER_COMPLETIONS_URL;
      this.headers = Object.freeze({
        'Content-Type': 'application/json',
        ...(nonempty(config.apiKey) ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(nonempty(config.referer) ? { 'HTTP-Referer': config.referer } : {}),
        ...(nonempty(config.title) ? { 'X-Title': config.title } : {}),
      });
    } else {
      this.endpoint = customCompletionsUrl(config.baseUrl);
      this.headers = Object.freeze({
        'Content-Type': 'application/json',
        ...(nonempty(config.apiKey) ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      });
    }
    this.hasCredential = Object.hasOwn(this.headers, 'Authorization');
    this.healthAuthority = createHash('sha256').update(JSON.stringify({
      version: 1,
      identity: this.identity,
      endpoint: this.endpoint,
      headers: this.headers,
    }), 'utf8').digest('hex');
  }

  async nextTurn(input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn> {
    if (signal.aborted) throw aborted();

    const messages = providerMessages(input);
    const body = JSON.stringify({
      model: this.identity.model,
      temperature: 0,
      messages,
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

    const responseText = await this.request(body, signal);
    return parseProviderResponse(responseText);
  }

  async probe(signal: AbortSignal): Promise<LiveModelProbe> {
    this.assertLiveCredential();
    const body = JSON.stringify({
      model: this.identity.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Recat model health probe. Return the required fixed JSON value.',
        },
        {
          role: 'user',
          content: '{"purpose":"credential_and_model_health","accountingData":false}',
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: MODEL_HEALTH_SCHEMA_NAME,
          strict: true,
          schema: MODEL_HEALTH_JSON_SCHEMA,
        },
      },
    });
    const response = parseStructuredProviderResponse(
      await this.request(body, signal),
      this.identity.provider,
    );
    if (
      !isRecord(response.raw)
      || Object.keys(response.raw).length !== 1
      || response.raw.ok !== true
    ) {
      throw invalidResponse();
    }
    return { identity: response.identity };
  }

  async reviewLiveDecision(
    input: {
      readonly snapshot: AgentTransactionSnapshot;
      readonly candidateDecision: ReturnType<typeof parseAgentDecision>;
    },
    signal: AbortSignal,
  ): Promise<LiveModelReviewResponse> {
    this.assertLiveCredential();
    let snapshotPayload: unknown;
    let candidateDecision: ReturnType<typeof parseAgentDecision>;
    try {
      snapshotPayload = JSON.parse(
        serializeAgentSnapshot(input.snapshot, MAX_SNAPSHOT_BYTES),
      ) as unknown;
      candidateDecision = parseAgentDecision({ decision: input.candidateDecision });
    } catch {
      throw new AgentModelError('AGENT_MODEL_INPUT_INVALID', 'terminal');
    }
    const body = JSON.stringify({
      model: this.identity.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            `Recat live verifier prompt ${AGENT_MODEL_PROMPT_VERSION}.`,
            'Independently approve only when the exact candidate is fully supported by the exact immutable snapshot.',
            'Return only the fixed review schema. Do not correct or replace the candidate.',
          ].join(' '),
        },
        {
          role: 'user',
          content: safeCanonicalJson({
            purpose: 'distinct_live_review',
            snapshot: snapshotPayload,
            candidateDecision,
          }),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: agentLiveReviewSchemaName,
          strict: true,
          schema: agentLiveReviewJsonSchema,
        },
      },
    });
    const response = parseStructuredProviderResponse(
      await this.request(body, signal),
      this.identity.provider,
    );
    return {
      identity: response.identity,
      rawReview: response.raw,
    };
  }

  private assertLiveCredential(): void {
    if (!this.hasCredential) {
      throw new AgentModelError('AGENT_MODEL_CONFIG_INVALID', 'terminal');
    }
  }

  private async request(body: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw aborted();
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body,
        signal,
      });
    } catch {
      if (signal.aborted) throw aborted();
      throw new AgentModelError('AGENT_MODEL_NETWORK_ERROR', 'retryable');
    }

    if (signal.aborted) throw aborted();
    if (!response.ok) {
      cancelUnreadBody(response);
      throw new AgentModelError(
        'AGENT_MODEL_HTTP_ERROR',
        retryableStatus(response.status) ? 'retryable' : 'terminal',
      );
    }
    return readBoundedResponse(response, signal);
  }
}

function validModel(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_MODEL_LENGTH
    || value.trim() !== value
  ) {
    throw new AgentModelError('AGENT_MODEL_CONFIG_INVALID', 'terminal');
  }
  return value;
}

function customCompletionsUrl(rawBaseUrl: string): string {
  try {
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim() !== rawBaseUrl || rawBaseUrl === '') {
      throw new Error('invalid');
    }
    const url = new URL(rawBaseUrl);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw new Error('invalid');
    }
    const base = url.toString().replace(/\/+$/, '');
    return `${base}/chat/completions`;
  } catch {
    throw new AgentModelError('AGENT_MODEL_CONFIG_INVALID', 'terminal');
  }
}

function nonempty(value: string | undefined): value is string {
  return typeof value === 'string' && value !== '';
}

function providerMessages(input: AgentModelInput): ProviderMessage[] {
  try {
    const record = plainDataRecord(input);
    const kind = record.kind;
    if (kind !== 'decision' && kind !== 'review') throw new Error('invalid');
    exactKeys(
      record,
      kind === 'decision'
        ? ['kind', 'snapshot', 'history']
        : ['kind', 'snapshot', 'history', 'candidateDecision'],
    );
    if (!Array.isArray(record.history) || record.history.length > MAX_HISTORY_ENTRIES) {
      throw new Error('invalid');
    }
    const snapshot = record.snapshot as AgentTransactionSnapshot;
    const snapshotPayload = JSON.parse(
      serializeAgentSnapshot(snapshot, MAX_SNAPSHOT_BYTES),
    ) as unknown;
    const history = historyMessages(
      record.history as AgentModelHistoryEntry[],
      snapshot,
    );
    if (utf8Bytes(JSON.stringify(history)) > MAX_HISTORY_BYTES) throw new Error('invalid');
    const candidateDecision = kind === 'review'
      ? parseAgentDecision({ decision: record.candidateDecision })
      : undefined;
    if (
      candidateDecision !== undefined
      && utf8Bytes(safeCanonicalJson(candidateDecision)) > MAX_CANDIDATE_BYTES
    ) {
      throw new Error('invalid');
    }
    const content = safeCanonicalJson({
      promptVersion: AGENT_MODEL_PROMPT_VERSION,
      purpose: kind,
      snapshot: snapshotPayload,
      ...(candidateDecision === undefined ? {} : { candidateDecision }),
    });
    return [
      {
        role: 'system',
        content: kind === 'decision' ? DECISION_INSTRUCTION : REVIEW_INSTRUCTION,
      },
      { role: 'user', content },
      ...history,
    ];
  } catch (error) {
    if (error instanceof AgentModelError) throw error;
    throw new AgentModelError('AGENT_MODEL_INPUT_INVALID', 'terminal');
  }
}

function plainDataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('invalid');
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || descriptor.value === undefined
    ) {
      throw new Error('invalid');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('invalid');
  }
}

function historyMessages(
  entries: readonly AgentModelHistoryEntry[],
  snapshot: AgentTransactionSnapshot,
): ProviderMessage[] {
  const pending = new Map<string, AgentToolName>();
  const usedIds = new Set<string>();
  const messages: ProviderMessage[] = [];

  for (const rawEntry of entries) {
    const entry = plainDataRecord(rawEntry);
    if (entry.role === 'assistant') {
      exactKeys(entry, ['role', 'toolCalls']);
      if (pending.size !== 0 || !Array.isArray(entry.toolCalls)) throw new Error('invalid');
      if (entry.toolCalls.length === 0 || entry.toolCalls.length > MAX_TOOL_CALLS) {
        throw new Error('invalid');
      }
      const toolCalls = entry.toolCalls.map((rawCall) => {
        const call = plainDataRecord(rawCall);
        exactKeys(call, ['id', 'name', 'arguments']);
        const id = strictIdentifier(call.id);
        const name = call.name;
        if (typeof name !== 'string' || !TOOL_NAMES.has(name) || usedIds.has(id)) {
          throw new Error('invalid');
        }
        usedIds.add(id);
        pending.set(id, name as AgentToolName);
        return {
          id,
          type: 'function' as const,
          function: {
            name,
            arguments: validatedToolArguments(name as AgentToolName, call.arguments),
          },
        };
      });
      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      continue;
    }

    if (entry.role !== 'tool') throw new Error('invalid');
    exactKeys(entry, ['role', 'toolCallId', 'name', 'result']);
    const callId = strictIdentifier(entry.toolCallId);
    const expectedName = pending.get(callId);
    if (typeof entry.name !== 'string' || expectedName !== entry.name) throw new Error('invalid');
    pending.delete(callId);
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      name: expectedName,
      content: validatedToolResult(expectedName, entry.result, snapshot),
    });
  }

  if (pending.size !== 0) throw new Error('invalid');
  return messages;
}

function validatedToolArguments(name: AgentToolName, rawArguments: unknown): string {
  const args = plainDataRecord(rawArguments);
  if (name === 'list_tax_codes' || name === 'list_rules') {
    exactKeys(args, []);
    return '{}';
  }
  exactKeys(
    args,
    name === 'search_classification_knowledge'
      ? ['query', 'limit', 'mode']
      : ['query', 'limit'],
  );
  if (
    typeof args.query !== 'string'
    || args.query.length === 0
    || Array.from(args.query).length > 160
    || !Number.isInteger(args.limit)
    || (args.limit as number) < 1
    || (args.limit as number) > 100
  ) {
    throw new Error('invalid');
  }
  if (
    name === 'search_classification_knowledge'
    && args.mode !== 'auto'
    && args.mode !== 'exact'
    && args.mode !== 'lexical'
    && args.mode !== 'hybrid'
    && args.mode !== 'semantic'
  ) {
    throw new Error('invalid');
  }
  return safeCanonicalJson(args);
}

function validatedToolResult(
  name: AgentToolName,
  rawResult: unknown,
  snapshot: AgentTransactionSnapshot,
): string {
  if (
    name === 'search_classification_knowledge'
    || (
      name === 'find_similar_transactions'
      && rawResult !== null
      && typeof rawResult === 'object'
      && !Array.isArray(rawResult)
      && Object.hasOwn(rawResult, 'search')
    )
  ) {
    return safeCanonicalJson(parseAgentClassificationToolResult(rawResult));
  }
  const result = plainDataRecord(rawResult);
  exactKeys(result, ['items']);
  if (!Array.isArray(result.items) || result.items.length > 20) throw new Error('invalid');

  const allowedItems = name === 'search_categories'
    ? snapshot.candidateCategories
    : name === 'list_tax_codes'
      ? snapshot.tax.eligibleReferences
      : name === 'list_rules'
        ? snapshot.rules
        : snapshot.similarVerifiedTransactions;
  const allowedByJson = new Map(
    allowedItems.map((item, index) => [safeCanonicalJson(item), { index, item }]),
  );
  let lastIndex = -1;
  const items = result.items.map((item) => {
    const allowed = allowedByJson.get(safeCanonicalJson(item));
    if (allowed === undefined || allowed.index <= lastIndex) throw new Error('invalid');
    lastIndex = allowed.index;
    return allowed.item;
  });
  return safeCanonicalJson({ items });
}

function strictIdentifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value.length > MAX_IDENTIFIER_LENGTH
    || value.trim() !== value
  ) {
    throw new Error('invalid');
  }
  return value;
}

function safeCanonicalJson(value: unknown): string {
  const seen = new Set<object>();

  function visit(current: unknown): unknown {
    if (
      current === null
      || typeof current === 'string'
      || typeof current === 'boolean'
    ) {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('invalid');
      return current;
    }
    if (typeof current !== 'object' || seen.has(current)) throw new Error('invalid');
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map(visit);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(current).sort((left, right) => String(left).localeCompare(String(right)))) {
        if (typeof key !== 'string') throw new Error('invalid');
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
          || descriptor.value === undefined
        ) {
          throw new Error('invalid');
        }
        record[key] = visit(descriptor.value);
      }
      return record;
    } finally {
      seen.delete(current);
    }
  }

  return JSON.stringify(visit(value));
}

function retryableStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 429
    || (status >= 500 && status <= 599);
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      throw new AgentModelError('AGENT_MODEL_RESPONSE_INVALID', 'terminal');
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) {
      throw new AgentModelError('AGENT_MODEL_RESPONSE_INVALID', 'terminal');
    }
    if (length > MAX_RESPONSE_BYTES) {
      cancelUnreadBody(response);
      throw new AgentModelError('AGENT_MODEL_RESPONSE_TOO_LARGE', 'terminal');
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new AgentModelError('AGENT_MODEL_RESPONSE_INVALID', 'terminal');
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new AgentModelError('AGENT_MODEL_RESPONSE_TOO_LARGE', 'terminal');
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof AgentModelError) throw error;
    if (signal.aborted) throw aborted();
    throw new AgentModelError('AGENT_MODEL_NETWORK_ERROR', 'retryable');
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AgentModelError('AGENT_MODEL_RESPONSE_INVALID', 'terminal');
  }
}

function cancelUnreadBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw aborted();
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      void reader.cancel().catch(() => undefined);
      reject(aborted());
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([reader.read(), abortPromise]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

function parseProviderResponse(text: string): AgentModelTurn {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length !== 1) {
    throw invalidResponse();
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw invalidResponse();
  const message = choice.message;
  const usage = normalizeUsage(body.usage);

  if (choice.finish_reason === 'tool_calls') {
    if (message.content !== null) throw invalidResponse();
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0 || message.tool_calls.length > MAX_TOOL_CALLS) {
      throw invalidResponse();
    }
    const seenIds = new Set<string>();
    const toolCalls = message.tool_calls.map((rawCall) => parseToolCall(rawCall, seenIds));
    return {
      kind: 'tool_calls',
      toolCalls,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  if (choice.finish_reason === 'stop') {
    if (message.tool_calls !== undefined && message.tool_calls !== null) throw invalidResponse();
    if (typeof message.content !== 'string' || message.content.trim() === '') throw invalidResponse();
    let rawDecision: unknown;
    try {
      rawDecision = JSON.parse(message.content);
    } catch {
      throw invalidResponse();
    }
    if (!isRecord(rawDecision)) throw invalidResponse();
    return {
      kind: 'decision',
      rawDecision,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  throw invalidResponse();
}

function parseStructuredProviderResponse(
  text: string,
  provider: AgentModelIdentity['provider'],
): { readonly identity: AgentModelIdentity; readonly raw: unknown } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  if (
    !isRecord(body)
    || typeof body.model !== 'string'
    || body.model.trim() === ''
    || body.model.length > MAX_MODEL_LENGTH
    || !Array.isArray(body.choices)
    || body.choices.length !== 1
  ) {
    throw invalidResponse();
  }
  const choice = body.choices[0];
  if (
    !isRecord(choice)
    || choice.finish_reason !== 'stop'
    || !isRecord(choice.message)
    || typeof choice.message.content !== 'string'
    || choice.message.content.trim() === ''
    || (choice.message.tool_calls !== undefined && choice.message.tool_calls !== null)
  ) {
    throw invalidResponse();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(choice.message.content);
  } catch {
    throw invalidResponse();
  }
  if (!isRecord(raw)) throw invalidResponse();
  return {
    identity: {
      provider,
      model: body.model,
    },
    raw,
  };
}

function parseToolCall(rawCall: unknown, seenIds: Set<string>): AgentToolCall {
  try {
    if (!isRecord(rawCall) || rawCall.type !== 'function' || !isRecord(rawCall.function)) {
      throw new Error('invalid');
    }
    const id = strictIdentifier(rawCall.id);
    if (seenIds.has(id)) throw new Error('invalid');
    seenIds.add(id);
    const name = rawCall.function.name;
    if (typeof name !== 'string' || !TOOL_NAMES.has(name)) throw new Error('invalid');
    if (typeof rawCall.function.arguments !== 'string') throw new Error('invalid');
    const argumentKeys = topLevelJsonObjectKeys(rawCall.function.arguments);
    const args: unknown = JSON.parse(rawCall.function.arguments);
    if (!isRecord(args)) throw new Error('invalid');
    if (argumentKeys.length !== Object.keys(args).length) throw new Error('invalid');
    return { id, name: name as AgentToolName, arguments: args };
  } catch {
    throw invalidResponse();
  }
}

function topLevelJsonObjectKeys(text: string): string[] {
  let index = 0;
  const keys: string[] = [];
  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? '')) index += 1;
  };
  const readString = (): string => {
    if (text[index] !== '"') throw new Error('invalid');
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index]!;
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(text.slice(start, index)) as string;
      }
    }
    throw new Error('invalid');
  };
  const skipValue = () => {
    skipWhitespace();
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (index < text.length) {
      const character = text[index]!;
      if (inString) {
        index += 1;
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        index += 1;
      } else if (character === '{' || character === '[') {
        depth += 1;
        index += 1;
      } else if (character === '}' || character === ']') {
        if (depth === 0) return;
        depth -= 1;
        index += 1;
      } else if (character === ',' && depth === 0) {
        return;
      } else {
        index += 1;
      }
    }
  };

  skipWhitespace();
  if (text[index] !== '{') throw new Error('invalid');
  index += 1;
  skipWhitespace();
  if (text[index] === '}') {
    index += 1;
    skipWhitespace();
    if (index !== text.length) throw new Error('invalid');
    return keys;
  }
  while (index < text.length) {
    keys.push(readString());
    skipWhitespace();
    if (text[index] !== ':') throw new Error('invalid');
    index += 1;
    skipValue();
    skipWhitespace();
    if (text[index] === ',') {
      index += 1;
      skipWhitespace();
      continue;
    }
    if (text[index] === '}') {
      index += 1;
      skipWhitespace();
      if (index !== text.length) throw new Error('invalid');
      return keys;
    }
    throw new Error('invalid');
  }
  throw new Error('invalid');
}

function normalizeUsage(rawUsage: unknown): AgentModelUsage | undefined {
  if (rawUsage === undefined) return undefined;
  if (!isRecord(rawUsage)) throw invalidResponse();
  const inputTokens = optionalTokenCount(rawUsage.prompt_tokens);
  const outputTokens = optionalTokenCount(rawUsage.completion_tokens);
  const totalTokens = optionalTokenCount(rawUsage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function optionalTokenCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidResponse();
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidResponse(): AgentModelError {
  return new AgentModelError('AGENT_MODEL_RESPONSE_INVALID', 'terminal');
}

function aborted(): AgentModelError {
  return new AgentModelError('AGENT_MODEL_ABORTED', 'terminal');
}
