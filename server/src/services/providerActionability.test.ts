import { describe, expect, it } from 'vitest';
import {
  assertProviderActionabilityAllowsPrepare,
  assertTransactionProviderActionability,
  dispositionFromWriteSafety,
  effectiveProviderActionabilityCounts,
  effectiveProviderDisposition,
  isFreshProviderActionability,
  persistProviderActionability,
  type ProviderActionabilityDb,
  type ProviderActionabilityObservation,
} from './providerActionability.js';
import { QboWriteSafetyError } from '../lib/qbo/writeSafety.js';

const TXN = {
  id: 'txn-1',
  companyId: 'company-1',
  revision: 4,
  qboSyncToken: '17',
  qboType: 'Purchase',
  qboId: 'qbo-1',
  date: new Date('2026-08-01T00:00:00.000Z'),
} as const;

function evidence(overrides: Partial<{
  bookCloseDate: string | null;
  cleared: boolean;
  reconciled: boolean;
}> = {}) {
  return {
    bookCloseDate: null,
    cleared: false,
    reconciled: false,
    ...overrides,
  };
}

function observation(overrides: Partial<ProviderActionabilityObservation> = {}) {
  return {
    companyId: TXN.companyId,
    transactionId: TXN.id,
    disposition: 'WRITABLE' as const,
    checkedAt: new Date('2026-08-30T18:00:00.000Z'),
    revision: TXN.revision,
    qboSyncToken: TXN.qboSyncToken,
    qboType: TXN.qboType,
    qboId: TXN.qboId,
    txnDate: TXN.date,
    bankAccountQboId: 'bank-1',
    bookCloseDate: null,
    cleared: false,
    reconciled: false,
    unavailableCode: null,
    unavailableReason: null,
    ...overrides,
  };
}

describe('provider actionability', () => {
  it('maps safety evidence by specificity and never changes local TxnStatus', () => {
    expect(dispositionFromWriteSafety({ txnDate: '2026-08-01' }, evidence())).toBe('WRITABLE');
    expect(dispositionFromWriteSafety({ txnDate: '2026-08-01' }, evidence({ cleared: true })))
      .toBe('WRITABLE');
    expect(dispositionFromWriteSafety({ txnDate: '2026-08-01' }, evidence({ reconciled: true })))
      .toBe('WRITABLE');
    expect(dispositionFromWriteSafety(
      { txnDate: '2026-08-01' },
      evidence({ bookCloseDate: '2026-08-15', cleared: true, reconciled: true }),
    )).toBe('BLOCKED_PERIOD_CLOSED');
  });

  it('fails closed when evidence is missing, stale, or bound to another mirror', () => {
    const now = new Date('2026-08-30T18:15:00.000Z');
    expect(effectiveProviderDisposition(null, TXN, now)).toBe('UNKNOWN');
    expect(effectiveProviderDisposition(
      observation({ checkedAt: new Date('2026-08-30T17:59:59.000Z') }),
      TXN,
      now,
      15 * 60 * 1000,
    )).toBe('UNKNOWN');
    expect(isFreshProviderActionability(
      observation({ qboSyncToken: '18' }),
      TXN,
      now,
    )).toBe(false);
    expect(isFreshProviderActionability(
      observation({ checkedAt: now }),
      TXN,
      now,
    )).toBe(true);
  });

  it('reinterprets legacy cleared/reconciled locks as writable while retaining binding checks', () => {
    const now = new Date('2026-08-30T18:15:00.000Z');
    const stale = new Date('2026-08-30T17:59:59.000Z');

    expect(effectiveProviderDisposition(
      observation({ disposition: 'WRITABLE', checkedAt: stale }),
      TXN,
      now,
      15 * 60 * 1000,
    )).toBe('UNKNOWN');
    expect(effectiveProviderDisposition(
      observation({ disposition: 'BLOCKED_RECONCILED', checkedAt: stale }),
      TXN,
      now,
      15 * 60 * 1000,
    )).toBe('WRITABLE');
    expect(effectiveProviderDisposition(
      observation({ disposition: 'BLOCKED_PERIOD_CLOSED', checkedAt: stale }),
      TXN,
      now,
      15 * 60 * 1000,
    )).toBe('UNKNOWN');
    expect(effectiveProviderDisposition(
      observation({
        disposition: 'BLOCKED_RECONCILED',
        checkedAt: new Date('2026-08-28T18:14:59.999Z'),
      }),
      TXN,
      now,
      15 * 60 * 1000,
    )).toBe('WRITABLE');
    expect(effectiveProviderDisposition(
      observation({
        disposition: 'BLOCKED_CLEARED',
        checkedAt: stale,
        qboSyncToken: 'different-binding',
      }),
      TXN,
      now,
      15 * 60 * 1000,
    )).toBe('UNKNOWN');
  });

  it('allows legacy cleared/reconciled observations but rejects closed or unknown prepares', () => {
    const now = new Date('2026-08-30T18:00:00.000Z');
    expect(() => assertProviderActionabilityAllowsPrepare(
      observation({ disposition: 'BLOCKED_PERIOD_CLOSED' }),
      TXN,
      now,
    )).toThrowError(new QboWriteSafetyError('QBO_PERIOD_CLOSED'));
    expect(() => assertProviderActionabilityAllowsPrepare(
      observation({ disposition: 'BLOCKED_CLEARED' }),
      TXN,
      now,
    )).not.toThrow();
    expect(() => assertProviderActionabilityAllowsPrepare(
      observation({ disposition: 'BLOCKED_RECONCILED' }),
      TXN,
      now,
    )).not.toThrow();
    expect(() => assertProviderActionabilityAllowsPrepare(null, TXN, now))
      .toThrowError(new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE'));
  });

  it('uses one full-binding effective definition for actionable, blocked, and unknown counts', () => {
    const now = new Date('2026-08-30T18:00:00.000Z');
    const rows = [
      { ...TXN, providerActionability: observation({ checkedAt: now }) },
      {
        ...TXN,
        id: 'txn-2',
        qboId: 'qbo-2',
        providerActionability: observation({
          transactionId: 'txn-2',
          qboId: 'qbo-2',
          disposition: 'BLOCKED_CLEARED',
          checkedAt: now,
        }),
      },
      {
        ...TXN,
        id: 'txn-3',
        qboId: 'qbo-3',
        providerActionability: observation({
          transactionId: 'txn-3',
          qboId: 'stale-qbo-id',
          disposition: 'BLOCKED_RECONCILED',
          checkedAt: now,
        }),
      },
    ];
    expect(effectiveProviderActionabilityCounts(rows, now)).toEqual({
      total: 3,
      actionable: 2,
      blocked: 0,
      unknown: 1,
    });
  });

  it('gates a transaction by its current joined cache binding', async () => {
    const now = new Date('2026-08-30T18:00:00.000Z');
    const db = {
      transaction: { findFirst: async () => ({ ...TXN }) },
      transactionActionability: {
        findUnique: async () => observation({ disposition: 'BLOCKED_RECONCILED', checkedAt: now }),
      },
    } as ProviderActionabilityDb;
    await expect(assertTransactionProviderActionability(
      TXN.companyId,
      TXN.id,
      db,
      now,
    )).resolves.toBeUndefined();
  });

  it('persists only when the transaction and actionability bindings still match (bounded CAS)', async () => {
    let actionability: ProviderActionabilityObservation | null = null;
    const updates: Array<Record<string, unknown>> = [];
    const db: ProviderActionabilityDb = {
      transaction: {
        findFirst: async () => ({ ...TXN }),
      },
      transactionActionability: {
        findUnique: async () => actionability,
        findMany: async () => actionability ? [actionability] : [],
        count: async () => actionability ? 1 : 0,
        updateMany: async ({ where, data }) => {
          updates.push({ where, data });
          if (!actionability) return { count: 0 };
          const exact = where.revision === actionability.revision
            && where.qboSyncToken === actionability.qboSyncToken
            && where.qboId === actionability.qboId;
          if (exact) {
            actionability = { ...actionability, ...(data as Partial<ProviderActionabilityObservation>) };
            return { count: 1 };
          }
          return { count: 0 };
        },
        upsert: async () => {
          throw new Error('upsert must not be used for an existing CAS row');
        },
        create: async ({ data }) => {
          actionability = data as ProviderActionabilityObservation;
          return actionability;
        },
      },
    };

    actionability = observation();
    await expect(persistProviderActionability({
      ...TXN,
      checkedAt: new Date('2026-08-30T18:14:00.000Z'),
      evidence: evidence({ cleared: true }),
    }, db)).resolves.toBe(true);
    expect(updates[0]?.where).toMatchObject({
      transactionId: TXN.id,
      companyId: TXN.companyId,
      revision: TXN.revision,
      qboSyncToken: TXN.qboSyncToken,
      qboType: TXN.qboType,
      qboId: TXN.qboId,
      transaction: {
        is: {
          companyId: TXN.companyId,
          revision: TXN.revision,
          qboSyncToken: TXN.qboSyncToken,
          qboType: TXN.qboType,
          qboId: TXN.qboId,
          date: TXN.date,
        },
      },
    });
    expect(actionability?.disposition).toBe('WRITABLE');

    actionability = observation({ revision: TXN.revision + 1, qboSyncToken: '18' });
    await expect(persistProviderActionability({ ...TXN, evidence: evidence() }, db)).resolves.toBe(false);
    expect(actionability.disposition).toBe('WRITABLE');
  });
});

it('reports missing or foreign transactions as not found rather than a provider outage', async () => {
  const db = {
    transaction: { findFirst: async () => null },
    transactionActionability: { findUnique: async () => { throw new Error('Must not read an unowned observation'); } },
  } as unknown as ProviderActionabilityDb;
  await expect(assertTransactionProviderActionability('company-1', 'missing-fixture', db))
    .rejects.toMatchObject({ status: 404, code: 'TRANSACTION_NOT_FOUND' });
});
