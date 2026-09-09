import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  categorize: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
  setPendingCount: vi.fn(),
  refreshCompanies: vi.fn(),
  navigate: vi.fn(),
  tags: [] as Array<{ id: string; companyId: string; name: string; color: string }>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: {
      id: 'COMPANY_GENERIC', nickname: 'Generic company', holdingAccountIds: [], lastSyncedAt: null,
    },
    activeCompanyId: 'COMPANY_GENERIC',
    role: 'admin',
    accounts: [
      { id: 'ACCOUNT_GENERIC', qboId: 'EXPENSE_GENERIC', name: 'Generic expense', fullName: 'Expenses · Generic expense', classification: 'Expenses', active: true },
      { id: 'ACCOUNT_OFFICE', qboId: 'EXPENSE_OFFICE', name: 'Office expense', fullName: 'Expenses · Office expense', classification: 'Expenses', active: true },
      { id: 'ACCOUNT_DUPLICATE', qboId: 'EXPENSE_DUPLICATE', name: 'Office expense', fullName: 'COGS · Office expense', classification: 'COGS', active: true },
      { id: 'ACCOUNT_HOLDING', qboId: 'HOLDING', name: 'Uncategorised Expense', fullName: 'Expenses · Uncategorised Expense', classification: 'Expenses', active: true },
    ],
    tags: mocks.tags, setPendingCount: mocks.setPendingCount, refreshCompanies: mocks.refreshCompanies,
    dryRun: false, tagsRequired: false, taxReadiness: null, toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  createCategorizationRequestId: vi.fn(),
  companies: { sync: vi.fn() },
  rules: { create: vi.fn(), lifecycle: vi.fn() },
  autopilot: { get: vi.fn(), listRuns: vi.fn(), getReadiness: vi.fn() },
  transactions: {
    list: mocks.list, categorize: mocks.categorize, stageCategorization: vi.fn(), commitCategorization: vi.fn(),
    reconcileCategorization: vi.fn(), retryCategorization: vi.fn(), undoCategorization: vi.fn(),
    post: mocks.post, undo: vi.fn(), retry: vi.fn(), transfer: vi.fn(), bulkPost: vi.fn(),
  },
}));

vi.mock('./settings/AutopilotCard', () => ({ AutopilotQueueStatus: () => null }));

import Queue from './Queue';

function transaction(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'TRANSACTION_GENERIC', companyId: 'COMPANY_GENERIC', qboId: 'PURCHASE_GENERIC', qboType: 'Purchase',
    date: '2026-07-28T00:00:00.000Z', payee: 'Generic supplier', memo: null, amount: -10.5,
    bankAccount: 'Operating account', status: 'PENDING', revision: 1, category: 'Generic expense',
    categoryQboId: 'EXPENSE_GENERIC', taxCalculation: null, taxCode: null, taxCodeQboId: null,
    splits: null, tagIds: [], suggestion: null, error: null, postedAt: null, postedBy: null,
    activeCategorizationAttempt: null, ...overrides,
  } as TransactionDto;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  mocks.list.mockResolvedValue({
    transactions: [transaction(), transaction({ id: 'TRANSACTION_OTHER', payee: 'Another supplier', bankAccount: 'Savings account' })],
    nextCursor: null,
    pendingCount: 2,
  });
  mocks.categorize.mockResolvedValue(transaction({ category: 'Office expense', categoryQboId: 'EXPENSE_OFFICE' }));
  mocks.tags = [];

});

async function renderQueue() {
  render(<Queue />);
  await screen.findByText('Generic supplier');
}

describe('Queue shared controls', () => {
  it('uses shared controls for account filtering and category selection without the legacy global picker handler', async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
    await user.keyboard('oper{Enter}');
    expect(screen.getByText('Generic supplier')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
    await user.type(screen.getByRole('textbox', { name: 'Category for Generic supplier' }), 'office');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('combobox', { name: 'Category for Generic supplier' })).toHaveTextContent(/Office expense/);
  });

  it('applies the bulk category to every selected pending transaction', async () => {
    const user = userEvent.setup();
    mocks.categorize.mockImplementation(async (id: string, patch: { category: string; categoryQboId: string }) =>
      transaction({ id, ...patch }),
    );
    await renderQueue();
    await user.click(screen.getAllByRole('checkbox')[0]!);
    await user.click(screen.getByRole('combobox', { name: 'Category for selected transactions' }));
    await user.click(screen.getByRole('option', { name: /^Expenses.*Office expense$/ }));
    expect(mocks.categorize).toHaveBeenCalledTimes(2);
    for (const id of ['TRANSACTION_GENERIC', 'TRANSACTION_OTHER']) {
      expect(mocks.categorize).toHaveBeenCalledWith(id, {
        category: 'Office expense', categoryQboId: 'EXPENSE_OFFICE', tagIds: [],
      });
    }
    expect(screen.getByRole('combobox', { name: 'Category for selected transactions' })).toHaveTextContent('Office expense');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('preserves the selected account ID when category names repeat', async () => {
    const user = userEvent.setup();
    mocks.categorize.mockImplementation(async (id: string, patch: { category: string; categoryQboId: string }) => transaction({ id, ...patch }));
    await renderQueue();
    await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
    await user.click(screen.getByRole('option', { name: /COGS.*Office expense/ }));
    expect(mocks.categorize).toHaveBeenLastCalledWith('TRANSACTION_GENERIC', {
      category: 'Office expense', categoryQboId: 'EXPENSE_DUPLICATE', tagIds: [],
    });
    await user.click(screen.getAllByRole('checkbox')[0]!);
    await user.click(screen.getByRole('combobox', { name: 'Category for selected transactions' }));
    await user.click(screen.getByRole('option', { name: /COGS.*Office expense/ }));
    expect(mocks.categorize).toHaveBeenLastCalledWith('TRANSACTION_OTHER', {
      category: 'Office expense', categoryQboId: 'EXPENSE_DUPLICATE', tagIds: [],
    });
    await user.click(screen.getByRole('combobox', { name: 'Category for selected transactions' }));
    expect(screen.getByRole('option', { name: /COGS.*Office expense/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps row shortcuts available from an ordinary button without hijacking Enter', async () => {
    const user = userEvent.setup();
    await renderQueue();
    screen.getByRole('button', { name: /Sync now/ }).focus();
    await user.keyboard('x');
    expect(screen.getAllByRole('checkbox').some((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    await user.keyboard('{Enter}');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('shows a concise placeholder before choosing a bulk category', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await user.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getByRole('combobox', { name: 'Category for selected transactions' })).toHaveTextContent('Assign one category…');
  });

  it('keeps the clear-selection action when only a posted row is selected', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue({ transactions: [transaction({ status: 'POSTED' })], nextCursor: null, pendingCount: 0 });
    await renderQueue();
    await user.click(screen.getAllByRole('checkbox')[1]!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category for selected transactions' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'esc' }));
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('renders the account filter with the shared select control', async () => {
    await renderQueue();

    expect(screen.getByRole('combobox', { name: 'Account filter' }).tagName).toBe('BUTTON');
  });

  it('does not activate another row when opening its category picker', async () => {
    const user = userEvent.setup();
    await renderQueue();

    const genericRow = screen.getByText('Generic supplier').closest('.interactive-surface')!;
    const otherRow = screen.getByText('Another supplier').closest('.interactive-surface')!;
    await user.click(genericRow);
    expect(genericRow).toHaveStyle({ background: 'var(--hl)' });

    await user.click(screen.getByRole('combobox', { name: 'Category for Another supplier' }));

    expect(genericRow).toHaveStyle({ background: 'var(--hl)' });
    expect(otherRow).toHaveStyle({ background: 'transparent' });
  });

  it('keeps an unselected rule suggestion visible and described on the category trigger', async () => {
    mocks.list.mockResolvedValue({
      transactions: [transaction({
        category: null,
        categoryQboId: null,
        suggestion: {
          source: 'rule',
          category: 'Office expense', categoryQboId: 'EXPENSE_OFFICE',
          matchedRules: 2, winnerMatchText: 'office supply',
        },
      })],
      nextCursor: null,
      pendingCount: 1,
    });
    await renderQueue();

    const category = screen.getByRole('combobox', { name: 'Category for Generic supplier' });
    expect(category).toHaveTextContent('Office expense');
    expect(category).toHaveAccessibleDescription(
      'Suggested category: Office expense. Suggested by rule. Matched 2 rules — “office supply” won (topmost). Reorder in Rules.',
    );
    expect(screen.getByText('rule')).toHaveAttribute(
      'data-tip',
      'Matched 2 rules — “office supply” won (topmost). Reorder in Rules.',
    );
  });

  it('does not let shared-control type-ahead activate Queue shortcuts', async () => {
    const user = userEvent.setup();
    mocks.tags = [{ id: 'TAG_GENERIC', companyId: 'COMPANY_GENERIC', name: 'Generic tag', color: '#667788' }];
    await renderQueue();

    await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
    await user.keyboard('txjk');

    expect(screen.queryByRole('button', { name: 'Generic tag' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('keeps tag interactions open but dismisses the tag picker on an outside click', async () => {
    const user = userEvent.setup();
    mocks.tags = [{ id: 'TAG_GENERIC', companyId: 'COMPANY_GENERIC', name: 'Generic tag', color: '#667788' }];
    mocks.categorize.mockResolvedValue(transaction({ tagIds: ['TAG_GENERIC'] }));
    await renderQueue();

    await user.click(screen.getAllByRole('button', { name: '+ tag' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Generic tag' }));
    expect(screen.getByRole('button', { name: 'Generic tag' })).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole('button', { name: 'Generic tag' })).not.toBeInTheDocument();
  });

  it('opens the split editor from a portalled category footer without activating its row', async () => {
    const user = userEvent.setup();
    await renderQueue();

    const genericRow = screen.getByText('Generic supplier').closest('.interactive-surface')!;
    const otherRow = screen.getByText('Another supplier').closest('.interactive-surface')!;
    await user.click(screen.getByRole('combobox', { name: 'Category for Another supplier' }));
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    expect(genericRow).toHaveStyle({ background: 'var(--hl)' });
    expect(otherRow).toHaveStyle({ background: 'transparent' });

    await user.click(screen.getByRole('button', { name: /split into multiple categories/i }));

    expect(screen.getByText('Split transaction')).toBeInTheDocument();
    expect(genericRow).toHaveStyle({ background: 'var(--hl)' });
    expect(otherRow).toHaveStyle({ background: 'transparent' });
  });

  it('keeps an explicitly loaded posted split row inert', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue({
      transactions: [transaction({
        status: 'POSTED',
        category: null,
        categoryQboId: null,
        splits: [{
          amount: -10.5,
          category: 'Generic expense',
          categoryQboId: 'EXPENSE_GENERIC',
          taxCode: null,
          taxCodeQboId: null,
          tagIds: [],
        }],
      })],
      nextCursor: null,
      pendingCount: 0,
    });
    await renderQueue();

    const splitTrigger = screen.getByRole('button', { name: 'Split · 1 category' });
    expect(splitTrigger).toHaveClass('control-trigger', 'queue-split-trigger');
    expect(splitTrigger).toBeDisabled();
    await user.click(splitTrigger);
    expect(screen.queryByText('Split transaction')).not.toBeInTheDocument();
    expect(mocks.categorize).not.toHaveBeenCalled();
  });

  it('uses the shared control trigger contract and plural copy for a multi-category split', async () => {
    mocks.list.mockResolvedValue({
      transactions: [transaction({
        status: 'POSTED',
        category: null,
        categoryQboId: null,
        splits: [
          {
            amount: -5.25,
            category: 'Generic expense',
            categoryQboId: 'EXPENSE_GENERIC',
            taxCode: null,
            taxCodeQboId: null,
            tagIds: [],
          },
          {
            amount: -5.25,
            category: 'Office expense',
            categoryQboId: 'EXPENSE_OFFICE',
            taxCode: null,
            taxCodeQboId: null,
            tagIds: [],
          },
        ],
      })],
      nextCursor: null,
      pendingCount: 0,
    });
    await renderQueue();

    expect(screen.getByRole('button', { name: 'Split · 2 categories' }))
      .toHaveClass('control-trigger', 'queue-split-trigger');
  });

  it('opens a pending split from its shared summary trigger', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue({
      transactions: [transaction({
        category: null,
        categoryQboId: null,
        splits: [{
          amount: -10.5,
          category: 'Generic expense',
          categoryQboId: 'EXPENSE_GENERIC',
          taxCode: null,
          taxCodeQboId: null,
          tagIds: [],
        }],
      })],
      nextCursor: null,
      pendingCount: 1,
    });
    await renderQueue();

    const splitTrigger = screen.getByRole('button', { name: 'Split · 1 category' });
    expect(splitTrigger).toHaveClass('control-trigger', 'queue-split-trigger');
    expect(splitTrigger).toBeEnabled();
    await user.click(splitTrigger);
    expect(screen.getByText('Split transaction')).toBeInTheDocument();
  });

  it('selects an unselected row suggestion first with Enter', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue({
      transactions: [transaction({
        category: null,
        categoryQboId: null,
        suggestion: {
          category: 'Office expense',
          categoryQboId: 'EXPENSE_OFFICE',
          source: 'history',
        },
      })],
      nextCursor: null,
      pendingCount: 1,
    });
    mocks.categorize.mockImplementation(async (_id: string, request: { category: string; categoryQboId: string | null }) =>
      transaction({ category: request.category, categoryQboId: request.categoryQboId }),
    );
    await renderQueue();

    const category = screen.getByRole('combobox', { name: 'Category for Generic supplier' });
    await user.click(category);
    await user.keyboard('{Enter}');

    expect(category).toHaveTextContent('Expenses · Office expense');
  });
});
