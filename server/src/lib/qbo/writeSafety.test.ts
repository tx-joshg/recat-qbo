import { describe, expect, it } from 'vitest';
import { assertQboWriteAllowed, type QboWriteSafetyTarget } from './writeSafety.js';

const purchase: QboWriteSafetyTarget = {
  qboType: 'Purchase',
  qboId: 'purchase-1',
  txnDate: '2026-08-01',
  bankAccountQboId: 'bank-1',
};

describe('QuickBooks write safety', () => {
  it('allows a transaction in an open period', () => {
    expect(() => assertQboWriteAllowed(purchase, { bookCloseDate: null })).not.toThrow();
  });

  it.each([
    ['2026-08-01', 'on'],
    ['2026-08-02', 'before'],
  ])('blocks a transaction %s the closing date', (bookCloseDate) => {
    expect(() => assertQboWriteAllowed(purchase, { bookCloseDate }))
      .toThrow(expect.objectContaining({ code: 'QBO_PERIOD_CLOSED' }));
  });

  it('allows the first day after the closing date', () => {
    expect(() => assertQboWriteAllowed(purchase, { bookCloseDate: '2026-07-31' }))
      .not.toThrow();
  });

  describe.each(['Purchase', 'Deposit'] as const)('%s category and tax writes', (qboType) => {
    // Cleared and reconciled status is no longer collected or consulted: a
    // write only redistributes categories, never the reconciled amount.
    it('allows an open-period bank line', () => {
      expect(() => assertQboWriteAllowed({ ...purchase, qboType }, { bookCloseDate: null }))
        .not.toThrow();
    });

    it('still blocks a transaction in closed books', () => {
      expect(() => assertQboWriteAllowed({ ...purchase, qboType }, { bookCloseDate: '2026-08-01' }))
        .toThrow(expect.objectContaining({ code: 'QBO_PERIOD_CLOSED' }));
    });
  });

  it.each([
    [{ ...purchase, txnDate: '08/01/2026' }, { bookCloseDate: null, cleared: false, reconciled: false }],
    [purchase, { bookCloseDate: 'not-a-date', cleared: false, reconciled: false }],
    [{ ...purchase, bankAccountQboId: '' }, { bookCloseDate: null, cleared: false, reconciled: false }],
  ])('fails closed on malformed safety input', (target, evidence) => {
    expect(() => assertQboWriteAllowed(target, evidence))
      .toThrow(expect.objectContaining({ code: 'QBO_WRITE_SAFETY_UNAVAILABLE' }));
  });
});
