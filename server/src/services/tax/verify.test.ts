import { describe, expect, it } from 'vitest';
import type { QboTxn } from '../../lib/qbo/types.js';
import type { RawPurchase } from '../../lib/qbo/real.js';
import {
  buildPurchaseRestore,
  canonicalHash,
  type QboPurchaseExpectedState,
} from '../../lib/qbo/purchaseTax.js';
import { verifyPurchaseRestore, verifyPurchaseResult } from './verify.js';

const untouched = {
  Id: 'old-line',
  Amount: 50,
  DetailType: 'AccountBasedExpenseLineDetail',
  Description: 'preserve',
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: 'existing' },
    TaxCodeRef: { value: 'oos' },
  },
};

function expected(): QboPurchaseExpectedState {
  return {
    qboId: 'p1',
    totalAmtCents: 15000,
    fundingAccountQboId: 'bank',
    currencyQboId: 'CAD',
    txnDate: '2026-07-23',
    credit: false,
    taxCalculation: 'TaxInclusive',
    targetLines: [
      {
        accountQboId: 'expense',
        taxCodeQboId: 'gst',
        grossCents: 10000,
        netCents: 9524,
        taxCents: 476,
      },
    ],
    untouchedLineHashes: [canonicalHash(untouched)],
  };
}

function after(overrides: Partial<RawPurchase> = {}): QboTxn {
  const raw: RawPurchase = {
    Id: 'p1',
    SyncToken: '2',
    TxnDate: '2026-07-23',
    TotalAmt: 150,
    Credit: false,
    AccountRef: { value: 'bank' },
    CurrencyRef: { value: 'CAD' },
    GlobalTaxCalculation: 'TaxInclusive',
    TxnTaxDetail: { TotalTax: 4.76 },
    Line: [
      structuredClone(untouched),
      {
        Id: 'new-line',
        Amount: 95.24,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'expense' },
          TaxCodeRef: { value: 'gst' },
          TaxInclusiveAmt: 100,
        },
      },
    ],
    ...overrides,
  };
  return {
    qboId: 'p1',
    qboType: 'Purchase',
    syncToken: '2',
    date: raw.TxnDate!,
    payee: 'Vendor',
    amount: 0,
    bankAccount: 'Bank',
    lines: [],
    raw,
  };
}

describe('verifyPurchaseResult', () => {
  it('accepts a semantically matching read-back', () => {
    expect(verifyPurchaseResult(expected(), after())).toMatchObject({
      ok: true,
      details: { matchedTargetLines: 1, returnedTotalTaxCents: 476 },
    });
  });

  it.each([
    [{ TotalAmt: 149.99 }, 'TAX_GROSS_MISMATCH'],
    [{ AccountRef: { value: 'other-bank' } }, 'QBO_STATE_DRIFT'],
    [{ GlobalTaxCalculation: 'TaxExcluded' as const }, 'QBO_STATE_DRIFT'],
    [{ TxnTaxDetail: { TotalTax: 1 } }, 'QBO_STATE_DRIFT'],
  ])('rejects invariant drift %#', (overrides, code) => {
    expect(verifyPurchaseResult(expected(), after(overrides))).toMatchObject({ ok: false, code });
  });

  it('rejects a wrong destination account or missing TaxCode', () => {
    const raw = after().raw as RawPurchase;
    raw.Line![1]!.AccountBasedExpenseLineDetail!.AccountRef = { value: 'wrong' };
    raw.Line![1]!.AccountBasedExpenseLineDetail!.TaxCodeRef = undefined;
    expect(verifyPurchaseResult(expected(), after(raw))).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it('rejects changed or missing unrelated lines', () => {
    const raw = after().raw as RawPurchase;
    raw.Line![0]!.Description = 'changed';
    expect(verifyPurchaseResult(expected(), after(raw))).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it('rejects net plus tax that does not reconcile to gross', () => {
    const exp = expected();
    exp.targetLines[0]!.netCents = 9523;
    const raw = after().raw as RawPurchase;
    raw.Line![1]!.Amount = 95.23;
    expect(verifyPurchaseResult(exp, after(raw))).toMatchObject({
      ok: false,
      code: 'TAX_GROSS_MISMATCH',
    });
  });
});

describe('verifyPurchaseRestore', () => {
  it('accepts the original canonical accounting state with a new SyncToken', () => {
    const original = after().raw as RawPurchase;
    const restore = buildPurchaseRestore(after({ SyncToken: '9' }), original, 'undo-1');
    const restored = after({ ...restore.body, SyncToken: '10' });
    expect(restore.operation).toBe('restore');
    if (restore.operation !== 'restore') throw new Error('wrong operation');
    expect(verifyPurchaseRestore(restore.expected, restored)).toMatchObject({ ok: true });
  });

  it('rejects an undo that restores the account but not the original TaxCode', () => {
    const original = after().raw as RawPurchase;
    const restore = buildPurchaseRestore(after({ SyncToken: '9' }), original, 'undo-1');
    if (restore.operation !== 'restore') throw new Error('wrong operation');
    const restored = after({ ...restore.body, SyncToken: '10' });
    (restored.raw as RawPurchase).Line![1]!.AccountBasedExpenseLineDetail!.TaxCodeRef = { value: 'wrong' };
    expect(verifyPurchaseRestore(restore.expected, restored)).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });
});
