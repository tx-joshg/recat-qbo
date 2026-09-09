import { Buffer } from 'node:buffer';
import {
  AgentDecisionError,
  agentDecisionSchemaVersion,
  parseAgentDecision,
  type AgentDecision,
} from './decision.js';
import {
  AGENT_MODEL_PROMPT_VERSION,
  AgentModelError,
  type AgentModel,
  type AgentModelErrorClassification,
  type AgentModelErrorCode,
  type AgentModelHistoryEntry,
  type AgentModelInput,
  type AgentModelUsage,
  type AgentModelTurn,
} from './model.js';
import {
  AgentSnapshotError,
  serializeAgentSnapshot,
  type AgentTransactionSnapshot,
} from './snapshot.js';
import {
  AgentToolError,
  createSnapshotTools,
  type AgentToolDependencies,
  type AgentToolCall,
  type AgentToolName,
  type AgentToolRegistry,
} from './tools.js';
import { verifyAgentDecision } from './verifier.js';

export interface AgentLimits {
  readonly maxToolCalls: number;
  readonly maxTurns: number;
  readonly maxContextBytes: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export const DEFAULT_AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({
  maxToolCalls: 8,
  maxTurns: 4,
  maxContextBytes: 64 * 1024,
  maxResponseBytes: 32 * 1024,
  timeoutMs: 30_000,
});

export interface AgentRunnerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AgentRunDependencies {
  readonly model: AgentModel;
  readonly reviewModel?: AgentModel;
  readonly classificationSearch?: AgentToolDependencies['classificationSearch'];
  readonly limits?: Partial<AgentLimits>;
  readonly clock?: AgentRunnerClock;
  readonly signal?: AbortSignal;
  /** Deterministic seam for runs whose deadline began before this function was entered. */
  readonly startedAtMs?: number;
}

export interface AgentRunUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export type AgentVerificationMode =
  | 'deterministic'
  | 'same_model'
  | 'distinct_model';

export type AgentRunDiagnosticCode =
  | 'AGENT_RUN_VERIFIED'
  | 'AGENT_RUN_MODEL_ABSTAIN'
  | 'AGENT_RUN_LIMITS_INVALID'
  | 'AGENT_RUN_SNAPSHOT_INVALID'
  | 'AGENT_RUN_CONTEXT_LIMIT'
  | 'AGENT_RUN_RESPONSE_TOO_LARGE'
  | 'AGENT_RUN_MODEL_RESPONSE_INVALID'
  | 'AGENT_RUN_MODEL_ERROR'
  | 'AGENT_RUN_TOOL_LIMIT'
  | 'AGENT_RUN_TURN_LIMIT'
  | 'AGENT_RUN_TOOL_CALL_INVALID'
  | 'AGENT_RUN_TOOL_CALL_DUPLICATE'
  | 'AGENT_RUN_TOOL_ERROR'
  | 'AGENT_RUN_TIMEOUT'
  | 'AGENT_RUN_CANCELLED'
  | 'AGENT_RUN_REVIEW_ABSTAIN'
  | 'AGENT_RUN_REVIEW_CONFLICT'
  | 'AGENT_RUN_REVIEW_INVALID'
  | 'AGENT_RUN_REVIEW_TAX_INVALID'
  | 'AGENT_RUN_REVIEW_UNVERIFIED'
  | 'AGENT_RUN_REVIEW_FAILED'
  | AgentDecisionError['code']
  | AgentModelError['code']
  | AgentToolError['code']
  | ReturnType<typeof verifyAgentDecision>['code'];

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export interface AgentRunResult {
  readonly status: 'verified' | 'abstain';
  readonly decision: DeepReadonly<AgentDecision>;
  readonly snapshotRevision: number;
  readonly decisionProvider: string;
  readonly decisionModel: string;
  readonly promptVersion: typeof AGENT_MODEL_PROMPT_VERSION;
  readonly schemaVersion: typeof agentDecisionSchemaVersion;
  readonly usage?: AgentRunUsage;
  readonly durationMs: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly verificationMode: AgentVerificationMode;
  readonly diagnosticCode: AgentRunDiagnosticCode;
  readonly providerFailure?: {
    readonly code: AgentModelErrorCode;
    readonly classification: AgentModelErrorClassification;
  };
}

interface RunState {
  readonly startedAtMs: number;
  readonly seenToolCallIds: Set<string>;
  turns: number;
  toolCalls: number;
  usageSeen: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokensSeen: boolean;
  outputTokensSeen: boolean;
  totalTokensSeen: boolean;
}

type ModelLoopOutcome =
  | { readonly ok: true; readonly decision: AgentDecision }
  | {
      readonly ok: false;
      readonly code: AgentRunDiagnosticCode;
      readonly providerFailure?: AgentRunResult['providerFailure'];
    };

type TerminalCause = 'timeout' | 'cancelled';

const systemClock: AgentRunnerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function runShadowDecision(
  snapshot: AgentTransactionSnapshot,
  deps: AgentRunDependencies,
): Promise<AgentRunResult> {
  const clock = deps.clock ?? systemClock;
  const startedAtMs = validTime(deps.startedAtMs) ? deps.startedAtMs : clock.now();
  const state: RunState = {
    startedAtMs,
    seenToolCallIds: new Set<string>(),
    turns: 0,
    toolCalls: 0,
    usageSeen: false,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokensSeen: false,
    outputTokensSeen: false,
    totalTokensSeen: false,
  };
  const configuredReviewMode = reviewMode(deps.model, deps.reviewModel);
  let reviewExecuted = false;
  const { limits, invalid: limitsInvalid } = resolvedLimits(deps.limits);
  const controller = new AbortController();
  let terminalCause: TerminalCause | undefined;
  let timer: unknown;
  let timerScheduled = false;
  let lastNow = startedAtMs;

  const latchTerminalCause = (cause: TerminalCause): void => {
    if (terminalCause !== undefined) return;
    terminalCause = cause;
    controller.abort();
  };
  const abortForCancellation = (): void => latchTerminalCause('cancelled');
  if (deps.signal?.aborted === true) abortForCancellation();
  else deps.signal?.addEventListener('abort', abortForCancellation, { once: true });

  const deadlineFailure = (): AgentRunDiagnosticCode | undefined => {
    const existingFailure = terminalFailure(terminalCause);
    if (existingFailure !== undefined) return existingFailure;
    lastNow = clock.now();
    if (lastNow - startedAtMs >= limits.timeoutMs) {
      latchTerminalCause('timeout');
      return 'AGENT_RUN_TIMEOUT';
    }
    return undefined;
  };

  try {
    if (limitsInvalid) {
      return finish(
        systemAbstention('AGENT_RUN_LIMITS_INVALID'),
        'AGENT_RUN_LIMITS_INVALID',
      );
    }

    const initialDeadlineFailure = deadlineFailure();
    if (initialDeadlineFailure !== undefined) {
      return finish(systemAbstention(initialDeadlineFailure), initialDeadlineFailure);
    }
    timer = clock.setTimeout(() => {
      latchTerminalCause('timeout');
    }, Math.max(0, limits.timeoutMs - (lastNow - startedAtMs)));
    timerScheduled = true;

    let serializedSnapshot: string;
    try {
      serializedSnapshot = serializeAgentSnapshot(
        snapshot,
        DEFAULT_AGENT_LIMITS.maxContextBytes,
      );
    } catch (error) {
      const code = error instanceof AgentSnapshotError
        ? 'AGENT_RUN_SNAPSHOT_INVALID'
        : 'AGENT_RUN_SNAPSHOT_INVALID';
      return finish(systemAbstention(code), code);
    }
    if (utf8Bytes(serializedSnapshot) > limits.maxContextBytes) {
      return finish(
        systemAbstention('AGENT_RUN_CONTEXT_LIMIT'),
        'AGENT_RUN_CONTEXT_LIMIT',
      );
    }

    const validatedSnapshot = deepFreeze(
      JSON.parse(serializedSnapshot),
    ) as AgentTransactionSnapshot;
    const tools = createSnapshotTools(validatedSnapshot, {
      ...(deps.classificationSearch === undefined
        ? {}
        : { classificationSearch: deps.classificationSearch }),
    });
    const primary = await runModelLoop({
      model: deps.model,
      kind: 'decision',
      snapshot: validatedSnapshot,
      tools,
      limits,
      state,
      controller,
      deadlineFailure,
      terminalFailure: () => terminalFailure(terminalCause),
    });
    if (!primary.ok) {
      return finish(systemAbstention(primary.code), primary.code, primary.providerFailure);
    }

    const primaryVerification = verifyAgentDecision(validatedSnapshot, primary.decision);
    if (!primaryVerification.ok) {
      return finish(
        systemAbstention(primaryVerification.code),
        primaryVerification.code,
      );
    }
    if (primaryVerification.decision.kind === 'abstain') {
      return finish(
        {
          status: 'abstain',
          decision: primaryVerification.decision,
        },
        'AGENT_RUN_MODEL_ABSTAIN',
      );
    }

    const candidateDecision = structuredClone(
      primaryVerification.decision,
    ) as AgentDecision;
    if (deps.reviewModel === undefined) {
      return finish(
        { status: 'verified', decision: candidateDecision },
        'AGENT_RUN_VERIFIED',
      );
    }

    const review = await runModelLoop({
      model: deps.reviewModel,
      kind: 'review',
      candidateDecision,
      snapshot: validatedSnapshot,
      tools,
      limits,
      state,
      controller,
      deadlineFailure,
      terminalFailure: () => terminalFailure(terminalCause),
      onTurnStart: () => {
        reviewExecuted = true;
      },
    });
    if (!review.ok) {
      const reviewCode = reviewFailureCode(review.code);
      return finish(systemAbstention(reviewCode), reviewCode, review.providerFailure);
    }
    if (review.decision.kind === 'abstain') {
      return finish(
        systemAbstention('AGENT_RUN_REVIEW_ABSTAIN'),
        'AGENT_RUN_REVIEW_ABSTAIN',
      );
    }
    const reviewVerification = verifyAgentDecision(validatedSnapshot, review.decision);
    if (!reviewVerification.ok || reviewVerification.decision.kind === 'abstain') {
      const code = reviewTaxSelectionDiffers(candidateDecision, review.decision)
        || (!reviewVerification.ok && isTaxVerificationCode(reviewVerification.code))
        ? 'AGENT_RUN_REVIEW_TAX_INVALID'
        : 'AGENT_RUN_REVIEW_UNVERIFIED';
      return finish(
        systemAbstention(code),
        code,
      );
    }
    if (safeJson(reviewVerification.decision) !== safeJson(candidateDecision)) {
      const code = reviewTaxSelectionDiffers(
        candidateDecision,
        reviewVerification.decision,
      )
        ? 'AGENT_RUN_REVIEW_TAX_INVALID'
        : 'AGENT_RUN_REVIEW_CONFLICT';
      return finish(
        systemAbstention(code),
        code,
      );
    }
    return finish(
      { status: 'verified', decision: candidateDecision },
      'AGENT_RUN_VERIFIED',
    );
  } catch {
    const code = terminalFailure(terminalCause) ?? 'AGENT_RUN_MODEL_ERROR';
    return finish(systemAbstention(code), code);
  } finally {
    if (timerScheduled) clock.clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abortForCancellation);
  }

  function finish(
    outcome: {
      readonly status: 'verified' | 'abstain';
      readonly decision: DeepReadonly<AgentDecision>;
    },
    diagnosticCode: AgentRunDiagnosticCode,
    providerFailure?: AgentRunResult['providerFailure'],
  ): AgentRunResult {
    const durationMs = safeDuration(clock.now(), startedAtMs);
    const usage = aggregateUsage(state);
    return deepFreeze({
      ...outcome,
      snapshotRevision: safeRevision(snapshot),
      decisionProvider: safeIdentityPart(deps.model.identity.provider),
      decisionModel: safeIdentityPart(deps.model.identity.model),
      promptVersion: AGENT_MODEL_PROMPT_VERSION,
      schemaVersion: agentDecisionSchemaVersion,
      ...(usage === undefined ? {} : { usage }),
      durationMs,
      turns: state.turns,
      toolCalls: state.toolCalls,
      verificationMode: reviewExecuted ? configuredReviewMode : 'deterministic',
      diagnosticCode,
      ...(providerFailure === undefined ? {} : { providerFailure }),
    });
  }
}

async function runModelLoop(options: {
  readonly model: AgentModel;
  readonly kind: 'decision' | 'review';
  readonly candidateDecision?: AgentDecision;
  readonly snapshot: AgentTransactionSnapshot;
  readonly tools: AgentToolRegistry;
  readonly limits: AgentLimits;
  readonly state: RunState;
  readonly controller: AbortController;
  readonly deadlineFailure: () => AgentRunDiagnosticCode | undefined;
  readonly terminalFailure: () => AgentRunDiagnosticCode | undefined;
  readonly onTurnStart?: () => void;
}): Promise<ModelLoopOutcome> {
  const history: AgentModelHistoryEntry[] = [];

  while (true) {
    if (options.state.turns >= options.limits.maxTurns) {
      return failed('AGENT_RUN_TURN_LIMIT');
    }
    const beforeTurnFailure = options.deadlineFailure();
    if (beforeTurnFailure !== undefined) return failed(beforeTurnFailure);
    if (!contextFits(
      options.kind,
      options.snapshot,
      history,
      options.candidateDecision,
      options.limits.maxContextBytes,
    )) {
      return failed('AGENT_RUN_CONTEXT_LIMIT');
    }

    const input = deepFreeze(structuredClone(options.kind === 'decision'
      ? {
        kind: 'decision',
        snapshot: options.snapshot,
        history,
      }
      : {
        kind: 'review',
        snapshot: options.snapshot,
        history,
        candidateDecision: options.candidateDecision!,
      })) as AgentModelInput;

    options.state.turns += 1;
    options.onTurnStart?.();
    let turn: AgentModelTurn;
    try {
      const operation = options.model.nextTurn(input, options.controller.signal);
      turn = await raceAbort(operation, options.controller.signal);
    } catch (error) {
      const terminal = options.terminalFailure();
      if (terminal !== undefined) return failed(terminal);
      if (error instanceof AgentModelError) {
        return failed(error.code, {
          code: error.code,
          classification: error.classification,
        });
      }
      return failed('AGENT_RUN_MODEL_ERROR');
    }

    const afterTurnFailure = options.deadlineFailure();
    if (afterTurnFailure !== undefined) return failed(afterTurnFailure);
    const turnJson = safeJson(turn);
    if (turnJson === undefined) return failed('AGENT_RUN_MODEL_RESPONSE_INVALID');
    if (utf8Bytes(turnJson) > options.limits.maxResponseBytes) {
      return failed('AGENT_RUN_RESPONSE_TOO_LARGE');
    }
    if (!recordUsage(options.state, turn.usage)) {
      return failed('AGENT_RUN_MODEL_RESPONSE_INVALID');
    }

    if (turn.kind === 'decision') {
      try {
        return { ok: true, decision: parseAgentDecision(turn.rawDecision) };
      } catch (error) {
        if (error instanceof AgentDecisionError) return failed(error.code);
        return failed('AGENT_RUN_MODEL_RESPONSE_INVALID');
      }
    }
    if (turn.kind !== 'tool_calls' || !Array.isArray(turn.toolCalls) || turn.toolCalls.length === 0) {
      return failed('AGENT_RUN_MODEL_RESPONSE_INVALID');
    }

    const validatedCalls = validateToolBatch(
      turn.toolCalls,
      options.state.seenToolCallIds,
    );
    if (!validatedCalls.ok) return failed(validatedCalls.code);
    if (
      validatedCalls.calls.length
      > options.limits.maxToolCalls - options.state.toolCalls
    ) {
      return failed('AGENT_RUN_TOOL_LIMIT');
    }

    const toolHistory: AgentModelHistoryEntry[] = [{
      role: 'assistant',
      toolCalls: validatedCalls.calls.map((call) => structuredClone(call)),
    }];
    for (const call of validatedCalls.calls) {
      const beforeToolFailure = options.deadlineFailure();
      if (beforeToolFailure !== undefined) return failed(beforeToolFailure);
      try {
        const operation = options.tools.call(call.name, call.arguments);
        const result = await raceAbort(operation, options.controller.signal);
        options.state.toolCalls += 1;
        toolHistory.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name as AgentToolName,
          result,
        });
      } catch (error) {
        const terminal = options.terminalFailure();
        if (terminal !== undefined) return failed(terminal);
        if (error instanceof AgentToolError) return failed(error.code);
        return failed('AGENT_RUN_TOOL_ERROR');
      }
      const afterToolFailure = options.deadlineFailure();
      if (afterToolFailure !== undefined) return failed(afterToolFailure);
    }
    for (const call of validatedCalls.calls) {
      options.state.seenToolCallIds.add(call.id);
    }
    history.push(...toolHistory);
  }
}

function validateToolBatch(
  calls: readonly AgentToolCall[],
  seen: ReadonlySet<string>,
):
  | { readonly ok: true; readonly calls: readonly AgentToolCall[] }
  | { readonly ok: false; readonly code: AgentRunDiagnosticCode } {
  const batchIds = new Set<string>();
  const validated: AgentToolCall[] = [];
  for (const call of calls) {
    if (
      call === null
      || typeof call !== 'object'
      || typeof call.id !== 'string'
      || call.id === ''
      || call.id.trim() !== call.id
      || call.id.length > 200
      || typeof call.name !== 'string'
      || call.name === ''
    ) {
      return { ok: false, code: 'AGENT_RUN_TOOL_CALL_INVALID' };
    }
    if (batchIds.has(call.id) || seen.has(call.id)) {
      return { ok: false, code: 'AGENT_RUN_TOOL_CALL_DUPLICATE' };
    }
    batchIds.add(call.id);
    validated.push({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return { ok: true, calls: validated };
}

function raceAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error('aborted'));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([operation, aborted]).finally(() => {
    if (listener !== undefined) signal.removeEventListener('abort', listener);
  });
}

function contextFits(
  kind: 'decision' | 'review',
  snapshot: AgentTransactionSnapshot,
  history: readonly AgentModelHistoryEntry[],
  candidateDecision: AgentDecision | undefined,
  maximum: number,
): boolean {
  const serializedContext = safeJson({
    kind,
    snapshot,
    history,
    ...(candidateDecision === undefined ? {} : { candidateDecision }),
  });
  return serializedContext !== undefined
    && utf8Bytes(serializedContext) <= maximum;
}

function recordUsage(state: RunState, usage: AgentModelUsage | undefined): boolean {
  if (usage === undefined) return true;
  if (
    usage === null
    || typeof usage !== 'object'
    || Array.isArray(usage)
  ) return false;
  const fields = [
    ['inputTokens', 'inputTokens', 'inputTokensSeen'],
    ['outputTokens', 'outputTokens', 'outputTokensSeen'],
    ['totalTokens', 'totalTokens', 'totalTokensSeen'],
  ] as const;
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(usage);
  } catch {
    return false;
  }
  if (
    keys.length === 0
    || keys.some((key) =>
      typeof key !== 'string'
      || !fields.some(([source]) => source === key))
  ) return false;

  const next = {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    inputTokensSeen: state.inputTokensSeen,
    outputTokensSeen: state.outputTokensSeen,
    totalTokensSeen: state.totalTokensSeen,
  };
  for (const [source, total, seen] of fields) {
    if (!keys.includes(source)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(usage, source);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) return false;
    const value = descriptor.value;
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < 0
    ) return false;
    const aggregate = next[total] + value;
    if (!Number.isSafeInteger(aggregate)) return false;
    next[total] = aggregate;
    next[seen] = true;
  }
  state.inputTokens = next.inputTokens;
  state.outputTokens = next.outputTokens;
  state.totalTokens = next.totalTokens;
  state.inputTokensSeen = next.inputTokensSeen;
  state.outputTokensSeen = next.outputTokensSeen;
  state.totalTokensSeen = next.totalTokensSeen;
  state.usageSeen = true;
  return true;
}

function aggregateUsage(state: RunState): AgentRunUsage | undefined {
  if (!state.usageSeen) return undefined;
  return {
    ...(state.inputTokensSeen ? { inputTokens: state.inputTokens } : {}),
    ...(state.outputTokensSeen ? { outputTokens: state.outputTokens } : {}),
    ...(state.totalTokensSeen ? { totalTokens: state.totalTokens } : {}),
  };
}

function resolvedLimits(
  overrides: Partial<AgentLimits> | undefined,
): { readonly limits: AgentLimits; readonly invalid: boolean } {
  let invalid = false;
  const resolve = (key: keyof AgentLimits): number => {
    const raw = overrides?.[key] ?? DEFAULT_AGENT_LIMITS[key];
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      invalid = true;
      return DEFAULT_AGENT_LIMITS[key];
    }
    return Math.min(raw, DEFAULT_AGENT_LIMITS[key]);
  };
  const limits = {
    maxToolCalls: resolve('maxToolCalls'),
    maxTurns: resolve('maxTurns'),
    maxContextBytes: resolve('maxContextBytes'),
    maxResponseBytes: resolve('maxResponseBytes'),
    timeoutMs: resolve('timeoutMs'),
  };
  return { limits, invalid };
}

function reviewMode(
  model: AgentModel,
  reviewModel: AgentModel | undefined,
): AgentVerificationMode {
  if (reviewModel === undefined) return 'deterministic';
  return model.identity.provider === reviewModel.identity.provider
    && model.identity.model === reviewModel.identity.model
    ? 'same_model'
    : 'distinct_model';
}

function reviewFailureCode(code: AgentRunDiagnosticCode): AgentRunDiagnosticCode {
  if (code === 'AGENT_DECISION_INVALID' || code === 'AGENT_RUN_MODEL_RESPONSE_INVALID') {
    return 'AGENT_RUN_REVIEW_INVALID';
  }
  if (code === 'AGENT_RUN_TIMEOUT' || code === 'AGENT_RUN_CANCELLED') return code;
  if (
    code === 'AGENT_RUN_TOOL_CALL_DUPLICATE'
    || code === 'AGENT_RUN_TOOL_CALL_INVALID'
    || code === 'AGENT_RUN_TOOL_LIMIT'
    || code === 'AGENT_RUN_TURN_LIMIT'
    || code === 'AGENT_RUN_CONTEXT_LIMIT'
    || code.startsWith('AGENT_MODEL_')
    || code.startsWith('AGENT_TOOL_')
  ) {
    return code;
  }
  return 'AGENT_RUN_REVIEW_FAILED';
}

function reviewTaxSelectionDiffers(
  candidate: DeepReadonly<AgentDecision>,
  reviewed: DeepReadonly<AgentDecision>,
): boolean {
  if (candidate.kind !== 'proposal' || reviewed.kind !== 'proposal') return false;
  if (candidate.taxCalculation !== reviewed.taxCalculation) return true;
  const candidateCategories = candidate.lines
    .map((line) => line.categoryQboId)
    .sort();
  const reviewedCategories = reviewed.lines
    .map((line) => line.categoryQboId)
    .sort();
  if (safeJson(candidateCategories) !== safeJson(reviewedCategories)) return false;
  const candidatePairs = candidate.lines
    .map((line) => categoryTaxPair(line.categoryQboId, line.taxCodeQboId))
    .sort();
  const reviewedPairs = reviewed.lines
    .map((line) => categoryTaxPair(line.categoryQboId, line.taxCodeQboId))
    .sort();
  return safeJson(candidatePairs) !== safeJson(reviewedPairs);
}

function isTaxVerificationCode(code: AgentRunDiagnosticCode): boolean {
  return code.startsWith('AGENT_TAX_') || code.startsWith('AGENT_EVIDENCE_TAX_');
}

function categoryTaxPair(categoryQboId: string, taxCodeQboId: string | null): string {
  return JSON.stringify([categoryQboId, taxCodeQboId]);
}

function systemAbstention(
  code: AgentRunDiagnosticCode,
): {
  readonly status: 'abstain';
  readonly decision: Extract<AgentDecision, { kind: 'abstain' }>;
} {
  const contextCodes = new Set<AgentRunDiagnosticCode>([
    'AGENT_RUN_CONTEXT_LIMIT',
    'AGENT_RUN_TOOL_LIMIT',
    'AGENT_RUN_TURN_LIMIT',
  ]);
  const verificationFailure = code.startsWith('AGENT_EVIDENCE_')
    || code.startsWith('AGENT_LINE_')
    || code.startsWith('AGENT_CATEGORY_')
    || code.startsWith('AGENT_TAG_')
    || code.startsWith('AGENT_TAX_')
    || code.startsWith('AGENT_RUN_REVIEW_');
  return {
    status: 'abstain',
    decision: {
      kind: 'abstain',
      reasonCode: code.startsWith('AGENT_TAX_')
        || code === 'AGENT_RUN_REVIEW_TAX_INVALID'
        ? 'INVALID_TAX_STATE'
        : verificationFailure
        ? 'CONFLICTING_EVIDENCE'
        : contextCodes.has(code)
          ? 'INSUFFICIENT_CONTEXT'
          : code === 'AGENT_RUN_SNAPSHOT_INVALID'
            ? 'UNSUPPORTED_TRANSACTION'
            : 'PROVIDER_FAILURE',
      rationale: 'Shadow decision abstained safely.',
    },
  };
}

function failed(
  code: AgentRunDiagnosticCode,
  providerFailure?: AgentRunResult['providerFailure'],
): ModelLoopOutcome {
  return {
    ok: false,
    code,
    ...(providerFailure === undefined ? {} : { providerFailure }),
  };
}

function terminalFailure(
  cause: TerminalCause | undefined,
): AgentRunDiagnosticCode | undefined {
  if (cause === 'timeout') return 'AGENT_RUN_TIMEOUT';
  if (cause === 'cancelled') return 'AGENT_RUN_CANCELLED';
  return undefined;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function safeDuration(now: number, startedAtMs: number): number {
  if (!Number.isFinite(now) || now <= startedAtMs) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(now - startedAtMs));
}

function safeRevision(snapshot: AgentTransactionSnapshot): number {
  try {
    return Number.isSafeInteger(snapshot.transaction.revision)
      ? snapshot.transaction.revision
      : 0;
  } catch {
    return 0;
  }
}

function safeIdentityPart(value: unknown): string {
  return typeof value === 'string' && value.length <= 200 ? value : 'unknown';
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
