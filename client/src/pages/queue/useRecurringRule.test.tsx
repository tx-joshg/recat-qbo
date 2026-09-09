import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { useRecurringRule } from './useRecurringRule';

const mocks = vi.hoisted(() => ({ currentCase: vi.fn(), lifecycle: vi.fn(), prepare: vi.fn(), commit: vi.fn(), toast: vi.fn(), key: vi.fn() }));
vi.mock('../../lib/api', () => ({
  classificationMemory: { currentCase: mocks.currentCase },
  rules: { lifecycle: mocks.lifecycle },
  ruleOperations: { prepareFromCase: mocks.prepare, commit: mocks.commit },
  createCategorizationRequestId: mocks.key,
}));
const target = { companyId: 'company-a', transactionId: 'transaction-a', payee: 'Example supplier' };
const caseValue = { id: 'case-a', companyId: 'company-a', transactionId: 'transaction-a', invalidatedAt: null };
const prepared = {
  ok: true, companyId: 'company-a', operationId: 'operation-a', mutation: 'create', originIntent: 'make_recurring', status: 'PREPARED',
  preview: { companyId: 'company-a', operationId: 'operation-a', autoPost: false, condition: { matchText: 'Example supplier' }, categoryName: 'Office', affectedPendingCount: 2, affectedProcessedCount: 1 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Harness({ company = 'company-a' }: { company?: string | null }) {
  const recurring = useRecurringRule(company, mocks.toast);
  return <><button onClick={() => recurring.offer(target)}>Verified write</button>
    <button onClick={() => recurring.invalidate(['transaction-a'])}>Undo target</button>
    <button onClick={() => recurring.invalidate(['transaction-b'])}>Refresh other</button>{recurring.content}</>;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.currentCase.mockResolvedValue(caseValue);
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [], nextCursor: null });
  mocks.prepare.mockResolvedValue(prepared);
  mocks.commit.mockResolvedValue({ ...prepared, preview: null, status: 'COMMITTED' });
  mocks.key.mockReturnValue('request-a');
});

it.each([
  ['no current case', null], ['different company', { ...caseValue, companyId: 'company-b' }],
  ['different transaction', { ...caseValue, transactionId: 'transaction-b' }],
  ['invalidated case', { ...caseValue, invalidatedAt: '2026-09-01T00:00:00Z' }],
])('keeps the verified decision applied once for %s', async (_label, value) => {
  mocks.currentCase.mockResolvedValue(value);
  render(<Harness />);
  await userEvent.click(screen.getByText('Verified write'));
  expect(screen.queryByText('Apply once')).not.toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('treats CASE_NOT_FOUND as apply once without a mutation or error toast', async () => {
  mocks.currentCase.mockRejectedValue(Object.assign(new Error('No case'), { code: 'CASE_NOT_FOUND', status: 404 }));
  render(<Harness />);
  await userEvent.click(screen.getByText('Verified write'));
  expect(screen.queryByText('Apply once')).not.toBeInTheDocument();
  expect(mocks.toast).not.toHaveBeenCalled();
});
it.each(['switch back', 'unmount', 'target invalidation'])('discards a late case after %s', async kind => {
  const pending = deferred<typeof caseValue>(); mocks.currentCase.mockReturnValue(pending.promise);
  const view = render(<Harness />);
  await userEvent.click(screen.getByText('Verified write'));
  if (kind === 'switch back') { view.rerender(<Harness company="company-b" />); view.rerender(<Harness />); }
  else if (kind === 'unmount') view.unmount();
  else await userEvent.click(screen.getByText('Undo target'));
  await act(async () => pending.resolve(caseValue));
  expect(screen.queryByText('Apply once')).not.toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('invalidates only the affected transaction and drops a late preparation', async () => {
  const pending = deferred<typeof prepared>(); mocks.prepare.mockReturnValue(pending.promise);
  render(<Harness />);
  await userEvent.click(screen.getByText('Verified write'));
  await userEvent.click(screen.getByText('Refresh other'));
  expect(screen.getByText('Apply once')).toBeInTheDocument();
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  await userEvent.click(screen.getByText('Undo target'));
  await act(async () => pending.resolve(prepared));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.commit).not.toHaveBeenCalled();
});
it('reuses the operation key after a lost prepare response and never sends twice in one turn', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(prepared);
  render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  const button = screen.getByText('Make recurring suggestion');
  act(() => { button.click(); button.click(); });
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
  await screen.findByText('Make recurring suggestion');
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(mocks.prepare.mock.calls.map(call => call[2].idempotencyKey)).toEqual(['request-a', 'request-a']);
  expect(mocks.key).toHaveBeenCalledTimes(1);
});
it.each([
  ['different company', { companyId: 'company-b' }],
  ['auto-post elevation', { preview: { ...prepared.preview, autoPost: true } }],
  ['preview mismatch', { preview: { ...prepared.preview, operationId: 'operation-b' } }],
])('does not confirm %s from preparation', async (_label, change) => {
  mocks.prepare.mockResolvedValue({ ...prepared, ...change });
  render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalled();
});
it('keeps the same operation after a failed commit and fences late success after a company change', async () => {
  const pending = deferred<typeof prepared>();
  mocks.commit.mockRejectedValueOnce(new Error('Failed to fetch')).mockReturnValue(pending.promise);
  const view = render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  await userEvent.click(screen.getByText('Confirm recurring suggestion'));
  const button = screen.getByText('Confirm recurring suggestion');
  act(() => { button.click(); button.click(); });
  expect(mocks.commit).toHaveBeenCalledTimes(2);
  expect(mocks.commit.mock.calls).toEqual(Array(2).fill(['company-a', 'operation-a', 'request-a']));
  view.rerender(<Harness company={null} />);
  await act(async () => pending.resolve({ ...prepared, status: 'COMMITTED' }));
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('accepts an already committed prepare replay after a lost commit response and cancel', async () => {
  mocks.commit.mockRejectedValueOnce(new Error('Response lost.'));
  render(<Harness />);
  await userEvent.click(screen.getByText('Verified write'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  await userEvent.click(screen.getByText('Confirm recurring suggestion'));
  await userEvent.click(screen.getByText('Cancel'));
  mocks.prepare.mockResolvedValue({ ...prepared, status: 'REPLAYED', preview: null });
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(screen.queryByText('Apply once')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.prepare.mock.calls[1]).toEqual(mocks.prepare.mock.calls[0]);
  expect(mocks.commit).toHaveBeenCalledTimes(1);
  expect(mocks.toast).toHaveBeenLastCalledWith('Recurring suggestion created — auto-post remains off');
});

it.each(['companyId', 'mutation', 'originIntent'] as const)('rejects a terminal prepare replay with mismatched %s', async field => {
  mocks.prepare.mockResolvedValue({ ...prepared, status: 'REPLAYED', preview: null, [field]: 'unrelated' });
  render(<Harness />);
  await userEvent.click(screen.getByText('Verified write'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(screen.getByText('Apply once')).toBeInTheDocument();
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith('Recurring suggestion could not be prepared.');
});

it.each(['legacy', 'bridge', 'paused', undefined])('does not offer a new recurring rule in %s mode', async runtimeMode => {
  mocks.lifecycle.mockResolvedValue({ runtimeMode, items: [], nextCursor: null });
  render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  expect(mocks.lifecycle).toHaveBeenCalledWith('company-a', 'all', undefined, 1);
  expect(screen.queryByText('Make recurring suggestion')).not.toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it.each(['unavailable', 'paused'])('does not start a new operation when status becomes %s after offering it', async mode => {
  render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  if (mode === 'paused') mocks.lifecycle.mockResolvedValue({ runtimeMode: 'paused', items: [], nextCursor: null });
  else mocks.lifecycle.mockRejectedValue(new Error('Status unavailable.'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.key).not.toHaveBeenCalled();
});
it('keeps exact preparation recovery available after the company becomes paused', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('Response lost.'));
  render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'paused', items: [], nextCursor: null });
  mocks.prepare.mockResolvedValue({ ...prepared, status: 'REPLAYED', preview: null });
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(mocks.prepare.mock.calls[1]).toEqual(mocks.prepare.mock.calls[0]);
  expect(mocks.lifecycle).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Make recurring suggestion')).not.toBeInTheDocument();
});
it('fences a delayed mode check after the company changes before preparation', async () => {
  const view = render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  const pending = deferred<{ runtimeMode: string }>(); mocks.lifecycle.mockReturnValue(pending.promise);
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  view.rerender(<Harness company="company-b" />);
  await act(async () => pending.resolve({ runtimeMode: 'canonical' }));
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.key).not.toHaveBeenCalled();
});

it('retains the local intent after a failed status read and starts it only after a successful retry', async () => {
  render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  mocks.lifecycle.mockRejectedValueOnce(new Error('Status unavailable.'));
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(screen.getByText('Apply once')).toBeInTheDocument();
  expect(mocks.key).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText('Make recurring suggestion'));
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.key).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
it('discards an offer whose status read completes after switching away and back', async () => {
  const pending = deferred<{ runtimeMode: string }>(); mocks.lifecycle.mockReturnValue(pending.promise);
  const view = render(<Harness />); await userEvent.click(screen.getByText('Verified write'));
  view.rerender(<Harness company="company-b" />); view.rerender(<Harness />);
  await act(async () => pending.resolve({ runtimeMode: 'canonical' }));
  expect(screen.queryByText('Make recurring suggestion')).not.toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
