import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatementDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  pl: vi.fn(),
  bs: vi.fn(),
  transactionLog: vi.fn(),
  custom: vi.fn(),
  bankAccounts: vi.fn(),
  drilldown: vi.fn(),
  setLogTags: vi.fn(),
  savedList: vi.fn(),
  savedCreate: vi.fn(),
  savedDel: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: { id: 'COMPANY_GENERIC', nickname: 'Generic company' },
    activeCompanyId: 'COMPANY_GENERIC',
    role: 'admin',
    tags: [],
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    reports: {
      pl: mocks.pl,
      bs: mocks.bs,
      transactionLog: mocks.transactionLog,
      custom: mocks.custom,
      bankAccounts: mocks.bankAccounts,
      drilldown: mocks.drilldown,
      setLogTags: mocks.setLogTags,
    },
    savedReports: {
      list: mocks.savedList,
      create: mocks.savedCreate,
      del: mocks.savedDel,
    },
  };
});

vi.mock('../components/TagPicker', () => ({ default: () => null }));

import Reports from './Reports';

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
  await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}


import { ApiError } from '../lib/api';

function statement(overrides: Partial<StatementDto> = {}): StatementDto {
  return {
    title: 'Profit & Loss',
    subtitle: 'September 2026',
    columns: [{ label: 'September 2026' }],
    rows: [{ label: 'Net income', kind: 'grand', indent: false, cells: [{ value: 0, text: '$0.0k' }] }],
    basisLabel: 'Cash basis',
    period: { start: '2026-09-01', end: '2026-09-01' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pl.mockResolvedValue(statement());
  mocks.bs.mockResolvedValue(statement({ title: 'Balance Sheet' }));
  mocks.transactionLog.mockResolvedValue({ start: '2026-06-01', end: '2026-09-01', rows: [] });
  mocks.custom.mockResolvedValue({ rows: [], count: 0, total: 0 });
  mocks.bankAccounts.mockResolvedValue([]);
  mocks.drilldown.mockResolvedValue({ accountName: '', rows: [] });
  mocks.setLogTags.mockResolvedValue({ ok: true });
  mocks.savedList.mockResolvedValue([]);
  mocks.savedCreate.mockResolvedValue({});
  mocks.savedDel.mockResolvedValue(undefined);
});

describe('Reports', () => {
  it('keeps P&L filters usable after failure and retries current filters', async () => {
    mocks.pl
      .mockRejectedValueOnce(new ApiError(504, 'QuickBooks did not respond before this report request timed out.', 'QBO_REPORT_TIMEOUT', undefined, '8c9ed2fd-f3e0-4f6c-8784-41464977d558'))
      .mockRejectedValueOnce(new ApiError(504, 'QuickBooks did not respond before this report request timed out.', 'QBO_REPORT_TIMEOUT', undefined, '8c9ed2fd-f3e0-4f6c-8784-41464977d558'))
      .mockResolvedValueOnce(statement());
    const user = userEvent.setup();

    render(<Reports />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Profit & Loss could not load');
    await choose(user, 'Accounting method', 'Accrual');
    expect(await screen.findByRole('alert')).toHaveTextContent('Profit & Loss could not load');
    expect(mocks.pl).toHaveBeenLastCalledWith('COMPANY_GENERIC', expect.objectContaining({ basis: 'accrual' }));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$0.0k')).toBeVisible();
    expect(mocks.pl).toHaveBeenLastCalledWith('COMPANY_GENERIC', expect.objectContaining({ basis: 'accrual' }));
  });

  it('renders zero P&L statement as a success', async () => {
    mocks.pl.mockResolvedValue(statement({ rows: [{ label: 'Net income', kind: 'grand', indent: false, cells: [{ value: 0, text: '$0.0k' }] }] }));

    render(<Reports />);

    expect(await screen.findByText('$0.0k')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows Balance Sheet failure in place and retries', async () => {
    mocks.bs
      .mockRejectedValueOnce(new ApiError(502, 'QuickBooks could not provide this report right now.', 'QBO_REPORT_UNAVAILABLE', undefined, '8c9ed2fd-f3e0-4f6c-8784-41464977d558'))
      .mockResolvedValueOnce(statement({ title: 'Balance Sheet' }));
    const user = userEvent.setup();

    render(<Reports />);
    await choose(user, 'Report', 'Balance Sheet');

    expect(await screen.findByRole('alert')).toHaveTextContent('Balance Sheet could not load');
    expect(screen.getByLabelText('Accounting method')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$0.0k')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces a pending transaction-log read', async () => {
    mocks.transactionLog.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(<Reports />);
    await choose(user, 'Report', 'Transaction log');

    expect(await screen.findByLabelText('Loading transaction log')).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps transaction log failure in its card and retries', async () => {
    mocks.transactionLog
      .mockRejectedValueOnce(new ApiError(502, 'QuickBooks could not provide this report right now.', 'QBO_REPORT_UNAVAILABLE', undefined, '8c9ed2fd-f3e0-4f6c-8784-41464977d558'))
      .mockResolvedValueOnce({ start: '2026-06-01', end: '2026-09-01', rows: [] });
    const user = userEvent.setup();

    render(<Reports />);
    await choose(user, 'Report', 'Transaction log');

    expect(await screen.findByRole('alert')).toHaveTextContent('Transaction log could not load');
    expect(screen.getByLabelText('Period')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No transactions in this period.')).toBeVisible();
  });

});

it('clears the previous transaction log while a custom range is incomplete', async () => {
  const user = userEvent.setup();
  render(<Reports />);
  await choose(user, 'Report', 'Transaction log');
  expect(await screen.findByText('No transactions in this period.')).toBeVisible();
  await choose(user, 'Period', 'Custom range…');
  expect(screen.queryByText('No transactions in this period.')).not.toBeInTheDocument();
  expect(screen.getByText('Choose a valid start and end date to load the transaction log.')).toBeVisible();
  expect(mocks.transactionLog).toHaveBeenCalledTimes(1);
});

it('ignores an older statement response after the filters change', async () => {
  let finishOld!: (value: StatementDto) => void;
  mocks.pl.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  mocks.pl.mockResolvedValue(statement({ rows: [{ label: 'Current result', kind: 'grand', indent: false, cells: [{ value: 100, text: '$100' }] }] }));
  const user = userEvent.setup();
  render(<Reports />);
  await choose(user, 'Accounting method', 'Accrual');
  expect(await screen.findByText('Current result')).toBeVisible();
  await act(async () => finishOld(statement({ rows: [{ label: 'Obsolete result', kind: 'grand', indent: false, cells: [{ value: 999, text: '$999' }] }] })));
  expect(screen.queryByText('Obsolete result')).not.toBeInTheDocument();
  expect(screen.getByText('Current result')).toBeVisible();
});
