import { describe, expect, it, vi } from 'vitest';
import { QboDepositPreparationError } from '../lib/qbo/depositTax.js';
import { McpSchemaBoundsError } from './schemaBounds.js';
import {
  SpanKind,
  SpanStatusCode,
  propagation,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  currentMcpTraceContext,
  mcpTraceCarrier,
  observeMcpToolCall,
} from './observability.js';

describe('MCP observability', () => {
  it('logs only bounded allowlisted metadata for successful and failed calls', async () => {
    const log = vi.fn();
    const value = await observeMcpToolCall(
      {
        requestId: 'request-a',
        traceId: 'a'.repeat(32),
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'list_companies',
      },
      log,
      async () => ({ items: [1, 2] }),
    );

    expect(value).toEqual({ items: [1, 2] });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-a',
      traceId: 'a'.repeat(32),
      tokenPrefix: 'rct_SAFE',
      method: 'tools/call',
      tool: 'list_companies',
      count: 2,
      outcome: 'success',
      durationMs: expect.any(Number),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('items');

    await expect(observeMcpToolCall(
      { requestId: 'request-b', traceId: 'b'.repeat(32), tokenPrefix: 'rct_SAFE', method: 'tools/call', tool: 'get_transaction' },
      log,
      async () => { throw new Error('SECRET_SENTINEL'); },
    )).rejects.toThrow('SECRET_SENTINEL');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_SENTINEL');
  });

  async function logFailure(error: unknown) {
    const log = vi.fn();
    await expect(observeMcpToolCall(
      { requestId: 'request-example', traceId: 'a'.repeat(32), tokenPrefix: 'rct_SAFE', method: 'tools/call', tool: 'commit_categorization' },
      log,
      async () => { throw error; },
    )).rejects.toBe(error);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_PROVIDER_DETAIL');
    return log.mock.calls[0]![0];
  }

  it('logs a known internal error identity without its provider message', async () => {
    const error = new QboDepositPreparationError('QBO_DEPOSIT_UNSUPPORTED', 'PRIVATE_PROVIDER_DETAIL');
    expect(await logFailure(error)).toMatchObject({
      errorClass: 'QboDepositPreparationError', errorCode: 'QBO_DEPOSIT_UNSUPPORTED', outcome: 'error', count: 0,
    });
  });

  it('retains a documented schema-bound failure code', async () => {
    const error = new McpSchemaBoundsError('INPUT_BYTES', 'PRIVATE_PROVIDER_DETAIL');
    expect(await logFailure(error)).toMatchObject({
      errorClass: 'McpSchemaBoundsError', errorCode: 'INPUT_BYTES',
    });
  });

  it.each([
    ['McpSchemaBoundsError', 'OUTPUT_BYTES'],
    ['McpSchemaBoundsError', 'OUTPUT_SERIALIZATION'],
    ['HttpError', 'RESPONSE_TOO_LARGE'],
    ['QboRateLimitError', 'QBO_RATE_LIMITED'],
  ])('retains the public sibling identity %s/%s', async (name, code) => {
    // These sibling features can land independently; avoid coupling this test
    // to their constructors while enforcing the shared diagnostics contract.
    const error = Object.assign(new Error('PRIVATE_PROVIDER_DETAIL'), { name, code });
    expect(await logFailure(error)).toMatchObject({ errorClass: name, errorCode: code });
  });

  it('keeps a standard error class while omitting an unknown provider-controlled code', async () => {
    const error = Object.assign(new TypeError('PRIVATE_PROVIDER_DETAIL'), { code: 'SYNTHETIC_ACCOUNT_123' });
    const event = await logFailure(error);
    expect(event.errorClass).toBe('TypeError');
    expect(event).not.toHaveProperty('errorCode');
    expect(JSON.stringify(event)).not.toContain('SYNTHETIC_ACCOUNT_123');
  });

  it('rejects arbitrary class names and uppercase codes even when they match identifier syntax', async () => {
    const error = Object.assign(new Error('PRIVATE_PROVIDER_DETAIL'), {
      name: 'SyntheticCustomerAlias', code: 'SYNTHETIC_ACCOUNT_123',
    });
    const event = await logFailure(error);
    expect(event.errorClass).toBe('UnknownError');
    expect(event).not.toHaveProperty('errorCode');
    expect(JSON.stringify(event)).not.toMatch(/SyntheticCustomerAlias|SYNTHETIC_ACCOUNT_123/);
  });

  it.each([null, undefined, 'PRIVATE_PROVIDER_DETAIL', 42, { name: 'Error', code: 'QBO_DEPOSIT_UNSUPPORTED' }])(
    'uses a safe fallback for a non-Error thrown value %#', async (error) => {
      const event = await logFailure(error);
      expect(event.errorClass).toBe('UnknownError');
      expect(event).not.toHaveProperty('errorCode');
    },
  );

  it.each(['name', 'code'])('preserves the original failure when its %s getter throws', async (key) => {
    const error = new Error('PRIVATE_PROVIDER_DETAIL');
    Object.defineProperty(error, key, { get() { throw new Error('PRIVATE_GETTER_DETAIL'); } });
    const event = await logFailure(error);
    expect(event.errorClass).toBe('UnknownError');
    expect(event).not.toHaveProperty('errorCode');
    expect(JSON.stringify(event)).not.toContain('PRIVATE_GETTER_DETAIL');
  });

  it('reads provider-controlled identity properties only once', async () => {
    const error = new Error('PRIVATE_PROVIDER_DETAIL');
    const name = vi.fn().mockReturnValueOnce('TypeError').mockReturnValue('SyntheticCustomerAlias');
    const code = vi.fn().mockReturnValueOnce('QBO_TIMEOUT').mockReturnValue('SYNTHETIC_ACCOUNT_123');
    Object.defineProperties(error, { name: { get: name }, code: { get: code } });
    const event = await logFailure(error);
    expect(event).toMatchObject({ errorClass: 'TypeError', errorCode: 'QBO_TIMEOUT' });
    expect(name).toHaveBeenCalledTimes(1);
    expect(code).toHaveBeenCalledTimes(1);
  });

  it('creates a server span and propagates only parsed trace context to application reads', async () => {
    const span = {
      setStatus: vi.fn().mockReturnThis(),
      recordException: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as Span;
    const tracer = {
      startSpan: vi.fn(() => span),
    } as unknown as Tracer;
    const traceContext = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
      tracestate: 'vendor=value',
      baggage: Object.freeze({
        'correlation-id': 'safe-correlation',
        deployment: 'test',
      }),
    };

    const value = await observeMcpToolCall(
      {
        requestId: 'server-request-id',
        traceId: traceContext.traceId,
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'list_companies',
        era: 'modern',
        traceContext,
        tracer,
      },
      vi.fn(),
      async () => currentMcpTraceContext(),
    );

    expect(value).toEqual(traceContext);
    expect(currentMcpTraceContext()).toBeUndefined();
    expect(mcpTraceCarrier(traceContext)).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
      baggage: 'correlation-id=safe-correlation,deployment=test',
    });
    expect(tracer.startSpan).toHaveBeenCalledWith(
      'recat.mcp.request',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'rpc.system': 'mcp',
          'rpc.method': 'tools/call',
          'mcp.tool.name': 'list_companies',
          'mcp.protocol.era': 'modern',
          'mcp.request.id': 'server-request-id',
        },
      },
      expect.anything(),
    );
    const parentContext = vi.mocked(tracer.startSpan).mock.calls[0]![2]!;
    expect(trace.getSpanContext(parentContext)).toMatchObject({
      traceId: traceContext.traceId,
      spanId: traceContext.parentSpanId,
      traceFlags: 1,
      isRemote: true,
    });
    expect(
      propagation.getBaggage(parentContext)?.getEntry('correlation-id')?.value,
    ).toBe('safe-correlation');
    expect(
      propagation.getBaggage(parentContext)?.getEntry('deployment')?.value,
    ).toBe('test');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('marks failed spans without recording private exception details', async () => {
    const span = {
      setStatus: vi.fn().mockReturnThis(),
      recordException: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as Span;
    const tracer = { startSpan: vi.fn(() => span) } as unknown as Tracer;

    await expect(observeMcpToolCall(
      {
        requestId: 'server-request-id',
        traceId: 'a'.repeat(32),
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'list_companies',
        era: 'legacy',
        traceContext: { traceId: 'a'.repeat(32), baggage: Object.freeze({}) },
        tracer,
      },
      vi.fn(),
      async () => { throw new Error('PRIVATE_EXCEPTION_SENTINEL'); },
    )).rejects.toThrow('PRIVATE_EXCEPTION_SENTINEL');

    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});
