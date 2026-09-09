import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { ReadFailureCard } from './ReadFailureCard';

describe('ReadFailureCard', () => {
  it('shows context/reference and calls retry', async () => {
    const retry = vi.fn();
    render(
      <ReadFailureCard
        title="Profit & Loss could not load"
        context="September 2026 · Cash basis"
        error={new ApiError(504, 'QuickBooks did not respond before this report request timed out.', 'QBO_REPORT_TIMEOUT', undefined, '8c9ed2fd-f3e0-4f6c-8784-41464977d558')}
        onRetry={retry}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Profit & Loss could not load');
    expect(screen.getByText('September 2026 · Cash basis')).toBeVisible();
    expect(screen.getByText('Reference: 8c9ed2fd-f3e0-4f6c-8784-41464977d558')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not show a reference when there is no API error', () => {
    render(
      <ReadFailureCard
        title="Dashboard could not load"
        context="September 2026"
        error={null}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByText(/^Reference:/)).not.toBeInTheDocument();
  });
});
