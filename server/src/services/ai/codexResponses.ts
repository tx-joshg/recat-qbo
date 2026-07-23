// Behavioral reference: pi-mono's MIT-licensed OpenAI Codex Responses adapter
// (packages/ai/src/api/openai-codex-responses.ts). This Recat-specific port
// retains bounded final-text and function-call SSE surfaces for suggestions
// and Recat's transaction-bound autopilot.

import { createRequestSignal, readLimited, readSseData, sanitizeText } from './aiHttp.js';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const DEFAULT_TIMEOUT_MS = 120_000;
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const EVENT_LIMIT_BYTES = 256 * 1024;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const RECAT_INSTRUCTIONS = 'You are Recat QBO, a helpful bookkeeping category assistant.';

export type CodexMessageRole = 'system' | 'user' | 'assistant';

export interface CodexMessage {
  role: CodexMessageRole;
  content: string;
}

export interface CodexFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CodexJsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export class CodexResponseError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'CodexResponseError';
    this.status = options.status;
    this.code = options.code;
  }
}

function messageItem(role: CodexMessageRole, content: string): Record<string, unknown> {
  if (typeof content !== 'string') throw new Error('Each message content must be a string');
  if (!['system', 'user', 'assistant'].includes(role)) {
    throw new Error(`Unsupported message role: ${String(role)}`);
  }
  if (role === 'system') {
    return {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: content }],
    };
  }
  if (role === 'assistant') {
    return { type: 'message', role, content: [{ type: 'output_text', text: content }] };
  }
  return { type: 'message', role, content: [{ type: 'input_text', text: content }] };
}

export function buildCodexRequest({
  model,
  messages,
  tools,
  inputItems,
  textFormat,
}: {
  model: string;
  messages: CodexMessage[];
  tools?: CodexFunctionTool[];
  inputItems?: Record<string, unknown>[];
  textFormat?: CodexJsonSchemaFormat;
}): Record<string, unknown> {
  if (typeof model !== 'string' || !model.trim()) throw new Error('ChatGPT model is required');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages array is required');
  return {
    model: model.trim(),
    instructions: RECAT_INSTRUCTIONS,
    input: [
      ...messages.map((message) => messageItem(message?.role, message?.content)),
      ...(inputItems ?? []),
    ],
    ...(tools && tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
          tool_choice: 'auto',
          parallel_tool_calls: true,
        }
      : {}),
    ...(textFormat
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: textFormat.name,
              schema: textFormat.schema,
              strict: true,
            },
          },
        }
      : {}),
    store: false,
    stream: true,
  };
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redactSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value !== 'string') return value;
  return secrets.reduce(
    (redacted, secret) => (secret ? redacted.split(secret).join('[redacted]') : redacted),
    value,
  );
}

function upstreamErrorMessage(status: number, bodyText: string, secrets: string[]): string {
  let detail: unknown;
  try {
    const parsed = unknownRecord(JSON.parse(bodyText));
    const error = parsed?.error;
    detail = typeof error === 'string' ? error : unknownRecord(error)?.message;
  } catch {
    detail = bodyText;
  }
  const safe = sanitizeText(redactSecrets(detail, secrets));
  return `ChatGPT provider error (${status})${safe ? `: ${safe}` : ''}`;
}

function eventError(event: Record<string, unknown>, fallback: string): CodexResponseError {
  const nested = unknownRecord(event.error);
  const response = unknownRecord(event.response);
  const responseError = unknownRecord(response?.error);
  const raw = event.message ?? nested?.message ?? responseError?.message;
  const message = sanitizeText(raw);
  const code = sanitizeText(event.code ?? nested?.code ?? responseError?.code, 100);
  return new CodexResponseError(message ? `${fallback}: ${message}` : fallback, {
    ...(code ? { code } : {}),
  });
}

type ParsedEvent = Record<string, unknown>;

function parseEventData(data: string): ParsedEvent {
  if (data.trim() === '[DONE]') return { type: 'done' };
  try {
    const parsed = unknownRecord(JSON.parse(data));
    if (!parsed) throw new Error('not an object');
    return parsed;
  } catch {
    throw new CodexResponseError('Malformed ChatGPT response event');
  }
}

export async function* parseCodexSse(
  response: Response,
  { signal }: { signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  let outputBytes = 0;
  let terminal = false;
  const createError = (reason: 'empty_body' | 'aborted' | 'event_too_large'): CodexResponseError => {
    if (reason === 'empty_body') return new CodexResponseError('ChatGPT response body was empty');
    if (reason === 'aborted') return new CodexResponseError('ChatGPT request was aborted');
    return new CodexResponseError('ChatGPT response event was too large');
  };

  for await (const data of readSseData(response, {
    ...(signal ? { signal } : {}),
    maxEventBytes: EVENT_LIMIT_BYTES,
    createError,
  })) {
    const parsed = parseEventData(data);
    if (parsed.type === 'done' || parsed.type === 'response.completed') {
      terminal = true;
      break;
    }
    if (parsed.type === 'response.output_text.delta') {
      const deltaValue = 'delta' in parsed ? parsed.delta : undefined;
      const delta = typeof deltaValue === 'string' ? deltaValue : '';
      outputBytes += Buffer.byteLength(delta, 'utf8');
      if (outputBytes > OUTPUT_LIMIT_BYTES) {
        throw new CodexResponseError('ChatGPT response output was too large');
      }
      if (delta) yield delta;
      continue;
    }
    if (parsed.type === 'response.failed') throw eventError(parsed, 'ChatGPT response failed');
    if (parsed.type === 'response.incomplete') {
      throw eventError(parsed, 'ChatGPT response was incomplete');
    }
    if (parsed.type === 'error') throw eventError(parsed, 'ChatGPT stream error');
  }

  if (!terminal) throw new CodexResponseError('ChatGPT response ended before completion');
}

export interface CodexResponseOptions {
  accessToken: string;
  accountId: string;
  model: string;
  messages: CodexMessage[];
  tools?: CodexFunctionTool[];
  inputItems?: Record<string, unknown>[];
  textFormat?: CodexJsonSchemaFormat;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function* streamCodexResponses({
  accessToken,
  accountId,
  model,
  messages,
  tools,
  inputItems,
  textFormat,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CodexResponseOptions): AsyncGenerator<string> {
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new CodexResponseError('ChatGPT is not connected');
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw new CodexResponseError('ChatGPT account is unavailable');
  }
  const request = buildCodexRequest({
    model,
    messages,
    ...(tools ? { tools } : {}),
    ...(inputItems ? { inputItems } : {}),
    ...(textFormat ? { textFormat } : {}),
  });
  const fetchSignal = createRequestSignal(
    signal,
    timeoutMs,
    `ChatGPT request timed out after ${timeoutMs}ms`,
  );
  try {
    const response = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'recat-qbo',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: fetchSignal.signal,
    });

    if (!response.ok) {
      const body = await readLimited(response, ERROR_BODY_LIMIT_BYTES);
      throw new CodexResponseError(upstreamErrorMessage(response.status, body, [accessToken, accountId]), {
        status: response.status,
      });
    }
    yield* parseCodexSse(response, { signal: fetchSignal.signal });
  } catch (error) {
    if (fetchSignal.timedOut()) {
      throw new CodexResponseError(`ChatGPT request timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted) throw new CodexResponseError('ChatGPT request was aborted');
    if (error instanceof CodexResponseError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new CodexResponseError(
      `ChatGPT request failed: ${sanitizeText(message) || 'network error'}`,
    );
  } finally {
    fetchSignal.cleanup();
  }
}

export async function completeCodexText(options: CodexResponseOptions): Promise<string> {
  let text = '';
  for await (const delta of streamCodexResponses(options)) text += delta;
  return text;
}

export interface CodexFunctionCall {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
}

export interface CodexTurnResponse {
  text: string;
  functionCalls: CodexFunctionCall[];
  /** Replay-safe response items needed by a store:false continuation. */
  outputItems: Record<string, unknown>[];
}

interface FunctionCallAccumulator {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
}

/**
 * Parse one complete Responses stream, preserving function-call linkage and
 * encrypted reasoning/output items needed for a stateless continuation.
 */
export async function parseCodexTurnSse(
  response: Response,
  { signal }: { signal?: AbortSignal } = {},
): Promise<CodexTurnResponse> {
  let text = '';
  let outputBytes = 0;
  let terminal = false;
  const calls = new Map<string, FunctionCallAccumulator>();
  const reasoningItems: Record<string, unknown>[] = [];
  const createError = (reason: 'empty_body' | 'aborted' | 'event_too_large'): CodexResponseError => {
    if (reason === 'empty_body') return new CodexResponseError('ChatGPT response body was empty');
    if (reason === 'aborted') return new CodexResponseError('ChatGPT request was aborted');
    return new CodexResponseError('ChatGPT response event was too large');
  };
  const addByteCount = (bytes: number): void => {
    outputBytes += bytes;
    if (outputBytes > OUTPUT_LIMIT_BYTES) {
      throw new CodexResponseError('ChatGPT response output was too large');
    }
  };
  const addBytes = (value: string): void => {
    addByteCount(Buffer.byteLength(value, 'utf8'));
  };
  const callFor = (itemId: string, outputIndex: number): FunctionCallAccumulator => {
    const existing = calls.get(itemId);
    if (existing) return existing;
    const created = { itemId, callId: '', name: '', arguments: '', outputIndex };
    calls.set(itemId, created);
    return created;
  };
  const setFinalArguments = (call: FunctionCallAccumulator, value: string): void => {
    const previousBytes = Buffer.byteLength(call.arguments, 'utf8');
    const finalBytes = Buffer.byteLength(value, 'utf8');
    if (finalBytes > previousBytes) addByteCount(finalBytes - previousBytes);
    call.arguments = value;
  };

  for await (const data of readSseData(response, {
    ...(signal ? { signal } : {}),
    maxEventBytes: EVENT_LIMIT_BYTES,
    createError,
  })) {
    const parsed = parseEventData(data);
    if (parsed.type === 'done' || parsed.type === 'response.completed') {
      terminal = true;
      break;
    }
    if (parsed.type === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      addBytes(delta);
      text += delta;
      continue;
    }
    if (parsed.type === 'response.output_item.added') {
      const item = unknownRecord(parsed.item);
      if (item?.type === 'function_call' && typeof item.id === 'string') {
        const call = callFor(
          item.id,
          typeof parsed.output_index === 'number' ? parsed.output_index : calls.size,
        );
        if (typeof item.call_id === 'string') call.callId = item.call_id;
        if (typeof item.name === 'string') call.name = item.name;
        if (typeof item.arguments === 'string') {
          setFinalArguments(call, item.arguments);
        }
      }
      continue;
    }
    if (parsed.type === 'response.function_call_arguments.delta') {
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : '';
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      if (!itemId) throw new CodexResponseError('Malformed ChatGPT function-call event');
      addBytes(delta);
      callFor(
        itemId,
        typeof parsed.output_index === 'number' ? parsed.output_index : calls.size,
      ).arguments += delta;
      continue;
    }
    if (parsed.type === 'response.function_call_arguments.done') {
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : '';
      if (!itemId) throw new CodexResponseError('Malformed ChatGPT function-call event');
      const call = callFor(
        itemId,
        typeof parsed.output_index === 'number' ? parsed.output_index : calls.size,
      );
      if (typeof parsed.call_id === 'string') call.callId = parsed.call_id;
      if (typeof parsed.name === 'string') call.name = parsed.name;
      if (typeof parsed.arguments === 'string') {
        setFinalArguments(call, parsed.arguments);
      }
      continue;
    }
    if (parsed.type === 'response.output_item.done') {
      const item = unknownRecord(parsed.item);
      if (item?.type === 'function_call' && typeof item.id === 'string') {
        const call = callFor(
          item.id,
          typeof parsed.output_index === 'number' ? parsed.output_index : calls.size,
        );
        if (typeof item.call_id === 'string') call.callId = item.call_id;
        if (typeof item.name === 'string') call.name = item.name;
        if (typeof item.arguments === 'string') {
          setFinalArguments(call, item.arguments);
        }
      } else if (item?.type === 'reasoning') {
        const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
        outputBytes += size;
        if (outputBytes > OUTPUT_LIMIT_BYTES) {
          throw new CodexResponseError('ChatGPT response output was too large');
        }
        reasoningItems.push(item);
      }
      continue;
    }
    if (parsed.type === 'response.failed') throw eventError(parsed, 'ChatGPT response failed');
    if (parsed.type === 'response.incomplete') {
      throw eventError(parsed, 'ChatGPT response was incomplete');
    }
    if (parsed.type === 'error') throw eventError(parsed, 'ChatGPT stream error');
  }
  if (!terminal) throw new CodexResponseError('ChatGPT response ended before completion');

  const functionCalls = [...calls.values()]
    .sort((a, b) => a.outputIndex - b.outputIndex)
    .map((call) => {
      if (!call.callId || !call.name || !call.arguments) {
        throw new CodexResponseError('ChatGPT returned an incomplete function call');
      }
      return { ...call };
    });
  const outputItems: Record<string, unknown>[] = [
    ...reasoningItems,
    ...functionCalls.map((call) => ({
      type: 'function_call',
      id: call.itemId,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    })),
    ...(text
      ? [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ]
      : []),
  ];
  return { text, functionCalls, outputItems };
}

/** One bounded tool-capable Responses turn. Existing text completion stays unchanged. */
export async function completeCodexTurn(options: CodexResponseOptions): Promise<CodexTurnResponse> {
  const {
    accessToken,
    accountId,
    model,
    messages,
    tools,
    inputItems,
    textFormat,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  if (!accessToken) throw new CodexResponseError('ChatGPT is not connected');
  if (!accountId) throw new CodexResponseError('ChatGPT account is unavailable');
  const request = buildCodexRequest({
    model,
    messages,
    ...(tools ? { tools } : {}),
    ...(inputItems ? { inputItems } : {}),
    ...(textFormat ? { textFormat } : {}),
  });
  const fetchSignal = createRequestSignal(
    signal,
    timeoutMs,
    `ChatGPT request timed out after ${timeoutMs}ms`,
  );
  try {
    const response = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'recat-qbo',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: fetchSignal.signal,
    });
    if (!response.ok) {
      const body = await readLimited(response, ERROR_BODY_LIMIT_BYTES);
      throw new CodexResponseError(
        upstreamErrorMessage(response.status, body, [accessToken, accountId]),
        { status: response.status },
      );
    }
    return await parseCodexTurnSse(response, { signal: fetchSignal.signal });
  } catch (error) {
    if (fetchSignal.timedOut()) {
      throw new CodexResponseError(`ChatGPT request timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted) throw new CodexResponseError('ChatGPT request was aborted');
    if (error instanceof CodexResponseError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new CodexResponseError(
      `ChatGPT request failed: ${sanitizeText(message) || 'network error'}`,
    );
  } finally {
    fetchSignal.cleanup();
  }
}
