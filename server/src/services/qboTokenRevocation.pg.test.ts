import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import * as qboFactory from '../lib/qbo/factory.js';
import { startJobs, stopJobs } from '../jobs/scheduler.js';
import { disconnectCompanyWithLiveAuthority } from './companyLiveAuthority.js';
import { sweepQboTokenRevocations } from './qboTokenRevocation.js';

const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('durable disconnect revocation', () => {
  const companyIds: string[] = [];

  afterEach(async () => {
    stopJobs();
    vi.restoreAllMocks();
    await prisma.company.deleteMany({ where: { id: { in: companyIds.splice(0) } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function seed() {
    const company = await prisma.company.create({ data: {
      realmId: `synthetic-disconnect-${randomUUID()}`,
      legalName: 'Synthetic ledger', nickname: 'Synthetic ledger',
      accessToken: 'synthetic-encrypted-access', refreshToken: 'synthetic-encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() + 60_000),
    } });
    companyIds.push(company.id);
    return company;
  }

  it('recovers the captured revoke at boot when the original capability was never invoked', async () => {
    const company = await seed();
    const revoke = vi.spyOn(qboFactory, 'revokeCapturedQboToken').mockResolvedValue();
    const disconnected = await disconnectCompanyWithLiveAuthority(company.id);
    expect(disconnected.company).toMatchObject({ accessToken: null, refreshToken: null, tokenExpiresAt: null });
    expect(disconnected.company.disconnectedAt).toBeInstanceOf(Date);
    expect(revoke).not.toHaveBeenCalled();

    startJobs();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce(), { timeout: 1_000 });
    expect(revoke).toHaveBeenCalledWith({ realmId: company.realmId, refreshToken: company.refreshToken });
    await disconnected.revoke();
    expect(revoke).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(await prisma.qboTokenRevocation.count()).toBe(0));
  });

  it('rolls back the snapshot together with the local disconnect', async () => {
    const company = await seed();
    await expect(disconnectCompanyWithLiveAuthority(company.id, {
      now: () => new Date(),
      withSerializableTransaction: (callback) => prisma.$transaction(async (tx) => {
        await callback(tx);
        throw new Error('Synthetic rollback');
      }),
    })).rejects.toThrow('Synthetic rollback');
    await expect(prisma.company.findUniqueOrThrow({ where: { id: company.id } }))
      .resolves.toMatchObject({ disconnectedAt: null, refreshToken: company.refreshToken });
    await expect(prisma.qboTokenRevocation.count()).resolves.toBe(0);
  });

  it('deduplicates concurrent and repeated disconnects and concurrent drains', async () => {
    const company = await seed();
    const capabilities = await Promise.all([
      disconnectCompanyWithLiveAuthority(company.id),
      disconnectCompanyWithLiveAuthority(company.id),
    ]);
    capabilities.push(await disconnectCompanyWithLiveAuthority(company.id));
    await expect(prisma.qboTokenRevocation.count()).resolves.toBe(1);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const revoke = vi.spyOn(qboFactory, 'revokeCapturedQboToken').mockReturnValue(waiting);
    const draining = Promise.all(capabilities.map((capability) => capability.revoke()));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    await sweepQboTokenRevocations();
    expect(revoke).toHaveBeenCalledOnce();
    release();
    await draining;
    await expect(prisma.qboTokenRevocation.count()).resolves.toBe(0);
  });

  it('reclaims an expired pre-attempt owner through a new database client', async () => {
    const company = await seed();
    await disconnectCompanyWithLiveAuthority(company.id);
    await prisma.qboTokenRevocation.updateMany({ data: {
      leaseOwner: 'synthetic-dead-owner', leaseExpiresAt: new Date(Date.now() - 60_000),
    } });
    const restarted = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    const revoke = vi.fn(async () => undefined);
    try {
      await sweepQboTokenRevocations({ db: restarted, now: () => new Date(), revoke });
      expect(revoke).toHaveBeenCalledWith({ realmId: company.realmId, refreshToken: company.refreshToken });
      await expect(restarted.qboTokenRevocation.count()).resolves.toBe(0);
    } finally { await restarted.$disconnect(); }
  });

  it('cancels queued revocation atomically with reconnect and preserves replacement tokens', async () => {
    const company = await seed();
    const disconnected = await disconnectCompanyWithLiveAuthority(company.id);
    await prisma.company.update({ where: { id: company.id }, data: {
      disconnectedAt: null, accessToken: 'synthetic-replacement-access', refreshToken: 'synthetic-replacement-refresh',
      qboTokenRevocations: { deleteMany: {} },
    } });
    const revoke = vi.spyOn(qboFactory, 'revokeCapturedQboToken').mockResolvedValue();
    await disconnected.revoke();
    await sweepQboTokenRevocations();
    expect(revoke).not.toHaveBeenCalled();
    await expect(prisma.company.findUniqueOrThrow({ where: { id: company.id } })).resolves.toMatchObject({
      disconnectedAt: null, refreshToken: 'synthetic-replacement-refresh',
    });
  });

  it('never lets late cleanup of a claimed snapshot consume a newer disconnect', async () => {
    const company = await seed();
    const old = await disconnectCompanyWithLiveAuthority(company.id);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const revoke = vi.spyOn(qboFactory, 'revokeCapturedQboToken')
      .mockReturnValueOnce(waiting).mockResolvedValue(undefined);
    const oldAttempt = old.revoke();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    await prisma.company.update({ where: { id: company.id }, data: {
      disconnectedAt: null, refreshToken: 'synthetic-new-generation-refresh',
      qboTokenRevocations: { deleteMany: {} },
    } });
    const latest = await disconnectCompanyWithLiveAuthority(company.id);
    release();
    await oldAttempt;
    await expect(prisma.qboTokenRevocation.count()).resolves.toBe(1);
    expect(revoke.mock.calls[0]?.[0].refreshToken).toBe(company.refreshToken);
    await latest.revoke();
    expect(revoke.mock.calls[1]?.[0].refreshToken).toBe('synthetic-new-generation-refresh');
    await expect(prisma.qboTokenRevocation.count()).resolves.toBe(0);
  });

  it('consumes an ordinary failed best-effort attempt without restoring authority or retrying it', async () => {
    const company = await seed();
    const disconnected = await disconnectCompanyWithLiveAuthority(company.id);
    const revoke = vi.spyOn(qboFactory, 'revokeCapturedQboToken').mockRejectedValue(new Error('Synthetic provider failure'));
    await disconnected.revoke();
    await sweepQboTokenRevocations();
    expect(revoke).toHaveBeenCalledOnce();
    await expect(prisma.qboTokenRevocation.count()).resolves.toBe(0);
    await expect(prisma.company.findUniqueOrThrow({ where: { id: company.id } }))
      .resolves.toMatchObject({ refreshToken: null, accessToken: null });
  });
});
