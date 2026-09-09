import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaxReadinessDto, TransactionDto } from '@recat/shared';
import SplitEditor from './SplitEditor';

const toast = vi.fn();
vi.mock('../state/AppContext', () => ({
  useApp: () => ({ toast }),
}));

const READY: TaxReadinessDto = {
  status: 'ready',
  reason: null,
  usingSalesTax: true,
  refreshedAt: '2026-07-28T00:00:00.000Z',
  taxCodes: [{
    qboId: 'TAX_CODE_STANDARD',
    name: 'Standard purchase tax',
    active: true,
    taxable: true,
    combinedPurchaseRate: 5,
    combinedSalesRate: null,
  }, {
    qboId: 'TAX_CODE_EXPLICIT_NONE',
    name: 'Explicit non-tax treatment',
    active: true,
    taxable: false,
    combinedPurchaseRate: null,
    combinedSalesRate: null,
  }],
  salesStatus: 'needs_setup',
  salesReason: null,
  salesTaxCodes: [],
};

const TXN: TransactionDto = {
  id: 'TRANSACTION_GENERIC',
  companyId: 'COMPANY_GENERIC',
  qboId: 'PURCHASE_GENERIC',
  qboType: 'Purchase',
  date: '2026-07-28T00:00:00.000Z',
  payee: 'Generic supplier',
  memo: null,
  amount: -10.5,
  bankAccount: 'Generic bank',
  status: 'PENDING',
  revision: 2,
  category: null,
  categoryQboId: null,
  taxCalculation: 'TaxInclusive',
  taxCode: null,
  taxCodeQboId: null,
  splits: [
    {
      amount: -5,
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard purchase tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      tagIds: [],
      memo: 'First memo',
    },
    {
      amount: -5.5,
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard purchase tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      tagIds: [],
      memo: 'Second memo',
    },
  ],
  tagIds: [],
  suggestion: null,
  error: null,
  postedAt: null,
  postedBy: null,
  activeCategorizationAttempt: null,
};

const SALES_READY: TaxReadinessDto = {
  ...READY,
  salesStatus: 'ready',
  salesReason: null,
  salesTaxCodes: [{
    qboId: 'SALES_TAX_CODE',
    name: 'Standard sales tax',
    active: true,
    taxable: true,
    combinedPurchaseRate: null,
    combinedSalesRate: 5,
  }],
};

describe('SplitEditor tax fields', () => {
  it.each([
    { amount: -100, sourceGrossCents: -11200, expected: '112.00' },
    { amount: 100, sourceGrossCents: 11200, expected: '112.00' },
    { amount: -100, sourceGrossCents: undefined, expected: '100.00' },
  ])('seeds allocation from proven gross or the legacy amount: $sourceGrossCents', ({ amount, sourceGrossCents, expected }) => {
    render(<SplitEditor txn={{ ...TXN, amount, sourceGrossCents, splits: null }}
      tags={[]} catOpts={[]} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Amount for split line 1')).toHaveValue(expected);
    expect(screen.getByText(/assign every dollar to a category/)).toHaveTextContent(`$${expected}`);
  });

  it('saves the calculation, memo, and purchase tax selection on every line', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={TXN}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText('Tax calculation for split'),
      'TaxExcluded',
    );
    const firstMemo = screen.getByLabelText('Memo for split line 1');
    await user.clear(firstMemo);
    await user.type(firstMemo, 'Updated generic memo');
    await user.selectOptions(
      screen.getByLabelText('Purchase tax for split line 2'),
      'TAX_CODE_STANDARD',
    );
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          memo: 'Updated generic memo',
          taxCodeQboId: 'TAX_CODE_STANDARD',
        }),
        expect.objectContaining({
          memo: 'Second memo',
          taxCodeQboId: 'TAX_CODE_STANDARD',
        }),
      ],
      'TaxExcluded',
    );
  });

  it('keeps the legacy split editor free of tax controls when readiness is disabled', () => {
    render(
      <SplitEditor
        txn={{ ...TXN, taxCalculation: null, splits: TXN.splits!.map((line) => ({
          ...line,
          taxCode: null,
          taxCodeQboId: null,
        })) }}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={{
          status: 'unsupported',
          reason: 'Purchase tax is disabled.',
          usingSalesTax: false,
          refreshedAt: null,
          taxCodes: [],
          salesStatus: 'unsupported',
          salesReason: 'Sales tax is disabled.',
          salesTaxCodes: [],
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Tax calculation for split')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Purchase tax for split line 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save split/i })).toBeEnabled();
  });

  it('does not offer or accept an explicit non-tax code in taxed mode', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={{
          ...TXN,
          splits: [
            TXN.splits![0]!,
            {
              ...TXN.splits![1]!,
              taxCode: 'Explicit non-tax treatment',
              taxCodeQboId: 'TAX_CODE_EXPLICIT_NONE',
            },
          ],
        }}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.queryByRole('option', { name: 'Explicit non-tax treatment' }))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Select a usable purchase tax code for every taxed split line.',
    );
  });

  it('explains that every split must be entirely taxable or entirely No tax', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={TXN}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText('Purchase tax for split line 2'),
      '',
    );
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Use a supported taxable code on every split line, or choose No tax on every split line.',
    );
  });

  it('uses sales tax labels and codes for a tax-ready Deposit while retaining line memo and tags', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={{
          ...TXN,
          qboType: 'Deposit',
          amount: 10.5,
          splits: TXN.splits!.map((line) => ({
            ...line,
            amount: Math.abs(line.amount),
            taxCode: null,
            taxCodeQboId: null,
            tagIds: ['TAG_GENERIC'],
          })),
        }}
        tags={[{ id: 'TAG_GENERIC', companyId: 'COMPANY_GENERIC', name: 'Generic tag', color: '#667788' }]}
        catOpts={[{ group: 'Income', name: 'Generic expense' }]}
        taxReadiness={SALES_READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.getByLabelText('Sales tax for split line 1')).toHaveTextContent('Standard sales tax');
    expect(screen.queryByLabelText('Purchase tax for split line 1')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Sales tax for split line 1'), 'SALES_TAX_CODE');
    await user.selectOptions(screen.getByLabelText('Sales tax for split line 2'), 'SALES_TAX_CODE');
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ memo: 'First memo', tags: ['TAG_GENERIC'], taxCodeQboId: 'SALES_TAX_CODE' }),
        expect.objectContaining({ memo: 'Second memo', tags: ['TAG_GENERIC'], taxCodeQboId: 'SALES_TAX_CODE' }),
      ]),
      'TaxInclusive',
    );
  });

  it('does not save a sales-ready Deposit split with stale purchase tax IDs', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={{
          ...TXN,
          qboType: 'Deposit',
          amount: 10.5,
          taxCalculation: 'TaxInclusive',
          splits: TXN.splits!.map((line) => ({
            ...line,
            amount: Math.abs(line.amount),
            taxCodeQboId: 'TAX_CODE_STANDARD',
          })),
        }}
        tags={[]}
        catOpts={[{ group: 'Income', name: 'Generic expense' }]}
        taxReadiness={SALES_READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Select a usable sales tax code for every taxed split line.',
    );
  });
});
