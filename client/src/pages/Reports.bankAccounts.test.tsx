import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatementDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  companyId: 'COMPANY_GENERIC',
  role: 'viewer',
  listTransactions: vi.fn(),
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
    activeCompany: { id: mocks.companyId, nickname: 'Generic company' },
    activeCompanyId: mocks.companyId,
    role: mocks.role,
    tags: [],
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    transactions: { list: mocks.listTransactions },
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
  vi.clearAllMocks();
  mocks.companyId = 'COMPANY_GENERIC';
  mocks.role = 'viewer';
  mocks.listTransactions.mockResolvedValue({ transactions: [], nextCursor: null });
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

describe('Report bank account filters', () => {
  it('lets a viewer filter historical accounts without access to the Queue API', async () => {
    mocks.bankAccounts.mockResolvedValue(['Example archived account']);
    const user = userEvent.setup();
    render(<Reports />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Report' }), 'custom');
    const option = await screen.findByRole('option', { name: 'Example archived account' });
    await user.selectOptions(option.parentElement!, 'Example archived account');
    await waitFor(() => expect(mocks.custom).toHaveBeenLastCalledWith('COMPANY_GENERIC', expect.objectContaining({ account: 'Example archived account' })));
    expect(mocks.listTransactions).not.toHaveBeenCalled();
  });

  it('reloads options for the selected company and ignores an older response', async () => {
    let resolveOld!: (names: string[]) => void;
    mocks.bankAccounts.mockReturnValueOnce(new Promise<string[]>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(['Example current account']);
    const user = userEvent.setup();
    const view = render(<Reports />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Report' }), 'custom');
    await waitFor(() => expect(mocks.bankAccounts).toHaveBeenCalledTimes(1));
    mocks.companyId = 'COMPANY_OTHER';
    view.rerender(<Reports />);
    expect(await screen.findByRole('option', { name: 'Example current account' })).toBeInTheDocument();
    await act(async () => resolveOld(['Example old account']));
    expect(screen.queryByRole('option', { name: 'Example old account' })).not.toBeInTheDocument();
  });
});
