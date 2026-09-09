import type {
  StageCategorizationBody,
  StagedCategorization,
  TransactionDto,
} from '@recat/shared';

export type DesiredStage = Omit<StageCategorizationBody, 'expectedRevision'>;
export type RowStageStatus = 'idle' | 'calculating' | 'ready' | 'error' | 'conflict';

export interface RowStageView {
  status: RowStageStatus;
  desired: DesiredStage | null;
  staged: DesiredStage | null;
  result: StagedCategorization | null;
  error: string | null;
}

export interface RowStageTransport {
  stage(expectedRevision: number, desired: DesiredStage): Promise<StagedCategorization>;
  reload(): Promise<TransactionDto | null>;
  isMutable(transaction: TransactionDto): boolean;
}

interface CodedHttpError {
  code?: unknown;
  status?: unknown;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameDesired(left: DesiredStage, right: DesiredStage): boolean {
  return left.taxCalculation === right.taxCalculation
    && sameStrings(left.tagIds, right.tagIds)
    && left.lines.length === right.lines.length
    && left.lines.every((line, index) => {
      const other = right.lines[index];
      return other !== undefined
        && line.grossCents === other.grossCents
        && line.categoryQboId === other.categoryQboId
        && line.taxCodeQboId === other.taxCodeQboId
        && line.memo === other.memo
        && sameStrings(line.tagIds, other.tagIds);
    });
}

function snapshot(desired: DesiredStage): DesiredStage {
  return {
    taxCalculation: desired.taxCalculation,
    lines: desired.lines.map((line) => ({
      grossCents: line.grossCents,
      categoryQboId: line.categoryQboId,
      taxCodeQboId: line.taxCodeQboId,
      ...(line.memo !== undefined ? { memo: line.memo } : {}),
      tagIds: [...line.tagIds],
    })),
    tagIds: [...desired.tagIds],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not calculate tax.';
}

function requiresReload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return true;
  const candidate = error as CodedHttpError;
  if (candidate.code === 'STALE_REVISION' || candidate.code === 'MUTATION_BLOCKED') return true;
  if (!Number.isInteger(candidate.status)) return true;
  const status = candidate.status as number;
  return status === 408 || (status >= 500 && status <= 599);
}

export function createRowStageCoordinator(
  revision: number,
  transport: RowStageTransport,
  publish: (view: RowStageView) => void,
): { update(desired: DesiredStage): void; retry(): void; restage(): boolean; dispose(): void } {
  let canonicalRevision = revision;
  let status: RowStageStatus = 'idle';
  let desired: DesiredStage | null = null;
  let staged: DesiredStage | null = null;
  let result: StagedCategorization | null = null;
  let error: string | null = null;
  let queued: DesiredStage | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let desiredGeneration = 0;
  let recoveryAttemptedGeneration: number | null = null;
  let reloadRequired = false;

  const emit = () => {
    if (disposed) return;
    publish({ status, desired, staged, result, error });
  };

  const settleError = (failure: unknown, stillRequiresReload: boolean) => {
    inFlight = null;
    queued = null;
    status = 'error';
    staged = null;
    result = null;
    error = messageOf(failure);
    reloadRequired = stillRequiresReload;
    emit();
  };

  const settleConflict = () => {
    inFlight = null;
    queued = null;
    status = 'conflict';
    desired = null;
    staged = null;
    result = null;
    error = 'The transaction is no longer available for categorization.';
    reloadRequired = false;
    emit();
  };

  function startReload(): void {
    status = 'calculating';
    staged = null;
    result = null;
    error = null;
    inFlight = Promise.resolve();
    emit();
    if (disposed) return;

    let reloadPromise: Promise<TransactionDto | null>;
    try {
      reloadPromise = transport.reload();
    } catch (reloadError) {
      reloadPromise = Promise.reject(reloadError);
    }

    const run = async () => {
      let latest: TransactionDto | null;
      try {
        latest = await reloadPromise;
      } catch (reloadError) {
        if (disposed) return;
        settleError(reloadError, true);
        return;
      }

      if (disposed) return;
      if (latest === null || !transport.isMutable(latest)) {
        settleConflict();
        return;
      }

      canonicalRevision = latest.revision;
      reloadRequired = false;
      const next = queued ?? desired;
      queued = null;
      inFlight = null;
      if (next !== null) {
        recoveryAttemptedGeneration = desiredGeneration;
        start(next);
      }
    };

    inFlight = run();
  }

  function start(requested: DesiredStage): void {
    queued = null;
    status = 'calculating';
    staged = null;
    result = null;
    error = null;
    inFlight = Promise.resolve();
    emit();
    if (disposed) return;

    let stagePromise: Promise<StagedCategorization>;
    try {
      stagePromise = transport.stage(canonicalRevision, snapshot(requested));
    } catch (stageError) {
      stagePromise = Promise.reject(stageError);
    }

    const run = async () => {
      try {
        const stagedResult = await stagePromise;
        if (disposed) return;

        canonicalRevision = stagedResult.revision;
        reloadRequired = false;
        inFlight = null;
        if (desired !== null && sameDesired(desired, requested)) {
          queued = null;
          status = 'ready';
          staged = requested;
          result = stagedResult;
          error = null;
          emit();
          return;
        }

        const next = queued ?? desired;
        queued = null;
        if (next !== null) start(next);
      } catch (stageError) {
        if (disposed) return;

        if (!requiresReload(stageError)) {
          reloadRequired = false;
          inFlight = null;
          if (desired !== null && !sameDesired(desired, requested)) {
            const next = queued ?? desired;
            queued = null;
            start(next);
            return;
          }
          settleError(stageError, false);
          return;
        }

        reloadRequired = true;
        if (recoveryAttemptedGeneration === desiredGeneration) {
          settleError(stageError, true);
          return;
        }
        inFlight = null;
        startReload();
      }
    };

    inFlight = run();
  };

  return {
    update(nextDesired) {
      if (disposed || status === 'conflict') return;
      const next = snapshot(nextDesired);
      if (desired !== null && sameDesired(desired, next)) return;

      desired = next;
      desiredGeneration += 1;
      staged = null;
      result = null;
      error = null;
      if (inFlight !== null) {
        queued = next;
        status = 'calculating';
        emit();
        return;
      }
      if (reloadRequired) {
        startReload();
        return;
      }
      start(next);
    },

    retry() {
      if (disposed || inFlight !== null || desired === null || status !== 'error') return;
      if (reloadRequired) {
        startReload();
        return;
      }
      start(desired);
    },

    restage() {
      if (disposed || inFlight !== null || desired === null || status !== 'ready') return false;
      desiredGeneration += 1;
      start(desired);
      return true;
    },

    dispose() {
      disposed = true;
      queued = null;
    },
  };
}
