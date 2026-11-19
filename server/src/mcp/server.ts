import { randomUUID } from 'node:crypto';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpHandler,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type {
  AuthInfo,
  McpHttpHandler,
  McpRequestContext,
} from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { McpPrincipal } from './auth.js';
import {
  companyReads,
  createRecatMcpServer,
  type CompanyReadOperations,
  type RecatMcpContext,
} from './readTools.js';
import {
  mcpMutationOperations,
  type McpMutationOperations,
} from './mutationTools.js';
import { extractMcpTraceContext } from './trace.js';
import {
  isSafeToolFailure,
  safeInvalidToolFailure,
} from './result.js';
import {
  McpSchemaBoundsError,
  parseBoundedMcpInput,
} from './schemaBounds.js';

const INTERNAL_REQUEST_ID_HEADER = 'x-recat-mcp-request-id';
const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_MCP_PROTOCOL_VERSIONS = new Set(
  SUPPORTED_PROTOCOL_VERSIONS.filter(
    (version) => version !== MODERN_MCP_PROTOCOL_VERSION,
  ),
);
const MAX_SSE_ERROR_EVENT_CHARACTERS = 1024 * 1024;
const boundedUnknown = z.unknown();

function rpcIdKey(id: unknown): string | null {
  if (typeof id === 'string') return `string:${id}`;
  if (typeof id === 'number' && Number.isFinite(id)) return `number:${id}`;
  return null;
}

interface ToolCallEnvelope {
  id: string | number;
  idKey: string;
  request: Record<string, unknown>;
  params: Record<string, unknown>;
}

function toolCallEnvelope(entry: unknown): ToolCallEnvelope | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const request = entry as Record<string, unknown>;
  const params = request.params;
  const idKey = rpcIdKey(request.id);
  if (
    request.jsonrpc !== '2.0' ||
    request.method !== 'tools/call' ||
    idKey === null ||
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    typeof (params as Record<string, unknown>).name !== 'string' ||
    (params as Record<string, unknown>).name === ''
  ) {
    return null;
  }
  return {
    id: request.id as string | number,
    idKey,
    request,
    params: params as Record<string, unknown>,
  };
}

export interface PreparedToolCalls {
  body: unknown;
  toolCallIds: ReadonlyMap<string, string | number>;
  hadBoundedFailures: boolean;
}

interface ToolCallPreparationOptions {
  modernRequest?: boolean;
  protocolVersion?: string;
}

function validModernMetadata(
  params: Record<string, unknown>,
  protocolVersion: string | undefined,
): boolean {
  const meta = params._meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return false;
  }
  const record = meta as Record<string, unknown>;
  const bodyVersion = record['io.modelcontextprotocol/protocolVersion'];
  const capabilities = record['io.modelcontextprotocol/clientCapabilities'];
  return (
    protocolVersion === MODERN_MCP_PROTOCOL_VERSION &&
    bodyVersion === protocolVersion &&
    capabilities !== null &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities)
  );
}

export function prepareBoundedToolCalls(
  body: unknown,
  options: ToolCallPreparationOptions = {},
): PreparedToolCalls {
  const toolCallIds = new Map<string, string | number>();
  let hadBoundedFailures = false;
  const prepareEntry = (entry: unknown): unknown => {
    const call = toolCallEnvelope(entry);
    if (call === null) return entry;
    if (
      options.modernRequest === true &&
      !validModernMetadata(call.params, options.protocolVersion)
    ) {
      return entry;
    }
    toolCallIds.set(call.idKey, call.id);
    try {
      parseBoundedMcpInput(
        boundedUnknown,
        call.params.arguments ?? {},
      );
      return entry;
    } catch (error) {
      if (!(error instanceof McpSchemaBoundsError)) throw error;
      hadBoundedFailures = true;
      return {
        ...call.request,
        params: {
          ...call.params,
          arguments: null,
        },
      };
    }
  };
  return {
    body: Array.isArray(body) ? body.map(prepareEntry) : prepareEntry(body),
    toolCallIds,
    hadBoundedFailures,
  };
}

function requestBodyMethod(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const method = (body as Record<string, unknown>).method;
  return typeof method === 'string' ? method : undefined;
}

function sanitizeToolPayload(
  payload: unknown,
  requestId: string,
  toolCallIds: ReadonlyMap<string, string | number>,
): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const response = payload as Record<string, unknown>;
  const responseId = rpcIdKey(response.id);
  if (responseId === null || !toolCallIds.has(responseId)) return false;
  if (
    response.error !== null &&
    typeof response.error === 'object' &&
    (response.error as Record<string, unknown>).code === -32602 &&
    response.result === undefined
  ) {
    delete response.error;
    response.result = safeInvalidToolFailure(requestId);
    return true;
  }
  const result = response.result;
  if (
    result === null ||
    typeof result !== 'object' ||
    (result as Record<string, unknown>).isError !== true ||
    isSafeToolFailure(result, requestId)
  ) {
    return false;
  }
  response.result = {
    ...(result as Record<string, unknown>),
    ...safeInvalidToolFailure(requestId),
  };
  return true;
}

function responseWithBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sanitizePayloadText(
  text: string,
  requestId: string,
  toolCallIds: ReadonlyMap<string, string | number>,
): string {
  try {
    const payload = JSON.parse(text) as unknown;
    let changed = false;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        changed = sanitizeToolPayload(item, requestId, toolCallIds) || changed;
      }
    } else {
      changed = sanitizeToolPayload(payload, requestId, toolCallIds);
    }
    return changed ? JSON.stringify(payload) : text;
  } catch {
    return text;
  }
}

function streamingSseResponse(
  response: Response,
  requestId: string,
  toolCallIds: ReadonlyMap<string, string | number>,
): Response {
  if (response.body === null) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let passingThroughLine = false;
  const writeLine = (
    line: string,
    newline: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (line.startsWith('data:')) {
      const space = line[5] === ' ' ? 6 : 5;
      const data = sanitizePayloadText(
        line.slice(space),
        requestId,
        toolCallIds,
      );
      controller.enqueue(encoder.encode(`data: ${data}${newline}`));
      return;
    }
    controller.enqueue(encoder.encode(`${line}${newline}`));
  };
  const writeDecoded = (
    decoded: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    let offset = 0;
    while (offset < decoded.length) {
      if (passingThroughLine) {
        const newline = decoded.indexOf('\n', offset);
        if (newline < 0) {
          controller.enqueue(encoder.encode(decoded.slice(offset)));
          return;
        }
        controller.enqueue(encoder.encode(decoded.slice(offset, newline + 1)));
        passingThroughLine = false;
        offset = newline + 1;
        continue;
      }

      const newline = decoded.indexOf('\n', offset);
      const fragment = newline < 0
        ? decoded.slice(offset)
        : decoded.slice(offset, newline);
      buffered += fragment;
      if (buffered.length > MAX_SSE_ERROR_EVENT_CHARACTERS) {
        controller.enqueue(encoder.encode(buffered));
        buffered = '';
        if (newline < 0) {
          passingThroughLine = true;
          return;
        }
        controller.enqueue(encoder.encode('\n'));
      } else if (newline >= 0) {
        writeLine(buffered, '\n', controller);
        buffered = '';
      }
      if (newline < 0) return;
      offset = newline + 1;
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const decoded = decoder.decode(chunk, { stream: true });
      let offset = 0;
      while (offset < decoded.length) {
        let end = Math.min(offset + 64 * 1024, decoded.length);
        if (
          end < decoded.length &&
          decoded.charCodeAt(end - 1) >= 0xD800 &&
          decoded.charCodeAt(end - 1) <= 0xDBFF &&
          decoded.charCodeAt(end) >= 0xDC00 &&
          decoded.charCodeAt(end) <= 0xDFFF
        ) {
          end -= 1;
        }
        writeDecoded(
          decoded.slice(offset, end),
          controller,
        );
        offset = end;
      }
    },
    flush(controller) {
      writeDecoded(decoder.decode(), controller);
      if (buffered !== '') writeLine(buffered, '', controller);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function sanitizeSdkToolResponse(
  response: Response,
  toolCallIds: ReadonlyMap<string, string | number>,
  requestId: string,
): Promise<Response> {
  if (toolCallIds.size === 0) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const text = await response.text();
    return responseWithBody(
      response,
      sanitizePayloadText(text, requestId, toolCallIds),
    );
  }
  if (contentType.includes('text/event-stream')) {
    return streamingSseResponse(response, requestId, toolCallIds);
  }
  return response;
}

function principalFrom(authInfo: AuthInfo | undefined): McpPrincipal {
  const value = authInfo?.extra?.principal;
  if (value === null || typeof value !== 'object') {
    throw new Error('Authenticated MCP principal is required');
  }
  const candidate = value as Partial<McpPrincipal>;
  if (
    typeof candidate.tokenId !== 'string' ||
    typeof candidate.tokenPrefix !== 'string' ||
    typeof candidate.userId !== 'string' ||
    typeof candidate.isInstanceAdmin !== 'boolean' ||
    !Array.isArray(candidate.memberships)
  ) {
    throw new Error('Authenticated MCP principal is invalid');
  }
  const memberships = candidate.memberships.map((membership) => {
    if (
      membership === null ||
      typeof membership !== 'object' ||
      typeof membership.companyId !== 'string' ||
      !['viewer', 'categorizer', 'admin'].includes(membership.role)
    ) {
      throw new Error('Authenticated MCP membership is invalid');
    }
    return Object.freeze({
      companyId: membership.companyId,
      role: membership.role,
    });
  });
  return Object.freeze({
    tokenId: candidate.tokenId,
    tokenPrefix: candidate.tokenPrefix,
    userId: candidate.userId,
    isInstanceAdmin: candidate.isInstanceAdmin,
    memberships: Object.freeze(memberships),
  });
}

export function contextFrom(
  authInfo: AuthInfo | undefined,
  era: McpRequestContext['era'],
  reads: CompanyReadOperations = companyReads,
  requestInfo?: Request,
  mutations: McpMutationOperations = mcpMutationOperations,
): RecatMcpContext {
  const trace = extractMcpTraceContext({
    traceparent: requestInfo?.headers.get('traceparent') ?? undefined,
    tracestate: requestInfo?.headers.get('tracestate') ?? undefined,
    baggage: requestInfo?.headers.get('baggage') ?? undefined,
  });
  return Object.freeze({
    principal: principalFrom(authInfo),
    era,
    reads,
    mutations,
    requestId:
      requestInfo?.headers.get(INTERNAL_REQUEST_ID_HEADER) ?? randomUUID(),
    traceId: trace.traceId,
    traceContext: trace,
  });
}

export function createRecatMcpHandler(
  reads: CompanyReadOperations = companyReads,
  mutations: McpMutationOperations = mcpMutationOperations,
): McpHttpHandler {
  const sdkHandler = createMcpHandler(
    ({ authInfo, era, requestInfo }) =>
      createRecatMcpServer(
        contextFrom(authInfo, era, reads, requestInfo, mutations),
      ),
    { legacy: 'stateless' },
  );
  return {
    ...sdkHandler,
    fetch: async (request, options) => {
      const requestId = randomUUID();
      if (request.headers.has('last-event-id')) {
        return Response.json(
          { error: 'replay_not_supported', requestId },
          { status: 400 },
        );
      }
      let body = options?.parsedBody;
      if (body === undefined && request.method.toUpperCase() === 'POST') {
        try {
          body = await request.clone().json();
        } catch {
          // The SDK owns malformed JSON handling.
        }
      }
      const protocolVersion =
        request.headers.get('mcp-protocol-version') ?? undefined;
      const modernRequest =
        request.headers.has('mcp-method') ||
        request.headers.has('mcp-name') ||
        (
          protocolVersion !== undefined &&
          !LEGACY_MCP_PROTOCOL_VERSIONS.has(protocolVersion)
        );
      const rejectInitialized =
        protocolVersion === MODERN_MCP_PROTOCOL_VERSION &&
        requestBodyMethod(body) === 'notifications/initialized';
      if (body !== undefined) {
        try {
          parseBoundedMcpInput(boundedUnknown, body);
        } catch (error) {
          if (!(error instanceof McpSchemaBoundsError)) throw error;
          return Response.json(
            { error: 'invalid_request', requestId },
            { status: 400 },
          );
        }
      }
      const prepared = prepareBoundedToolCalls(body, {
        modernRequest,
        protocolVersion,
      });
      const headers = new Headers(request.headers);
      headers.set(INTERNAL_REQUEST_ID_HEADER, requestId);
      const internalRequest = new Request(request, { headers });
      const response = await sdkHandler.fetch(
        internalRequest,
        prepared.hadBoundedFailures
          ? { ...options, parsedBody: prepared.body }
          : options,
      );
      if (rejectInitialized && response.status === 202) {
        const params =
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          (body as Record<string, unknown>).params !== null &&
          typeof (body as Record<string, unknown>).params === 'object' &&
          !Array.isArray((body as Record<string, unknown>).params)
            ? (body as Record<string, unknown>).params as Record<string, unknown>
            : null;
        if (
          params === null ||
          !validModernMetadata(params, protocolVersion)
        ) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32602,
                message: 'Invalid request parameters',
              },
            },
            { status: 400 },
          );
        }
        return new Response(null, { status: 405 });
      }
      return sanitizeSdkToolResponse(
        response,
        prepared.toolCallIds,
        requestId,
      );
    },
  };
}

export function createRecatMcpRequestHandler(
  handler = createRecatMcpHandler(),
): RequestHandler {
  const nodeHandler = toNodeHandler(handler);
  return (req, res, next) => {
    void nodeHandler(req, res, req.body).catch(next);
  };
}
