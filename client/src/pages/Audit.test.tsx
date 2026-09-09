import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntryDto } from '@recat/shared';
import Audit from './Audit';

const mocks = vi.hoisted(() => ({ companyId: 'company-a' as string | null, revision: 0, list: vi.fn(), legacyUndo: vi.fn(), durableUndo: vi.fn(), toast: vi.fn(), notify: vi.fn(), requestId: vi.fn() }));
vi.mock('../state/AppContext', () => ({ useApp: () => ({ activeCompanyId: mocks.companyId, qboMutationRevision: mocks.revision, notifyQboMutation: mocks.notify, toast: mocks.toast }) }));
vi.mock('./settings/AutopilotCard', () => ({ AutopilotQueueStatus: () => null }));
vi.mock('../lib/api', () => ({ audit: { list: mocks.list, exportUrl: () => '/synthetic-export' }, transactions: { undo: mocks.legacyUndo, undoCategorization: mocks.durableUndo }, createCategorizationRequestId: mocks.requestId }));
function entry(overrides: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return { id: 'entry-a', companyId: 'company-a', transactionId: 'transaction-a', at: '2026-09-01T12:00:00.000Z', actor: 'Example user', payee: 'Example supplier', amount: -10, action: 'posted', before: 'Holding', after: 'Expense', undo: { kind: 'categorization' }, ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { vi.clearAllMocks(); mocks.companyId = 'company-a'; mocks.revision = 0; mocks.list.mockResolvedValue({ entries: [entry()], nextCursor: null }); mocks.requestId.mockReturnValue('request-example'); vi.spyOn(window, 'confirm').mockReturnValue(true); });

describe('Audit guarded Undo', () => {
  it('confirms and sends durable Undo once, then reports verified REVERTED without claiming Queue return', async () => {
    const pending = deferred<unknown>(); mocks.durableUndo.mockReturnValue(pending.promise);
    render(<Audit />); const button = await screen.findByRole('button', { name: 'Undo Example supplier' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(mocks.durableUndo).toHaveBeenCalledExactlyOnceWith('transaction-a', 'request-example');
    expect(button).toBeDisabled();
    await act(async () => pending.resolve({ ok: true, status: 'REVERTED', outcome: 'VERIFIED' }));
    expect(mocks.notify).toHaveBeenCalledWith('company-a', ['transaction-a']);
    expect(mocks.toast).toHaveBeenCalledWith('Undo verified in QuickBooks.');
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/back to the queue/i));
  });
  it('does not allocate an Undo request when confirmation is cancelled', async () => {
    vi.mocked(window.confirm).mockReturnValue(false); render(<Audit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Example supplier' }));
    expect(mocks.requestId).not.toHaveBeenCalled(); expect(mocks.durableUndo).not.toHaveBeenCalled();
  });
  it('keeps Undo locked when the Audit search changes during a request', async () => {
    const pending = deferred<unknown>(); mocks.durableUndo.mockReturnValue(pending.promise); render(<Audit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Example supplier' }));
    fireEvent.change(screen.getByPlaceholderText(/Search anything/), { target: { value: 'Example' } });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    const button = await screen.findByRole('button', { name: 'Undo Example supplier' });
    expect(button).toBeDisabled(); fireEvent.click(button); expect(mocks.durableUndo).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ok: true, status: 'REVERTED', outcome: 'VERIFIED' }));
  });
  it('uses the legacy API for a dry-run reset without allocating a durable ID', async () => {
    mocks.list.mockResolvedValue({ entries: [entry({ action: 'dry-run', undo: { kind: 'legacy' } })], nextCursor: null }); mocks.legacyUndo.mockResolvedValue({ status: 'PENDING' });
    render(<Audit />); fireEvent.click(await screen.findByRole('button', { name: 'Undo Example supplier' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Dry run moved back to the queue.'));
    expect(mocks.legacyUndo).toHaveBeenCalledWith('transaction-a'); expect(mocks.requestId).not.toHaveBeenCalled();
  });
  it.each(['IN_PROGRESS', 'UNCHANGED', 'UNCERTAIN'] as const)('does not claim success for %s', async outcome => {
    mocks.durableUndo.mockResolvedValue({ ok: false, status: 'PENDING', outcome }); render(<Audit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Example supplier' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled()); expect(mocks.toast).not.toHaveBeenCalledWith('Undo verified in QuickBooks.');
  });
  it('does not render raw payload or offer Undo without server eligibility', async () => {
    mocks.list.mockResolvedValue({ entries: [entry({ undo: undefined, payload: { raw: 'synthetic-private-payload' } })], nextCursor: null });
    render(<Audit />); await screen.findByText('Example supplier'); expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument(); expect(document.body).not.toHaveTextContent('synthetic-private-payload');
  });
  it('rejects late list responses after switching to no company', async () => {
    const pending = deferred<unknown>(); mocks.list.mockReturnValue(pending.promise); const view = render(<Audit />);
    mocks.companyId = null; view.rerender(<Audit />); await act(async () => pending.resolve({ entries: [entry()], nextCursor: null }));
    expect(screen.queryByText('Example supplier')).not.toBeInTheDocument();
  });
  it('fences Undo UI feedback after company switch while invalidating the original company', async () => {
    const pending = deferred<unknown>(); mocks.durableUndo.mockReturnValue(pending.promise); const view = render(<Audit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Example supplier' })); mocks.companyId = 'company-b'; mocks.list.mockResolvedValue({ entries: [], nextCursor: null }); view.rerender(<Audit />);
    await act(async () => pending.resolve({ ok: true, status: 'REVERTED', outcome: 'VERIFIED' })); expect(mocks.toast).not.toHaveBeenCalled(); expect(mocks.notify).toHaveBeenCalledWith('company-a', ['transaction-a']);
  });
  it('fences Undo UI feedback after unmount while invalidating the original company', async () => {
    const pending = deferred<unknown>(); mocks.durableUndo.mockReturnValue(pending.promise); const view = render(<Audit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Example supplier' })); view.unmount();
    await act(async () => pending.resolve({ ok: true, status: 'REVERTED', outcome: 'VERIFIED' })); expect(mocks.toast).not.toHaveBeenCalled(); expect(mocks.notify).toHaveBeenCalledWith('company-a', ['transaction-a']);
  });
});


it('renders blocked actions with the amber caution pill', async () => {
  mocks.list.mockResolvedValue({ entries: [entry({ action: 'blocked', undo: undefined })], nextCursor: null });
  render(<Audit />);
  expect(await screen.findByText('blocked', { exact: true })).toHaveStyle({ color: 'var(--amT)' });
});
