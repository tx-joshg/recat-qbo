// Direct TypeScript port of Mailflow PR #275's restart-safe device poller.
// It intentionally keeps only display-safe state and never accepts tokens or
// upstream device/exchange secrets.

import type {
  CodexDeviceDto,
  CodexDevicePollDto,
  CodexDeviceStartDto,
  SuggestionProvider,
} from '@recat/shared';

export type CodexDeviceUiState =
  | {
      phase: 'pending';
      flowId: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: number;
      retryAfterMs: number;
    }
  | { phase: 'connected' }
  | { phase: 'failed'; reconnectRequired: boolean; reason: string }
  | { phase: 'cancelled' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string };

export function providerSelectionDecision(
  requestedProvider: SuggestionProvider,
  currentDisplayedProvider: SuggestionProvider,
  codexStatusLoaded: boolean,
  codexConnected: boolean,
): {
  displayedProvider: SuggestionProvider;
  providerToPersist: SuggestionProvider | null;
} {
  if (requestedProvider === 'codex' && !codexStatusLoaded) {
    return { displayedProvider: currentDisplayedProvider, providerToPersist: null };
  }
  return {
    displayedProvider: requestedProvider,
    providerToPersist:
      requestedProvider === 'codex' && !codexConnected ? null : requestedProvider,
  };
}

export function providerPersistenceForCodexTransition(
  phase: CodexDeviceUiState['phase'],
  explicitlySelected: boolean,
): SuggestionProvider | null {
  return phase === 'connected' && explicitlySelected ? 'codex' : null;
}

interface CodexDevicePollerOptions {
  startDevice: () => Promise<CodexDeviceStartDto>;
  pollDevice: (flowId: string) => Promise<CodexDevicePollDto>;
  cancelDevice: (flowId: string) => Promise<CodexDevicePollDto>;
  onState: (state: CodexDeviceUiState) => void;
  now?: () => number;
  setTimer?: (callback: () => void | Promise<void>, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createCodexDevicePoller({
  startDevice,
  pollDevice,
  cancelDevice,
  onState,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: CodexDevicePollerOptions) {
  let timer: unknown = null;
  let flow: { flowId: string; expiresAt: number; intervalMs: number } | null = null;
  let generation = 0;
  let disposed = false;

  function clearScheduledPoll(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function isCurrent(expectedGeneration: number): boolean {
    return !disposed && expectedGeneration === generation;
  }

  function emit(
    state: CodexDeviceUiState,
    expectedGeneration = generation,
  ): CodexDeviceUiState | null {
    if (!isCurrent(expectedGeneration)) return null;
    onState(state);
    return state;
  }

  function schedule(delay: unknown, expectedGeneration: number): void {
    if (!isCurrent(expectedGeneration) || !flow) return;
    clearScheduledPoll();
    const boundedDelay = Math.max(0, finiteNumber(delay) ?? flow.intervalMs);
    timer = setTimer(() => pollOnce(expectedGeneration), boundedDelay);
  }

  function expireIfNeeded(expectedGeneration: number): boolean {
    if (!flow || now() < flow.expiresAt) return false;
    flow = null;
    clearScheduledPoll();
    emit({ phase: 'expired' }, expectedGeneration);
    return true;
  }

  async function pollOnce(expectedGeneration: number): Promise<void> {
    timer = null;
    if (!isCurrent(expectedGeneration) || !flow || expireIfNeeded(expectedGeneration)) return;
    const activeFlow = flow;
    try {
      const response = await pollDevice(activeFlow.flowId);
      if (!isCurrent(expectedGeneration) || flow !== activeFlow) return;
      if (expireIfNeeded(expectedGeneration)) return;

      if (response.status === 'pending') {
        schedule(response.retryAfterMs, expectedGeneration);
        return;
      }

      flow = null;
      clearScheduledPoll();
      if (response.status === 'connected') {
        emit({ phase: 'connected' }, expectedGeneration);
      } else if (response.status === 'failed') {
        emit(
          {
            phase: 'failed',
            reconnectRequired: response.reconnectRequired === true,
            reason: cleanString(response.reason) || 'authorization_failed',
          },
          expectedGeneration,
        );
      } else if (response.status === 'cancelled' || response.status === 'expired') {
        emit({ phase: response.status }, expectedGeneration);
      } else {
        emit({ phase: 'error', message: 'ChatGPT authorization failed' }, expectedGeneration);
      }
    } catch {
      if (!isCurrent(expectedGeneration) || flow !== activeFlow) return;
      if (expireIfNeeded(expectedGeneration)) return;
      schedule(activeFlow.intervalMs, expectedGeneration);
    }
  }

  async function start(existingDevice: CodexDeviceDto | null = null) {
    if (disposed) throw new Error('ChatGPT device poller is disposed');
    const expectedGeneration = ++generation;
    flow = null;
    clearScheduledPoll();
    try {
      const response = existingDevice ?? (await startDevice());
      if (!isCurrent(expectedGeneration)) return null;
      const flowId = cleanString(response.flowId);
      const userCode = cleanString(response.userCode);
      const verificationUrl = cleanString(response.verificationUrl);
      const expiresAt = finiteNumber(response.expiresAt);
      const intervalMs = finiteNumber(response.intervalMs);
      if (!flowId || !userCode || !verificationUrl || expiresAt === null || intervalMs === null) {
        throw new Error('Invalid ChatGPT authorization response');
      }
      flow = { flowId, expiresAt, intervalMs };
      const state = emit(
        {
          phase: 'pending',
          flowId,
          userCode,
          verificationUrl,
          expiresAt,
          retryAfterMs: intervalMs,
        },
        expectedGeneration,
      );
      schedule(intervalMs, expectedGeneration);
      return state;
    } catch (error) {
      if (isCurrent(expectedGeneration)) {
        flow = null;
        clearScheduledPoll();
        emit({ phase: 'error', message: 'Unable to start ChatGPT authorization' }, expectedGeneration);
      }
      throw error;
    }
  }

  async function cancel(): Promise<void> {
    if (disposed) return;
    const flowId = flow?.flowId;
    const expectedGeneration = ++generation;
    flow = null;
    clearScheduledPoll();
    try {
      if (flowId) await cancelDevice(flowId);
      emit({ phase: 'cancelled' }, expectedGeneration);
    } catch (error) {
      emit({ phase: 'error', message: 'Unable to cancel ChatGPT authorization' }, expectedGeneration);
      throw error;
    }
  }

  function dispose(): void {
    disposed = true;
    generation += 1;
    flow = null;
    clearScheduledPoll();
  }

  return { start, cancel, dispose };
}
