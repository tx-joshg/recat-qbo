import { describe, expect, it, vi } from 'vitest';
import {
  loadAgentSnapshotSource,
  type AgentSnapshotLoaderDb,
} from './snapshotLoader.js';
import { buildAgentSnapshot } from './core/snapshot.js';

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';
const RULE_ID = '33333333-3333-4333-8333-333333333333';
const HISTORY_ID = '44444444-4444-4444-8444-444444444444';
const COMPATIBLE_RULE_ID = '66666666-6666-4666-8666-666666666666';
const COMPATIBLE_HISTORY_ID = '77777777-7777-4777-8777-777777777777';

describe('agent snapshot loader', () => {
  it('uses one repeatable-read snapshot and maps only bounded allowlisted source data', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('agent-snapshot:current')) {
        return [{
          id: TRANSACTION_ID,
          companyId: COMPANY_ID,
          revision: 7,
          status: 'PENDING',
          qboType: 'Purchase',
          date: new Date('2026-07-28T00:00:00.000Z'),
          amount: '-123.45',
          currency: 'CAD',
          sourceAccountQboId: 'source-card',
          payee: 'Bounded merchant',
          memo: 'Bounded memo',
          holdingAccountIds: ['holding'],
          taxSupportStatus: 'ready',
          taxUsingSalesTax: true,
          configVersion: 'config-v7',
          ruleRuntimeMode: 'canonical',
        }];
      }
      if (sql.includes('agent-snapshot:accounts')) {
        return [
          { qboId: 'source-card', fullName: 'Private card 123456789', classification: 'Liability', accountType: 'Credit Card', active: true },
          { qboId: 'expense-a', fullName: 'Expenses · Generic', classification: 'Expenses', accountType: 'Expense', active: true },
          { qboId: 'holding', fullName: 'Holding', classification: 'Expenses', accountType: 'Expense', active: true },
          { qboId: 'stale-expense', fullName: 'Stale', classification: 'Expenses', accountType: 'Expense', active: false },
        ];
      }
      if (sql.includes('agent-snapshot:rates')) {
        return [
          { qboId: 'rate-5', name: 'GST', active: true, rateValue: '5.000000' },
          { qboId: 'rate-7', name: 'PST', active: true, rateValue: '7.000000' },
        ];
      }
      if (sql.includes('agent-snapshot:tax */')) {
        return [
          { qboId: 'tax-a', name: 'Tax A', active: true, taxable: true, purchaseTaxRateList: [{ taxRateQboId: 'rate-5', taxTypeApplicable: 'TaxOnAmount' }], salesTaxRateList: [] },
          { qboId: 'tax-composite', name: 'GST/PST BC', active: true, taxable: true, purchaseTaxRateList: [{ taxRateQboId: 'rate-5', taxTypeApplicable: 'TaxOnAmount' }, { taxRateQboId: 'rate-7', taxTypeApplicable: 'TaxOnAmount' }], salesTaxRateList: [] },
          { qboId: 'tax-unsupported', name: 'Unsupported composite', active: true, taxable: true, purchaseTaxRateList: [{ taxRateQboId: 'rate-5', taxTypeApplicable: 'TaxOnAmount' }, null], salesTaxRateList: [] },
          { qboId: 'tax-stale', name: 'Tax stale', active: false, taxable: true, purchaseTaxRateList: [{ taxRateQboId: 'rate-5', taxTypeApplicable: 'TaxOnAmount' }], salesTaxRateList: [] },
        ];
      }
      if (sql.includes('agent-snapshot:tags')) {
        return [{ id: TAG_ID, name: 'Generic tag' }];
      }
      if (sql.includes('agent-snapshot:rules')) {
        return [
          { id: RULE_ID, revision: 1, priority: 1, createdAt: new Date('2026-07-01T00:00:00.000Z'), matchField: 'payee', matchText: 'merchant', direction: 'Purchase', category: 'Expenses · Generic', categoryQboId: 'expense-a', taxCalculation: 'TaxExcluded', taxCodeQboId: 'tax-a', tagIds: [TAG_ID], autoPost: false },
          { id: COMPATIBLE_RULE_ID, revision: 2, priority: 2, createdAt: new Date('2026-07-02T00:00:00.000Z'), matchField: 'payee', matchText: 'merchant', direction: 'Purchase', category: 'Expenses · Generic', categoryQboId: 'expense-a', taxCalculation: 'TaxInclusive', taxCodeQboId: 'tax-composite', tagIds: [TAG_ID], autoPost: true },
          { id: '55555555-5555-4555-8555-555555555555', revision: 1, priority: 2, createdAt: new Date('2026-07-03T00:00:00.000Z'), matchField: 'payee', matchText: 'merchant', direction: 'Purchase', category: 'Stale', categoryQboId: 'stale-expense', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [], autoPost: false },
        ];
      }
      if (sql.includes('agent-snapshot:history-lines')) {
        return [
          { transactionId: HISTORY_ID, signedGrossAmount: '-123.45', categoryQboId: 'expense-a', taxCodeQboId: 'tax-a', memo: null, tagIds: [] },
          { transactionId: COMPATIBLE_HISTORY_ID, signedGrossAmount: '-123.45', categoryQboId: 'expense-a', taxCodeQboId: 'tax-composite', memo: null, tagIds: [] },
        ];
      }
      if (sql.includes('agent-snapshot:history')) {
        return [
          {
            transactionId: HISTORY_ID, companyId: COMPANY_ID, status: 'POSTED', mutationStatus: 'VERIFIED',
            date: new Date('2026-07-20T00:00:00.000Z'), signedAmount: '-123.45', currency: 'CAD',
            payee: 'Earlier merchant', memo: null, taxCalculation: 'TaxExcluded', tagIds: [TAG_ID],
            verifiedAt: new Date('2026-07-21T00:00:00.000Z'),
          },
          {
            transactionId: COMPATIBLE_HISTORY_ID, companyId: COMPANY_ID, status: 'POSTED', mutationStatus: 'VERIFIED',
            date: new Date('2026-07-22T00:00:00.000Z'), signedAmount: '-123.45', currency: 'CAD',
            payee: 'Compatible merchant', memo: null, taxCalculation: 'TaxInclusive', tagIds: [TAG_ID],
            verifiedAt: new Date('2026-07-23T00:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const db = {
      $transaction: vi.fn(async (callback, options) => {
        expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
        return callback({ $queryRawUnsafe: query });
      }),
    } as AgentSnapshotLoaderDb;

    const source = await loadAgentSnapshotSource(COMPANY_ID, TRANSACTION_ID, db);

    expect(source).toEqual({
      transaction: { id: TRANSACTION_ID, revision: 7 },
      date: '2026-07-28',
      signedAmountCents: -12_345,
      currency: 'CAD',
      sourceAccount: { displayName: 'Source credit card', type: 'CREDIT_CARD' },
      payee: 'Bounded merchant',
      memo: 'Bounded memo',
      candidateCategories: [{ qboId: 'expense-a', name: 'Expenses · Generic' }],
      tax: {
        status: 'ready',
        supportedCalculationModes: ['TaxInclusive'],
        eligibleReferences: [
          { qboId: 'tax-composite', label: 'GST/PST BC' },
          { qboId: 'tax-a', label: 'Tax A' },
        ],
      },
      tags: [{ id: TAG_ID, name: 'Generic tag' }],
      rules: [{
        id: COMPATIBLE_RULE_ID,
        ruleRevision: 2,
        priority: 2,
        matchField: 'payee',
        matchText: 'merchant',
        action: {
          version: 2,
          direction: 'Purchase',
          category: 'Expenses · Generic',
          categoryQboId: 'expense-a',
          taxCalculation: 'TaxInclusive',
          taxCodeQboId: 'tax-composite',
          tagIds: [TAG_ID],
        },
        autoPost: true,
      }],
      similarVerifiedTransactions: [{
        transactionId: COMPATIBLE_HISTORY_ID,
        date: '2026-07-22',
        signedAmountCents: -12_345,
        currency: 'CAD',
        payee: 'Compatible merchant',
        taxCalculation: 'TaxInclusive',
        lines: [{
          signedGrossCents: -12_345,
          categoryQboId: 'expense-a',
          taxCodeQboId: 'tax-composite',
          tagIds: [],
        }],
        tagIds: [TAG_ID],
        verifiedAt: '2026-07-23T00:00:00.000Z',
      }],
      featureVersion: 'shadow-core.1',
      configurationVersion: 'config-v7',
    });
    expect(() => buildAgentSnapshot(source)).not.toThrow();
    expect(JSON.stringify(source)).not.toContain('123456789');
    const taxSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('agent-snapshot:tax'));
    expect(taxSql).toContain('"active" = TRUE');
    const currentSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('agent-snapshot:current'));
    expect(currentSql).toContain("txn.\"rawData\" #>> '{AccountRef,value}'");
    expect(currentSql).toContain("txn.\"rawData\" #>> '{DepositToAccountRef,value}'");
    expect(currentSql).toContain("'{JournalEntryLineDetail,AccountRef,value}'");
    expect(currentSql).toContain('COUNT(DISTINCT credit."accountQboId") = 1');
    expect(currentSql).not.toContain('txn."bankAccount"');
    expect(currentSql).toContain('company."ruleRuntimeMode"');
    const rulesSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('agent-snapshot:rules'));
    expect(rulesSql).toContain('rule."createdAt"');
    expect(rulesSql).toContain('ORDER BY rule."priority", rule."createdAt" DESC, rule."id"');
  });

  it.each([
    ['missing currency', null, 'source-card', '-1.00'],
    ['invalid currency', 'customer-content', 'source-card', '-1.00'],
    ['unassigned currency', 'ZZZ', 'source-card', '-1.00'],
    ['missing cached source account', 'CAD', null, '-1.00'],
    ['fractional cents', 'CAD', 'source-card', '-1.001'],
    ['unsafe cents', 'CAD', 'source-card', '-90071992547409.92'],
  ])('fails closed for %s without inventing metadata', async (
    _name,
    currency,
    sourceAccountQboId,
    amount,
  ) => {
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('agent-snapshot:current')) return [{
              id: TRANSACTION_ID,
              companyId: COMPANY_ID,
              revision: 7,
              status: 'PENDING',
              qboType: 'Purchase',
              date: new Date('2026-07-28T00:00:00.000Z'),
              amount,
              currency,
              sourceAccountQboId,
              payee: 'Merchant',
              memo: null,
              holdingAccountIds: [],
              taxSupportStatus: 'needs_setup',
              taxUsingSalesTax: null,
              configVersion: 'config-v7',
            }];
          if (sql.includes('agent-snapshot:accounts')) return [{
            qboId: 'source-card',
            fullName: 'Source card',
            classification: 'Liability',
            accountType: 'Credit Card',
            active: true,
          }];
          return [];
        },
      }),
    } as AgentSnapshotLoaderDb;

    await expect(loadAgentSnapshotSource(COMPANY_ID, TRANSACTION_ID, db))
      .rejects.toMatchObject({ code: 'AGENT_MODEL_INPUT_INVALID' });
  });

  it.each(['canonical', 'legacy', 'bridge', 'paused', 'unknown', undefined])('gates ordered complete rule projections by runtime mode %s', async (ruleRuntimeMode) => {
    const OLDEST_ID = '00000000-0000-4000-8000-000000000001';
    const NEWER_HIGH_ID = '00000000-0000-4000-8000-000000000003';
    const NEWER_LOW_ID = '00000000-0000-4000-8000-000000000002';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('agent-snapshot:current')) return [{
        id: TRANSACTION_ID,
        companyId: COMPANY_ID,
        revision: 1,
        status: 'PENDING',
        qboType: 'Purchase',
        date: new Date('2026-07-28T00:00:00.000Z'),
        amount: '-1.00',
        currency: 'CAD',
        sourceAccountQboId: 'source-card',
        payee: 'Merchant',
        memo: null,
        holdingAccountIds: [],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: null,
        configVersion: 'config-v1',
        ruleRuntimeMode,
      }];
      if (sql.includes('agent-snapshot:accounts')) return [
        { qboId: 'source-card', fullName: 'Source card', classification: 'Liability', accountType: 'Credit Card', active: true },
        { qboId: 'expense-a', fullName: 'Expenses · Generic', classification: 'Expenses', accountType: 'Expense', active: true },
      ];
      if (sql.includes('agent-snapshot:rules')) return [
        { id: OLDEST_ID, revision: 1, priority: 5, createdAt: new Date('2026-07-01T00:00:00.000Z'), matchField: 'payee', matchText: 'merchant', direction: 'Purchase', category: 'Expenses · Generic', categoryQboId: 'expense-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [], autoPost: false },
        { id: NEWER_HIGH_ID, revision: 1, priority: 5, createdAt: new Date('2026-07-02T00:00:00.000Z'), matchField: 'payee', matchText: 'merchant', direction: 'Purchase', category: 'Expenses · Generic', categoryQboId: 'expense-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [], autoPost: false },
        { id: NEWER_LOW_ID, revision: 1, priority: 5, createdAt: new Date('2026-07-02T00:00:00.000Z'), matchField: 'payee', matchText: 'merchant', direction: 'Purchase', category: 'Expenses · Generic', categoryQboId: 'expense-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [], autoPost: false },
      ];
      return [];
    });
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRawUnsafe: query }),
    } as AgentSnapshotLoaderDb;

    const source = await loadAgentSnapshotSource(COMPANY_ID, TRANSACTION_ID, db);
    const snapshot = buildAgentSnapshot(source);

    const expected = ruleRuntimeMode === 'canonical' ? [NEWER_LOW_ID, NEWER_HIGH_ID, OLDEST_ID] : [];
    expect(source.rules.map((rule) => rule.id)).toEqual(expected);
    expect(snapshot.rules.map((rule) => rule.id)).toEqual(expected);
    expect(query.mock.calls.some(([sql]) => sql.includes('agent-snapshot:rules'))).toBe(ruleRuntimeMode === 'canonical');
  });

  it.each(['JournalEntry', 'UnknownTransaction'])('rejects unsupported %s transactions instead of projecting Purchase defaults', async (qboType) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('agent-snapshot:current')) return [{
        id: TRANSACTION_ID,
        companyId: COMPANY_ID,
        revision: 1,
        status: 'PENDING',
        qboType,
        date: new Date('2026-07-28T00:00:00.000Z'),
        amount: '-1.00',
        currency: 'CAD',
        sourceAccountQboId: 'source-card',
        payee: 'Merchant',
        memo: null,
        holdingAccountIds: [],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: null,
        configVersion: 'config-v1',
      }];
      if (sql.includes('agent-snapshot:accounts')) return [
        { qboId: 'source-card', fullName: 'Source card', classification: 'Liability', accountType: 'Credit Card', active: true },
        { qboId: 'expense-a', fullName: 'Expenses · Generic', classification: 'Expenses', accountType: 'Expense', active: true },
      ];
      return [];
    });
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRawUnsafe: query }),
    } as AgentSnapshotLoaderDb;

    await expect(loadAgentSnapshotSource(COMPANY_ID, TRANSACTION_ID, db))
      .rejects.toMatchObject({ code: 'AGENT_MODEL_INPUT_INVALID' });
  });

  it('advertises both supported modes when every usable code has one component', async () => {
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('agent-snapshot:current')) return [{
            id: TRANSACTION_ID,
            companyId: COMPANY_ID,
            revision: 1,
            status: 'PENDING',
            qboType: 'Purchase',
            date: new Date('2026-07-28T00:00:00.000Z'),
            amount: '-1.00',
            currency: 'CAD',
            sourceAccountQboId: 'source-card',
            payee: 'Merchant',
            memo: null,
            holdingAccountIds: [],
            taxSupportStatus: 'ready',
            taxUsingSalesTax: true,
            configVersion: 'config-v1',
          }];
          if (sql.includes('agent-snapshot:accounts')) return [
            { qboId: 'source-card', fullName: 'Source card', classification: 'Liability', accountType: 'Credit Card', active: true },
            { qboId: 'expense-a', fullName: 'Expenses · Generic', classification: 'Expenses', accountType: 'Expense', active: true },
          ];
          if (sql.includes('agent-snapshot:tax')) return [
            { qboId: 'tax-a', name: 'GST', active: true, taxable: true, purchaseTaxRateList: [{ taxRateQboId: 'rate-5', taxTypeApplicable: 'TaxOnAmount' }], salesTaxRateList: [] },
          ];
          if (sql.includes('agent-snapshot:rates')) return [
            { qboId: 'rate-5', name: 'GST', active: true, rateValue: '5.000000' },
          ];
          return [];
        },
      }),
    } as AgentSnapshotLoaderDb;

    const source = await loadAgentSnapshotSource(COMPANY_ID, TRANSACTION_ID, db);

    expect(source.tax).toEqual({
      status: 'ready',
      supportedCalculationModes: ['TaxInclusive', 'TaxExcluded'],
      eligibleReferences: [{ qboId: 'tax-a', label: 'GST' }],
    });
  });

  it('caps every model-facing top-level collection at twenty', async () => {
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('agent-snapshot:current')) {
            return [{
              id: TRANSACTION_ID,
              companyId: COMPANY_ID,
              revision: 1,
              status: 'PENDING',
              qboType: 'Purchase',
              date: new Date('2026-07-28T00:00:00.000Z'),
              amount: '-1.00',
              currency: 'USD',
              sourceAccountQboId: 'source-bank',
              payee: 'Merchant',
              memo: null,
              holdingAccountIds: [],
              taxSupportStatus: 'needs_setup',
              taxUsingSalesTax: null,
              configVersion: 'config-v1',
            }];
          }
          if (sql.includes('agent-snapshot:accounts')) {
            return [
              { qboId: 'source-bank', fullName: 'Source', classification: 'Bank', accountType: 'Bank', active: true },
              ...Array.from({ length: 25 }, (_, index) => ({
                qboId: `expense-${String(index).padStart(2, '0')}`,
                fullName: `Expense ${String(index).padStart(2, '0')}`,
                classification: 'Expenses',
                accountType: 'Expense',
                active: true,
              })),
            ];
          }
          if (sql.includes('agent-snapshot:tags')) {
            return Array.from({ length: 25 }, (_, index) => ({
              id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
              name: `Tag ${String(index).padStart(2, '0')}`,
            }));
          }
          return [];
        },
      }),
    } as AgentSnapshotLoaderDb;

    const source = await loadAgentSnapshotSource(COMPANY_ID, TRANSACTION_ID, db);

    expect(source.currency).toBe('USD');
    expect(source.candidateCategories).toHaveLength(20);
    expect(source.tags).toHaveLength(20);
    expect(source.rules).toHaveLength(0);
    expect(source.similarVerifiedTransactions).toHaveLength(0);
  });
});
