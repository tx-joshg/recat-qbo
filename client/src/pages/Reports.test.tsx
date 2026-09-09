import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatementDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  pl: vi.fn(), bs: vi.fn(), transactionLog: vi.fn(), custom: vi.fn(),
  transactions: vi.fn(), savedList: vi.fn(), toast: vi.fn(),
}));
vi.mock('../state/AppContext', () => ({
  useApp: () => ({ activeCompany: { id: 'company-a', nickname: 'Example company' },
    activeCompanyId: 'company-a', role: 'admin', tags: [], toast: mocks.toast }),
}));
vi.mock('../lib/api', async () => ({
  ...await vi.importActual<typeof import('../lib/api')>('../lib/api'),
  reports: { pl: mocks.pl, bs: mocks.bs, transactionLog: mocks.transactionLog, custom: mocks.custom },
  transactions: { list: mocks.transactions }, savedReports: { list: mocks.savedList },
}));
import Reports from './Reports';

const statement: StatementDto = {
  title: 'Example statement', subtitle: 'Example period', columns: [{ label: 'Total' }],
  rows: [{ label: 'Net income', kind: 'grand', indent: false, cells: [{ value: 0, text: '$0' }] }],
  basisLabel: 'Cash basis', period: { start: '2026-01-01', end: '2026-01-31' },
};
const year = new Date().getFullYear();
const currentMonth = new Date().getMonth();
const currentMonthLabel = new Date(year, currentMonth, 1).toLocaleString('en-US', { month: 'long' });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pl.mockResolvedValue(statement);
  mocks.bs.mockResolvedValue(statement);
  mocks.transactionLog.mockResolvedValue({ start: '2026-01-01', end: '2026-01-31', rows: [] });
  mocks.custom.mockResolvedValue({ rows: [], count: 0, total: 0 });
  mocks.transactions.mockResolvedValue({ transactions: [{ bankAccount: 'Operating account' }] });
  mocks.savedList.mockResolvedValue([]);
});

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

describe('Reports shared dropdowns', () => {
  it.each([
    ['Profit & Loss', ['Report', 'Report period', 'Display columns by', 'Compare to', 'Accounting method']],
    ['Balance Sheet', ['Report', 'As of end of', 'Compare to', 'Accounting method']],
    ['Transaction log', ['Report', 'Period']],
    ['Custom & tags', ['Report', 'Custom report period', 'Money flow', 'Bank account', 'Group by']],
  ])('uses themed controls for every dropdown on %s', async (tab, labels) => {
    const user = userEvent.setup();
    const view = render(<div className="rr" data-theme="dark"><Reports /></div>);
    if (tab !== 'Profit & Loss') await choose(user, 'Report', tab);
    expect(view.container.querySelectorAll('select')).toHaveLength(0);
    for (const label of labels) {
      await user.click(screen.getByRole('combobox', { name: label }));
      expect(screen.getByRole('listbox', { name: label }).closest('.rr')).toHaveAttribute('data-theme', 'dark');
      await user.keyboard('{Escape}');
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(screen.getByRole('combobox', { name: label })).toHaveFocus();
    }
  });

  it.each([
    ['Report period', `Year to date ${year}`, { period: 'ytd', compare: 'none' }],
    ['Display columns by', 'Months', { columns: 'months', compare: 'none' }],
    ['Compare to', 'Same month last year', { compare: 'py' }],
    ['Accounting method', 'Accrual', { basis: 'accrual' }],
  ])('sends the selected P&L %s', async (label, option, params) => {
    const user = userEvent.setup(); render(<Reports />);
    await choose(user, label, option);
    await waitFor(() => expect(mocks.pl).toHaveBeenLastCalledWith('company-a', expect.objectContaining(params)));
  });

  it.each([
    ['As of end of', `Jan ${year}`, { asOf: `${year}-01` }],
    ['Compare to', 'Previous month', { compare: 'prev' }],
    ['Accounting method', 'Accrual', { basis: 'accrual' }],
  ])('sends the selected Balance Sheet %s', async (label, option, params) => {
    const user = userEvent.setup(); render(<Reports />);
    await choose(user, 'Report', 'Balance Sheet'); await choose(user, label, option);
    await waitFor(() => expect(mocks.bs).toHaveBeenLastCalledWith('company-a', expect.objectContaining(params)));
  });

  it('selects the transaction-log period and exposes custom date fields', async () => {
    const user = userEvent.setup(); render(<Reports />);
    await choose(user, 'Report', 'Transaction log');
    await choose(user, 'Period', 'All time');
    await waitFor(() => expect(mocks.transactionLog).toHaveBeenLastCalledWith('company-a', expect.objectContaining({ start: '1900-01-01' })));
    await choose(user, 'Period', 'Custom range…');
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });

  it.each([
    ['Custom report period', currentMonthLabel, { range: `${year}-${String(currentMonth + 1).padStart(2, '0')}` }],
    ['Money flow', 'Money out only', { flow: 'out' }],
    ['Bank account', 'Operating account', { account: 'Operating account' }],
    ['Group by', 'Category', { groupBy: 'cat' }],
  ])('sends the selected custom-report %s', async (label, option, config) => {
    const user = userEvent.setup(); render(<Reports />);
    await choose(user, 'Report', 'Custom & tags'); await choose(user, label, option);
    await waitFor(() => expect(mocks.custom).toHaveBeenLastCalledWith('company-a', expect.objectContaining(config)));
  });

  it('shows the applied saved period and bank account when they are absent from current choices', async () => {
    mocks.savedList.mockResolvedValue([{ id: 'saved-a', name: 'Earlier report', config: {
      range: '2001-01', account: 'Archived account', flow: 'out', groupBy: 'acct', tagIds: [],
    } }]);
    const user = userEvent.setup(); render(<Reports />);
    await choose(user, 'Report', 'Custom & tags');
    await user.click(await screen.findByRole('button', { name: 'Earlier report' }));
    await waitFor(() => expect(mocks.custom).toHaveBeenLastCalledWith('company-a', expect.objectContaining({ range: '2001-01', account: 'Archived account' })));
    for (const [label, value] of [['Custom report period', 'January 2001'], ['Bank account', 'Archived account']] as const) {
      expect(screen.getByRole('combobox', { name: label })).toHaveTextContent(value);
      await user.click(screen.getByRole('combobox', { name: label }));
      expect(screen.getByRole('option', { name: value })).toHaveAttribute('aria-selected', 'true');
      await user.keyboard('{Escape}');
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
  });

  it('changes reports with the keyboard and restores trigger focus', async () => {
    const user = userEvent.setup(); render(<Reports />);
    const trigger = screen.getByRole('combobox', { name: 'Report' });
    trigger.focus(); await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(mocks.bs).toHaveBeenCalled());
    expect(trigger).toHaveFocus();
  });
});
