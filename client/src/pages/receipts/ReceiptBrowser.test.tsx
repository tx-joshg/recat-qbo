import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  batchApprove: vi.fn(),
  batchReprocess: vi.fn(),
  batchDelete: vi.fn(),
  export: vi.fn(),
  upload: vi.fn(),
  duplicates: vi.fn(),
  toast: vi.fn(),
  role: 'categorizer' as 'viewer' | 'categorizer',
}));

vi.mock('../../lib/api', () => ({
  createCategorizationRequestId: () =>
    '00000000-0000-4000-8000-000000000061',
  receipts: {
    list: mocks.list,
    stats: mocks.stats,
    batchApprove: mocks.batchApprove,
    batchDelete: mocks.batchDelete,
    batchReprocess: mocks.batchReprocess,
    export: mocks.export,
    upload: mocks.upload,
    duplicates: mocks.duplicates,
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    role: mocks.role,
    toast: mocks.toast,
    session: { id: 'user-1', isInstanceAdmin: false },
    sessionLoading: false,
  }),
}));

vi.mock('../../components/Nav', () => ({ default: () => null }));
vi.mock('../../components/Toast', () => ({ default: () => null }));

import ReceiptBrowser from './ReceiptBrowser';
import App from '../../App';

function LocationProbe() {
  return <output aria-label="Current path">{useLocation().pathname}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'categorizer';
  mocks.list.mockResolvedValue({
    receipts: [{
      id: '00000000-0000-4000-8000-000000000071',
      filename: 'synthetic.pdf',
      status: 'READY',
      revision: 2,
      approved: false,
      sourceKind: 'WEB_UPLOAD',
      currentExtraction: {
        vendorName: 'Invented Vendor',
        receiptDate: '2026-07-30',
        totalAmount: '11',
        currency: 'USD',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
    }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  mocks.stats.mockResolvedValue({
    received: 3,
    needsReview: 1,
    queued: 1,
    processing: 0,
    failed: 0,
    totalByCurrency: [{ currency: 'CAD', amount: '24.40' }],
    totalByCategory: [{
      category: 'Synthetic category',
      currency: 'CAD',
      amount: '24.40',
    }],
    totalTaxByCurrency: [{ currency: 'CAD', amount: '2.40' }],
    processingCostUsd: '0.02',
    recentActivity: [],
  });
  mocks.batchApprove.mockResolvedValue({ updated: 1 });
  mocks.batchReprocess.mockResolvedValue({ updated: 1 });
  mocks.batchDelete.mockResolvedValue({ updated: 1 });
  mocks.export.mockResolvedValue(new Blob(['synthetic']));
  mocks.upload.mockResolvedValue({ receipts: [] });
  mocks.duplicates.mockResolvedValue([]);
});

describe('ReceiptBrowser', () => {
  it('refreshes summary totals when polling observes processing completion', async () => {
    let poll: (() => void) | undefined;
    const originalInterval = window.setInterval;
    const timer = vi.spyOn(window, 'setInterval').mockImplementation((handler, delay) => {
      if (delay !== 3_000) return originalInterval(handler, delay) as unknown as ReturnType<typeof window.setInterval>;
      poll = handler as () => void;
      return 123 as unknown as ReturnType<typeof window.setInterval>;
    });
    try {
      const initial = await mocks.list();
      mocks.list.mockClear();
      mocks.list.mockResolvedValueOnce({ ...initial, receipts: initial.receipts.map((receipt: object) => ({ ...receipt, status: 'PROCESSING' })) });
      render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
      await screen.findByText('CAD 24.40');
      await waitFor(() => expect(poll).toBeDefined());
      const stats = await mocks.stats.mock.results[0]!.value;
      mocks.stats.mockResolvedValue({ ...stats, queued: 0, processing: 0, totalByCurrency: [{ currency: 'CAD', amount: '42.00' }] });
      await act(async () => poll!());
      await screen.findByText('CAD 42.00');
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(mocks.stats).toHaveBeenCalledTimes(2);
    } finally {
      timer.mockRestore();
    }
  });

  it('renders dashboard summary and receipt browser in one workspace', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);

    expect(await screen.findByText('Received')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Receipt totals' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tax totals' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add receipts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.queryByText('Spend by category')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dashboard|browse receipts/i }))
      .not.toBeInTheDocument();
  });

  it('keeps receipt sections expanded and applies shared control classes', async () => {
    const view = render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);

    await screen.findByText('synthetic.pdf');
    expect(view.container.querySelector('details')).not.toBeInTheDocument();
    expect(view.container.querySelector('summary')).not.toBeInTheDocument();

    const filtersHeading = screen.getByRole('heading', { name: 'Filters' });
    const uploadHeading = screen.getByRole('heading', { name: 'Add receipts' });
    expect(filtersHeading.closest('section')).toHaveClass('receipt-section');
    expect(uploadHeading.closest('section')).toHaveClass('receipt-section');
    expect(screen.getByRole('region', { name: 'Filters' })).toHaveClass('receipt-section');
    expect(screen.getByRole('region', { name: 'Add receipts' })).toHaveClass('receipt-section');

    for (const name of [
      'Search receipts',
      'Receipt date from',
      'Receipt date to',
      'Document type filter',
    ]) {
      expect(screen.getByLabelText(name)).toHaveClass('text-control');
    }
    for (const name of [
      'Dashboard timeframe',
      'Receipt source filter',
      'Receipt match filter',
      'Sort receipts',
    ]) {
      expect(screen.getByLabelText(name)).toHaveClass('control-trigger');
    }
    expect(screen.getByLabelText('Missing information')).toHaveClass('checkbox-control');
    expect(screen.getByLabelText('Drop receipt files')).toHaveClass('receipt-dropzone');
    expect(view.container.querySelector('input[type="file"]')).toHaveClass('receipt-file-input');
    expect(screen.getByLabelText('Toggle sort direction')).toHaveClass('btn', 'btn-ghost');
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveClass('btn', 'btn-ghost');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveClass('btn', 'btn-ghost');
    for (const button of screen.getAllByRole('button', { name: /^(All|Needs review|Ready|Matched|Attached|Processing|Failed|Duplicates)$/ })) {
      expect(button).toHaveClass('btn');
    }
  });

  it('redirects the legacy dashboard route to the combined receipts workspace', async () => {
    render(
      <MemoryRouter initialEntries={['/receipts/dashboard']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByLabelText('Current path'))
      .toHaveTextContent('/receipts'));
    expect(screen.getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
  });

  it('refreshes the current duplicate mode and stats once after a deferred upload', async () => {
    let resolveUpload!: (result: { receipts: never[] }) => void;
    mocks.upload.mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    mocks.duplicates.mockResolvedValue([{
      key: 'synthetic-group',
      reason: 'document_identity',
      receipts: [{
        id: '00000000-0000-4000-8000-000000000072',
        filename: 'synthetic-copy.pdf',
        status: 'READY',
        revision: 1,
        approved: false,
        sourceKind: 'WEB_UPLOAD',
        createdAt: '2026-07-30T00:00:00.000Z',
      }],
    }]);
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await waitFor(() => {
      expect(mocks.stats).toHaveBeenCalledTimes(1);
      expect(mocks.list).toHaveBeenCalledTimes(1);
    });

    const file = new File(['x'], 'synthetic.png', { type: 'image/png' });
    fireEvent.drop(screen.getByLabelText(/drop receipt files/i), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(
      'company-1',
      [expect.objectContaining({ name: 'synthetic.png' })],
      'WEB_UPLOAD',
    ));
    await userEvent.click(screen.getByRole('button', { name: 'Duplicates' }));
    expect(await screen.findByText('synthetic-copy.pdf')).toBeInTheDocument();
    expect(mocks.duplicates).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpload({ receipts: [] });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.stats).toHaveBeenCalledTimes(2);
      expect(mocks.duplicates).toHaveBeenCalledTimes(2);
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(screen.getByText('synthetic-copy.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the selected rows and current totals visible while an upload refresh is pending', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');
    await screen.findByText('CAD 24.40');
    await user.click(screen.getByRole('checkbox', { name: /select synthetic.pdf/i }));
    const originalList = await mocks.list.mock.results[0]!.value;
    const originalStats = await mocks.stats.mock.results[0]!.value;
    let finishList!: (value: typeof originalList) => void;
    let finishStats!: (value: typeof originalStats) => void;
    mocks.list.mockReturnValueOnce(new Promise((resolve) => { finishList = resolve; }));
    mocks.stats.mockReturnValueOnce(new Promise((resolve) => { finishStats = resolve; }));
    mocks.upload.mockResolvedValueOnce({ receipts: [] });
    fireEvent.drop(screen.getByLabelText(/drop receipt files/i), {
      dataTransfer: { files: [new File(['example'], 'new-example.png', { type: 'image/png' })] },
    });
    await waitFor(() => {
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(mocks.stats).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('checkbox', { name: /select synthetic.pdf/i })).toBeChecked();
    expect(screen.getByText('CAD 24.40')).toBeInTheDocument();
    await act(async () => { finishList(originalList); finishStats(originalStats); });
    expect(screen.getByRole('checkbox', { name: /select synthetic.pdf/i })).toBeChecked();
  });

  it('filters, selects, and batch approves current revisions', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);

    expect(await screen.findByText('synthetic.pdf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Needs review' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({ statuses: ['NEEDS_REVIEW'] }),
    ));
    await userEvent.click(screen.getByRole('checkbox', {
      name: /select synthetic.pdf/i,
    }));
    for (const name of [
      /approve selected/i,
      /reprocess selected/i,
      /export selected/i,
      /delete selected/i,
    ]) {
      expect(screen.getByRole('button', { name })).toHaveClass('btn', 'btn-ghost');
    }
    await userEvent.click(screen.getByRole('button', { name: /approve selected/i }));

    expect(mocks.batchApprove).toHaveBeenCalledWith('company-1', {
      receipts: [{
        id: '00000000-0000-4000-8000-000000000071',
        expectedRevision: 2,
      }],
    });
  });

  it.each(['Approve selected', 'Reprocess selected', 'Delete selected'])(
    'refreshes both the table and summary once after %s', async (action) => {
      const user = userEvent.setup();
      render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
      await screen.findByText('synthetic.pdf');
      await waitFor(() => expect(screen.getByText('Received').closest('section')).toHaveTextContent('3'));
      await user.click(screen.getByRole('checkbox', { name: /select synthetic.pdf/i }));
      mocks.list.mockResolvedValueOnce({ receipts: [], total: 0, page: 1, pageSize: 20 });
      mocks.stats.mockResolvedValueOnce({
        received: 0, needsReview: 0, queued: 0, processing: 0, failed: 0,
        totalByCurrency: [], totalByCategory: [], totalTaxByCurrency: [],
        processingCostUsd: '0', recentActivity: [],
      });
      await user.click(screen.getByRole('button', { name: action }));
      await waitFor(() => {
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(mocks.stats).toHaveBeenCalledTimes(2);
        expect(screen.queryByText('synthetic.pdf')).not.toBeInTheDocument();
        expect(screen.getByText('Received').closest('section')).toHaveTextContent('0');
      });
    },
  );

  it('applies date, type, source, match, and missing-information filters', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');
    await userEvent.type(screen.getByLabelText('Receipt date from'), '2026-07-01');
    await userEvent.type(screen.getByLabelText('Receipt date to'), '2026-07-31');
    await userEvent.type(screen.getByLabelText('Document type filter'), 'receipt');
    await userEvent.click(screen.getByRole('combobox', { name: 'Receipt source filter' }));
    await userEvent.click(screen.getByRole('option', { name: 'Web upload' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Receipt match filter' }));
    await userEvent.click(screen.getByRole('option', { name: 'Unmatched' }));
    await userEvent.click(screen.getByLabelText('Missing information'));

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({
        dateFrom: '2026-07-01',
        dateTo: '2026-07-31',
        documentTypes: ['receipt'],
        sourceKinds: ['WEB_UPLOAD'],
        matched: false,
        missingInfo: true,
      }),
    ));
  });

  it('preserves debounced search and pagination in list queries', async () => {
    const result = await mocks.list();
    mocks.list.mockClear();
    mocks.list.mockResolvedValue({ ...result, total: 21 });
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');

    fireEvent.change(screen.getByLabelText('Search receipts'), {
      target: { value: '  Invented Vendor  ' },
    });
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({ search: 'Invented Vendor', page: 1 }),
    ));

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({ search: 'Invented Vendor', page: 2 }),
    ));
  });

  it('preserves sort field and direction in list queries', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');

    await userEvent.click(screen.getByRole('combobox', { name: 'Sort receipts' }));
    await userEvent.click(screen.getByRole('option', { name: 'Receipt date' }));
    await userEvent.click(screen.getByLabelText('Toggle sort direction'));

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({ sortBy: 'receiptDate', sortOrder: 'asc' }),
    ));
  });

  it('batch reprocesses and deletes using the visible current revision', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    const checkbox = await screen.findByRole('checkbox', {
      name: /select synthetic.pdf/i,
    });
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: /reprocess selected/i }));
    expect(mocks.batchReprocess).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        receipts: [{
          id: '00000000-0000-4000-8000-000000000071',
          expectedRevision: 2,
        }],
      }),
    );

    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(mocks.batchDelete).toHaveBeenCalledWith('company-1', {
      receipts: [{
        id: '00000000-0000-4000-8000-000000000071',
        expectedRevision: 2,
      }],
    });
  });

  it('lets viewers select and export without exposing mutation actions', async () => {
    mocks.role = 'viewer';
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:synthetic-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('checkbox', {
      name: /select synthetic.pdf/i,
    }));

    expect(screen.queryByRole('button', { name: /approve selected/i }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /export selected/i }));
    expect(mocks.export).toHaveBeenCalledWith('company-1', {
      documentIds: ['00000000-0000-4000-8000-000000000071'],
    });
  });

  it('renders duplicate groups with navigable receipt links', async () => {
    const duplicate = {
      ...(await mocks.list()).receipts[0],
      id: '00000000-0000-4000-8000-000000000072',
      filename: 'synthetic-copy.pdf',
    };
    mocks.duplicates.mockResolvedValue([{
      key: 'synthetic-group',
      reason: 'document_identity',
      receipts: [
        (await mocks.list()).receipts[0],
        duplicate,
      ],
    }]);
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Duplicates' }));

    expect(await screen.findByText('same receipt identity')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sort receipts')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Toggle sort direction')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Search receipts')).toBeDisabled();
    expect(screen.getAllByRole('link', { name: 'synthetic-copy.pdf' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          href: expect.stringContaining(
            '/receipts/00000000-0000-4000-8000-000000000072',
          ),
        }),
      ]));
  });
});
