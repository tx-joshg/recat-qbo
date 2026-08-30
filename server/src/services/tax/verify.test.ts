import { describe, expect, it } from 'vitest';
import {
  canonicalDepositLineHash,
  canonicalPurchaseLineHash,
  verifyDepositResult,
  verifyPreparedResult,
  verifyPurchaseResult,
  type ExpectedDepositResult,
  type ExpectedPurchaseResult,
} from './verify.js';
import type {
  QboDepositPreparedWrite,
  QboDepositSnapshot,
  QboPreparedWrite,
  QboPurchasePreparedWrite,
} from '../../lib/qbo/types.js';

const targetLine = {
  id: null,
  amountCents: -10_50,
  description: 'Fuel',
  accountQboId: 'expense',
  customerQboId: 'customer-1',
  classQboId: 'class-1',
  taxCodeQboId: 'GST5',
  taxAmountCents: -50,
  taxInclusiveCents: -10_50,
};

const untouchedLine = {
  id: 'untouched-1',
  amountCents: 10_50,
  description: 'Payment',
  accountQboId: 'bank',
  customerQboId: null,
  classQboId: 'class-2',
  taxCodeQboId: null,
  taxAmountCents: 0,
  taxInclusiveCents: null,
};

const expected: ExpectedPurchaseResult = {
  qboId: 'purchase-1',
  totalCents: -10_50,
  accountQboId: 'bank',
  date: '2026-07-27',
  direction: 'purchase',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: -50,
  targetLines: [targetLine],
  untouchedLineHashes: [canonicalPurchaseLineHash(untouchedLine)],
};

const actual = {
  qboId: 'purchase-1',
  syncToken: '1',
  totalCents: -10_50,
  accountQboId: 'bank',
  date: '2026-07-27',
  direction: 'purchase' as const,
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: -50,
  lines: [{ ...targetLine, id: 'new-target' }, untouchedLine],
};

describe('verifyPurchaseResult', () => {
  it('accepts the expected Purchase target and untouched-line state', () => {
    expect(verifyPurchaseResult(expected, actual)).toEqual({ ok: true });
  });

  it('accepts QBO non-taxable null/default normalization without accepting tax drift', () => {
    const nonTaxableTarget = {
      ...targetLine,
      taxCodeQboId: null,
      taxAmountCents: null,
      taxInclusiveCents: null,
    };
    const nonTaxableExpected: ExpectedPurchaseResult = {
      ...expected,
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      targetLines: [nonTaxableTarget],
      untouchedLineHashes: [],
    };
    const normalizedByQbo = {
      ...actual,
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: null,
      lines: [{
        ...nonTaxableTarget,
        id: 'provider-assigned-target',
        taxCodeQboId: 'PROVIDER_DEFAULT_NON_TAX',
      }],
    };

    expect(verifyPurchaseResult(nonTaxableExpected, normalizedByQbo))
      .toEqual({ ok: true });
    expect(verifyPurchaseResult(nonTaxableExpected, {
      ...normalizedByQbo,
      totalTaxCents: -1,
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyPurchaseResult({
      ...nonTaxableExpected,
      totalTaxCents: -1,
    }, {
      ...normalizedByQbo,
      totalTaxCents: -1,
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyPurchaseResult(nonTaxableExpected, {
      ...normalizedByQbo,
      lines: [{ ...normalizedByQbo.lines[0], taxAmountCents: -1 }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('requires the exact literal tax code for preserve-current Purchase verification', () => {
    const preservedTarget = {
      ...targetLine,
      id: 'preserved-target',
      taxCodeQboId: 'NON',
      taxAmountCents: null,
      taxInclusiveCents: null,
      rawHash: 'exact-target-line',
      categoryOnlyHash: 'category-only-line',
    };
    const preservedExpected: ExpectedPurchaseResult = {
      ...expected,
      taxDisposition: 'preserve_current',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      preservedHash: 'preserved-top-level',
      targetLines: [preservedTarget],
      untouchedLineHashes: [],
    };
    const preservedActual = {
      ...actual,
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: null,
      preservedHash: 'preserved-top-level',
      lines: [{ ...preservedTarget, rawHash: 'provider-normalized-reference-name' }],
    };

    expect(verifyPurchaseResult(preservedExpected, preservedActual)).toEqual({ ok: true });
    expect(verifyPurchaseResult(preservedExpected, {
      ...preservedActual,
      lines: [{
        ...preservedActual.lines[0]!,
        taxCodeQboId: 'PROVIDER_DEFAULT_NON_TAX',
      }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyPurchaseResult(preservedExpected, {
      ...preservedActual,
      preservedHash: 'changed-top-level',
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyPurchaseResult(preservedExpected, {
      ...preservedActual,
      lines: [{
        ...preservedTarget,
        rawHash: 'changed-custom-field',
        categoryOnlyHash: 'changed-non-category-field',
      }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('accepts omitted redundant tax fields when the inclusive amount proves the exact tax', () => {
    const expectedTarget = {
      ...targetLine,
      amountCents: -10_00,
      taxAmountCents: -50,
      taxInclusiveCents: -10_50,
    };
    const expectedWithDerivedTax = {
      ...expected,
      targetLines: [expectedTarget],
    };
    const qboReadback = {
      ...actual,
      totalTaxCents: null,
      lines: [{
        ...expectedTarget,
        id: 'new-target',
        taxAmountCents: null,
      }, untouchedLine],
    };

    expect(verifyPurchaseResult(expectedWithDerivedTax, qboReadback)).toEqual({ ok: true });
  });

  it('rejects omitted tax fields when the inclusive amount does not prove the expected tax', () => {
    const expectedTarget = {
      ...targetLine,
      amountCents: -10_00,
      taxAmountCents: -50,
      taxInclusiveCents: -10_50,
    };
    const expectedWithDerivedTax = {
      ...expected,
      targetLines: [expectedTarget],
    };
    const qboReadback = {
      ...actual,
      totalTaxCents: null,
      lines: [{
        ...expectedTarget,
        id: 'new-target',
        taxAmountCents: null,
        taxInclusiveCents: -10_49,
      }, untouchedLine],
    };

    expect(verifyPurchaseResult(expectedWithDerivedTax, qboReadback)).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it.each([
    ['Purchase ID', { qboId: 'purchase-2' }],
    ['total', { totalCents: -10_49 }],
    ['account', { accountQboId: 'other-bank' }],
    ['date', { date: '2026-07-28' }],
    ['direction', { direction: 'refund' }],
    ['global tax mode', { globalTaxCalculation: 'TaxExcluded' }],
    ['total tax', { totalTaxCents: -49 }],
  ])('detects %s drift', (_name, changes) => {
    expect(verifyPurchaseResult(expected, { ...actual, ...changes })).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it('detects a changed target Purchase line', () => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [{ ...actual.lines[0], taxInclusiveCents: -10_49 }, actual.lines[1]],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it.each([
    ['customer', { customerQboId: 'customer-2' }],
    ['class', { classQboId: 'class-2' }],
    ['line tax', { taxAmountCents: -49 }],
  ])('detects changed target-line %s detail', (_field, changes) => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [{ ...actual.lines[0], ...changes }, actual.lines[1]],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('detects a changed untouched Purchase line', () => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [actual.lines[0], { ...actual.lines[1], description: 'Changed payment' }],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it.each([
    ['customer', { customerQboId: 'customer-2' }],
    ['class', { classQboId: 'class-3' }],
    ['line tax', { taxAmountCents: 1 }],
  ])('detects changed untouched-line %s detail', (_field, changes) => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [actual.lines[0], { ...actual.lines[1], ...changes }],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('detects missing and extra Purchase lines', () => {
    expect(verifyPurchaseResult(expected, { ...actual, lines: [actual.lines[0]] })).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [...actual.lines, { ...untouchedLine, id: 'extra' }],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('matches duplicate target lines as a multiset', () => {
    const duplicateTargetExpected = { ...expected, targetLines: [targetLine, targetLine] };
    const duplicateTargetActual = {
      ...actual,
      lines: [{ ...targetLine, id: 'new-target-1' }, { ...targetLine, id: 'new-target-2' }, untouchedLine],
    };

    expect(verifyPurchaseResult(duplicateTargetExpected, duplicateTargetActual)).toEqual({ ok: true });
    expect(
      verifyPurchaseResult(duplicateTargetExpected, { ...duplicateTargetActual, lines: duplicateTargetActual.lines.slice(1) }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('matches duplicate untouched lines as a multiset', () => {
    const duplicateUntouchedExpected = {
      ...expected,
      untouchedLineHashes: [canonicalPurchaseLineHash(untouchedLine), canonicalPurchaseLineHash(untouchedLine)],
    };
    const duplicateUntouchedActual = { ...actual, lines: [actual.lines[0], untouchedLine, untouchedLine] };

    expect(verifyPurchaseResult(duplicateUntouchedExpected, duplicateUntouchedActual)).toEqual({ ok: true });
    expect(
      verifyPurchaseResult(duplicateUntouchedExpected, { ...duplicateUntouchedActual, lines: duplicateUntouchedActual.lines.slice(0, 2) }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('hashes semantically identical lines consistently regardless of property insertion order', () => {
    const reorderedLine = {
      taxInclusiveCents: untouchedLine.taxInclusiveCents,
      taxAmountCents: untouchedLine.taxAmountCents,
      taxCodeQboId: untouchedLine.taxCodeQboId,
      classQboId: untouchedLine.classQboId,
      customerQboId: untouchedLine.customerQboId,
      accountQboId: untouchedLine.accountQboId,
      description: untouchedLine.description,
      amountCents: untouchedLine.amountCents,
      id: untouchedLine.id,
    };

    expect(canonicalPurchaseLineHash(reorderedLine)).toBe(canonicalPurchaseLineHash(untouchedLine));
  });
});

const depositTargetLine = {
  id: null,
  amountCents: 10_700,
  description: 'Generic sale',
  accountQboId: 'income',
  entityQboId: 'payer',
  paymentMethodQboId: 'payment-method',
  classQboId: 'class',
  taxCodeQboId: 'sales-code',
  taxApplicableOn: 'Sales',
};

const depositUntouchedLine = {
  id: 'untouched',
  amountCents: 5_000,
  description: 'Generic untouched line',
  accountQboId: 'other-income',
  entityQboId: 'other-payer',
  paymentMethodQboId: 'other-method',
  classQboId: 'other-class',
  taxCodeQboId: null,
  taxApplicableOn: null,
};

const expectedDeposit: ExpectedDepositResult = {
  qboId: 'deposit-generic',
  totalCents: 15_700,
  depositToAccountQboId: 'bank',
  date: '2026-07-28',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: 700,
  targetLines: [depositTargetLine],
  untouchedLineHashes: [canonicalDepositLineHash(depositUntouchedLine)],
};

const actualDeposit: QboDepositSnapshot = {
  qboId: 'deposit-generic',
  syncToken: '8',
  totalCents: 15_700,
  depositToAccountQboId: 'bank',
  date: '2026-07-28',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: 700,
  lines: [
    depositUntouchedLine,
    { ...depositTargetLine, id: 'assigned-target' },
  ],
};

describe('verifyDepositResult', () => {
  it('accepts expected Deposit entity fields and target/untouched multisets', () => {
    expect(verifyDepositResult(expectedDeposit, actualDeposit)).toEqual({ ok: true });
    expect(verifyDepositResult(
      {
        ...expectedDeposit,
        targetLines: [depositTargetLine, depositTargetLine],
        untouchedLineHashes: [
          canonicalDepositLineHash(depositUntouchedLine),
          canonicalDepositLineHash(depositUntouchedLine),
        ],
      },
      {
        ...actualDeposit,
        lines: [
          depositUntouchedLine,
          { ...depositTargetLine, id: 'assigned-target-1' },
          depositUntouchedLine,
          { ...depositTargetLine, id: 'assigned-target-2' },
        ],
      },
    )).toEqual({ ok: true });
  });

  it.each([
    ['Deposit ID', { qboId: 'other-deposit' }],
    ['total', { totalCents: 15_699 }],
    ['deposit account', { depositToAccountQboId: 'other-bank' }],
    ['date', { date: '2026-07-29' }],
    ['global tax mode', { globalTaxCalculation: 'TaxExcluded' }],
    ['total tax', { totalTaxCents: 699 }],
  ])('detects %s drift', (_name, changes) => {
    expect(verifyDepositResult(expectedDeposit, { ...actualDeposit, ...changes })).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it.each([
    ['amount', { amountCents: 10_699 }],
    ['account', { accountQboId: 'other-income' }],
    ['payer', { entityQboId: 'other-payer' }],
    ['payment method', { paymentMethodQboId: 'other-method' }],
    ['class', { classQboId: 'other-class' }],
    ['tax code', { taxCodeQboId: 'other-code' }],
    ['tax applicability', { taxApplicableOn: 'Purchase' }],
  ])('detects changed target-line %s detail', (_field, changes) => {
    expect(verifyDepositResult(expectedDeposit, {
      ...actualDeposit,
      lines: [actualDeposit.lines[0]!, { ...actualDeposit.lines[1]!, ...changes }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('requires a prepared existing Deposit line ID to survive readback', () => {
    const expectedWithId = {
      ...expectedDeposit,
      targetLines: [{ ...depositTargetLine, id: 'holding-line' }],
    };

    expect(verifyDepositResult(expectedWithId, {
      ...actualDeposit,
      lines: [
        actualDeposit.lines[0]!,
        { ...actualDeposit.lines[1]!, id: 'different-line' },
      ],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyDepositResult(expectedWithId, {
      ...actualDeposit,
      lines: [
        actualDeposit.lines[0]!,
        { ...actualDeposit.lines[1]!, id: 'holding-line' },
      ],
    })).toEqual({ ok: true });
  });

  it('detects changed, missing, and extra untouched Deposit lines', () => {
    expect(verifyDepositResult(expectedDeposit, {
      ...actualDeposit,
      lines: [{ ...actualDeposit.lines[0]!, description: 'changed' }, actualDeposit.lines[1]!],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyDepositResult(expectedDeposit, {
      ...actualDeposit,
      lines: [actualDeposit.lines[1]!],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyDepositResult(expectedDeposit, {
      ...actualDeposit,
      lines: [...actualDeposit.lines, { ...depositUntouchedLine, id: 'extra' }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('detects drift in preserved Deposit entity and raw line metadata fingerprints', () => {
    const actualWithFingerprints = {
      ...actualDeposit,
      preservedHash: 'entity-preserved',
      lines: [
        {
          ...depositUntouchedLine,
          rawHash: 'untouched-raw',
          targetHash: 'untouched-target',
        },
        {
          ...depositTargetLine,
          id: 'assigned-target',
          rawHash: 'assigned-target-raw',
          targetHash: 'target-preserved',
        },
      ],
    } as unknown as QboDepositSnapshot;
    const expectedWithFingerprints = {
      ...expectedDeposit,
      preservedHash: 'entity-preserved',
      targetLines: [{
        ...depositTargetLine,
        rawHash: 'target-raw',
        targetHash: 'target-preserved',
      }],
      untouchedLineHashes: [
        canonicalDepositLineHash(actualWithFingerprints.lines[0]!),
      ],
    } as unknown as ExpectedDepositResult;

    expect(verifyDepositResult(
      expectedWithFingerprints,
      actualWithFingerprints,
    )).toEqual({ ok: true });
    expect(verifyDepositResult(
      expectedWithFingerprints,
      { ...actualWithFingerprints, preservedHash: 'entity-drifted' },
    )).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyDepositResult(
      expectedWithFingerprints,
      {
        ...actualWithFingerprints,
        lines: [
          { ...actualWithFingerprints.lines[0]!, rawHash: 'untouched-drifted' },
          actualWithFingerprints.lines[1]!,
        ],
      },
    )).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyDepositResult(
      expectedWithFingerprints,
      {
        ...actualWithFingerprints,
        lines: [
          actualWithFingerprints.lines[0]!,
          { ...actualWithFingerprints.lines[1]!, targetHash: 'target-drifted' },
        ],
      },
    )).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('reserves ID-sensitive untouched lines before matching an ID-agnostic colliding target', () => {
    const collidingTarget = { ...depositUntouchedLine, id: null };
    const collisionExpected: ExpectedDepositResult = {
      ...expectedDeposit,
      targetLines: [collidingTarget],
      untouchedLineHashes: [canonicalDepositLineHash(depositUntouchedLine)],
    };
    const assignedTarget = { ...collidingTarget, id: 'assigned-colliding-target' };
    const collisionActual: QboDepositSnapshot = {
      ...actualDeposit,
      lines: [depositUntouchedLine, assignedTarget],
    };

    expect(verifyDepositResult(collisionExpected, collisionActual)).toEqual({ ok: true });
    expect(verifyDepositResult(collisionExpected, {
      ...collisionActual,
      lines: [depositUntouchedLine],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyDepositResult(collisionExpected, {
      ...collisionActual,
      lines: [...collisionActual.lines, { ...depositUntouchedLine, id: 'extra' }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });
});

describe('verifyPreparedResult', () => {
  const depositPrepared = {
    qboType: 'Deposit',
    expected: expectedDeposit,
  } as QboDepositPreparedWrite;
  const purchasePrepared = {
    qboType: 'Purchase',
    expected,
  } as QboPurchasePreparedWrite;

  it('dispatches each prepared union member to its matching verifier', () => {
    expect(verifyPreparedResult(depositPrepared, actualDeposit)).toEqual({ ok: true });
    expect(verifyPreparedResult(purchasePrepared, actual)).toEqual({ ok: true });
  });

  it('fails closed when the actual snapshot kind does not match the prepared union member', () => {
    expect(verifyPreparedResult(depositPrepared, actual)).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
    expect(verifyPreparedResult(purchasePrepared, actualDeposit)).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it('fails closed on a malformed prepared-write discriminator', () => {
    const malformed = {
      ...depositPrepared,
      qboType: 'JournalEntry',
    } as unknown as QboPreparedWrite;

    expect(verifyPreparedResult(malformed, actualDeposit)).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });
});
