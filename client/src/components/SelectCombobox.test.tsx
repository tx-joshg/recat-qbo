import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, Select, type ControlOption } from './SelectCombobox';

const OPTIONS: ControlOption[] = [
  { value: 'all', label: 'All accounts', searchText: 'all every' },
  { value: 'bank', label: 'Operating bank', searchText: 'checking operating' },
  { value: 'archive', label: 'Archived account', disabled: true },
];

async function waitForAnimationFrames(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

describe('Select', () => {
  it('opens a labelled listbox, selects with the keyboard, and restores focus after Escape', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><Select label="Account filter" value="all" options={OPTIONS} onValueChange={onValueChange} /></div>);

    const trigger = screen.getByRole('combobox', { name: 'Account filter' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Account filter' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('bank');

    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses type-ahead, never selects disabled options, and exposes the selected option', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><Select label="Account filter" value="all" options={OPTIONS} onValueChange={onValueChange} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
    expect(screen.getByRole('option', { name: 'Archived account' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('oper{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('bank');
  });
});

describe('Combobox', () => {
  it('copies the source theme to the portaled control scope', async () => {
    const user = userEvent.setup();
    render(<div className="rr" data-theme="dark"><Combobox
      label="Category"
      value={null}
      options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]}
      onValueChange={vi.fn()}
    /></div>);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox').closest('.rr')).toHaveAttribute('data-theme', 'dark');
  });

  it('keeps document scroll fixed while navigating options', async () => {
    const user = userEvent.setup();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 2600 });
      render(<div className="rr" data-theme="dark"><Combobox
        label="Category"
        value={null}
        options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]}
        onValueChange={vi.fn()}
      /></div>);

      await user.click(screen.getByRole('combobox'));
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(window.scrollY).toBe(2600);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
      else delete (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView;
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
      else delete (window as { scrollY?: number }).scrollY;
    }
  });

  it('keeps a navigated option inside the listbox viewport when the listbox has an offset', async () => {
    const user = userEvent.setup();
    render(<div className="rr"><Combobox
      label="Category"
      value={null}
      options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]}
      onValueChange={vi.fn()}
    /></div>);

    await user.click(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    const option = screen.getByRole('option', { name: 'Two' });
    const originalClientHeight = Object.getOwnPropertyDescriptor(listbox, 'clientHeight');
    const originalListboxOffsetTop = Object.getOwnPropertyDescriptor(listbox, 'offsetTop');
    const originalOptionOffsetTop = Object.getOwnPropertyDescriptor(option, 'offsetTop');
    const originalOptionOffsetHeight = Object.getOwnPropertyDescriptor(option, 'offsetHeight');
    Object.defineProperties(listbox, {
      clientHeight: { configurable: true, value: 40 },
      offsetTop: { configurable: true, value: 30 },
    });
    Object.defineProperties(option, {
      offsetTop: { configurable: true, value: 100 },
      offsetHeight: { configurable: true, value: 20 },
    });
    const listboxRect = vi.spyOn(listbox, 'getBoundingClientRect').mockReturnValue({
      top: 200, bottom: 240, height: 40,
    } as DOMRect);
    const optionRect = vi.spyOn(option, 'getBoundingClientRect').mockImplementation(() => ({
      top: 270 - listbox.scrollTop,
      bottom: 290 - listbox.scrollTop,
      height: 20,
    } as DOMRect));

    try {
      listbox.scrollTop = 0;
      await user.keyboard('{ArrowDown}');

      const listboxBounds = listbox.getBoundingClientRect();
      const optionBounds = option.getBoundingClientRect();
      expect(optionBounds.top).toBeGreaterThanOrEqual(listboxBounds.top);
      expect(optionBounds.bottom).toBeLessThanOrEqual(listboxBounds.bottom);
    } finally {
      listboxRect.mockRestore();
      optionRect.mockRestore();
      if (originalClientHeight) Object.defineProperty(listbox, 'clientHeight', originalClientHeight);
      else delete (listbox as { clientHeight?: number }).clientHeight;
      if (originalListboxOffsetTop) Object.defineProperty(listbox, 'offsetTop', originalListboxOffsetTop);
      else delete (listbox as { offsetTop?: number }).offsetTop;
      if (originalOptionOffsetTop) Object.defineProperty(option, 'offsetTop', originalOptionOffsetTop);
      else delete (option as { offsetTop?: number }).offsetTop;
      if (originalOptionOffsetHeight) Object.defineProperty(option, 'offsetHeight', originalOptionOffsetHeight);
      else delete (option as { offsetHeight?: number }).offsetHeight;
    }
  });

  it('keeps the selected option visible when reopening the same selection', async () => {
    const user = userEvent.setup();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('control-options') ? 20 : 0;
    });
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('control-options')) return new DOMRect(0, 100, 200, 20);
      if (this.classList.contains('control-option')) {
        const index = Number(this.id.split('-').at(-1));
        return new DOMRect(0, 100 + index * 20 - (this.parentElement?.scrollTop ?? 0), 200, 20);
      }
      return originalRect.call(this);
    });
    try {
      render(<div className="rr"><Combobox label="Account" value="bank" options={OPTIONS} onValueChange={vi.fn()} /></div>);
      const trigger = screen.getByRole('combobox', { name: 'Account' });
      await user.click(trigger);
      await user.keyboard('{Escape}');
      await user.click(trigger);

      const listbox = screen.getByRole('listbox', { name: 'Account' });
      const selected = screen.getByRole('option', { name: 'Operating bank' });
      expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(listbox.getBoundingClientRect().top);
      expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(listbox.getBoundingClientRect().bottom);
    } finally {
      bounds.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it('focuses its search input, filters options, renders an explicit empty state, and clears only when allowed', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="bank" options={OPTIONS} onValueChange={onValueChange} allowClear searchPlaceholder="Search categories" emptyText="No matching categories" /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const input = screen.getByRole('textbox', { name: 'Category' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'missing');
    expect(screen.getByText('No matching categories')).toBeInTheDocument();
    await user.clear(input);
    await user.click(screen.getByRole('option', { name: 'Clear selection' }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it('renders custom option presentation and footer inside the portalled menu', async () => {
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="all" options={OPTIONS} onValueChange={vi.fn()} renderOption={(option) => <><span>{option.label}</span>{option.value === 'bank' && <em>suggested</em>}</>} footer={<button type="button">Split into multiple categories</button>} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(screen.getByText('suggested')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Split into multiple categories' })).toBeInTheDocument();
  });

  it.each(['trigger', 'footer'] as const)('preserves %s focus across parent rerenders while the menu is open', async (target) => {
    const user = userEvent.setup();
    const control = () => <div className="rr"><Combobox
      label="Category"
      value="all"
      options={OPTIONS.map((option) => ({ ...option }))}
      onValueChange={vi.fn()}
      footer={<button type="button">Footer action</button>}
    /></div>;
    const { rerender } = render(control());
    const trigger = screen.getByRole('combobox', { name: 'Category' });
    await user.click(trigger);
    expect(screen.getByRole('textbox', { name: 'Category' })).toHaveFocus();
    const focused = target === 'trigger'
      ? trigger
      : screen.getByRole('button', { name: 'Footer action' });
    focused.focus();
    rerender(control());
    await waitForAnimationFrames();

    expect(focused).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    await user.click(trigger);
    await waitForAnimationFrames();
    expect(screen.getByRole('textbox', { name: 'Category' })).toHaveFocus();
  });

  it('does not restore a dismissed control focus over a newly opened control or unrelated field', async () => {
    const user = userEvent.setup();
    render(
      <div className="rr">
        <Combobox label="First category" value="all" options={OPTIONS} onValueChange={vi.fn()} />
        <Combobox label="Second category" value="all" options={OPTIONS} onValueChange={vi.fn()} />
        <input aria-label="Unrelated field" />
      </div>,
    );

    await user.click(screen.getByRole('combobox', { name: 'First category' }));
    expect(screen.getByRole('textbox', { name: 'First category' })).toHaveFocus();

    const secondTrigger = screen.getByRole('combobox', { name: 'Second category' });
    await user.click(secondTrigger);
    const secondInput = screen.getByRole('textbox', { name: 'Second category' });
    await waitForAnimationFrames();
    expect(secondTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(secondInput).toHaveFocus();

    const unrelatedField = screen.getByRole('textbox', { name: 'Unrelated field' });
    await user.click(unrelatedField);
    await waitForAnimationFrames();
    expect(unrelatedField).toHaveFocus();
  });

  it('dismisses a portalled menu after an outside pointer interaction', async () => {
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="all" options={OPTIONS} onValueChange={vi.fn()} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(screen.getByRole('listbox', { name: 'Category' })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('listbox', { name: 'Category' })).not.toBeInTheDocument();
  });

  it('dismisses after an inside search interaction and keeps focus on an outside field', async () => {
    const user = userEvent.setup();
    let insidePointerDowns = 0;
    render(
      <div className="rr" onPointerDown={() => { insidePointerDowns += 1; }}>
        <Combobox label="Category" value="all" options={OPTIONS} onValueChange={vi.fn()} />
        <input aria-label="Outside field" />
      </div>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    insidePointerDowns = 0;
    await user.click(screen.getByRole('textbox', { name: 'Category' }));
    expect(insidePointerDowns).toBeGreaterThan(0);
    const outsideField = screen.getByRole('textbox', { name: 'Outside field' });
    fireEvent.pointerDown(outsideField);
    outsideField.focus();
    fireEvent.pointerUp(outsideField);
    fireEvent.click(outsideField);

    expect(screen.queryByRole('listbox', { name: 'Category' })).not.toBeInTheDocument();
    expect(outsideField).toHaveFocus();
  });

  it('keeps the active listbox option programmatically associated with its focused search input', async () => {
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="all" options={OPTIONS} onValueChange={vi.fn()} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const input = screen.getByRole('textbox', { name: 'Category' });
    await user.keyboard('{ArrowDown}');

    const listbox = screen.getByRole('listbox', { name: 'Category' });
    const activeOptionId = input.getAttribute('aria-activedescendant');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(activeOptionId).not.toBeNull();
    expect(document.getElementById(activeOptionId!)).toHaveAttribute('role', 'option');
  });
});
