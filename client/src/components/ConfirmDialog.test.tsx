import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog';

function Harness({ busy = false, onCancel = vi.fn() }: { busy?: boolean; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open confirmation</button>
    <ConfirmDialog
      open={open}
      title="Confirm classification"
      confirmLabel="Confirm"
      busy={busy}
      onConfirm={vi.fn()}
      onCancel={() => { onCancel(); setOpen(false); }}
    >Review the classification.</ConfirmDialog>
  </>;
}

describe('ConfirmDialog accessibility', () => {
  it('labels the modal, focuses it, traps focus, and restores the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open confirmation' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Confirm classification' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(cancel).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('ignores Escape, backdrop, and cancellation while busy', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<Harness busy onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('uses the latest cancel callback on idle Escape and restores the opener', async () => {
    const firstCancel = vi.fn();
    const latestCancel = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Harness onCancel={firstCancel} />);
    const opener = screen.getByRole('button', { name: 'Open confirmation' });
    await user.click(opener);

    rerender(<Harness onCancel={latestCancel} />);
    await user.keyboard('{Escape}');

    expect(firstCancel).not.toHaveBeenCalled();
    expect(latestCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('wraps reverse tab navigation when the dialog container has focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm classification' });
    dialog.focus();
    expect(dialog).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
  });

  it('focuses the dialog and contains tab navigation when opened busy', async () => {
    const user = userEvent.setup();
    render(<Harness busy />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm classification' });
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();
  });
});
