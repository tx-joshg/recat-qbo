import { describe, expect, it, vi } from 'vitest';
import type { StagedCategorization, TransactionDto } from '@recat/shared';
import {
  createRowStageCoordinator,
  type DesiredStage,
  type RowStageTransport,
  type RowStageView,
} from './rowStageCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function desired(categoryQboId: string): Extract<DesiredStage, { lines: unknown }> {
  return {
    taxCalculation: 'NotApplicable',
    lines: [{
      grossCents: -1_050,
      categoryQboId,
      taxCodeQboId: null,
      memo: `memo-${categoryQboId}`,
      tagIds: [`line-tag-${categoryQboId}`],
    }],
    tagIds: [`transaction-tag-${categoryQboId}`],
  };
}

function result(revision: number, categoryQboId = 'EXPENSE_ACCOUNT'): StagedCategorization {
  return {
    transactionId: 'transaction-1',
    revision,
    taxCalculation: 'NotApplicable',
    totals: { subtotalCents: -1_050, taxCents: 0, totalCents: -1_050 },
    lines: [{
      idx: 0,
      subtotalCents: -1_050,
      taxCents: 0,
      totalCents: -1_050,
      categoryQboId,
      taxCodeQboId: null,
      memo: `memo-${categoryQboId}`,
      tagIds: [`line-tag-${categoryQboId}`],
    }],
    tagIds: [`transaction-tag-${categoryQboId}`],
  };
}

function transaction(revision: number, status: TransactionDto['status'] = 'PENDING'): TransactionDto {
  return {
    id: 'transaction-1',
    companyId: 'company-1',
    qboId: 'qbo-transaction-1',
    qboType: 'Purchase',
    date: '2026-09-04',
    payee: 'Vendor',
    memo: null,
    amount: -10.5,
    bankAccount: 'Checking',
    status,
    revision,
    category: null,
    categoryQboId: null,
    taxCalculation: null,
    taxCode: null,
    taxCodeQboId: null,
    splits: null,
    tagIds: [],
    suggestion: null,
    error: null,
    postedAt: null,
    postedBy: null,
    activeCategorizationAttempt: null,
  };
}

function httpError(
  code: string,
  message: string,
  status = code === 'STALE_REVISION' ? 409 : 400,
): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

function transport(overrides: Partial<RowStageTransport> = {}): RowStageTransport {
  return {
    stage: vi.fn().mockResolvedValue(result(2)),
    reload: vi.fn().mockResolvedValue(transaction(1)),
    isMutable: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function lastView(publish: ReturnType<typeof vi.fn>): RowStageView {
  return publish.mock.calls.at(-1)?.[0] as RowStageView;
}

describe('createRowStageCoordinator', () => {

  it('stages only A and latest C when B and C arrive during A', async () => {
    const first = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(result(3, 'C'));
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    coordinator.update(desired('B'));
    coordinator.update(desired('C'));

    expect(stage).toHaveBeenCalledTimes(1);
    first.resolve(result(2, 'A'));
    await vi.waitFor(() => expect(stage).toHaveBeenLastCalledWith(2, desired('C')));
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it('reserves the in-flight slot before publishing a calculating view', async () => {
    const first = deferred<StagedCategorization>();
    const stage = vi.fn().mockReturnValue(first.promise);
    let coordinator!: ReturnType<typeof createRowStageCoordinator>;
    const publish = vi.fn((view: RowStageView) => {
      if (
        view.status === 'calculating'
        && view.desired !== null
        && 'lines' in view.desired
        && view.desired.lines[0]?.categoryQboId === 'A'
      ) {
        coordinator.update(desired('B'));
      }
    });
    coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));

    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenLastCalledWith(1, desired('A'));
    first.resolve(result(2, 'A'));
    await vi.waitFor(() => expect(stage).toHaveBeenLastCalledWith(2, desired('B')));
  });

  it('uses exact value equality for desired snapshots', async () => {
    const first = deferred<StagedCategorization>();
    const stage = vi.fn().mockReturnValue(first.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    coordinator.update(desired('A'));
    expect(stage).toHaveBeenCalledTimes(1);

    first.resolve(result(2, 'A'));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
    coordinator.update(desired('A'));

    expect(stage).toHaveBeenCalledTimes(1);
    expect(lastView(publish)).toMatchObject({
      status: 'ready',
      desired: desired('A'),
      staged: desired('A'),
      result: result(2, 'A'),
      error: null,
    });
  });

  it('explicitly restages the retained desired snapshot only once while active', async () => {
    const restaged = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockResolvedValueOnce(result(2, 'A'))
      .mockReturnValueOnce(restaged.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
    const retainedDesired = lastView(publish).desired;

    expect(coordinator.restage()).toBe(true);
    expect(coordinator.restage()).toBe(false);

    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenLastCalledWith(2, desired('A'));
    expect(lastView(publish)).toMatchObject({
      status: 'calculating',
      staged: null,
      result: null,
      error: null,
    });
    expect(lastView(publish).desired).toBe(retainedDesired);

    restaged.resolve(result(3, 'A'));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
    expect(lastView(publish).desired).toBe(retainedDesired);
    expect(lastView(publish).staged).toBe(retainedDesired);
  });

  it('reports that restage did not start from an error state', async () => {
    const stage = vi.fn().mockRejectedValue(
      httpError('INVALID_INPUT', 'Cannot calculate tax'),
    );
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'error',
      error: 'Cannot calculate tax',
    }));
    const failedView = lastView(publish);

    expect(coordinator.restage()).toBe(false);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(lastView(publish)).toBe(failedView);
  });

  it('deduplicates repeated retries while a retry is in flight', async () => {
    const retryStage = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockRejectedValueOnce(httpError('INVALID_INPUT', 'Cannot calculate tax'))
      .mockReturnValueOnce(retryStage.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'error',
      error: 'Cannot calculate tax',
    }));

    coordinator.retry();
    coordinator.retry();
    coordinator.retry();

    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenLastCalledWith(1, desired('A'));
    retryStage.resolve(result(2, 'A'));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
  });

  it('reloads and rebases the latest desired snapshot after a stale revision', async () => {
    const reload = deferred<TransactionDto | null>();
    const second = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockRejectedValueOnce(httpError('STALE_REVISION', 'Transaction changed'))
      .mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(
      1,
      transport({ stage, reload: vi.fn().mockReturnValue(reload.promise) }),
      publish,
    );

    coordinator.update(desired('A'));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('calculating'));
    coordinator.update(desired('B'));
    reload.resolve(transaction(7));

    await vi.waitFor(() => expect(stage).toHaveBeenLastCalledWith(7, desired('B')));
    expect(stage).toHaveBeenCalledTimes(2);
    second.resolve(result(8, 'B'));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
  });




  it('reloads and rebases once when a stage response is lost', async () => {
    const stage = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(result(5, 'A'));
    const reload = vi.fn().mockResolvedValue(transaction(4));
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage, reload }), publish);

    coordinator.update(desired('A'));

    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenLastCalledWith(4, desired('A'));
  });

  it('settles after one recovery stage when the recovered outcome is also ambiguous', async () => {
    const blockedThirdStage = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockRejectedValueOnce(new TypeError('First response lost'))
      .mockRejectedValueOnce(new TypeError('Recovery response lost'))
      .mockReturnValueOnce(blockedThirdStage.promise);
    const reload = vi.fn().mockResolvedValue(transaction(4));
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage, reload }), publish);

    coordinator.update(desired('A'));

    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'error',
      error: 'Recovery response lost',
    }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenNthCalledWith(2, 4, desired('A'));
  });

  it('allows one recovery for a newer desired generation queued during recovery', async () => {
    const recoveryStage = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockRejectedValueOnce(new TypeError('First response lost'))
      .mockReturnValueOnce(recoveryStage.promise)
      .mockResolvedValueOnce(result(8, 'B'));
    const reload = vi.fn()
      .mockResolvedValueOnce(transaction(4))
      .mockResolvedValueOnce(transaction(7));
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage, reload }), publish);

    coordinator.update(desired('A'));
    await vi.waitFor(() => expect(stage).toHaveBeenNthCalledWith(2, 4, desired('A')));
    coordinator.update(desired('B'));
    recoveryStage.reject(new TypeError('Recovery response lost'));

    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'ready',
      desired: desired('B'),
      staged: desired('B'),
    }));
    expect(reload).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenCalledTimes(3);
    expect(stage).toHaveBeenLastCalledWith(7, desired('B'));
  });

  it('retries a failed safety reload before sending another stage mutation', async () => {
    const retryReload = deferred<TransactionDto | null>();
    const stage = vi.fn()
      .mockRejectedValueOnce(new TypeError('Stage response lost'))
      .mockResolvedValueOnce(result(8, 'A'));
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockReturnValueOnce(retryReload.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage, reload }), publish);

    coordinator.update(desired('A'));
    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'error',
      error: 'Reload unavailable',
    }));

    coordinator.retry();
    coordinator.retry();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenCalledTimes(1);

    retryReload.resolve(transaction(7));
    await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenLastCalledWith(7, desired('A'));
  });

  it.each([408, 500, 502, 503, 504])(
    'reloads before retrying an ambiguous HTTP %s stage outcome',
    async (status) => {
      const stage = vi.fn()
        .mockRejectedValueOnce(httpError('UPSTREAM_FAILURE', 'Ambiguous upstream response', status))
        .mockResolvedValueOnce(result(6, 'A'));
      const reload = vi.fn().mockResolvedValue(transaction(5));
      const publish = vi.fn();
      const coordinator = createRowStageCoordinator(1, transport({ stage, reload }), publish);

      coordinator.update(desired('A'));

      await vi.waitFor(() => expect(lastView(publish).status).toBe('ready'));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(stage).toHaveBeenCalledTimes(2);
      expect(stage).toHaveBeenLastCalledWith(5, desired('A'));
    },
  );

  it('never publishes an obsolete stage result as ready', async () => {
    const first = deferred<StagedCategorization>();
    const second = deferred<StagedCategorization>();
    const stage = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    coordinator.update(desired('B'));
    first.resolve(result(2, 'A'));
    await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(2));

    expect(publish.mock.calls.map(([view]) => view as RowStageView)).not.toContainEqual(
      expect.objectContaining({ status: 'ready', result: result(2, 'A') }),
    );
    second.resolve(result(3, 'B'));
    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'ready',
      desired: desired('B'),
      staged: desired('B'),
      result: result(3, 'B'),
    }));
  });

  it('does not publish or start more work after disposal', async () => {
    const first = deferred<StagedCategorization>();
    const stage = vi.fn().mockReturnValue(first.promise);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));
    const publishCount = publish.mock.calls.length;
    coordinator.update(desired('B'));
    coordinator.dispose();
    first.resolve(result(2, 'A'));
    await first.promise;
    await Promise.resolve();
    coordinator.update(desired('C'));
    coordinator.retry();

    expect(publish).toHaveBeenCalledTimes(publishCount + 1);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the transport when calculating publication disposes the coordinator', () => {
    const stage = vi.fn().mockResolvedValue(result(2, 'A'));
    let coordinator!: ReturnType<typeof createRowStageCoordinator>;
    const publish = vi.fn(() => coordinator.dispose());
    coordinator = createRowStageCoordinator(1, transport({ stage }), publish);

    coordinator.update(desired('A'));

    expect(stage).not.toHaveBeenCalled();
  });

  it('fails closed when a stale reload is no longer mutable', async () => {
    const stage = vi.fn().mockRejectedValue(httpError('STALE_REVISION', 'Transaction changed'));
    const reload = vi.fn().mockResolvedValue(transaction(9, 'POSTED'));
    const isMutable = vi.fn().mockReturnValue(false);
    const publish = vi.fn();
    const coordinator = createRowStageCoordinator(
      1,
      transport({ stage, reload, isMutable }),
      publish,
    );

    coordinator.update(desired('A'));

    await vi.waitFor(() => expect(lastView(publish)).toMatchObject({
      status: 'conflict',
      desired: null,
      staged: null,
      result: null,
    }));
    const conflictView = lastView(publish);
    coordinator.update(desired('B'));
    coordinator.retry();

    expect(lastView(publish)).toEqual(conflictView);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(isMutable).toHaveBeenCalledWith(expect.objectContaining({ revision: 9, status: 'POSTED' }));
    expect(stage).toHaveBeenCalledTimes(1);
  });
});
