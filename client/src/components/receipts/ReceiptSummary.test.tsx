import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  receipts: {
    stats: mocks.stats,
  },
}));

import ReceiptSummary from './ReceiptSummary';

const stats = {
  received: 3,
  needsReview: 1,
  queued: 1,
  processing: 2,
  failed: 4,
  totalByCurrency: [
    { currency: 'CAD', amount: '24.40' },
    { currency: 'USD', amount: '10.00' },
  ],
  totalByCategory: [{
    category: 'Synthetic category',
    currency: 'CAD',
    amount: '24.40',
  }],
  totalTaxByCurrency: [{ currency: 'CAD', amount: '2.40' }],
  processingCostUsd: '0.02',
  recentActivity: [{
    id: 'event-1',
    action: 'EXTRACTION_COMPLETED',
    createdAt: '2026-07-30T12:00:00.000Z',
  }],
};

function renderSummary(refreshKey = 0) {
  return render(
    <ReceiptSummary
      companyId="company-1"
      refreshKey={refreshKey}
      toast={mocks.toast}
      uploadSection={(
        <section aria-label="Injected upload">
          <h2>Add receipts</h2>
        </section>
      )}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  mocks.stats.mockResolvedValue(stats);
});

afterEach(() => vi.unstubAllGlobals());

describe('ReceiptSummary', () => {
  it('renders receipt and tax totals around the supplied upload section', async () => {
    renderSummary();

    expect(await screen.findByText('CAD 24.40')).toBeInTheDocument();
    expect(screen.getByText('USD 10.00')).toBeInTheDocument();
    expect(screen.getByText('Processing cost: USD 0.02')).toBeInTheDocument();
    expect(screen.getByText(/EXTRACTION COMPLETED/)).toBeInTheDocument();
    expect(screen.queryByText('Spend by category')).not.toBeInTheDocument();
    expect(screen.queryByText(/Synthetic category/)).not.toBeInTheDocument();

    const upload = screen.getByRole('heading', { name: 'Add receipts' });
    const recent = screen.getByRole('heading', { name: 'Recent activity' });
    expect(upload.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('persists a selected timeframe and restores it on remount', async () => {
    const user = userEvent.setup();
    const view = renderSummary();
    await screen.findByText('CAD 24.40');
    await user.click(screen.getByRole('combobox', { name: 'Dashboard timeframe' }));
    await user.click(screen.getByRole('option', { name: 'All time' }));
    await waitFor(() => expect(mocks.stats).toHaveBeenLastCalledWith('company-1', {}));
    view.unmount();
    renderSummary();
    expect(screen.getByRole('combobox', { name: 'Dashboard timeframe' })).toHaveTextContent('All time');
  });

  it('uses the saved timeframe and reloads once when refreshKey changes', async () => {
    localStorage.setItem('recat_receipt_dashboard_timeframe:company-1', 'all');
    const view = renderSummary();

    await waitFor(() => expect(mocks.stats).toHaveBeenCalledTimes(1));
    expect(mocks.stats).toHaveBeenLastCalledWith('company-1', {});
    expect(screen.getByLabelText('Dashboard timeframe')).toHaveTextContent('All time');

    view.rerender(
      <ReceiptSummary
        companyId="company-1"
        refreshKey={1}
        toast={mocks.toast}
        uploadSection={<section><h2>Add receipts</h2></section>}
      />,
    );

    await waitFor(() => expect(mocks.stats).toHaveBeenCalledTimes(2));
  });
});
