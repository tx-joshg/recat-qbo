import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardDataDto, DashboardWidget } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  companyId: 'COMPANY_GENERIC',
  dashboard: vi.fn(),
  layoutGet: vi.fn(),
  layoutSave: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: { id: mocks.companyId, nickname: 'Generic company' },
    activeCompanyId: mocks.companyId,
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    companies: { dashboard: mocks.dashboard },
    dashboardLayout: { get: mocks.layoutGet, save: mocks.layoutSave },
  };
});

import Dashboard from './Dashboard';
import { ApiError } from '../lib/api';

function dashboardData(overrides: Partial<DashboardDataDto> = {}): DashboardDataDto {
  return {
    source: 'quickbooks',
    retrievedAt: '2026-09-01T12:00:00.000Z',
    months: ['Aug', 'Sep'],
    rev: [1000, 2000],
    exp: [400, 800],
    breakdown: [{ name: 'Office supplies', amount: 800 }],
    pl: { income: 2000, cogs: 250, expenses: 550 },
    pendingCount: 2,
    pendingTotal: 300,
    ...overrides,
  };
}

function renderDashboard() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Dashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.companyId = 'COMPANY_GENERIC';
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  mocks.dashboard.mockResolvedValue(dashboardData());
  mocks.layoutGet.mockResolvedValue({ widgets: null });
  mocks.layoutSave.mockResolvedValue(undefined);
});

describe('Dashboard', () => {
  it('shows a loading state while dashboard data is pending', () => {
    mocks.dashboard.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    expect(screen.getByLabelText('Loading dashboard')).toHaveAttribute('aria-busy', 'true');
  });

  it('prevents layout edits until the saved layout resolves', async () => {
    let resolveLayout!: (value: { widgets: DashboardWidget[] | null }) => void;
    mocks.layoutGet.mockReturnValue(new Promise((resolve) => {
      resolveLayout = resolve;
    }));
    const user = userEvent.setup();

    renderDashboard();

    const addWidget = screen.getByRole('button', { name: /add widget/i });
    expect(addWidget).toBeDisabled();
    await user.click(addWidget);
    expect(screen.queryByRole('button', { name: 'Expenses' })).not.toBeInTheDocument();

    resolveLayout({ widgets: [{ t: 'rev', sp: 1 }] });

    expect(await screen.findByText('Revenue')).toBeVisible();
    expect(mocks.layoutSave).not.toHaveBeenCalled();
  });

  it('keeps dashboard failure in page and retries', async () => {
    mocks.dashboard
      .mockRejectedValueOnce(new ApiError(503, 'Dashboard data is temporarily unavailable.', 'DASHBOARD_UNAVAILABLE', undefined, '8c9ed2fd-f3e0-4f6c-8784-41464977d558'))
      .mockResolvedValueOnce(dashboardData());
    mocks.layoutGet.mockResolvedValue({ widgets: null });

    renderDashboard();

    expect(await screen.findByRole('alert')).toHaveTextContent('Dashboard data is temporarily unavailable.');
    expect(screen.queryByText('Revenue vs expenses')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Revenue vs expenses')).toBeVisible();
  });

  it('distinguishes intentionally empty layout from error', async () => {
    mocks.dashboard.mockResolvedValue(dashboardData());
    mocks.layoutGet.mockResolvedValue({ widgets: [] });

    renderDashboard();

    expect(await screen.findByText('Your dashboard has no widgets.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(mocks.layoutSave).toHaveBeenCalledWith(expect.arrayContaining([{ t: 'rev', sp: 1 }]));
  });

  it('renders zero data and labels local fallback', async () => {
    mocks.dashboard.mockResolvedValue(dashboardData({
      rev: [0, 0],
      exp: [0, 0],
      source: 'local_fallback',
      retrievedAt: '2026-09-01T12:34:56.000Z',
    }));
    mocks.layoutGet.mockResolvedValue({ widgets: [{ t: 'rev', sp: 1 }] });

    renderDashboard();

    expect(await screen.findByText('$0.0k')).toBeVisible();
    expect(screen.getByText(/Partial data from Recat's posted transactions/)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

it('discards a previous company response after switching companies', async () => {
  let finishOld!: (value: DashboardDataDto) => void;
  mocks.dashboard.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  mocks.dashboard.mockResolvedValue(dashboardData({ breakdown: [{ name: 'Current company category', amount: 800 }] }));
  const view = renderDashboard();
  mocks.companyId = 'COMPANY_SECOND';
  view.rerender(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Dashboard /></MemoryRouter>);
  expect(await screen.findByText('Current company category')).toBeVisible();
  await act(async () => finishOld(dashboardData({ breakdown: [{ name: 'Previous company category', amount: 800 }] })));
  expect(screen.queryByText('Previous company category')).not.toBeInTheDocument();
  expect(screen.getByText('Current company category')).toBeVisible();
});
