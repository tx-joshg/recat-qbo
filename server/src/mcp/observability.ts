import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  createTraceState,
  context as otelContext,
  propagation,
  trace as otelTrace,
  type Tracer,
} from '@opentelemetry/api';
import type { McpTraceContext } from './trace.js';

export interface McpToolLogContext {
  requestId: string;
  traceId: string;
  tokenPrefix: string;
  tokenPrefixPolicy?: 'include' | 'redact' | 'redact-for-transfer-result';
  method: string;
  tool: string;
  era?: 'legacy' | 'modern';
  traceContext?: McpTraceContext;
  tracer?: Tracer;
}

export interface McpToolLogEvent extends McpToolLogContext {
  durationMs: number;
  count: number;
  outcome: 'success' | 'error';
  errorClass?: string;
  errorCode?: string;
}

export type McpToolLogger = (event: McpToolLogEvent) => void;

const traceStorage = new AsyncLocalStorage<McpTraceContext>();

export function currentMcpTraceContext(): McpTraceContext | undefined {
  return traceStorage.getStore();
}

export function mcpTraceCarrier(
  traceContext: McpTraceContext,
): Record<string, string> {
  const carrier: Record<string, string> = {};
  if (
    traceContext.parentSpanId !== undefined &&
    traceContext.traceFlags !== undefined
  ) {
    carrier.traceparent =
      `00-${traceContext.traceId}-${traceContext.parentSpanId}-${traceContext.traceFlags}`;
  }
  if (traceContext.tracestate !== undefined) {
    carrier.tracestate = traceContext.tracestate;
  }
  const baggage = Object.entries(traceContext.baggage)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
  if (baggage !== '') carrier.baggage = baggage;
  return carrier;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function resultCount(value: unknown): number {
  if (
    value !== null &&
    typeof value === 'object' &&
    'items' in value &&
    Array.isArray((value as { items: unknown }).items)
  ) {
    return Math.min((value as { items: unknown[] }).items.length, 100);
  }
  return 1;
}

// Error properties can come from providers. Accept explicit public identities,
// never arbitrary strings that merely look like identifiers. Keep these local
// to avoid importing the service graph into the tracing boundary.
const PUBLIC_ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'URIError', 'EvalError', 'AggregateError', 'HttpError',
  'QboDepositPreparationError', 'QboPurchasePreparationError', 'PurchaseTaxError',
  'QboAuthError', 'QboRequestTimeout', 'QboRateLimitError', 'QboAttachmentNotFoundError',
  'QboAttachmentAdapterError', 'QboWriteSafetyError',
  'QboHttpNotFoundError', 'QboObjectNotFoundError',
  'McpSchemaBoundsError', 'InvalidMcpToolOutputError',
  'CategorizationError', 'McpCategorizationError', 'McpOperationError',
  'McpOperationExecutionError', 'McpUndoError', 'McpTransferExecutionError',
  'TransferExecutionError', 'TransferOperationError', 'WritebackLifecycleError',
  'AttachmentError', 'ReceiptError',
]);

// Public tool result codes, QBO diagnostics, and schema-bound failure codes.
// New identities require an explicit addition; unknown codes stay out of logs.
const PUBLIC_ERROR_CODES = new Set([
  'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'COMPANY_UNAVAILABLE',
  'QBO_DISCONNECTED', 'RATE_LIMITED', 'QBO_RATE_LIMITED', 'QBO_PERIOD_CLOSED',
  'QBO_TRANSACTION_LOCKED', 'QBO_WRITE_SAFETY_UNAVAILABLE',
  'QBO_AMOUNT_UNSAFE', 'QBO_DEPOSIT_UNSUPPORTED', 'QBO_PURCHASE_UNSUPPORTED',
  'QBO_REFERENCE_MISSING', 'QBO_STATE_DRIFT', 'SYNC_TOKEN_CONFLICT',
  'QBO_AUTH', 'QBO_TIMEOUT', 'QBO_ATTACHMENT_NOT_FOUND',
  'QBO_ATTACHMENT_INVALID_INPUT', 'QBO_ATTACHMENT_REQUEST_TOO_LARGE',
  'QBO_ATTACHMENT_RESPONSE_INVALID',
  'INPUT_BYTES', 'INPUT_DEPTH', 'INPUT_KEYS', 'INPUT_SERIALIZATION',
  'OUTPUT_BYTES', 'OUTPUT_SERIALIZATION', 'RESPONSE_TOO_LARGE',
  'SCHEMA_BYTES', 'SCHEMA_DEPTH', 'SCHEMA_KEYS', 'SCHEMA_SUBSCHEMAS',
  'SCHEMA_SERIALIZATION', 'EXTERNAL_REF', 'INVALID_REF', 'INVALID_SCHEMA',
  'CYCLIC_VALUE', 'VALIDATION_TIME',
]);

function internalErrorIdentity(error: unknown): { errorClass: string; errorCode?: string } {
  try {
    if (error instanceof Error) {
      // Read once: even Error instances may have accessor-backed properties.
      const name = error.name;
      const code = (error as Error & { code?: unknown }).code;
      return {
        errorClass: PUBLIC_ERROR_CLASSES.has(name) ? name : 'UnknownError',
        ...(typeof code === 'string' && PUBLIC_ERROR_CODES.has(code)
          ? { errorCode: code }
          : {}),
      };
    }
  } catch {
    // Diagnostic inspection must not replace the original thrown value.
  }
  return { errorClass: 'UnknownError' };
}

function loggedTokenPrefix(
  context: McpToolLogContext,
  value: unknown,
  outcome: 'success' | 'error',
): string {
  const redact = context.tokenPrefixPolicy === 'redact'
    || (
      context.tokenPrefixPolicy === 'redact-for-transfer-result'
      && (
        outcome === 'error'
        || (
          value !== null
          && typeof value === 'object'
          && 'kind' in value
          && (value as { kind?: unknown }).kind === 'transfer'
        )
      )
    );
  return redact ? 'redacted' : bounded(context.tokenPrefix, 16);
}

export async function observeMcpToolCall<T>(
  context: McpToolLogContext,
  log: McpToolLogger,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const traceContext: McpTraceContext = context.traceContext ?? Object.freeze({
    traceId: context.traceId,
    baggage: Object.freeze({}),
  });
  let parentContext = ROOT_CONTEXT;
  if (
    traceContext.parentSpanId !== undefined &&
    traceContext.traceFlags !== undefined
  ) {
    parentContext = otelTrace.setSpanContext(parentContext, {
      traceId: traceContext.traceId,
      spanId: traceContext.parentSpanId,
      traceFlags: Number.parseInt(traceContext.traceFlags, 16),
      isRemote: true,
      ...(traceContext.tracestate === undefined
        ? {}
        : { traceState: createTraceState(traceContext.tracestate) }),
    });
  }
  const baggageEntries = Object.fromEntries(
    Object.entries(traceContext.baggage)
      .map(([key, value]) => [key, { value }]),
  );
  parentContext = propagation.setBaggage(
    parentContext,
    propagation.createBaggage(baggageEntries),
  );
  const tracer =
    context.tracer ?? otelTrace.getTracer('recat-qbo-mcp', '0.1.0');
  const span = tracer.startSpan(
    'recat.mcp.request',
    {
      kind: SpanKind.SERVER,
      attributes: {
        'rpc.system': 'mcp',
        'rpc.method': bounded(context.method, 64),
        'mcp.tool.name': bounded(context.tool, 64),
        'mcp.protocol.era': context.era ?? 'legacy',
        'mcp.request.id': bounded(context.requestId, 128),
      },
    },
    parentContext,
  );
  const activeContext = otelTrace.setSpan(parentContext, span);
  try {
    const value = await otelContext.with(
      activeContext,
      () => traceStorage.run(traceContext, operation),
    );
    span.setStatus({ code: SpanStatusCode.OK });
    log({
      requestId: bounded(context.requestId, 128),
      traceId: bounded(context.traceId, 64),
      tokenPrefix: loggedTokenPrefix(context, value, 'success'),
      method: bounded(context.method, 64),
      tool: bounded(context.tool, 64),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      count: resultCount(value),
      outcome: 'success',
    });
    return value;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    log({
      requestId: bounded(context.requestId, 128),
      traceId: bounded(context.traceId, 64),
      tokenPrefix: loggedTokenPrefix(context, undefined, 'error'),
      method: bounded(context.method, 64),
      tool: bounded(context.tool, 64),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      count: 0,
      outcome: 'error',
      ...internalErrorIdentity(error),
    });
    throw error;
  } finally {
    span.end();
  }
}
