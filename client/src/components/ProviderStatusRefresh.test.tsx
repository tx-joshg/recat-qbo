import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ProviderActionabilityRefreshResult } from '@recat/shared';
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../lib/api', () => ({ transactions: { refreshProviderStatus: mocks.refresh } }));
import ProviderStatusRefresh from './ProviderStatusRefresh';
function result(cursor: string | null, overrides: Partial<ProviderActionabilityRefreshResult> = {}): ProviderActionabilityRefreshResult {
  return { companyId: 'company-a', processed: cursor ? 1 : 0, persisted: cursor ? 1 : 0, failed: 0, nextCursor: cursor, partial: cursor !== null, complete: cursor === null, items: [], ...overrides };
}
beforeEach(() => { vi.clearAllMocks(); mocks.refresh.mockResolvedValue(result(null)); });
it('checks serial pages once and reloads after completion', async () => {
  let finish!: (r: ProviderActionabilityRefreshResult) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(result(null));
  const reload = vi.fn(async () => {}); render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await act(async () => finish(result('cursor-a')));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(mocks.refresh.mock.calls).toEqual([['company-a', undefined], ['company-a', 'cursor-a']]);
  expect(screen.getByRole('status')).toHaveTextContent('Checked 1 transaction');
});
it('stops after the current check and resumes from its cursor', async () => {
  let finish!: (r: ProviderActionabilityRefreshResult) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reload = vi.fn(async () => {}); const user = userEvent.setup();
  render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  await user.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await user.click(screen.getByRole('button', { name: 'Stop after current check' }));
  await act(async () => finish(result('cursor-a')));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Continue checking' }));
  expect(mocks.refresh).toHaveBeenLastCalledWith('company-a', 'cursor-a');
});
it('ignores a previous company check and does not schedule another page', async () => {
  let finish!: (r: ProviderActionabilityRefreshResult) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reload = vi.fn(async () => {}); const view=render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  view.rerender(<ProviderStatusRefresh companyId="company-b" onRefreshed={reload}/>);
  await act(async () => finish(result('cursor-a')));
  expect(reload).not.toHaveBeenCalled(); expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Check QuickBooks status' })).toBeEnabled();
});
it('stops scheduling and reloading when unmounted', async () => {
  let finish!: (r: ProviderActionabilityRefreshResult) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reload = vi.fn(async () => {}); const view=render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));view.unmount();
  await act(async () => finish(result('cursor-a')));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);expect(reload).not.toHaveBeenCalled();
});
it('bounds each batch and lets the user continue', async () => {
  let n=0; mocks.refresh.mockImplementation(async () => result(`cursor-${++n}`));
  render(<ProviderStatusRefresh companyId="company-a" onRefreshed={async()=>{}}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await screen.findByRole('button', { name: 'Continue checking' });expect(mocks.refresh).toHaveBeenCalledTimes(25);
});
it('keeps a failed cursor for explicit retry and reports partial failure', async () => {
  mocks.refresh.mockResolvedValueOnce(result('cursor-a')).mockRejectedValueOnce(new Error('PRIVATE_ERROR_SENTINEL'));
  const reload=vi.fn(async()=>{});render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await screen.findByRole('button', { name: 'Continue checking' });
  expect(screen.getByRole('status')).toHaveTextContent('Some checks could not finish');
  expect(screen.getByRole('status')).not.toHaveTextContent('PRIVATE_ERROR_SENTINEL');expect(reload).toHaveBeenCalledTimes(1);
});
it('rejects repeated cursors without an endless loop', async () => {
  mocks.refresh.mockResolvedValueOnce(result('cursor-a')).mockResolvedValueOnce(result('cursor-a'));
  const reload=vi.fn(async()=>{});render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await screen.findByRole('button', { name: 'Continue checking' });expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it('rejects a response for another company without reloading it', async () => {
  mocks.refresh.mockResolvedValue(result(null, { companyId: 'company-b' }));
  const reload=vi.fn(async()=>{});render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Some checks could not finish'));
  expect(reload).not.toHaveBeenCalled();
});
it('reloads even when the completed page is empty so a failed reload can be retried', async () => {
  const reload=vi.fn().mockRejectedValueOnce(new Error('RELOAD_FAILURE')).mockResolvedValueOnce(undefined);
  mocks.refresh.mockResolvedValue(result(null));
  const user=userEvent.setup();render(<ProviderStatusRefresh companyId="company-a" onRefreshed={reload}/>);
  await user.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('The Queue could not reload'));
  await user.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await waitFor(()=>expect(reload).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status')).not.toHaveTextContent('could not reload');
});
