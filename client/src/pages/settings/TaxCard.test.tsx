import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, TaxReadinessDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  role: 'admin' as Role,
  readiness: {
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
    }],
    salesStatus: 'needs_setup',
    salesReason: null,
    salesTaxCodes: [],
  } as TaxReadinessDto | null,
  loading: false,
  refresh: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    role: mocks.role,
    taxReadiness: mocks.readiness,
    taxReadinessLoading: mocks.loading,
    refreshTaxReferences: mocks.refresh,
    toast: mocks.toast,
  }),
}));

import TaxCard from './TaxCard';

const initialReadiness = structuredClone(mocks.readiness);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'admin';
  mocks.readiness = structuredClone(initialReadiness);
  mocks.loading = false;
  mocks.refresh.mockResolvedValue(undefined);
});

describe('TaxCard', () => {
  it('shows readiness and lets an admin refresh references', async () => {
    render(<TaxCard />);

    expect(screen.getByText(/purchase tax ready/i)).toBeInTheDocument();
    expect(screen.getByText(/1 usable purchase tax code/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /refresh tax references/i }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('shows readiness read-only to non-admin members', () => {
    mocks.role = 'categorizer';
    render(<TaxCard />);

    expect(screen.getByText(/purchase tax ready/i)).toBeInTheDocument();
    expect(screen.getByText(/only company administrators can refresh/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh tax references/i })).not.toBeInTheDocument();
  });
  it('displays the server refresh timestamp with its full date, time, and machine-readable value', () => {
    const { container } = render(<TaxCard />);
    expect(screen.getByText(/last refreshed/i)).toBeInTheDocument();
    const timestamp = container.querySelector('time');
    expect(timestamp).toHaveAttribute('datetime', '2026-07-28T00:00:00.000Z');
    expect(timestamp).toHaveTextContent('2026');
    expect(timestamp?.textContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it.each([null, '', 'invalid-timestamp'])('does not invent a refresh time from %s', (refreshedAt) => {
    mocks.readiness = { ...initialReadiness!, refreshedAt };
    const { container } = render(<TaxCard />);
    expect(container.querySelector('time')).toBeNull();
    expect(screen.queryByText(/last refreshed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
  });

  it('does not show a timestamp when readiness is unavailable or still loading', () => {
    mocks.readiness = null;
    mocks.loading = true;
    const { container, rerender } = render(<TaxCard />);
    expect(container.querySelector('time')).toBeNull();
    mocks.loading = false;
    rerender(<TaxCard />);
    expect(container.querySelector('time')).toBeNull();
  });

  it('retains the last server refresh time when a new refresh fails', async () => {
    mocks.refresh.mockRejectedValueOnce(new Error('Synthetic refresh failure'));
    const { container } = render(<TaxCard />);
    await userEvent.click(screen.getByRole('button', { name: /refresh tax references/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Synthetic refresh failure'));
    expect(container.querySelector('time')).toHaveAttribute('datetime', initialReadiness!.refreshedAt);
  });

  it('does not advance the displayed time merely because the refresh promise resolves', async () => {
    const { container } = render(<TaxCard />);
    await userEvent.click(screen.getByRole('button', { name: /refresh tax references/i }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(container.querySelector('time')).toHaveAttribute('datetime', initialReadiness!.refreshedAt);
  });

  it('updates the displayed time when refreshed readiness arrives from the server', () => {
    const { container, rerender } = render(<TaxCard />);
    mocks.readiness = { ...initialReadiness!, refreshedAt: '2026-08-02T13:24:35.000Z' };
    rerender(<TaxCard />);
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-08-02T13:24:35.000Z');
  });

  it('drops the previous company timestamp when context clears on a company switch', () => {
    const { container, rerender } = render(<TaxCard />);
    expect(container.querySelector('time')).toHaveAttribute('datetime', initialReadiness!.refreshedAt);
    mocks.readiness = null;
    mocks.loading = true;
    rerender(<TaxCard />);
    expect(container.querySelector('time')).toBeNull();
    mocks.readiness = { ...initialReadiness!, refreshedAt: '2025-12-01T12:00:00.000Z' };
    mocks.loading = false;
    rerender(<TaxCard />);
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2025-12-01T12:00:00.000Z');
  });

});
