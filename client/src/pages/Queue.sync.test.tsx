import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionDto } from '@recat/shared';

const context = vi.hoisted(() => ({
  companyId: 'company-a',
  companyName: 'Example company',
  toast: vi.fn(),
  refreshCompanies: vi.fn(),
  setPendingCount: vi.fn(),
  accounts: [],
  tags: [],
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: {
      id: context.companyId,
      nickname: context.companyName,
      holdingAccountIds: [],
      lastSyncedAt: null,
    },
    activeCompanyId: context.companyId,
    role: 'admin',
    accounts: context.accounts,
    tags: context.tags,
    dryRun: false,
    tagsRequired: false,
    taxReadiness: null,
    toast: context.toast,
    refreshCompanies: context.refreshCompanies,
    setPendingCount: context.setPendingCount,
  }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => vi.fn(),
}));
// Supplementary status reads are independent of the Queue's manual sync flow.
vi.mock('./settings/AutopilotCard', () => ({ AutopilotQueueStatus: () => null }));

import Queue from './Queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function row(companyId: string, payee: string): TransactionDto {
  return {
    id: `${companyId}-transaction`, companyId, qboId: '101', qboType: 'Purchase',
    date: '2026-09-01', payee, memo: null, amount: -12, bankAccount: 'Operating account',
    status: 'PENDING', revision: 0, category: null, categoryQboId: null,
    taxCalculation: null, taxCode: null, taxCodeQboId: null, splits: null, tagIds: [],
    suggestion: null, error: null, postedAt: null, postedBy: null,
    activeCategorizationAttempt: null,
  };
}

const fetchMock = vi.fn<typeof fetch>();
const reads = vi.fn<(companyId: string) => Promise<Response>>();
const sync = vi.fn<(companyId: string) => Promise<Response>>();

beforeEach(() => {
  context.companyId = 'company-a';
  context.companyName = 'Example company';
  context.toast.mockReset();
  context.refreshCompanies.mockReset().mockResolvedValue(undefined);
  context.setPendingCount.mockReset();
  reads.mockReset().mockImplementation(async (companyId) => json({
    transactions: [row(companyId, companyId === 'company-a' ? 'First supplier' : 'Second supplier')],
    pendingCount: 1, nextCursor: null,
  }));
  sync.mockReset().mockResolvedValue(json({ ok: true, message: 'No new transactions', lastSyncedAt: null }));
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const match = /^\/api\/companies\/([^/]+)\/(transactions|sync)$/.exec(String(input));
    if (!match) throw new Error(`Unexpected test request: ${String(input)}`);
    if (match[2] === 'sync') {
      expect(init?.method).toBe('POST');
      return sync(match[1]!);
    }
    expect(init?.method).toBe('GET');
    return reads(match[1]!);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => vi.unstubAllGlobals());

function KeyedQueue() {
  return <Queue key={context.companyId} />;
}

async function renderQueue(keyed = false) {
  const view = render(keyed ? <KeyedQueue /> : <Queue />);
  await screen.findByText('First supplier');
  return view;
}

const success = () => json({
  ok: true, message: '1 new transaction', lastSyncedAt: '2026-09-01T17:00:00.000Z',
});

describe('Queue manual sync', () => {
  it('shows immediate busy feedback and sends only one request for a double click', async () => {
    const pending = deferred<Response>();
    sync.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    await renderQueue();
    const button = screen.getByRole('button', { name: /sync now/i });
    try {
      await user.dblClick(button);
      expect(sync).toHaveBeenCalledExactlyOnceWith('company-a');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).toHaveTextContent('Syncing…');
    } finally {
      await act(async () => pending.resolve(success()));
    }
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('treats an HTTP-success ok:false body as failure without refreshing the Queue', async () => {
    sync.mockResolvedValueOnce(json({
      ok: false, message: 'Provider connection timed out.', lastSyncedAt: null,
    }));
    const user = userEvent.setup();
    await renderQueue();
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(context.toast).toHaveBeenCalledWith(
      'Sync failed for Example company — Provider connection timed out.',
    ));
    expect(reads).toHaveBeenCalledTimes(1);
    expect(context.refreshCompanies).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
  });

  it('refreshes rows and company data only after a successful sync', async () => {
    const user = userEvent.setup();
    await renderQueue();
    sync.mockResolvedValueOnce(success());
    reads.mockResolvedValueOnce(json({
      transactions: [row('company-a', 'Fresh supplier')], pendingCount: 1, nextCursor: null,
    }));
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    expect(await screen.findByText('Fresh supplier')).toBeInTheDocument();
    expect(context.refreshCompanies).toHaveBeenCalledOnce();
    expect(context.toast).toHaveBeenCalledWith('Synced Example company — 1 new transaction');
  });

  it('releases the sync lock after a transport failure so the user can retry', async () => {
    const user = userEvent.setup();
    await renderQueue();
    sync.mockRejectedValueOnce(new Error('Network offline'));
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(context.toast).toHaveBeenCalledWith(
      'Sync failed for Example company — Network offline',
    ));
    expect(reads).toHaveBeenCalledTimes(1);
    sync.mockResolvedValueOnce(success());
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(context.toast).toHaveBeenCalledWith('Synced Example company — 1 new transaction'));
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a failed Queue refresh from the successful sync that preceded it', async () => {
    const user = userEvent.setup();
    await renderQueue();
    sync.mockResolvedValueOnce(success());
    reads.mockRejectedValueOnce(new Error('Queue read unavailable'));
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(context.toast).toHaveBeenCalledWith(
      'Synced Example company, but Queue refresh failed — Queue read unavailable',
    ));
    expect(screen.getByText('First supplier')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
    expect(context.refreshCompanies).toHaveBeenCalledOnce();
  });

  it('refreshes company metadata but drops rows and notifications for the company the user left', async () => {
    const pending = deferred<Response>();
    sync.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const view = await renderQueue();
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    try {
      context.companyId = 'company-b';
      context.companyName = 'Other company';
      view.rerender(<Queue />);
      await screen.findByText('Second supplier');
      expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
    } finally {
      await act(async () => pending.resolve(success()));
    }
    expect(reads).toHaveBeenCalledTimes(2);
    expect(context.toast).not.toHaveBeenCalled();
    expect(context.refreshCompanies).toHaveBeenCalledOnce();
    expect(screen.queryByText('First supplier')).not.toBeInTheDocument();
  });

  it('keeps the company lock across remounts and releases it when the old request finishes', async () => {
    const pending = deferred<Response>();
    sync.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const view = await renderQueue(true);
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    try {
      context.companyId = 'company-b';
      context.companyName = 'Other company';
      view.rerender(<KeyedQueue />);
      await screen.findByText('Second supplier');
      expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
      context.companyId = 'company-a';
      context.companyName = 'Example company';
      view.rerender(<KeyedQueue />);
      await screen.findByText('First supplier');
      const returningButton = screen.getByRole('button', { name: /syncing/i });
      expect(returningButton).toBeDisabled();
      expect(returningButton).toHaveAttribute('aria-busy', 'true');
      await user.click(returningButton);
      expect(sync).toHaveBeenCalledExactlyOnceWith('company-a');
    } finally {
      await act(async () => pending.resolve(success()));
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled());
    expect(context.toast).not.toHaveBeenCalled();
    expect(context.refreshCompanies).toHaveBeenCalledOnce();
  });
});
