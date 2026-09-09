import { describe, expect, it } from 'vitest';
import type { StagedCategorization } from '@recat/shared';
import { verifyPreparedResult } from '../../services/tax/verify.js';
import {
  mapDepositSnapshot,
  QboDepositPreparationError,
  prepareDepositRecategorization,
  prepareDepositRestore,
} from './depositTax.js';
import {
  QboSyncTokenConflict,
  type QboDepositSnapshot,
  type QboPreparedWrite,
  type RawDeposit,
} from './types.js';

const HOLDING_ACCOUNT = 'holding';
const SALES_TAX_CODE = 'sales-code';

function completeDeposit(overrides: Partial<RawDeposit> = {}): RawDeposit {
  return {
    Id: 'deposit-generic',
    SyncToken: '7',
    TxnDate: '2026-07-28',
    TotalAmt: 157,
    DocNumber: 'generic-doc',
    PrivateNote: 'generic private note',
    DepositToAccountRef: { value: 'bank', name: 'Generic Bank' },
    CurrencyRef: { value: 'CUR', name: 'Generic Currency' },
    ExchangeRate: 1,
    GlobalTaxCalculation: 'TaxInclusive',
    TxnTaxDetail: { TotalTax: 0, TaxLine: [{ generic: true }] },
    status: 'Updated',
    MetaData: { CreateTime: '2026-07-01T00:00:00Z' },
    Line: [
      {
        Id: 'holding-line',
        Amount: 107,
        Description: 'holding description',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: HOLDING_ACCOUNT, name: 'Generic Holding' },
          Entity: { value: 'payer', name: 'Generic Payer' },
          PaymentMethodRef: { value: 'payment-method', name: 'Generic Method' },
          ClassRef: { value: 'class', name: 'Generic Class' },
        },
      },
      {
        Id: 'untouched',
        Amount: 50,
        Description: 'untouched description',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'other-income', name: 'Generic Existing Income' },
          Entity: { value: 'other-payer', name: 'Generic Other Payer' },
          PaymentMethodRef: { value: 'other-method', name: 'Generic Other Method' },
          ClassRef: { value: 'other-class', name: 'Generic Other Class' },
          GenericDetailField: 'preserve byte for byte',
        },
        GenericLineField: { preserve: true },
      },
    ],
    ...overrides,
  };
}

function snapshotFor(raw = completeDeposit()): QboDepositSnapshot {
  return mapDepositSnapshot(raw);
}

function staged(
  taxCalculation: StagedCategorization['taxCalculation'] = 'TaxInclusive',
): StagedCategorization {
  return {
    transactionId: '00000000-0000-4000-8000-000000000003',
    revision: 3,
    taxCalculation,
    totals: { subtotalCents: 10_000, taxCents: 700, totalCents: 10_700 },
    lines: [
      {
        idx: 0,
        subtotalCents: 10_000,
        taxCents: 700,
        totalCents: 10_700,
        categoryQboId: 'income',
        taxCodeQboId: SALES_TAX_CODE,
        memo: 'generic sales memo',
      },
    ],
    tagIds: [],
  };
}

function prepare(
  raw = completeDeposit(),
  categorization = staged(),
  before = snapshotFor(raw),
) {
  return prepareDepositRecategorization({
    current: raw,
    holdingAccountQboIds: [HOLDING_ACCOUNT],
    staged: categorization,
    before,
    requestId: 'request-generic',
  });
}

describe('prepareDepositRecategorization', () => {
  it('prepares the synthetic single-line non-taxable GST refund Deposit shape', () => {
    const raw: RawDeposit = {
      Id: 'DEPOSIT_SYNTHETIC_1',
      SyncToken: '0',
      TxnDate: '2024-05-10',
      DepositToAccountRef: { value: 'BANK_CAD', name: 'Example Bank (CAD)' },
      GlobalTaxCalculation: 'TaxInclusive',
      TotalAmt: 1200.45,
      HomeTotalAmt: 1200.45,
      CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
      ExchangeRate: 1,
      PrivateNote: 'Synthetic government refund REF-EXAMPLE-A',
      Line: [{
        Id: '1',
        LineNum: 1,
        Description: 'Synthetic government refund REF-EXAMPLE-A',
        Amount: 1200.45,
        DetailType: 'DepositLineDetail',
        CustomExtensions: [],
        DepositLineDetail: {
          AccountRef: { value: '1', name: 'Uncategorized Income' },
          TaxCodeRef: { value: '5' },
          TaxApplicableOn: 'Sales',
        },
      }],
      TxnTaxDetail: {},
    };
    const before = mapDepositSnapshot(raw);

    const prepared = prepareDepositRecategorization({
      current: raw,
      holdingAccountQboIds: ['1'],
      staged: {
        transactionId: '00000000-0000-4000-8000-000000000001',
        revision: 1,
        taxCalculation: 'TaxInclusive',
        totals: { subtotalCents: 120_045, taxCents: 0, totalCents: 120_045 },
        lines: [{
          idx: 0,
          subtotalCents: 120_045,
          taxCents: 0,
          totalCents: 120_045,
          categoryQboId: 'REFUND_ACCOUNT',
          taxCodeQboId: '5',
          memo: raw.Line![0]!.Description!,
          tagIds: [],
        }],
        tagIds: [],
      },
      before,
      requestId: '00000000-0000-4000-8000-000000000002',
    });

    expect(prepared).toMatchObject({
      qboType: 'Deposit',
      qboId: 'DEPOSIT_SYNTHETIC_1',
      body: {
        SyncToken: '0',
        GlobalTaxCalculation: 'TaxInclusive',
        Line: [{
          Id: '1',
          Amount: 1200.45,
          Description: raw.Line![0]!.Description,
          DepositLineDetail: {
            AccountRef: { value: 'REFUND_ACCOUNT' },
            TaxCodeRef: { value: '5' },
            TaxApplicableOn: 'Sales',
          },
        }],
      },
      expected: {
        totalCents: 120_045,
        totalTaxCents: 0,
        targetLines: [{
          amountCents: 120_045,
          accountQboId: 'REFUND_ACCOUNT',
          taxCodeQboId: '5',
          taxApplicableOn: 'Sales',
        }],
      },
    });
  });

  it('splits one holding Deposit line into reviewed zero-rate lines', () => {
    const raw: RawDeposit = {
      Id: 'DEPOSIT_SYNTHETIC_2',
      SyncToken: '0',
      TxnDate: '2024-05-09',
      DepositToAccountRef: { value: 'BANK_CAD', name: 'Example Bank (CAD)' },
      GlobalTaxCalculation: 'TaxInclusive',
      TotalAmt: 1502.30,
      CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
      ExchangeRate: 1,
      PrivateNote: 'Synthetic government refund REF-EXAMPLE-B',
      Line: [{
        Id: '1',
        LineNum: 1,
        Description: 'Synthetic government refund REF-EXAMPLE-B',
        Amount: 1502.30,
        DetailType: 'DepositLineDetail',
        CustomExtensions: [],
        DepositLineDetail: {
          AccountRef: { value: '1', name: 'Uncategorized Income' },
          TaxCodeRef: { value: '5' },
          TaxApplicableOn: 'Sales',
        },
      }],
      TxnTaxDetail: {},
    };

    const prepared = prepareDepositRecategorization({
      current: raw,
      holdingAccountQboIds: ['1'],
      staged: {
        transactionId: '00000000-0000-4000-8000-000000000003',
        revision: 2,
        taxCalculation: 'TaxInclusive',
        totals: { subtotalCents: 150_230, taxCents: 0, totalCents: 150_230 },
        lines: [
          { idx: 0, subtotalCents: 150_000, taxCents: 0, totalCents: 150_000, categoryQboId: 'REFUND_ACCOUNT', taxCodeQboId: '5', memo: null, tagIds: [] },
          { idx: 1, subtotalCents: 230, taxCents: 0, totalCents: 230, categoryQboId: 'INTEREST_ACCOUNT', taxCodeQboId: '5', memo: null, tagIds: [] },
        ],
        tagIds: [],
      },
      before: mapDepositSnapshot(raw),
      requestId: '00000000-0000-4000-8000-000000000004',
    });

    expect(prepared.body.Line).toMatchObject([
      { Id: '1', Amount: 1500.00, Description: raw.Line![0]!.Description, DepositLineDetail: { AccountRef: { value: 'REFUND_ACCOUNT' }, TaxCodeRef: { value: '5' } } },
      { Amount: 2.30, Description: raw.Line![0]!.Description, DepositLineDetail: { AccountRef: { value: 'INTEREST_ACCOUNT' }, TaxCodeRef: { value: '5' } } },
    ]);
    expect(prepared.body.Line![1]).not.toHaveProperty('Id');
    expect(prepared.expected.targetLines).toHaveLength(2);
  });

  it('preserves a replaced Deposit line description when the proposal memo is null', () => {
    const raw: RawDeposit = {
      Id: 'DEPOSIT_SYNTHETIC_3',
      SyncToken: '0',
      TxnDate: '2024-05-09',
      DepositToAccountRef: { value: 'BANK_CAD', name: 'Example Bank (CAD)' },
      GlobalTaxCalculation: 'TaxInclusive',
      TotalAmt: 240.68,
      CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
      ExchangeRate: 1,
      PrivateNote: 'Synthetic rebate INV-EXAMPLE-C',
      Line: [{
        Id: '1',
        LineNum: 1,
        Description: 'Synthetic rebate INV-EXAMPLE-C',
        Amount: 240.68,
        DetailType: 'DepositLineDetail',
        CustomExtensions: [],
        DepositLineDetail: {
          AccountRef: { value: '1', name: 'Uncategorized Income' },
          TaxCodeRef: { value: '5' },
          TaxApplicableOn: 'Sales',
        },
      }],
      TxnTaxDetail: {},
    };

    const prepared = prepareDepositRecategorization({
      current: raw,
      holdingAccountQboIds: ['1'],
      staged: {
        transactionId: '00000000-0000-4000-8000-000000000005',
        revision: 1,
        taxCalculation: 'TaxInclusive',
        totals: { subtotalCents: 24_068, taxCents: 0, totalCents: 24_068 },
        lines: [{
          idx: 0,
          subtotalCents: 24_068,
          taxCents: 0,
          totalCents: 24_068,
          categoryQboId: 'REBATE_ACCOUNT',
          taxCodeQboId: '5',
          memo: null,
          tagIds: [],
        }],
        tagIds: [],
      },
      before: mapDepositSnapshot(raw),
      requestId: '00000000-0000-4000-8000-000000000006',
    });

    expect(prepared.body.Line![0]!.Description).toBe(raw.Line![0]!.Description);
    expect(prepared.expected.targetLines[0]!.description).toBe(raw.Line![0]!.Description);
  });

  it('derives zero Deposit tax when QBO omits TotalTax for an explicit zero-rate code', () => {
    const snapshot = mapDepositSnapshot({
      Id: 'DEPOSIT_SYNTHETIC_3',
      SyncToken: '1',
      TxnDate: '2024-05-09',
      DepositToAccountRef: { value: 'BANK_CAD', name: 'Example Bank (CAD)' },
      GlobalTaxCalculation: 'TaxInclusive',
      TotalAmt: 240.68,
      CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
      ExchangeRate: 1,
      PrivateNote: 'Synthetic rebate INV-EXAMPLE-C',
      Line: [{
        Id: '1',
        LineNum: 1,
        Amount: 240.68,
        DetailType: 'DepositLineDetail',
        CustomExtensions: [],
        DepositLineDetail: {
          AccountRef: { value: 'REBATE_ACCOUNT', name: 'Other Income' },
          TaxCodeRef: { value: '5' },
          TaxApplicableOn: 'Sales',
        },
      }],
      TxnTaxDetail: {},
    });

    expect(snapshot.totalTaxCents).toBe(0);
  });

  it.each(['TaxInclusive', 'TaxExcluded'] as const)(
    'derives omitted aggregate tax from net Deposit lines in %s mode',
    (taxCalculation) => {
      const raw = completeDeposit({
        GlobalTaxCalculation: taxCalculation,
        TotalAmt: 164,
        TxnTaxDetail: {},
      });
      raw.Line![0]!.DepositLineDetail!.TaxCodeRef = { value: SALES_TAX_CODE };

      expect(mapDepositSnapshot(raw).totalTaxCents).toBe(700);
    },
  );

  it('keeps explicit aggregate tax authoritative and absent tax mode unknown', () => {
    const raw = completeDeposit({ TotalAmt: 164, TxnTaxDetail: { TotalTax: 5 } });
    expect(mapDepositSnapshot(raw).totalTaxCents).toBe(500);

    raw.TxnTaxDetail = {};
    delete raw.GlobalTaxCalculation;
    expect(mapDepositSnapshot(raw).totalTaxCents).toBeNull();
  });

  it('fingerprints preserved entity metadata and exact raw line fields', () => {
    const raw = completeDeposit();
    const baseline = mapDepositSnapshot(raw);

    for (const changed of [
      { ...raw, PrivateNote: 'changed private note' },
      { ...raw, CurrencyRef: { value: 'ALT', name: 'Alternate Currency' } },
      { ...raw, ExchangeRate: 1.25 },
      { ...raw, UnknownDepositField: { changed: true } },
    ]) {
      expect(mapDepositSnapshot(changed).preservedHash).not.toBe(
        baseline.preservedHash,
      );
    }
    expect(mapDepositSnapshot({
      ...raw,
      SyncToken: '8',
      HomeTotalAmt: 999,
      status: 'Server updated',
      MetaData: { LastUpdatedTime: '2026-07-29T00:00:00Z' },
    }).preservedHash).toBe(baseline.preservedHash);

    const changedUntouched = structuredClone(raw);
    changedUntouched.Line![1]!.GenericLineField = { changed: true };
    expect(mapDepositSnapshot(changedUntouched).lines[1]!.rawHash).not.toBe(
      baseline.lines[1]!.rawHash,
    );

    const assignedTarget = structuredClone(raw);
    assignedTarget.Line![0]!.Id = 'qbo-assigned-id';
    assignedTarget.Line![0]!.LineNum = 7;
    assignedTarget.Line![0]!.ResponseOnlyField = 'qbo enrichment';
    assignedTarget.Line![0]!.DepositLineDetail!.AccountRef!.name =
      'Enriched holding account';
    assignedTarget.Line![0]!.DepositLineDetail!.Entity!.name =
      'Enriched payer';
    const assignedSnapshot = mapDepositSnapshot(assignedTarget);
    expect(assignedSnapshot.lines[0]!.targetHash).toBe(
      baseline.lines[0]!.targetHash,
    );
    expect(assignedSnapshot.lines[0]!.rawHash).not.toBe(
      baseline.lines[0]!.rawHash,
    );

    assignedTarget.Line![0]!.DepositLineDetail!.Entity!.value =
      'different-payer';
    expect(mapDepositSnapshot(assignedTarget).lines[0]!.targetHash).not.toBe(
      baseline.lines[0]!.targetHash,
    );
  });

  it('prepares an exact tax-inclusive Deposit body while preserving raw and modeled fields', () => {
    const raw = completeDeposit({ HomeTotalAmt: 157 });
    const prepared = prepare(raw);
    const {
      TxnTaxDetail: _staleTax,
      HomeTotalAmt: _homeTotal,
      status: _cdcStatus,
      ...writeable
    } = raw;

    expect(prepared).toMatchObject({
      qboType: 'Deposit',
      operation: 'recategorize',
      qboId: 'deposit-generic',
      requestId: 'request-generic',
      before: snapshotFor(raw),
      expected: {
        qboId: 'deposit-generic',
        totalCents: 15_700,
        depositToAccountQboId: 'bank',
        date: '2026-07-28',
        globalTaxCalculation: 'TaxInclusive',
        totalTaxCents: 700,
        targetLines: [{
          id: 'holding-line',
          amountCents: 10_000,
          description: 'generic sales memo',
          accountQboId: 'income',
          entityQboId: 'payer',
          paymentMethodQboId: 'payment-method',
          classQboId: 'class',
          taxCodeQboId: SALES_TAX_CODE,
          taxApplicableOn: 'Sales',
        }],
      },
    });
    expect(prepared.body).toEqual({
      ...writeable,
      SyncToken: '7',
      GlobalTaxCalculation: 'TaxInclusive',
      Line: [
        raw.Line![1],
        {
          Id: 'holding-line',
          Amount: 100,
          DetailType: 'DepositLineDetail',
          Description: 'generic sales memo',
          DepositLineDetail: {
            AccountRef: { value: 'income' },
            Entity: raw.Line![0]!.DepositLineDetail!.Entity,
            PaymentMethodRef: raw.Line![0]!.DepositLineDetail!.PaymentMethodRef,
            ClassRef: raw.Line![0]!.DepositLineDetail!.ClassRef,
            TaxCodeRef: { value: SALES_TAX_CODE },
            TaxApplicableOn: 'Sales',
          },
        },
      ],
    });
    expect(prepared.body.Line![0]).toEqual(raw.Line![1]);
    expect(JSON.stringify(prepared.body.Line![0])).toBe(JSON.stringify(raw.Line![1]));
    expect(prepared.body.DepositToAccountRef).toEqual(raw.DepositToAccountRef);
    expect(prepared.body.CurrencyRef).toEqual(raw.CurrencyRef);
    expect(prepared.body).not.toHaveProperty('TxnTaxDetail');
    expect(prepared.body).not.toHaveProperty('HomeTotalAmt');
    expect(prepared.body).not.toHaveProperty('status');
    expect(prepared.body.Line![1]!.DepositLineDetail).not.toHaveProperty('TaxAmount');
    expect(prepared.body.Line![1]!.DepositLineDetail).not.toHaveProperty('TaxInclusiveAmt');
    expect(prepared.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.body)).toBe(true);
  });

  it('uses net Amount for tax-exclusive lines without Purchase-only tax fields', () => {
    const raw = completeDeposit({ GlobalTaxCalculation: 'TaxExcluded' });
    const prepared = prepare(raw, staged('TaxExcluded'), {
      ...snapshotFor(raw),
      globalTaxCalculation: 'TaxExcluded',
    });

    expect(prepared.body.Line![1]).toEqual({
      Id: 'holding-line',
      Amount: 100,
      DetailType: 'DepositLineDetail',
      Description: 'generic sales memo',
      DepositLineDetail: {
        AccountRef: { value: 'income' },
        Entity: raw.Line![0]!.DepositLineDetail!.Entity,
        PaymentMethodRef: raw.Line![0]!.DepositLineDetail!.PaymentMethodRef,
        ClassRef: raw.Line![0]!.DepositLineDetail!.ClassRef,
        TaxCodeRef: { value: SALES_TAX_CODE },
        TaxApplicableOn: 'Sales',
      },
    });
    expect(prepared.expected.targetLines[0]).toMatchObject({
      amountCents: 10_000,
      taxCodeQboId: SALES_TAX_CODE,
      taxApplicableOn: 'Sales',
    });
    expect(prepared.body.Line![1]!.DepositLineDetail).not.toHaveProperty('TaxAmount');
    expect(prepared.body.Line![1]!.DepositLineDetail).not.toHaveProperty('TaxInclusiveAmt');
  });

  it('preserves multiple split ordering and exact positive cents', () => {
    const base = completeDeposit();
    const raw = completeDeposit({
      Line: [
        {
          ...base.Line![0]!,
          Id: 'holding-line-a',
          Amount: 64.2,
        },
        {
          ...base.Line![0]!,
          Id: 'holding-line-b',
          Amount: 42.8,
        },
        base.Line![1]!,
      ],
    });
    const splitStage: StagedCategorization = {
      ...staged(),
      totals: { subtotalCents: 10_000, taxCents: 700, totalCents: 10_700 },
      lines: [
        {
          ...staged().lines[0]!,
          subtotalCents: 6_000,
          taxCents: 420,
          totalCents: 6_420,
          memo: null,
        },
        {
          ...staged().lines[0]!,
          idx: 1,
          subtotalCents: 4_000,
          taxCents: 280,
          totalCents: 4_280,
          categoryQboId: 'income-second',
          memo: 'generic second memo',
        },
      ],
    };

    expect(prepare(raw, splitStage).body.Line!.slice(1).map((line) => ({
      id: line.Id ?? null,
      amount: line.Amount,
    }))).toEqual([
      { id: 'holding-line-a', amount: 60 },
      { id: 'holding-line-b', amount: 40 },
    ]);
  });

  it('rejects replacing more holding lines than the staged result can update in place', () => {
    const base = completeDeposit();
    const raw = completeDeposit({
      Line: [
        {
          ...base.Line![0]!,
          Id: 'holding-line-a',
          Amount: 50,
        },
        {
          ...base.Line![0]!,
          Id: 'holding-line-b',
          Amount: 57,
        },
        base.Line![1]!,
      ],
    });

    expect(() => prepare(raw, staged(), snapshotFor(raw))).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }),
    );
  });

  it('rejects expanding multiple holding lines beyond the existing in-place shape', () => {
    const splitStage: StagedCategorization = {
      ...staged(),
      lines: [
        {
          ...staged().lines[0]!,
          subtotalCents: 6_000,
          taxCents: 420,
          totalCents: 6_420,
        },
        {
          ...staged().lines[0]!,
          idx: 1,
          subtotalCents: 4_000,
          taxCents: 280,
          totalCents: 4_280,
          categoryQboId: 'income-second',
        },
        {
          ...staged().lines[0]!,
          idx: 2,
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
          categoryQboId: 'income-third',
        },
      ],
    };

    const base = completeDeposit();
    const raw = completeDeposit({
      Line: [
        { ...base.Line![0]!, Id: 'holding-line-a', Amount: 64.2 },
        { ...base.Line![0]!, Id: 'holding-line-b', Amount: 42.8 },
        base.Line![1]!,
      ],
    });

    expect(() => prepare(raw, splitStage)).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }),
    );
  });

  it.each([
    ['non-empty CustomExtensions', { CustomExtensions: [{ DefinitionId: 'generic-extension' }] }],
    ['non-array CustomExtensions', { CustomExtensions: 'generic-extension' }],
    ['LinkedTxn', { LinkedTxn: [{ TxnId: 'payment-generic', TxnType: 'Payment' }] }],
    ['unknown top-level field', { GenericLineField: 'semantic data' }],
    ['CheckNum', { DepositLineDetail: { CheckNum: 'CHECK-GENERIC' } }],
    ['TxnType', { DepositLineDetail: { TxnType: 'Payment' } }],
    ['unknown detail field', { DepositLineDetail: { GenericDetailField: 'semantic data' } }],
  ])('rejects a holding line with unsupported %s before rebuilding it', (_label, extra) => {
    const raw = completeDeposit();
    const holdingLine = raw.Line![0]!;
    Object.assign(holdingLine, extra);
    if (extra.DepositLineDetail !== undefined) {
      holdingLine.DepositLineDetail = {
        ...completeDeposit().Line![0]!.DepositLineDetail,
        ...extra.DepositLineDetail,
      };
    }

    expect(() => prepare(raw, staged(), snapshotFor(raw))).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({
        code: 'QBO_DEPOSIT_UNSUPPORTED',
      }),
    );
  });

  it('does not carry a stale aggregate tax into non-tax-bearing untouched lines', () => {
    const raw = completeDeposit({ TxnTaxDetail: { TotalTax: 3 } });
    const before = { ...snapshotFor(raw), totalTaxCents: 300 };

    expect(prepare(raw, staged(), before).expected.totalTaxCents).toBe(700);
  });

  it('proves a zero-value untouched line contributes no tax despite retained QBO tax metadata', () => {
    const base = completeDeposit();
    const raw = completeDeposit({
      TotalAmt: 107,
      Line: [
        {
          ...base.Line![0]!,
          DepositLineDetail: {
            ...base.Line![0]!.DepositLineDetail,
            TaxCodeRef: { value: SALES_TAX_CODE },
            TaxApplicableOn: 'Sales',
          },
        },
        {
          ...base.Line![1]!,
          Amount: 0,
          DepositLineDetail: {
            ...base.Line![1]!.DepositLineDetail,
            TaxCodeRef: { value: SALES_TAX_CODE },
            TaxApplicableOn: 'Sales',
          },
        },
      ],
    });

    const prepared = prepare(raw, staged(), snapshotFor(raw));

    expect(prepared.expected.totalTaxCents).toBe(700);
    expect(prepared.body.Line![0]).toEqual(raw.Line![1]);
    expect(prepared.body.Line![1]).toMatchObject({
      Id: 'holding-line',
      Amount: 100,
    });
  });

  it('rejects malformed present payer, payment method, and class references', () => {
    for (const malformedDetail of [
      { Entity: {} },
      { PaymentMethodRef: { value: '' } },
      { ClassRef: null },
    ]) {
      const raw = completeDeposit();
      raw.Line![0] = {
        ...raw.Line![0]!,
        DepositLineDetail: {
          ...raw.Line![0]!.DepositLineDetail,
          ...malformedDetail,
        },
      };
      const before = snapshotFor(raw);
      const detail = raw.Line![0]!.DepositLineDetail as Record<string, unknown>;
      before.lines[0] = {
        ...before.lines[0]!,
        entityQboId:
          ((detail.Entity as { value?: string } | null)?.value ?? null),
        paymentMethodQboId:
          ((detail.PaymentMethodRef as { value?: string } | null)?.value ?? null),
        classQboId:
          ((detail.ClassRef as { value?: string } | null)?.value ?? null),
      };

      expect(() => prepare(raw, staged(), before)).toThrowError(
        expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_REFERENCE_MISSING' }),
      );
    }
  });

  it('rejects invalid or unsupported QBO reference fields', () => {
    const malformed = completeDeposit();
    (malformed.Line![0]!.DepositLineDetail!.Entity as Record<string, unknown>).name = 42;

    expect(() => prepare(malformed, staged(), snapshotFor(malformed))).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_REFERENCE_MISSING' }),
    );

    for (const field of [
      'AccountRef',
      'Entity',
      'PaymentMethodRef',
      'ClassRef',
      'TaxCodeRef',
    ] as const) {
      const unsupported = completeDeposit();
      const detail = unsupported.Line![0]!.DepositLineDetail!;
      const reference = field === 'TaxCodeRef'
        ? (detail.TaxCodeRef = { value: SALES_TAX_CODE })
        : detail[field]!;
      (reference as Record<string, unknown>).GenericRefField = 'semantic data';

      expect(() => prepare(unsupported, staged(), snapshotFor(unsupported))).toThrowError(
        expect.objectContaining<QboDepositPreparationError>({
          code: 'QBO_DEPOSIT_UNSUPPORTED',
        }),
      );
    }
  });

  it('rejects unsupported shapes, missing references, mixed untouched tax mode, unsafe cents, balance drift, and stale tokens', () => {
    expect(() => prepare(completeDeposit({ Line: undefined }))).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }),
    );
    const wrongDetailType = completeDeposit();
    wrongDetailType.Line![0] = { ...wrongDetailType.Line![0]!, DetailType: 'UnsupportedDetail' };
    expect(() => prepare(wrongDetailType)).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }),
    );
    const missingBank = completeDeposit({ DepositToAccountRef: undefined });
    expect(() => prepare(
      missingBank,
      staged(),
      { ...snapshotFor(missingBank), depositToAccountQboId: null },
    )).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_REFERENCE_MISSING' }),
    );
    expect(() => prepare(completeDeposit(), {
      ...staged(),
      lines: [{ ...staged().lines[0]!, taxCodeQboId: null }],
    })).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_REFERENCE_MISSING' }),
    );
    expect(() => prepare(completeDeposit(), {
      ...staged(),
      lines: [{ ...staged().lines[0]!, subtotalCents: Number.MAX_SAFE_INTEGER }],
    })).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_AMOUNT_UNSAFE' }),
    );
    expect(() => prepare(completeDeposit(), {
      ...staged(),
      totals: { ...staged().totals, totalCents: 10_699 },
    })).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_STATE_DRIFT' }),
    );
    expect(() => prepare(
      completeDeposit({ TotalAmt: 158 }),
      staged(),
      snapshotFor(completeDeposit()),
    )).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_STATE_DRIFT' }),
    );
    expect(() => prepare(
      completeDeposit({ SyncToken: '8' }),
      staged(),
      snapshotFor(completeDeposit()),
    )).toThrowError(QboSyncTokenConflict);

    const mixed = completeDeposit({
      Line: [
        completeDeposit().Line![0]!,
        {
          ...completeDeposit().Line![1]!,
          DepositLineDetail: {
            ...completeDeposit().Line![1]!.DepositLineDetail,
            TaxCodeRef: { value: 'existing-sales-code' },
            TaxApplicableOn: 'Sales',
          },
        },
      ],
    });
    const mixedBefore: QboDepositSnapshot = {
      ...snapshotFor(mixed),
      lines: [
        snapshotFor(mixed).lines[0]!,
        {
          ...snapshotFor(mixed).lines[1]!,
          taxCodeQboId: 'existing-sales-code',
          taxApplicableOn: 'Sales',
        },
      ],
    };
    expect(() => prepare(mixed, staged('TaxExcluded'), mixedBefore)).toThrowError(
      expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }),
    );
  });
});

describe('prepareDepositRestore', () => {
  it.each([
    { taxCents: 0, subtotalCents: 10_700, firstTaxCents: 0, secondNetCents: 4_700, secondTaxCents: 0 },
    { taxCents: 700, subtotalCents: 10_000, firstTaxCents: 420, secondNetCents: 4_000, secondTaxCents: 280 },
  ])('verifies and restores a split with assigned sibling identity and $taxCents omitted tax cents', ({
    taxCents, subtotalCents, firstTaxCents, secondNetCents, secondTaxCents,
  }) => {
    const raw = completeDeposit({
      TotalAmt: 107,
      TxnTaxDetail: {},
      Line: [{
        Id: 'holding-line',
        Amount: 107,
        Description: 'Synthetic source description',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: HOLDING_ACCOUNT } },
      }],
    });
    const taxCodeQboId = taxCents === 0 ? 'sales-zero' : SALES_TAX_CODE;
    const original = prepare(raw, {
      ...staged(),
      totals: { subtotalCents, taxCents, totalCents: 10_700 },
      lines: [{
        idx: 0,
        subtotalCents: 6_000,
        taxCents: firstTaxCents,
        totalCents: 6_000 + firstTaxCents,
        categoryQboId: 'income-first',
        taxCodeQboId,
        memo: null,
      }, {
        idx: 1,
        subtotalCents: secondNetCents,
        taxCents: secondTaxCents,
        totalCents: secondNetCents + secondTaxCents,
        categoryQboId: 'income-second',
        taxCodeQboId,
        memo: null,
      }],
    });
    expect(original.expected.targetLines.map((line) => line.id)).toEqual(['holding-line', null]);

    // Simulate QBO readback: its new sibling gets an identity, both lines get
    // ordinal metadata, and the aggregate tax field is absent.
    const current: RawDeposit = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: {},
      Line: [
        { ...original.body.Line![0]!, LineNum: 1 },
        { ...original.body.Line![1]!, Id: 'qbo-assigned-sibling', LineNum: 2 },
      ],
    };
    const postedSnapshot = mapDepositSnapshot(current);
    expect(postedSnapshot.totalTaxCents).toBe(taxCents);
    expect(verifyPreparedResult(original, postedSnapshot)).toEqual({ ok: true });

    const restore = prepareDepositRestore({
      current,
      prepared: original,
      requestId: 'request-restore-split',
    });
    expect(restore.body.SyncToken).toBe('8');
    expect(restore.body.Line).toEqual(raw.Line);
    expect(restore.expected.targetLines).toHaveLength(1);
    expect(restore.body).not.toHaveProperty('TxnTaxDetail');

    const restoredSnapshot = mapDepositSnapshot({
      ...restore.body,
      SyncToken: '9',
      TxnTaxDetail: {},
    });
    expect(restoredSnapshot.totalTaxCents).toBe(0);
    expect(verifyPreparedResult(restore, restoredSnapshot)).toEqual({ ok: true });
  });

  it('accepts QBO LineNum enrichment through preparation and verified restore', () => {
    const raw = completeDeposit();
    raw.Line![0]!.LineNum = 7;
    const original = prepare(raw, staged(), snapshotFor(raw));
    const current: RawDeposit = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: { TotalTax: 7 },
      Line: [
        original.body.Line![0]!,
        { ...original.body.Line![1]!, LineNum: 7 },
      ],
    };

    expect(prepareDepositRestore({
      current,
      prepared: original,
      requestId: 'request-restore-line-num',
    })).toMatchObject({ operation: 'restore', qboType: 'Deposit' });
  });

  it('restores modeled target fields in exact before order with the fresh SyncToken', () => {
    const original = prepare();
    const current: RawDeposit = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: { TotalTax: 7 },
      Line: [
        original.body.Line![0]!,
        { Id: 'assigned-target', ...original.body.Line![1]! },
      ],
    };

    const restore = prepareDepositRestore({
      current,
      prepared: original,
      requestId: 'request-restore-generic',
    });

    expect(restore).toMatchObject({
      operation: 'restore',
      qboType: 'Deposit',
      qboId: 'deposit-generic',
      requestId: 'request-restore-generic',
      before: mapDepositSnapshot(current),
      expected: {
        globalTaxCalculation: 'TaxInclusive',
        totalTaxCents: 0,
        targetLines: [{
          id: 'holding-line',
          amountCents: 10_700,
          accountQboId: HOLDING_ACCOUNT,
          entityQboId: 'payer',
          paymentMethodQboId: 'payment-method',
          classQboId: 'class',
          taxCodeQboId: null,
          taxApplicableOn: null,
        }],
      },
    });
    expect(restore.body.SyncToken).toBe('8');
    expect(restore.body.Line).toEqual([
      {
        Id: 'holding-line',
        Amount: 107,
        Description: 'holding description',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: HOLDING_ACCOUNT },
          Entity: { value: 'payer' },
          PaymentMethodRef: { value: 'payment-method' },
          ClassRef: { value: 'class' },
        },
      },
      current.Line![0],
    ]);
    expect(restore.body).not.toHaveProperty('TxnTaxDetail');
  });

  it('refuses restore after target drift, untouched drift, unsupported shape, or wrong union member', () => {
    const original = prepare();
    const current: RawDeposit = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: { TotalTax: 7 },
      Line: [
        original.body.Line![0]!,
        { Id: 'assigned-target', ...original.body.Line![1]! },
      ],
    };

    const targetDrift: RawDeposit = {
      ...current,
      Line: [
        current.Line![0]!,
        { ...current.Line![1]!, Amount: 106.99 },
      ],
    };
    expect(() => prepareDepositRestore({
      current: targetDrift,
      prepared: original,
      requestId: 'request-target-drift',
    })).toThrowError(expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_STATE_DRIFT' }));

    const targetIdDrift: RawDeposit = {
      ...current,
      Line: [
        current.Line![0]!,
        { ...current.Line![1]!, Id: 'different-target-line' },
      ],
    };
    expect(() => prepareDepositRestore({
      current: targetIdDrift,
      prepared: original,
      requestId: 'request-target-id-drift',
    })).toThrowError(expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_STATE_DRIFT' }));

    const untouchedDrift: RawDeposit = {
      ...current,
      Line: [
        { ...current.Line![0]!, Description: 'drifted untouched description' },
        current.Line![1]!,
      ],
    };
    expect(() => prepareDepositRestore({
      current: untouchedDrift,
      prepared: original,
      requestId: 'request-untouched-drift',
    })).toThrowError(expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_STATE_DRIFT' }));

    expect(() => prepareDepositRestore({
      current: { ...current, Line: undefined },
      prepared: original,
      requestId: 'request-unsupported',
    })).toThrowError(expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }));

    expect(() => prepareDepositRestore({
      current,
      prepared: { ...original, qboType: 'Purchase' } as unknown as QboPreparedWrite,
      requestId: 'request-wrong-member',
    })).toThrowError(expect.objectContaining<QboDepositPreparationError>({ code: 'QBO_DEPOSIT_UNSUPPORTED' }));
  });
});
