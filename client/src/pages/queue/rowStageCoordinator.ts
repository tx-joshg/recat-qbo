import type {
  ManualStageCategorizationBody,
  RuleSuggestionStageCategorizationBody,
  StagedCategorization,
  TransactionDto,
} from '@recat/shared';

export type DesiredStage =
  | Omit<ManualStageCategorizationBody, 'expectedRevision'>
  | Omit<RuleSuggestionStageCategorizationBody, 'expectedRevision'>;
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
  reload(rejectedDesired?: DesiredStage): Promise<TransactionDto | null>;
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
  if ('ruleSuggestion' in left || 'ruleSuggestion' in right) {
    if (!('ruleSuggestion' in left) || !('ruleSuggestion' in right)) return false;
    const leftSuggestion = left.ruleSuggestion;
    const rightSuggestion = right.ruleSuggestion;
    return leftSuggestion.source === rightSuggestion.source
      && leftSuggestion.version === rightSuggestion.version
      && leftSuggestion.ruleId === rightSuggestion.ruleId
      && leftSuggestion.ruleRevision === rightSuggestion.ruleRevision
      && leftSuggestion.autoPost === rightSuggestion.autoPost
      && leftSuggestion.action.version === rightSuggestion.action.version
      && leftSuggestion.action.direction === rightSuggestion.action.direction
      && leftSuggestion.action.category === rightSuggestion.action.category
      && leftSuggestion.action.categoryQboId === rightSuggestion.action.categoryQboId
      && leftSuggestion.action.taxCalculation === rightSuggestion.action.taxCalculation
      && leftSuggestion.action.taxCodeQboId === rightSuggestion.action.taxCodeQboId
      && sameStrings(leftSuggestion.action.tagIds, rightSuggestion.action.tagIds);
  }
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
  if ('ruleSuggestion' in desired) {
    return {
      ruleSuggestion: {
        ...desired.ruleSuggestion,
        action: {
          ...desired.ruleSuggestion.action,
          tagIds: [...desired.ruleSuggestion.action.tagIds],
        },
      },
    };
  }
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
  if (candidate.code === 'STALE_RULE_SUGGESTION') return true;
  if (!Number.isInteger(candidate.status)) return true;
  const status = candidate.status as number;
  return status === 408 || (status >= 500 && status <= 599);
}

function isStaleRuleSuggestion(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as CodedHttpError).code === 'STALE_RULE_SUGGESTION';
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
  let rejectedRuleReload: { desired: DesiredStage; error: unknown } | null = null;

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

  function startReload(rejection?: { desired: DesiredStage; error: unknown }): void {
    if (rejection !== undefined) rejectedRuleReload = rejection;
    const rejected = rejectedRuleReload;
    status = 'calculating';
    staged = null;
    result = null;
    error = null;
    inFlight = Promise.resolve();
    emit();
    if (disposed) return;

    let reloadPromise: Promise<TransactionDto | null>;
    try {
      reloadPromise = rejected === null
        ? transport.reload()
        : transport.reload(rejected.desired);
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
      rejectedRuleReload = null;
      if (rejected !== null) {
        const next = queued ?? desired;
        queued = null;
        if (next !== null && !('ruleSuggestion' in next)) {
          inFlight = null;
          start(next);
          return;
        }
        desired = null;
        settleError(rejected.error, false);
        return;
      }
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
        if (isStaleRuleSuggestion(stageError)) {
          inFlight = null;
          startReload({ desired: requested, error: stageError });
          return;
        }
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
