import { describe, expect, it, vi } from 'vitest';
import {
  finishPendingQboDisconnect,
  sweepPendingQboDisconnects,
  type QboDisconnectDeps,
} from './qboDisconnect.js';

function deps(overrides: Partial<QboDisconnectDeps> = {}): QboDisconnectDeps {
  return {
    db: {
      company: {
        findUnique: vi.fn(async () => ({
          disconnectedAt: new Date('2026-07-23T12:00:00Z'),
          realmId: 'realm-1',
          accessToken: 'encrypted-access',
          refreshToken: 'encrypted-refresh',
          tokenExpiresAt: new Date('2026-07-23T13:00:00Z'),
        })),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as unknown as QboDisconnectDeps['db'],
    acquireLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('durable QuickBooks disconnect cleanup', () => {
  it('leaves durable credentials for the scheduler while a write lease is busy', async () => {
    const value = deps({ acquireLease: vi.fn(async () => false) });

    await expect(finishPendingQboDisconnect('co-1', value)).resolves.toBe(false);
    expect(value.revoke).not.toHaveBeenCalled();
    expect(value.db.company.updateMany).not.toHaveBeenCalled();
    expect(value.releaseLease).not.toHaveBeenCalled();
  });

  it('revokes and clears credentials after acquiring the write boundary', async () => {
    const value = deps();

    await expect(finishPendingQboDisconnect('co-1', value)).resolves.toBe(true);
    expect(value.revoke).toHaveBeenCalledWith({
      disconnectedAt: new Date('2026-07-23T12:00:00Z'),
      realmId: 'realm-1',
      accessToken: 'encrypted-access',
      refreshToken: 'encrypted-refresh',
      tokenExpiresAt: new Date('2026-07-23T13:00:00Z'),
    });
    expect(value.db.company.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'co-1',
        disconnectedAt: new Date('2026-07-23T12:00:00Z'),
        accessToken: 'encrypted-access',
        refreshToken: 'encrypted-refresh',
        tokenExpiresAt: new Date('2026-07-23T13:00:00Z'),
      },
      data: {
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
      },
    });
    expect(value.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('does not clear a newly reconnected credential snapshot', async () => {
    const value = deps();
    vi.mocked(value.db.company.updateMany).mockResolvedValue({ count: 0 });

    await expect(finishPendingQboDisconnect('co-1', value)).resolves.toBe(true);

    expect(value.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'encrypted-refresh' }),
    );
    expect(value.db.company.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          disconnectedAt: new Date('2026-07-23T12:00:00Z'),
          refreshToken: 'encrypted-refresh',
        }),
      }),
    );
  });

  it('sweeps incomplete disconnects and reports leases that are still busy', async () => {
    const value = deps();
    vi.mocked(value.db.company.findMany).mockResolvedValue([
      { id: 'co-1' },
      { id: 'co-2' },
    ] as never);
    vi.mocked(value.acquireLease)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(sweepPendingQboDisconnects(value)).resolves.toEqual({
      pending: 1,
      completed: 1,
    });
    expect(value.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'encrypted-refresh' }),
    );
  });
});
