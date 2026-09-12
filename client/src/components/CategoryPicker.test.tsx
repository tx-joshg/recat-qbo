import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CategoryPicker, { type CategoryOption } from './CategoryPicker';

// @ts-expect-error exported category options always carry a stable value
const MISSING_STABLE_CATEGORY_VALUE: CategoryOption = {
  group: 'Expenses',
  name: 'Office expense',
  sug: false,
};
void MISSING_STABLE_CATEGORY_VALUE;

function SplitFooterHarness() {
  const [splitOpen, setSplitOpen] = useState(false);

  return <div className="rr">
    <CategoryPicker
      label="Category"
      value={null}
      onPick={vi.fn()}
      onSplitFooter={() => setSplitOpen(true)}
      showBadges={false}
      options={[]}
    />
    {splitOpen && <div role="dialog" aria-label="Split transaction">Split editor</div>}
  </div>;
}

describe('CategoryPicker', () => {
  it('searches grouped categories, marks the suggested option, and selects its stable value', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><CategoryPicker label="Category for Northwind" value={null} onPick={onPick} showBadges triggerText="Choose category…" options={[{ value: 'expense-office', group: 'Expenses', name: 'Office expense', sug: true }, { value: 'expense-travel', group: 'Expenses', name: 'Travel', sug: false }]} /></div>);

    expect(screen.getByRole('combobox', { name: 'Category for Northwind' })).not.toHaveAccessibleDescription();
    await user.click(screen.getByRole('combobox', { name: 'Category for Northwind' }));
    await user.type(screen.getByRole('textbox', { name: 'Category for Northwind' }), 'office');
    expect(screen.getByText('suggested')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('expense-office');
  });

  it('keeps the split footer specialized and routes it without selecting a category', async () => {
    const onSplitFooter = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><CategoryPicker label="Category" value={null} onPick={vi.fn()} onSplitFooter={onSplitFooter} showBadges={false} options={[]} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(screen.getByRole('button', { name: /split into multiple categories/i }));
    expect(onSplitFooter).toHaveBeenCalledTimes(1);
  });

  it('closes its portalled menu before opening the split editor', async () => {
    const user = userEvent.setup();
    render(<SplitFooterHarness />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const search = screen.getByRole('textbox', { name: 'Category' });
    expect(search).toHaveFocus();

    await user.click(screen.getByRole('button', { name: /split into multiple categories/i }));

    expect(screen.getByRole('dialog', { name: 'Split transaction' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Category' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Category' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(search);
  });

  it('connects each non-selected trigger description through a unique id', () => {
    render(
      <div className="rr">
        <CategoryPicker label="Category for Northwind" value={null} onPick={vi.fn()} showBadges={false} triggerText="Office expense" triggerBadge="rule" triggerBadgeTooltip="Matched 2 rules — “office supply” won (topmost). Reorder in Rules." options={[]} />
        <CategoryPicker label="Category for Contoso" value={null} onPick={vi.fn()} showBadges={false} triggerText="Travel" triggerBadge="suggested" options={[]} />
      </div>,
    );

    const northwind = screen.getByRole('combobox', { name: 'Category for Northwind' });
    const contoso = screen.getByRole('combobox', { name: 'Category for Contoso' });
    expect(northwind).toHaveAccessibleDescription('Suggested category: Office expense. Suggested by rule. Matched 2 rules — “office supply” won (topmost). Reorder in Rules.');
    expect(contoso).toHaveAccessibleDescription('Suggested category: Travel. Suggested.');
    expect(northwind).toHaveAttribute('aria-describedby');
    expect(contoso).toHaveAttribute('aria-describedby');
    expect(northwind.getAttribute('aria-describedby')).not.toBe(contoso.getAttribute('aria-describedby'));
  });
});
