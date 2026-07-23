// Multi-line entity safety (C1): mapping exposes ONLY holding-account lines
// with amount = the holding-line sum, and the write-side rebuild replaces only
// those lines — everything else on the entity survives verbatim.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QboAuthError } from './types.js';
import {
  RealQboClient,
  exchangeAuthCode,
  mapDeposit,
  mapJournalEntry,
  mapPurchase,
  mapTaxCode,
  mapTaxProfile,
  mapTaxRate,
  parseStatementReport,
  parseTransactionListReport,
  rebuildDepositLines,
  rebuildJournalEntryLines,
  rebuildPurchaseLines,
  sumLinesPostingTo,
  type RawDeposit,
  type RawJournalEntry,
  type RawPurchase,
  type RawReport,
  type RawTaxCode,
} from './real.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuth token errors', () => {
  it('uses a typed reason and omits the upstream body from token endpoint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'bad secret SECRET_SENTINEL',
          }),
          { status: 401 },
        ),
      ),
    );

    const error = await exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QboAuthError);
    expect(error).toMatchObject({ reason: 'INVALID_CLIENT_CREDENTIALS' });
    expect((error as Error).message).not.toContain('SECRET_SENTINEL');
  });

  it('maps fetch failures to Intuit unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const error = await exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QboAuthError);
    expect(error).toMatchObject({ reason: 'INTUIT_UNAVAILABLE' });
  });
});

const HOLDING = new Set(['4']);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RealQboClient.verifyConnection', () => {
  it('forces token refresh, persists rotated credentials, then reads Company Info', async () => {
    const events: string[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (input: string | URL | Request) => {
        events.push('refresh');
        expect(String(input)).toContain('/tokens/bearer');
        return new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      })
      .mockImplementationOnce(async (input: string | URL | Request) => {
        events.push('company-info');
        expect(String(input)).toContain('/companyinfo/realm-1');
        return new Response(
          JSON.stringify({ CompanyInfo: { LegalName: 'Example Company' } }),
          { status: 200 },
        );
      });
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.fn(async () => {
      events.push('persist');
    });
    const client = new RealQboClient({
      realmId: 'realm-1',
      environment: 'sandbox',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      holdingAccountQboIds: [],
      // A fresh access token proves verification refreshes intentionally.
      tokens: {
        accessToken: 'still-fresh',
        refreshToken: 'stored-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      onTokensRefreshed: persist,
    });

    await expect(client.verifyConnection()).resolves.toEqual({
      realmId: 'realm-1',
      legalName: 'Example Company',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
      }),
    );
    expect(events).toEqual(['refresh', 'persist', 'company-info']);
  });
});

describe('tax reference mapping', () => {
  it('preserves company-scoped string IDs and ordered purchase rate references', () => {
    const raw: RawTaxCode = {
      Id: 'GST-HST-ON',
      Name: 'HST ON',
      Active: true,
      Taxable: true,
      PurchaseTaxRateList: {
        TaxRateDetail: [
          { TaxRateRef: { value: 'rate-1' }, TaxTypeApplicable: 'TaxOnAmount', TaxOrder: 1 },
          { TaxRateRef: { value: 'rate-2' }, TaxTypeApplicable: 'TaxOnTax', TaxOrder: 2, TaxOnTaxOrder: 1 },
        ],
      },
    };
    expect(mapTaxCode(raw)).toMatchObject({
      qboId: 'GST-HST-ON',
      active: true,
      purchaseTaxRateList: [
        { taxRateQboId: 'rate-1', taxOrder: 1 },
        { taxRateQboId: 'rate-2', taxOrder: 2, taxOnTaxOrder: 1 },
      ],
      salesTaxRateList: [],
    });
  });

  it('distinguishes sales-only, inactive, and out-of-scope codes', () => {
    const salesOnly = mapTaxCode({
      Id: 'sales',
      Name: 'Sales only',
      SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: 'r1' } }] },
    });
    const inactive = mapTaxCode({ Id: 'old', Name: 'Old', Active: false });
    const outOfScope = mapTaxCode({ Id: 'oos', Name: 'Out of Scope', Taxable: false });
    expect(salesOnly.purchaseTaxRateList).toEqual([]);
    expect(salesOnly.salesTaxRateList).toHaveLength(1);
    expect(inactive.active).toBe(false);
    expect(outOfScope.taxable).toBe(false);
  });

  it('maps active and inactive rates plus tax preferences', () => {
    expect(mapTaxRate({ Id: 'r1', Name: 'GST', RateValue: 5 })).toMatchObject({
      qboId: 'r1',
      active: true,
      rateValue: 5,
    });
    expect(mapTaxRate({ Id: 'r2', Name: 'Old', Active: false })).toMatchObject({
      active: false,
      rateValue: null,
    });
    expect(mapTaxProfile({ TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: false } })).toMatchObject({
      usingSalesTax: true,
      partnerTaxEnabled: false,
    });
  });
});

/** Two-line purchase: $100 parked in holding + $50 already categorized. */
function twoLinePurchase(): RawPurchase {
  return {
    Id: '42',
    SyncToken: '3',
    TxnDate: '2026-07-01',
    TotalAmt: 150,
    EntityRef: { value: 'v1', name: 'COSTCO WHSE #1123' },
    AccountRef: { value: '1', name: 'Checking ·4821' },
    Line: [
      {
        Id: '1',
        Amount: 100,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '4', name: 'Ask My Accountant' } },
      },
      {
        Id: '2',
        Amount: 50,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'Shelf brackets',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '19', name: 'Office supplies' } },
      },
    ],
  };
}

describe('mapPurchase (multi-line)', () => {
  it('amount is the holding-line sum, not TotalAmt', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(txn.amount).toBe(-100); // NOT -150
  });

  it('lines contain only the holding-account lines', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(txn.lines).toHaveLength(1);
    expect(txn.lines[0]).toMatchObject({ accountQboId: '4', amount: 100 });
  });

  it('keeps the natural sign for credits', () => {
    const txn = mapPurchase({ ...twoLinePurchase(), Credit: true }, HOLDING);
    expect(txn.amount).toBe(100);
  });

  it('maps an entity with no holding lines to zero amount and no lines', () => {
    const txn = mapPurchase(twoLinePurchase(), new Set(['999']));
    expect(txn.amount).toBe(-0);
    expect(txn.lines).toHaveLength(0);
  });
});

describe('rebuildPurchaseLines (multi-line write safety)', () => {
  it('replaces only holding lines; the categorized line survives verbatim and the total is unchanged', () => {
    const raw = twoLinePurchase();
    const rebuilt = rebuildPurchaseLines(raw, HOLDING, [
      { amount: -60, accountQboId: '17', memo: 'client dinner' },
      { amount: -40, accountQboId: '14' },
    ]);

    // The already-categorized $50 Office supplies line is untouched.
    const kept = rebuilt.find((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === '19');
    expect(kept).toEqual(raw.Line?.[1]);

    // No holding line remains; the new category lines are present.
    expect(rebuilt.some((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === '4')).toBe(false);
    expect(rebuilt.filter((l) => ['17', '14'].includes(l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? ''))).toHaveLength(2);

    // Entity total unchanged: 50 + 60 + 40 = 150.
    const total = rebuilt.reduce((a, l) => a + (l.Amount ?? 0), 0);
    expect(total).toBeCloseTo(150, 2);
  });
});

describe('rebuildDepositLines', () => {
  const deposit: RawDeposit = {
    Id: '7',
    SyncToken: '0',
    TotalAmt: 300,
    DepositToAccountRef: { value: '1', name: 'Checking ·4821' },
    Line: [
      {
        Id: '1',
        Amount: 200,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '4', name: 'Ask My Accountant' }, Entity: { value: 'c9', name: 'Square' } },
      },
      {
        Id: '2',
        Amount: 100,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '7', name: 'Sales — food' } },
      },
    ],
  };

  it('keeps non-holding lines, preserves the payer Entity, and keeps the total', () => {
    const rebuilt = rebuildDepositLines(deposit, HOLDING, [{ amount: 200, accountQboId: '8' }]);
    expect(rebuilt.find((l) => l.DepositLineDetail?.AccountRef?.value === '7')).toEqual(deposit.Line?.[1]);
    const newLine = rebuilt.find((l) => l.DepositLineDetail?.AccountRef?.value === '8');
    expect(newLine?.DepositLineDetail?.Entity).toEqual({ value: 'c9', name: 'Square' });
    expect(rebuilt.reduce((a, l) => a + (l.Amount ?? 0), 0)).toBeCloseTo(300, 2);
  });

  it('mapDeposit amount is the holding-line sum', () => {
    expect(mapDeposit(deposit, HOLDING).amount).toBe(200);
  });
});

describe('rebuildJournalEntryLines', () => {
  const je: RawJournalEntry = {
    Id: '11',
    SyncToken: '0',
    Line: [
      {
        Id: '1',
        Amount: 80,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '4', name: 'Ask My Accountant' } },
      },
      {
        Id: '2',
        Amount: 20,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '23', name: 'Rent' } },
      },
      {
        Id: '3',
        Amount: 100,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '1', name: 'Checking ·4821' } },
      },
    ],
  };

  it('replaces only the holding Debit line; other Debits and all Credits survive', () => {
    const rebuilt = rebuildJournalEntryLines(je, HOLDING, [{ amount: -80, accountQboId: '17' }]);
    expect(rebuilt.find((l) => l.JournalEntryLineDetail?.AccountRef?.value === '23')).toEqual(je.Line?.[1]);
    expect(rebuilt.find((l) => l.JournalEntryLineDetail?.PostingType === 'Credit')).toEqual(je.Line?.[2]);
    expect(rebuilt.some((l) => l.JournalEntryLineDetail?.AccountRef?.value === '4')).toBe(false);
    // Debits still balance the credit: 20 + 80 = 100.
    const debits = rebuilt
      .filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit')
      .reduce((a, l) => a + (l.Amount ?? 0), 0);
    expect(debits).toBeCloseTo(100, 2);
  });

  it('mapJournalEntry amount is minus the holding-debit sum', () => {
    expect(mapJournalEntry(je, HOLDING).amount).toBe(-80);
  });
});

describe('sumLinesPostingTo', () => {
  it('sums only the raw lines posting to the given accounts', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(sumLinesPostingTo(txn, new Set(['19']))).toBe(50);
    expect(sumLinesPostingTo(txn, new Set(['4']))).toBe(100);
    expect(sumLinesPostingTo(txn, new Set(['999']))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reports API parsing — Intuit report JSON → normalized QboStatement /
// account-transaction rows. Fixtures follow the documented Rows/Columns shape
// (Section rows with Header/Summary, nested Rows.Row, ColData value+id).
// ---------------------------------------------------------------------------

const plReport: RawReport = {
  Columns: {
    Column: [
      { ColTitle: '', ColType: 'Account' },
      { ColTitle: 'Total', ColType: 'Money' },
    ],
  },
  Rows: {
    Row: [
      {
        type: 'Section',
        group: 'Income',
        Header: { ColData: [{ value: 'Income' }, { value: '' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Sales — food', id: '7' }, { value: '4200.00' }] },
            { type: 'Data', ColData: [{ value: 'Sales — beverage', id: '8' }, { value: '1,150.50' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Income' }, { value: '5350.50' }] },
      },
      {
        type: 'Section',
        group: 'COGS',
        Header: { ColData: [{ value: 'Cost of Goods Sold' }, { value: '' }] },
        Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Food purchases', id: '10' }, { value: '900.00' }] }] },
        Summary: { ColData: [{ value: 'Total Cost of Goods Sold' }, { value: '900.00' }] },
      },
      { type: 'Section', group: 'GrossProfit', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '4450.50' }] } },
      {
        type: 'Section',
        group: 'Expenses',
        Header: { ColData: [{ value: 'Expenses' }, { value: '' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Rent', id: '23' }, { value: '1800.00' }] },
            {
              // nested sub-account section — QBO nests Rows.Row arbitrarily deep
              type: 'Section',
              Header: { ColData: [{ value: 'Payroll' }, { value: '' }] },
              Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Payroll wages', id: '20' }, { value: '2100.00' }] }] },
              Summary: { ColData: [{ value: 'Total Payroll' }, { value: '2100.00' }] },
            },
          ],
        },
        Summary: { ColData: [{ value: 'Total Expenses' }, { value: '3900.00' }] },
      },
      { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '550.50' }] } },
    ],
  },
};

describe('parseStatementReport', () => {
  it('maps a realistic P&L body to the normalized statement tree', () => {
    const stmt = parseStatementReport(plReport);
    expect(stmt.columns).toEqual([{ label: 'Total' }]);
    expect(
      stmt.rows.map((r) => ({ label: r.label, kind: r.kind, indent: r.indent, id: r.accountQboId, v: r.values })),
    ).toEqual([
      { label: 'Income', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Sales — food', kind: 'line', indent: true, id: '7', v: [4200] },
      { label: 'Sales — beverage', kind: 'line', indent: true, id: '8', v: [1150.5] },
      { label: 'Total Income', kind: 'total', indent: false, id: undefined, v: [5350.5] },
      { label: 'Cost of Goods Sold', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Food purchases', kind: 'line', indent: true, id: '10', v: [900] },
      { label: 'Total Cost of Goods Sold', kind: 'total', indent: false, id: undefined, v: [900] },
      { label: 'Gross Profit', kind: 'grand', indent: false, id: undefined, v: [4450.5] },
      { label: 'Expenses', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Rent', kind: 'line', indent: true, id: '23', v: [1800] },
      { label: 'Payroll', kind: 'head', indent: true, id: undefined, v: [] },
      { label: 'Payroll wages', kind: 'line', indent: true, id: '20', v: [2100] },
      { label: 'Total Payroll', kind: 'total', indent: false, id: undefined, v: [2100] },
      { label: 'Total Expenses', kind: 'total', indent: false, id: undefined, v: [3900] },
      { label: 'Net Income', kind: 'grand', indent: false, id: undefined, v: [550.5] },
    ]);
  });

  it('marks top-level balance-sheet section summaries as grand rows', () => {
    const bs: RawReport = {
      Columns: {
        Column: [
          { ColTitle: '', ColType: 'Account' },
          { ColTitle: 'Total', ColType: 'Money' },
        ],
      },
      Rows: {
        Row: [
          {
            type: 'Section',
            group: 'TotalAssets',
            Header: { ColData: [{ value: 'ASSETS' }, { value: '' }] },
            Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Checking', id: '1' }, { value: '12400.00' }] }] },
            Summary: { ColData: [{ value: 'Total ASSETS' }, { value: '12400.00' }] },
          },
        ],
      },
    };
    const stmt = parseStatementReport(bs);
    expect(stmt.rows[2]).toEqual({ label: 'Total ASSETS', kind: 'grand', indent: false, values: [12400] });
  });

  it('tolerates empty / missing pieces (defensive parsing)', () => {
    expect(parseStatementReport({})).toEqual({ columns: [], rows: [] });
    const weird: RawReport = {
      Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
      Rows: { Row: [{ type: 'Data', ColData: [{ value: 'No id row' }, { value: 'n/a' }] }] },
    };
    expect(parseStatementReport(weird).rows).toEqual([
      { label: 'No id row', kind: 'line', indent: true, values: [0] },
    ]);
  });
});

describe('parseTransactionListReport', () => {
  const txnList: RawReport = {
    Columns: {
      Column: [
        { ColTitle: 'Date', ColType: 'tx_date' },
        { ColTitle: 'Transaction Type', ColType: 'txn_type' },
        { ColTitle: 'Name', ColType: 'name' },
        { ColTitle: 'Memo/Description', ColType: 'memo' },
        { ColTitle: 'Amount', ColType: 'subt_nat_amount' },
      ],
    },
    Rows: {
      Row: [
        {
          type: 'Data',
          ColData: [
            { value: '2026-07-05', id: '6' },
            { value: 'Expense' },
            { value: 'WEBFLOW.COM' },
            { value: '' },
            { value: '-29.00' },
          ],
        },
        {
          type: 'Data',
          ColData: [
            { value: '2026-07-11', id: '11' },
            { value: 'Expense' },
            { value: 'ULINE SHIP SUPPLIES' },
            { value: 'Boxes' },
            { value: '-212.06' },
          ],
        },
        {
          type: 'Section',
          group: 'GrandTotal',
          Summary: {
            ColData: [{ value: 'Grand Total' }, { value: '' }, { value: '' }, { value: '' }, { value: '-241.06' }],
          },
        },
      ],
    },
  };

  it('maps data rows via the report column metadata and skips summary rows', () => {
    expect(parseTransactionListReport(txnList)).toEqual([
      { date: '2026-07-05', payee: 'WEBFLOW.COM', amount: -29, txnType: 'Expense', qboId: '6' },
      { date: '2026-07-11', payee: 'ULINE SHIP SUPPLIES', memo: 'Boxes', amount: -212.06, txnType: 'Expense', qboId: '11' },
    ]);
  });

  it('flattens grouped sections and returns [] for an empty report', () => {
    const grouped: RawReport = { Columns: txnList.Columns, Rows: { Row: [{ type: 'Section', Rows: txnList.Rows }] } };
    expect(parseTransactionListReport(grouped)).toHaveLength(2);
    expect(parseTransactionListReport({})).toEqual([]);
  });
});
