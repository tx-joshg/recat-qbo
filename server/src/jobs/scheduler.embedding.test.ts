import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embeddingTick: vi.fn(),
  ruleRecovery: vi.fn(),
  preparationRetry: vi.fn(),
}));

vi.mock('../services/classification/embedding/reconciler.js', () => ({
  runClassificationEmbeddingTick: mocks.embeddingTick,
}));
vi.mock('../services/rulePreparationRetry.js', () => ({
  recoverRulePreparationRetries: mocks.preparationRetry,
  rememberBusyRulePreparation: vi.fn(async () => undefined),
}));
vi.mock('../services/ruleAutoPost.js', () => ({
  recoverRuleAutoPosts: mocks.ruleRecovery,
  prepareRuleAutoPost: vi.fn(),
  resumeRuleAutoPost: vi.fn(),
}));

const {
  runClassificationSearchEmbeddingTick,
  runRuleAutoPostRecoveryTick,
} = await import('./scheduler.js');

describe('classification embedding scheduler', () => {
  beforeEach(() => {
    mocks.embeddingTick.mockReset();
    mocks.embeddingTick.mockResolvedValue({
      configured: true,
      processed: 1,
      published: 1,
      failed: 0,
      unavailable: 0,
    });
    mocks.preparationRetry.mockReset();
    mocks.preparationRetry.mockResolvedValue({ examined: 0, prepared: 0 });
    mocks.ruleRecovery.mockReset();
    mocks.ruleRecovery.mockResolvedValue({ examined: 1, completed: 1, pending: 0, failed: 0 });
  });

  it('runs at most once per ten-minute window', async () => {
    await runClassificationSearchEmbeddingTick(new Date('2026-08-31T00:00:00.000Z'));
    await runClassificationSearchEmbeddingTick(new Date('2026-08-31T00:09:59.999Z'));
    await runClassificationSearchEmbeddingTick(new Date('2026-08-31T00:10:00.000Z'));

    expect(mocks.embeddingTick).toHaveBeenCalledTimes(2);
  });

  it('coalesces rule recovery so scheduler ticks cannot overlap', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    mocks.ruleRecovery.mockImplementationOnce(async () => {
      await held;
      return { examined: 1, completed: 1, pending: 0, failed: 0 };
    });

    const first = runRuleAutoPostRecoveryTick();
    await runRuleAutoPostRecoveryTick();
    expect(mocks.ruleRecovery).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(mocks.preparationRetry).toHaveBeenCalledTimes(1);
    expect(mocks.preparationRetry.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.ruleRecovery.mock.invocationCallOrder[0]!);
  });
  it('keeps recovery coalesced while deferred preparation is still running', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.preparationRetry.mockImplementationOnce(async () => {
      entered(); await held;
      return { examined: 1, prepared: 1 };
    });
    const first = runRuleAutoPostRecoveryTick();
    await started;
    await runRuleAutoPostRecoveryTick();
    expect(mocks.ruleRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.preparationRetry).toHaveBeenCalledTimes(1);
    release(); await first;
  });

});
