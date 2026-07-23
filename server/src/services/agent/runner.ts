import { z } from 'zod';
import type { AgentToolContext } from './context.js';
import { AgentError, asAgentError } from './errors.js';
import type {
  AgentConversationItem,
  AgentModel,
  AgentModelInput,
  AgentModelTurn,
} from './model.js';
import { parseAgentDecision, type AgentDecision } from './decision.js';
import type { AgentToolRegistry, AgentToolResult } from './tools.js';

export interface AgentRunnerLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxToolResultBytes: number;
  maxContextBytes: number;
  maxTraceBytes: number;
  timeoutMs: number;
}

export const DEFAULT_AGENT_LIMITS: AgentRunnerLimits = {
  maxTurns: 8,
  maxToolCalls: 16,
  maxToolResultBytes: 16 * 1024,
  maxContextBytes: 96 * 1024,
  maxTraceBytes: 32 * 1024,
  timeoutMs: 45_000,
};

export interface AgentToolTraceEntry {
  callId: string;
  name: string;
  ok: boolean;
  resultBytes: number;
  errorCode?: string;
}

export interface AgentRunnerResult {
  decision: AgentDecision;
  toolTrace: AgentToolTraceEntry[];
  turnCount: number;
  toolCallCount: number;
}

const toolCallSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(100),
    arguments: z.unknown(),
  })
  .strict();

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function transactionInput(context: AgentToolContext): Record<string, unknown> {
  return {
    schemaVersion: context.schemaVersion,
    transaction: context.transaction,
    originalLineCount: context.originalLines.length,
  };
}

function safeToolLimitResult(): AgentToolResult {
  return {
    ok: false,
    schemaVersion: 'recat-tool-result-v1',
    error: {
      code: 'TOOL_FAILED',
      message: 'The tool result exceeded the run byte limit.',
    },
  };
}

function agentPrompt(): string {
  return [
    'You categorize one QuickBooks Purchase for Recat.',
    'Use only the supplied read-only tools and IDs returned by those tools.',
    'Return one strict structured decision: categorize, transfer, or skip.',
    'Never invent account, TaxCode, transaction, or company IDs.',
    'For categorize decisions, preserve the transaction amount sign: grossAmount lines must sum exactly to transaction.amount. Purchases are negative.',
    'Skip when evidence is insufficient or the accounting shape is unsupported.',
  ].join(' ');
}

async function boundedAwait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export async function runAgent(
  model: AgentModel,
  tools: AgentToolRegistry,
  context: AgentToolContext,
  options: { limits?: Partial<AgentRunnerLimits>; signal?: AbortSignal } = {},
): Promise<AgentRunnerResult> {
  const limits = { ...DEFAULT_AGENT_LIMITS, ...options.limits };
  const controller = new AbortController();
  let abortKind: 'timeout' | 'external' | null = null;
  const timeout = setTimeout(() => {
    abortKind = 'timeout';
    controller.abort(new Error('agent timeout'));
  }, limits.timeoutMs);
  timeout.unref?.();
  const onExternalAbort = () => {
    abortKind = 'external';
    controller.abort(options.signal?.reason ?? new Error('agent cancelled'));
  };
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const history: AgentConversationItem[] = [];
  const trace: AgentToolTraceEntry[] = [];
  let toolCallCount = 0;
  let invalidDecisionCount = 0;
  let toolArgumentFailureCount = 0;
  let contextBytes = byteLength(transactionInput(context));

  try {
    for (let turnCount = 1; turnCount <= limits.maxTurns; turnCount += 1) {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const input: AgentModelInput = {
        systemPrompt: agentPrompt(),
        transaction: transactionInput(context),
        tools: tools.definitions,
        history: structuredClone(history),
        maxContextBytes: limits.maxContextBytes,
      };
      contextBytes = Math.max(contextBytes, byteLength(input));
      if (contextBytes > limits.maxContextBytes) {
        throw new AgentError('AGENT_LIMIT', 'Agent context exceeded the configured byte limit.', false);
      }

      let turn: AgentModelTurn;
      try {
        turn = await boundedAwait(model.nextTurn(input, controller.signal), controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw asAgentError(err);
      }

      if (turn.kind === 'decision') {
        try {
          return {
            decision: parseAgentDecision(turn.value),
            toolTrace: trace,
            turnCount,
            toolCallCount,
          };
        } catch {
          invalidDecisionCount += 1;
          if (invalidDecisionCount > 1) {
            throw new AgentError(
              'AGENT_MALFORMED_OUTPUT',
              'The agent returned an invalid structured decision twice.',
              false,
            );
          }
          const correction: AgentConversationItem = {
            kind: 'correction',
            message:
              'Your decision did not match the required schema. Return only a complete schema-valid decision.',
          };
          history.push(correction);
          contextBytes += byteLength(correction);
          continue;
        }
      }

      if (turn.calls.length === 0) {
        throw new AgentError(
          'AGENT_MALFORMED_OUTPUT',
          'The agent emitted an empty tool-call turn.',
          false,
        );
      }
      const callIds = new Set<string>();
      for (const rawCall of turn.calls) {
        const parsed = toolCallSchema.safeParse(rawCall);
        if (!parsed.success) {
          throw new AgentError('AGENT_TOOL_ARGS', 'The agent emitted a malformed tool call.', false);
        }
        const call = parsed.data;
        if (callIds.has(call.id)) {
          throw new AgentError('AGENT_TOOL_ARGS', 'The agent reused a tool call ID.', false);
        }
        callIds.add(call.id);
        toolCallCount += 1;
        if (toolCallCount > limits.maxToolCalls) {
          throw new AgentError('AGENT_LIMIT', 'Agent tool-call limit exceeded.', false);
        }

        let result = await boundedAwait(tools.execute(call.name, call.arguments), controller.signal);
        let resultBytes = byteLength(result);
        if (resultBytes > limits.maxToolResultBytes) {
          result = safeToolLimitResult();
          resultBytes = byteLength(result);
        }
        if (!result.ok && result.error.code === 'TOOL_UNKNOWN') {
          throw new AgentError('AGENT_UNKNOWN_TOOL', 'The agent requested an unknown tool.', false);
        }
        if (!result.ok && result.error.code === 'TOOL_ARGS') {
          toolArgumentFailureCount += 1;
          if (toolArgumentFailureCount > 1) {
            throw new AgentError(
              'AGENT_TOOL_ARGS',
              'The agent repeatedly supplied invalid tool arguments.',
              false,
            );
          }
        }
        const item: AgentConversationItem = {
          kind: 'tool_result',
          callId: call.id,
          name: call.name,
          result,
        };
        history.push(item);
        contextBytes += byteLength(item);
        trace.push({
          callId: call.id,
          name: call.name,
          ok: result.ok,
          resultBytes,
          ...(!result.ok ? { errorCode: result.error.code } : {}),
        });
        if (byteLength(trace) > limits.maxTraceBytes) {
          throw new AgentError('AGENT_LIMIT', 'Agent tool trace exceeded the configured byte limit.', false);
        }
        if (contextBytes > limits.maxContextBytes) {
          throw new AgentError('AGENT_LIMIT', 'Agent context exceeded the configured byte limit.', false);
        }
      }
    }
    throw new AgentError('AGENT_LIMIT', 'Agent turn limit exceeded.', false);
  } catch (err) {
    if (abortKind === 'timeout') {
      throw new AgentError('AGENT_TIMEOUT', 'The agent run exceeded its time limit.', true);
    }
    if (abortKind === 'external') {
      throw new AgentError('AGENT_CANCELLED', 'The agent run was cancelled.', false);
    }
    throw asAgentError(err);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
