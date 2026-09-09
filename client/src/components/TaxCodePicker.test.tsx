import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaxReadinessDto } from '@recat/shared';
import TaxCodePicker from './TaxCodePicker';

const READY: TaxReadinessDto = {
  status: 'ready',
  reason: null,
  usingSalesTax: true,
  refreshedAt: '2026-07-28T00:00:00.000Z',
  taxCodes: [
    {
      qboId: 'TAX_CODE_STANDARD',
      name: 'Standard purchase tax',
      active: true,
      taxable: true,
      combinedPurchaseRate: 5,
      combinedSalesRate: null,
    },
    {
      qboId: 'TAX_CODE_INACTIVE',
      name: 'Inactive purchase tax',
      active: false,
      taxable: true,
      combinedPurchaseRate: 7,
      combinedSalesRate: null,
    },
    {
      qboId: 'TAX_CODE_UNSUPPORTED',
      name: 'Unsupported purchase tax',
      active: true,
      taxable: true,
      combinedPurchaseRate: null,
      combinedSalesRate: null,
    },
    {
      qboId: 'TAX_CODE_EXPLICIT_NONE',
      name: 'Explicit non-tax treatment',
      active: true,
      taxable: false,
      combinedPurchaseRate: null,
      combinedSalesRate: null,
    },
  ],
  salesStatus: 'needs_setup',
  salesReason: null,
  salesTaxCodes: [],
};

describe('TaxCodePicker', () => {
  it('shows no tax while ready without a selected tax code', () => {
    render(
      <TaxCodePicker
        id="tax-no-selection"
        label="Purchase tax"
        readiness={READY}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('No tax');
  });

  it('offers explicit no tax and only usable purchase tax codes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <TaxCodePicker
        id="tax-code"
        label="Purchase tax"
        readiness={READY}
        value={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Purchase tax' }));
    const picker = screen.getByRole('textbox', { name: 'Purchase tax' });
    expect(screen.getByRole('option', { name: 'No tax' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Standard purchase tax · 5%' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Inactive purchase tax' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Unsupported purchase tax' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Explicit non-tax treatment' })).not.toBeInTheDocument();

    await user.type(picker, 'standard');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('TAX_CODE_STANDARD');

    view.unmount();
    render(
      <TaxCodePicker
        id="tax-code"
        label="Purchase tax"
        readiness={READY}
        value="TAX_CODE_STANDARD"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Purchase tax' }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('explains disabled purchase tax while keeping No tax selectable', async () => {
    const user = userEvent.setup();
    render(
      <TaxCodePicker
        id="tax-disabled"
        label="Purchase tax"
        readiness={{
          status: 'unsupported',
          reason: 'Purchase tax is disabled.',
          usingSalesTax: false,
          refreshedAt: null,
          taxCodes: [],
          salesStatus: 'unsupported',
          salesReason: 'Sales tax is disabled.',
          salesTaxCodes: [],
        }}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Purchase tax')).not.toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('No tax');
    expect(screen.getByText(/purchase tax is disabled/i)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Purchase tax' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('explains unavailable readiness without inventing tax choices', () => {
    render(
      <TaxCodePicker
        id="tax-unavailable"
        label="Purchase tax"
        readiness={null}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Purchase tax')).not.toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('No tax');
    expect(screen.getByText(/tax availability is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Standard purchase tax')).not.toBeInTheDocument();
  });

  it('keeps No tax selectable while purchase-tax readiness is unavailable', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TaxCodePicker
        id="tax-unavailable-choice"
        label="Purchase tax"
        readiness={null}
        value="HISTORICAL_TAX"
        unavailableValueLabel="Historical purchase tax"
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('Historical purchase tax');
    await user.click(screen.getByRole('combobox', { name: 'Purchase tax' }));
    await user.click(screen.getByRole('option', { name: 'No tax' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('labels tax codes with the direction-appropriate combined percentage', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TaxCodePicker
        id="tax-rate"
        label="Tax code"
        readiness={{
          ...READY,
          salesStatus: 'ready',
          salesReason: null,
          salesTaxCodes: [{
            qboId: 'SALES_TAX_CODE',
            name: 'Standard sales tax',
            active: true,
            taxable: true,
            combinedPurchaseRate: null,
            combinedSalesRate: 12.25,
          }],
        }}
        value={null}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Tax code' }));
    expect(screen.getByRole('option', { name: 'Standard purchase tax · 5%' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    rerender(
      <TaxCodePicker
        id="tax-rate"
        label="Tax code"
        direction="sales"
        readiness={{
          ...READY,
          salesStatus: 'ready',
          salesReason: null,
          salesTaxCodes: [{
            qboId: 'SALES_TAX_CODE',
            name: 'Standard sales tax',
            active: true,
            taxable: true,
            combinedPurchaseRate: null,
            combinedSalesRate: 12.25,
          }],
        }}
        value={null}
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Tax code' }));
    expect(screen.getByRole('option', { name: 'Standard sales tax · 12.25%' })).toBeInTheDocument();
  });

  it('uses sales readiness and sales tax codes when requested', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TaxCodePicker
        id="sales-tax-code"
        label="Sales tax"
        direction="sales"
        readiness={{
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
        }}
        value={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Sales tax' }));
    const picker = screen.getByRole('textbox', { name: 'Sales tax' });
    expect(screen.getByRole('option', { name: 'Standard sales tax · 5%' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Standard purchase tax' })).not.toBeInTheDocument();
    await user.type(picker, 'standard');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('SALES_TAX_CODE');
  });
});
