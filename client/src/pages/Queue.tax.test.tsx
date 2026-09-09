import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CategorizationMutationResult,
  RuleMutationResult,
  StagedCategorization,
  TaxReadinessDto,
  TransactionDto,
} from '@recat/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  refreshProviderStatus: vi.fn(),
  role: 'categorizer' as 'categorizer' | 'admin' | 'viewer',
  bankAccounts: vi.fn(),
  categorize: vi.fn(),
  stage: vi.fn(),
  commit: vi.fn(),
  reconcile: vi.fn(),
  retryCategorization: vi.fn(),
  undoCategorization: vi.fn(),
  legacyPost: vi.fn(),
  legacyUndo: vi.fn(),
  retry: vi.fn(),
  bulkPost: vi.fn(),
  transfer: vi.fn(),
  sync: vi.fn(),
  currentCase: vi.fn(),
  prepareFromCase: vi.fn(),
  commitRuleOperation: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  setPendingCount: vi.fn(),
  refreshCompanies: vi.fn(),
  requestId: vi.fn(),
  activeCompanyId: 'COMPANY_GENERIC',
  qboMutationRevision: 0,
  mutationListeners: new Set<(event: { companyId: string; transactionIds: string[]; origin?: symbol }) => void>(),
  notifyQboMutation: vi.fn(),
  subscribeQboMutations: vi.fn(),
  taxReadiness: null as TaxReadinessDto | null,
  tags: [] as Array<{ id: string; companyId: string; name: string; color: string }>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    role: mocks.role,
    activeCompany: {
      id: mocks.activeCompanyId,
      nickname: 'Generic company',
      holdingAccountIds: [],
      lastSyncedAt: null,
    },
    activeCompanyId: mocks.activeCompanyId,
    qboMutationRevision: mocks.qboMutationRevision,
    notifyQboMutation: mocks.notifyQboMutation,
    subscribeQboMutations: mocks.subscribeQboMutations,
    accounts: [
      {
        id: 'ACCOUNT_GENERIC',
        qboId: 'EXPENSE_ACCOUNT',
        name: 'Generic expense',
        fullName: 'Expenses · Generic expense',
        classification: 'Expenses',
        active: true,
      },
      {
        id: 'ACCOUNT_ALTERNATE',
        qboId: 'EXPENSE_ACCOUNT_ALTERNATE',
        name: 'Alternate expense',
        fullName: 'Expenses · Alternate expense',
        classification: 'Expenses',
        active: true,
      },
      {
        id: 'ACCOUNT_LOCALIZED_HOLDING',
        qboId: 'LOCALIZED_HOLDING',
        name: 'Uncategorised Expense',
        fullName: 'Expenses · Uncategorised Expense',
        classification: 'Expenses',
        active: true,
      },
      {
        id: 'ACCOUNT_USER_NAMED',
        qboId: 'USER_NAMED',
        name: 'Old Uncategorized Costs',
        fullName: 'Expenses · Old Uncategorized Costs',
        classification: 'Expenses',
        active: true,
      },
    ],
    tags: mocks.tags,
    setPendingCount: mocks.setPendingCount,
    refreshCompanies: mocks.refreshCompanies,
    dryRun: false,
    tagsRequired: false,
    taxReadiness: mocks.taxReadiness,
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code?: string,
      readonly mutationResult?: CategorizationMutationResult,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    createCategorizationRequestId: mocks.requestId,
    companies: { sync: mocks.sync },
    reports: { bankAccounts: mocks.bankAccounts },
    classificationMemory: { currentCase: mocks.currentCase },
    rules: { lifecycle: vi.fn().mockResolvedValue({ runtimeMode: 'canonical', items: [], nextCursor: null }) },
    ruleOperations: { prepareFromCase: mocks.prepareFromCase, commit: mocks.commitRuleOperation },
    transactions: {
      list: mocks.list,
      refreshProviderStatus: mocks.refreshProviderStatus,
      categorize: mocks.categorize,
      stageCategorization: mocks.stage,
      commitCategorization: mocks.commit,
      reconcileCategorization: mocks.reconcile,
      retryCategorization: mocks.retryCategorization,
      undoCategorization: mocks.undoCategorization,
      post: mocks.legacyPost,
      undo: mocks.legacyUndo,
      retry: mocks.retry,
      transfer: mocks.transfer,
      bulkPost: mocks.bulkPost,
    },
  };
});


import Queue from './Queue';
import { ApiError } from '../lib/api';
import { installGlobalStyles } from '../test/globalStyles';

const READY: TaxReadinessDto = {
  status: 'ready',
  reason: null,
  usingSalesTax: true,
  refreshedAt: '2026-07-28T00:00:00.000Z',
  taxCodes: [{
    qboId: 'TAX_CODE_STANDARD',
    name: 'Standard purchase tax',
    active: true,
    taxable: true,
    combinedPurchaseRate: 5,
    combinedSalesRate: null,
  }],
  salesStatus: 'needs_setup',
  salesReason: null,
  salesTaxCodes: [],
};

const SALES_READY: TaxReadinessDto = {
  ...READY,
  salesStatus: 'ready',
  salesReason: null,
  salesTaxCodes: [{
    qboId: 'SALES_TAX_CODE',
    name: 'Standard sales tax',
    active: true,
    taxable: true,
    combinedPurchaseRate: null,
    combinedSalesRate: 5,
  }],
};

const SALES_INACTIVE_CODE = {
  qboId: 'SALES_TAX_INACTIVE',
  name: 'Inactive sales tax',
  active: false,
  taxable: true,
  combinedPurchaseRate: null,
  combinedSalesRate: 5,
};

const SALES_NON_DIRECTIONAL_CODE = {
  qboId: 'SALES_TAX_NON_DIRECTIONAL',
  name: 'Non-sales tax',
  active: true,
  taxable: true,
  combinedPurchaseRate: 5,
  combinedSalesRate: null,
};

const INVALID_SALES_CODE_CASES: Array<[string, string, TaxReadinessDto]> = [
  ['purchase-only', 'TAX_CODE_STANDARD', SALES_READY],
  ['inactive', SALES_INACTIVE_CODE.qboId, {
    ...SALES_READY,
    salesTaxCodes: [...SALES_READY.salesTaxCodes, SALES_INACTIVE_CODE],
  }],
  ['removed', 'SALES_TAX_REMOVED', SALES_READY],
  ['non-sales', SALES_NON_DIRECTIONAL_CODE.qboId, {
    ...SALES_READY,
    salesTaxCodes: [...SALES_READY.salesTaxCodes, SALES_NON_DIRECTIONAL_CODE],
  }],
];

function transaction(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'TRANSACTION_GENERIC',
    companyId: 'COMPANY_GENERIC',
    qboId: 'PURCHASE_GENERIC',
    qboType: 'Purchase',
    date: '2026-07-28T00:00:00.000Z',
    payee: 'Generic supplier',
    memo: null,
    amount: -10.5,
    bankAccount: 'Generic bank',
    status: 'PENDING',
    revision: 4,
    category: 'Generic expense',
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCalculation: 'TaxInclusive',
    taxCode: 'Standard purchase tax',
    taxCodeQboId: 'TAX_CODE_STANDARD',
    splits: null,
    tagIds: [],
    suggestion: null,
    error: null,
    postedAt: null,
    postedBy: null,
    activeCategorizationAttempt: null,
    ...overrides,
  };
}

function deposit(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return transaction({
    qboId: 'DEPOSIT_GENERIC',
    qboType: 'Deposit',
    payee: 'Generic customer receipt',
    amount: 10.5,
    taxCode: 'Standard sales tax',
    taxCodeQboId: 'SALES_TAX_CODE',
    ...overrides,
  });
}

const STAGED: StagedCategorization = {
  transactionId: 'TRANSACTION_GENERIC',
  revision: 5,
  taxCalculation: 'TaxInclusive',
  totals: { subtotalCents: -1000, taxCents: -50, totalCents: -1050 },
  lines: [{
    idx: 0,
    subtotalCents: -1000,
    taxCents: -50,
    totalCents: -1050,
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCodeQboId: 'TAX_CODE_STANDARD',
    memo: null,
    tagIds: [],
  }],
  tagIds: [],
};

function mutation(
  overrides: Partial<CategorizationMutationResult> = {},
): CategorizationMutationResult {
  return {
    transactionId: 'TRANSACTION_GENERIC',
    requestId: '00000000-0000-4000-8000-000000000101',
    ok: true,
    status: 'POSTED',
    outcome: 'VERIFIED',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderQueue(row: TransactionDto | TransactionDto[] = transaction()) {
  const transactions = Array.isArray(row) ? row : [row];
  mocks.list.mockResolvedValue({
    transactions,
    nextCursor: null,
    pendingCount: transactions.filter((transaction) => transaction.status === 'PENDING').length,
  });
  const view = render(<Queue />);
  await screen.findByText(transactions[0]!.payee);
  return view;
}

beforeEach(() => {
  mocks.qboMutationRevision = 0;
  vi.clearAllMocks();
  mocks.list.mockReset();
  mocks.mutationListeners.clear();
  mocks.subscribeQboMutations.mockImplementation(listener => { mocks.mutationListeners.add(listener); return () => mocks.mutationListeners.delete(listener); });
  mocks.notifyQboMutation.mockImplementation((companyId, transactionIds = [], origin) => { for (const listener of mocks.mutationListeners) listener({ companyId, transactionIds, origin }); });
  mocks.role = 'categorizer';
  mocks.refreshProviderStatus.mockResolvedValue({companyId: 'COMPANY_GENERIC', processed: 0, persisted: 0, failed: 0, nextCursor: null, partial: false, complete: true, items: []});
  Element.prototype.scrollIntoView = vi.fn();
  window.confirm = vi.fn(() => true);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  mocks.currentCase.mockResolvedValue(null);
  mocks.taxReadiness = READY;
  mocks.activeCompanyId = 'COMPANY_GENERIC';
  mocks.tags = [];
  mocks.transfer.mockResolvedValue([]);
  mocks.bankAccounts.mockResolvedValue([]);
  mocks.stage.mockResolvedValue(STAGED);
  mocks.commit.mockResolvedValue(mutation());
  mocks.reconcile.mockResolvedValue(mutation());
  mocks.retryCategorization.mockResolvedValue(mutation());
  mocks.undoCategorization.mockResolvedValue(
    mutation({
      requestId: '00000000-0000-4000-8000-000000000202',
      status: 'REVERTED',
    }),
  );
  mocks.categorize.mockResolvedValue(transaction());
  mocks.legacyPost.mockResolvedValue(transaction({ status: 'POSTED' }));
  mocks.legacyUndo.mockResolvedValue(transaction());
  mocks.requestId
    .mockReset()
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000101')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000202');
});

describe('tax-aware manual queue', () => {
  it('refreshes transaction rows when another view reports a company mutation', async () => {
    mocks.list.mockResolvedValueOnce({ transactions: [transaction()], nextCursor: null, pendingCount: 1 });
    const view = render(<Queue />);
    await screen.findByText('Generic supplier');
    mocks.list.mockResolvedValueOnce({ transactions: [transaction({ payee: 'Refreshed supplier', revision: 8 })], nextCursor: null, pendingCount: 1 });
    act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
    expect(await screen.findByText('Refreshed supplier')).toBeInTheDocument();
    expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument();
  });

  it('blocks Queue posting and navigation shortcuts while the split dialog owns focus', async () => {
    const user = userEvent.setup();
    await renderQueue([transaction(), transaction({
      id: 'TRANSACTION_SECOND', qboId: 'PURCHASE_SECOND', payee: 'Second supplier',
    })]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^post$/i })[0]).toBeEnabled());
    await user.click(screen.getAllByRole('button', { name: 'Split' })[0]!);
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Split transaction'));
    await user.keyboard('{Enter}jxc');
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.legacyPost).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Split transaction' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    (document.activeElement as HTMLElement)?.blur();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC', 5, '00000000-0000-4000-8000-000000000101',
    ));
  });

  it('shows a pointer cursor over clickable transaction rows', async () => {
    const style = installGlobalStyles();
    document.body.classList.add('rr');
    try {
      await renderQueue();
      const row = screen.getByText('Generic supplier').closest('.interactive-surface');
      expect(row).not.toBeNull();
      expect(getComputedStyle(row!).cursor).toBe('pointer');
    } finally {
      document.body.classList.remove('rr');
      style.remove();
    }
  });

  it('excludes localized Uncategorised holding accounts from category destinations', async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(screen.getByRole('combobox', {
      name: 'Category for Generic supplier',
    }));

    expect(screen.queryByRole('option', {
      name: /Uncategorised Expense/,
    })).not.toBeInTheDocument();
    expect(screen.getByRole('option', {
      name: /Alternate expense/,
    })).toBeInTheDocument();

    // A user's own account that merely mentions the term is not QuickBooks'
    // holding account, and hiding it would remove a destination they created
    // on purpose with nothing to explain where it went.
    expect(screen.getByRole('option', {
      name: /Old Uncategorized Costs/,
    })).toBeInTheDocument();
  });

  it.each([-1, 1])('stages proven source gross with direction %s instead of mirrored net', async (sign) => {
    const user = userEvent.setup();
    await renderQueue(transaction({ amount: sign * 100, sourceGrossCents: sign * 11200 }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC', expect.objectContaining({
        lines: [expect.objectContaining({ grossCents: sign * 11200 })],
      }),
    ));
  });

  it.each(['row', 'split'] as const)('explains an unavailable tax code after an existing %s preview', async (kind) => {
    const current = kind === 'row' ? transaction() : transaction({ category: null, categoryQboId: null, splits: [{ amount: -10.5, category: 'Generic expense', categoryQboId: 'EXPENSE_ACCOUNT', taxCode: 'Standard tax', taxCodeQboId: 'TAX_CODE_STANDARD', tagIds: [] }] });
    mocks.list.mockResolvedValue({ transactions: [current], nextCursor: null, pendingCount: 1 });
    const view = render(<Queue />);
    await screen.findByText('Generic supplier');
    await waitForPostEnabled();
    mocks.taxReadiness = { ...READY, taxCodes: [] };
    view.rerender(<Queue />);
    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
    expect(screen.queryByText('Subtotal −$10.00')).not.toBeInTheDocument();
    expect(screen.getByText(kind === 'split' ? 'Open Split to review its categories and tax codes before calculating tax.' : 'Choose an available category and tax code before calculating tax.')).toBeInTheDocument();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('offers accounts with no transactions currently in the Queue', async () => {
    mocks.list.mockResolvedValue({ transactions: [], nextCursor: null, pendingCount: 0 });
    mocks.bankAccounts.mockResolvedValue(['Example dormant account']);
    render(<Queue />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Account filter' }));
    expect(await screen.findByRole('option', { name: 'Example dormant account' })).toBeInTheDocument();
    expect(mocks.bankAccounts).toHaveBeenCalledWith('COMPANY_GENERIC');
  });

  it('ignores account results from a company that is no longer selected', async () => {
    const old = deferred<string[]>();
    mocks.list.mockResolvedValue({ transactions: [], nextCursor: null, pendingCount: 0 });
    mocks.bankAccounts.mockReturnValueOnce(old.promise).mockResolvedValueOnce(['Example current account']);
    const view = render(<Queue />);
    await waitFor(() => expect(mocks.bankAccounts).toHaveBeenCalledTimes(1));
    mocks.activeCompanyId = 'COMPANY_OTHER';
    view.rerender(<Queue />);
    await waitFor(() => expect(mocks.bankAccounts).toHaveBeenCalledWith('COMPANY_OTHER'));
    await userEvent.click(screen.getByRole('combobox', { name: 'Account filter' }));
    expect(await screen.findByRole('option', { name: 'Example current account' })).toBeInTheDocument();
    await act(async () => old.resolve(['Example old account']));
    expect(screen.queryByRole('option', { name: 'Example old account' })).not.toBeInTheDocument();
  });

  it('stages exact cents at the current revision, previews server totals, and commits that revision', async () => {
    const user = userEvent.setup();
    await renderQueue();

    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      {
        expectedRevision: 4,
        taxCalculation: 'TaxInclusive',
        lines: [{
          grossCents: -1050,
          categoryQboId: 'EXPENSE_ACCOUNT',
          taxCodeQboId: 'TAX_CODE_STANDARD',
          tagIds: [],
        }],
        tagIds: [],
      },
    ));

    expect(screen.getByText(/subtotal.*10\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/tax.*0\.50/i)).toBeInTheDocument();
    expect(screen.getByText(/total.*10\.50/i)).toBeInTheDocument();
    expect(screen.getByText('Subtotal −$10.00')).toBeInTheDocument();
    expect(screen.getByText('Tax −$0.50')).toBeInTheDocument();
    expect(screen.getByText('Total −$10.50')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      5,
      '00000000-0000-4000-8000-000000000101',
    ));
    expect(await screen.findByText(/posted.*verified/i)).toBeInTheDocument();
  });

  it('renders positive server preview totals as an explicit refund direction', async () => {
    mocks.stage.mockResolvedValue({
      ...STAGED,
      totals: { subtotalCents: 1000, taxCents: 50, totalCents: 1050 },
      lines: [{
        ...STAGED.lines[0]!,
        subtotalCents: 1000,
        taxCents: 50,
        totalCents: 1050,
      }],
    });
    const user = userEvent.setup();
    await renderQueue(transaction({ amount: 10.5 }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());

    expect(await screen.findByText('Subtotal +$10.00')).toBeInTheDocument();
    expect(screen.getByText('Tax +$0.50')).toBeInTheDocument();
    expect(screen.getByText('Total +$10.50')).toBeInTheDocument();
  });

  it('confirms the staged QuickBooks totals before allocating a commit UUID', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^post$/i }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(
      /post.*quickbooks[\s\S]*subtotal −\$10\.00[\s\S]*tax −\$0\.50[\s\S]*total −\$10\.50/i,
    ));
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.requestId).not.toHaveBeenCalled();
  });

  it('confirms the exact-restore QuickBooks operation before allocating an undo UUID', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    await renderQueue(transaction({ status: 'POSTED' }));

    await user.click(screen.getByRole('button', { name: /^undo$/i }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(
      /undo.*quickbooks[\s\S]*restore.*original purchase/i,
    ));
    expect(mocks.undoCategorization).not.toHaveBeenCalled();
    expect(mocks.requestId).not.toHaveBeenCalled();
  });


  it('lets an in-flight draft change restage and prevents the older request from clearing the newer one', async () => {
    const first = deferred<StagedCategorization>();
    const second = deferred<StagedCategorization>();
    mocks.stage
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const user = userEvent.setup();
    await renderQueue();

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
    expect(screen.getByText('Calculating tax…')).toBeInTheDocument();
    await act(async () => first.resolve(STAGED));

    expect(screen.queryByText(/subtotal.*10\.00/i)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve({
      ...STAGED,
      revision: 6,
      taxCalculation: 'TaxExcluded',
      totals: { subtotalCents: -1050, taxCents: -53, totalCents: -1103 },
    }));

    expect(await screen.findByText(/subtotal.*10\.50/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^post$/i })).toBeEnabled();
    expect(mocks.stage.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 5,
      taxCalculation: 'TaxExcluded',
    });
  });

  it('invalidates an in-flight preview when the category changes', async () => {
    await expectInFlightChangeRestages(async (user) => {
      await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
      await user.type(screen.getByRole('textbox', { name: 'Category for Generic supplier' }), 'alternate');
      await user.click(screen.getByRole('option', { name: /Alternate expense/ }));
    });
  });

  it('invalidates an in-flight preview when a row tag changes', async () => {
    mocks.tags = [{
      id: '00000000-0000-4000-8000-000000000070',
      companyId: 'COMPANY_GENERIC',
      name: 'Generic tag',
      color: '#667788',
    }];
    await expectInFlightChangeRestages(async (user) => {
      await user.click(screen.getByRole('button', { name: '+ tag' }));
      await user.click(screen.getByRole('button', { name: 'Generic tag' }));
    });
  });

  it('invalidates an in-flight preview when the tax code changes', async () => {
    await expectInFlightChangeRestages(async (user) => {
      await chooseControl(user, 'Purchase tax for Generic supplier', 'No tax');
    });
  });



  it.each([
    ['TaxInclusive', 'TaxInclusive'],
    ['TaxExcluded', 'TaxExcluded'],
  ] as const)(
    'reloads a %s split and stages its exact stored calculation and line tax identities',
    async (storedCalculation, expectedCalculation) => {
      const splitRow = transaction({
        category: null,
        categoryQboId: null,
        taxCalculation: storedCalculation,
        taxCode: null,
        taxCodeQboId: null,
        splits: [
          {
            amount: -6,
            category: 'Generic expense',
            categoryQboId: 'EXPENSE_ACCOUNT',
            taxCode: 'Standard purchase tax',
            taxCodeQboId: 'TAX_CODE_STANDARD',
            tagIds: [],
            memo: 'Generic first line',
          },
          {
            amount: -4.5,
            category: 'Generic expense',
            categoryQboId: 'EXPENSE_ACCOUNT',
            taxCode: 'Standard purchase tax',
            taxCodeQboId: 'TAX_CODE_STANDARD',
            tagIds: [],
          },
        ],
      });
      mocks.stage.mockResolvedValue({
        ...STAGED,
        taxCalculation: storedCalculation,
      });
      const user = userEvent.setup();
      await renderQueue(splitRow);

      expect(
        screen.getByLabelText('Tax calculation for Generic supplier'),
      ).toHaveTextContent(expectedCalculation === 'TaxExcluded' ? 'Tax exclusive' : 'Tax inclusive');
      await waitFor(() => expect(mocks.stage).toHaveBeenCalled());

      await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
        'TRANSACTION_GENERIC',
        {
          expectedRevision: 4,
          taxCalculation: expectedCalculation,
          lines: [
            {
              grossCents: -600,
              categoryQboId: 'EXPENSE_ACCOUNT',
              taxCodeQboId: 'TAX_CODE_STANDARD',
              memo: 'Generic first line',
              tagIds: [],
            },
            {
              grossCents: -450,
              categoryQboId: 'EXPENSE_ACCOUNT',
              taxCodeQboId: 'TAX_CODE_STANDARD',
              tagIds: [],
            },
          ],
          tagIds: [],
        },
      ));
    },
  );

  it('shows a reloaded all-blank split as transaction-wide NotApplicable', async () => {
    await renderQueue(transaction({
      category: null,
      categoryQboId: null,
      taxCalculation: 'NotApplicable',
      taxCode: null,
      taxCodeQboId: null,
      splits: [{
        amount: -10.5,
        category: 'Generic expense',
        categoryQboId: 'EXPENSE_ACCOUNT',
        taxCode: null,
        taxCodeQboId: null,
        tagIds: [],
      }],
    }));

    expect(
      screen.queryByLabelText('Tax calculation for Generic supplier'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('No tax selected')).toBeInTheDocument();
  });

  it('retains the request ID through uncertainty and retry, never claiming Posted', async () => {
    mocks.commit.mockResolvedValue(mutation({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message: 'The write may have succeeded.',
      },
    }));
    mocks.retryCategorization.mockResolvedValue(mutation({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
    }));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^post$/i }));

    expect(await screen.findByText(/verify in quickbooks/i)).toBeInTheDocument();
    expect(screen.queryByText(/posted/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry verification/i }));

    await waitFor(() => expect(mocks.retryCategorization).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      '00000000-0000-4000-8000-000000000101',
    ));
    expect(mocks.requestId).toHaveBeenCalledTimes(1);
  });

  it('uses a structured RETRYABLE ApiError as a known not-sent result', async () => {
    mocks.commit.mockRejectedValue(new ApiError(
      409,
      'The prepared write was not sent.',
      'RETRYABLE',
      mutation({
        ok: false,
        status: 'PENDING',
        outcome: 'RETRYABLE',
        error: { code: 'RETRYABLE', message: 'The prepared write was not sent.' },
      }),
    ));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^post$/i }));

    expect(await screen.findByText(/not posted.*restage to retry/i)).toBeInTheDocument();
    expect(screen.queryByText(/verify in quickbooks/i)).not.toBeInTheDocument();
  });

  it('returns a known pre-write ApiError to an actionable staged state', async () => {
    mocks.commit.mockRejectedValue(new ApiError(
      503,
      'The prepared write was not sent. Retry with a new request.',
      'PREWRITE_PERSISTENCE_FAILED',
    ));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^post$/i }));

    expect(await screen.findByRole('button', { name: /^post$/i })).toBeEnabled();
    expect(screen.queryByText(/verify in quickbooks/i)).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(
      'The prepared write was not sent. Retry with a new request.',
    );
  });

  it('treats an unstructured transport failure as genuinely uncertain', async () => {
    mocks.commit.mockRejectedValue(new TypeError('Network request failed'));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^post$/i }));

    expect(await screen.findByText(/verify in quickbooks/i)).toBeInTheDocument();
    expect(screen.queryByText(/posted.*verified/i)).not.toBeInTheDocument();
  });

  it.each([
    ['recategorize', 'UNCERTAIN', 'ERROR'],
    ['recategorize', 'COMMITTING', 'PENDING'],
    ['restore', 'UNCERTAIN', 'ERROR'],
    ['restore', 'COMMITTING', 'POSTED'],
  ] as const)(
    'reloads a %s %s attempt and reconciles it with its persisted request ID',
    async (operation, attemptStatus, transactionStatus) => {
      const persistedRequestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000302'
        : '00000000-0000-4000-8000-000000000301';
      const reloaded = {
        ...transaction({
          status: transactionStatus,
          error: transactionStatus === 'ERROR'
            ? { code: 'QBO_WRITE_UNCERTAIN', message: 'Verify the outcome.' }
            : null,
        }),
        activeCategorizationAttempt: {
          requestId: persistedRequestId,
          operation,
          status: attemptStatus,
        },
      } as TransactionDto;
      mocks.reconcile.mockResolvedValue(mutation({
        requestId: persistedRequestId,
        status: operation === 'restore' ? 'REVERTED' : 'POSTED',
      }));
      const user = userEvent.setup();
      await renderQueue(reloaded);

      expect(screen.getByText(/verify in quickbooks/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /^reconcile$/i }));

      await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith(
        'TRANSACTION_GENERIC',
        persistedRequestId,
      ));
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it.each(['PREPARED', 'COMMITTING', 'UNCERTAIN'] as const)(
    'locks every draft and stage path while a %s attempt is active',
    async (attemptStatus) => {
      mocks.tags = [{
        id: '00000000-0000-4000-8000-000000000070',
        companyId: 'COMPANY_GENERIC',
        name: 'Generic tag',
        color: '#667788',
      }];
      const persistedRequestId = '00000000-0000-4000-8000-000000000501';
      await renderQueue(transaction({
        activeCategorizationAttempt: {
          requestId: persistedRequestId,
          operation: 'recategorize',
          status: attemptStatus,
        },
      }));

      expect(screen.getByRole('combobox', {
        name: 'Category for Generic supplier',
      })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '+ tag' })).toBeDisabled();
      expect(screen.getByLabelText('Purchase tax for Generic supplier')).toBeDisabled();
      expect(screen.getByLabelText('Tax calculation for Generic supplier')).toBeDisabled();
      expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('checkbox')[1]).toBeDisabled();

      await userEvent.setup().keyboard('ct{Enter}');

      expect(mocks.categorize).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.commit).not.toHaveBeenCalled();
      expect(mocks.legacyPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['recategorize', 'PREPARED'],
    ['restore', 'PREPARED'],
    ['recategorize', 'COMMITTING'],
    ['restore', 'COMMITTING'],
    ['recategorize', 'UNCERTAIN'],
    ['restore', 'UNCERTAIN'],
  ] as const)(
    'resolves an ambiguous PREPARED %s resume to persisted %s without inventing or sending',
    async (operation, resolvedStatus) => {
      const requestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000712'
        : '00000000-0000-4000-8000-000000000711';
      const initial = transaction({
        status: operation === 'restore' ? 'POSTED' : 'PENDING',
        activeCategorizationAttempt: {
          requestId,
          operation,
          status: 'PREPARED',
        },
      });
      const resumedEndpoint = operation === 'restore'
        ? mocks.undoCategorization
        : mocks.commit;
      resumedEndpoint.mockRejectedValueOnce(new TypeError('connection reset'));
      const user = userEvent.setup();
      await renderQueue(initial);
      mocks.list.mockResolvedValue({
        transactions: [{
          ...initial,
          activeCategorizationAttempt: {
            requestId,
            operation,
            status: resolvedStatus,
          },
        }],
        nextCursor: null,
        pendingCount: 1,
      });

      await user.click(screen.getByRole('button', {
        name: operation === 'restore' ? 'Resume undo' : 'Resume post',
      }));

      if (resolvedStatus === 'PREPARED') {
        expect(await screen.findByRole('button', {
          name: operation === 'restore' ? 'Resume undo' : 'Resume post',
        })).toBeEnabled();
      } else {
        expect(await screen.findByRole('button', { name: /^reconcile$/i })).toBeEnabled();
      }
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(resumedEndpoint).toHaveBeenCalledTimes(1);
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it.each(['recategorize', 'restore'] as const)(
    'replays an ambiguous PREPARED %s resume with the exact UUID only after list proves no active attempt',
    async (operation) => {
      const requestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000722'
        : '00000000-0000-4000-8000-000000000721';
      const initial = transaction({
        status: operation === 'restore' ? 'POSTED' : 'PENDING',
        activeCategorizationAttempt: {
          requestId,
          operation,
          status: 'PREPARED',
        },
      });
      const result = mutation({
        requestId,
        status: operation === 'restore' ? 'REVERTED' : 'POSTED',
      });
      const resumedEndpoint = operation === 'restore'
        ? mocks.undoCategorization
        : mocks.commit;
      resumedEndpoint
        .mockRejectedValueOnce(new TypeError('connection reset'))
        .mockResolvedValueOnce(result);
      const user = userEvent.setup();
      await renderQueue(initial);
      mocks.list.mockResolvedValue({
        transactions: [{
          ...initial,
          activeCategorizationAttempt: null,
        }],
        nextCursor: null,
        pendingCount: 1,
      });

      await user.click(screen.getByRole('button', {
        name: operation === 'restore' ? 'Resume undo' : 'Resume post',
      }));

      await waitFor(() => expect(resumedEndpoint).toHaveBeenCalledTimes(2));
      if (operation === 'restore') {
        expect(resumedEndpoint).toHaveBeenNthCalledWith(
          2,
          'TRANSACTION_GENERIC',
          requestId,
        );
        expect(await screen.findByText(/reverted/i)).toBeInTheDocument();
      } else {
        expect(resumedEndpoint).toHaveBeenNthCalledWith(
          2,
          'TRANSACTION_GENERIC',
          4,
          requestId,
        );
        expect(await screen.findByText(/posted.*verified/i)).toBeInTheDocument();
      }
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['UNCERTAIN', 'recategorize', 'ERROR'],
    ['UNCERTAIN', 'restore', 'ERROR'],
    ['RETRYABLE', 'recategorize', 'PENDING'],
    ['RETRYABLE', 'restore', 'POSTED'],
  ] as const)(
    'records structured %s no-active replay result for %s with the persisted UUID',
    async (outcome, operation, resultStatus) => {
      const requestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000752'
        : '00000000-0000-4000-8000-000000000751';
      const initial = transaction({
        status: operation === 'restore' ? 'POSTED' : 'PENDING',
        activeCategorizationAttempt: {
          requestId,
          operation,
          status: 'PREPARED',
        },
      });
      const structuredResult = mutation({
        requestId,
        ok: false,
        status: resultStatus,
        outcome,
        error: {
          code: outcome === 'UNCERTAIN' ? 'QBO_WRITE_UNCERTAIN' : 'RETRYABLE',
          message: outcome === 'UNCERTAIN'
            ? 'Verify the QuickBooks outcome.'
            : 'The prepared write was not sent.',
        },
      });
      const resumedEndpoint = operation === 'restore'
        ? mocks.undoCategorization
        : mocks.commit;
      resumedEndpoint
        .mockRejectedValueOnce(new TypeError('connection reset'))
        .mockRejectedValueOnce(new ApiError(
          409,
          structuredResult.error!.message,
          structuredResult.error!.code,
          structuredResult,
        ));
      const user = userEvent.setup();
      await renderQueue(initial);
      mocks.list.mockResolvedValue({
        transactions: [{
          ...initial,
          activeCategorizationAttempt: null,
        }],
        nextCursor: null,
        pendingCount: 1,
      });

      await user.click(screen.getByRole('button', {
        name: operation === 'restore' ? 'Resume undo' : 'Resume post',
      }));

      await waitFor(() => expect(resumedEndpoint).toHaveBeenCalledTimes(2));
      if (operation === 'restore') {
        expect(resumedEndpoint).toHaveBeenNthCalledWith(
          2,
          'TRANSACTION_GENERIC',
          requestId,
        );
      } else {
        expect(resumedEndpoint).toHaveBeenNthCalledWith(
          2,
          'TRANSACTION_GENERIC',
          4,
          requestId,
        );
      }
      if (outcome === 'UNCERTAIN') {
        expect(await screen.findByText(/verify in quickbooks/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^reconcile$/i })).toBeEnabled();
      } else if (operation === 'restore') {
        expect(await screen.findByText('Undo not sent')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry undo' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: /^reconcile$/i })).not.toBeInTheDocument();
      } else {
        expect(await screen.findByRole('button', { name: 'Restage categorization' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: /^post$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^reconcile$/i })).not.toBeInTheDocument();
      }
      expect(screen.queryByText(/write status unresolved/i)).not.toBeInTheDocument();
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unstructured', () => new TypeError('replay connection reset')],
    ['mismatched', () => new ApiError(
      409,
      'Wrong durable result.',
      'QBO_WRITE_UNCERTAIN',
      mutation({
        requestId: '00000000-0000-4000-8000-000000000799',
        ok: false,
        status: 'ERROR',
        outcome: 'UNCERTAIN',
      }),
    )],
  ] as const)(
    'keeps a %s no-active replay failure neutral',
    async (_kind, replayError) => {
      const requestId = '00000000-0000-4000-8000-000000000761';
      const initial = transaction({
        activeCategorizationAttempt: {
          requestId,
          operation: 'recategorize',
          status: 'PREPARED',
        },
      });
      mocks.commit
        .mockRejectedValueOnce(new TypeError('connection reset'))
        .mockRejectedValueOnce(replayError());
      const user = userEvent.setup();
      await renderQueue(initial);
      mocks.list.mockResolvedValue({
        transactions: [{
          ...initial,
          activeCategorizationAttempt: null,
        }],
        nextCursor: null,
        pendingCount: 1,
      });

      await user.click(screen.getByRole('button', { name: 'Resume post' }));

      expect(await screen.findByText(/write status unresolved.*reload/i)).toBeInTheDocument();
      expect(mocks.commit).toHaveBeenCalledTimes(2);
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it.each(['recategorize', 'restore'] as const)(
    'renders neutral unresolved state when PREPARED %s resume state cannot be refetched',
    async (operation) => {
      const requestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000732'
        : '00000000-0000-4000-8000-000000000731';
      const resumedEndpoint = operation === 'restore'
        ? mocks.undoCategorization
        : mocks.commit;
      resumedEndpoint.mockRejectedValueOnce(new TypeError('connection reset'));
      const user = userEvent.setup();
      await renderQueue(transaction({
        status: operation === 'restore' ? 'POSTED' : 'PENDING',
        activeCategorizationAttempt: {
          requestId,
          operation,
          status: 'PREPARED',
        },
      }));
      mocks.list.mockRejectedValueOnce(new TypeError('list unavailable'));

      await user.click(screen.getByRole('button', {
        name: operation === 'restore' ? 'Resume undo' : 'Resume post',
      }));

      expect(await screen.findByText(/write status unresolved.*reload/i)).toBeInTheDocument();
      expect(resumedEndpoint).toHaveBeenCalledTimes(1);
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it('does not replay a resolved PREPARED resume after the active company changes', async () => {
    const requestId = '00000000-0000-4000-8000-000000000741';
    const oldCompanyReload = deferred<{
      transactions: TransactionDto[];
      nextCursor: null;
      pendingCount: number;
    }>();
    mocks.commit.mockRejectedValueOnce(new TypeError('connection reset'));
    const user = userEvent.setup();
    const view = await renderQueue(transaction({
      activeCategorizationAttempt: {
        requestId,
        operation: 'recategorize',
        status: 'PREPARED',
      },
    }));
    mocks.list.mockImplementation((companyId: string) => (
      companyId === 'COMPANY_GENERIC'
        ? oldCompanyReload.promise
        : Promise.resolve({
            transactions: [transaction({
              id: 'TRANSACTION_OTHER',
              companyId: 'COMPANY_OTHER',
              payee: 'Other company supplier',
            })],
            nextCursor: null,
            pendingCount: 1,
          })
    ));

    await user.click(screen.getByRole('button', { name: 'Resume post' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    mocks.activeCompanyId = 'COMPANY_OTHER';
    view.rerender(<Queue />);
    await screen.findByText('Other company supplier');
    await act(async () => oldCompanyReload.resolve({
      transactions: [{
        ...transaction(),
        activeCategorizationAttempt: null,
      }],
      nextCursor: null,
      pendingCount: 1,
    }));

    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.requestId).not.toHaveBeenCalled();
  });

  it.each([
    ['recategorize', 'PENDING', 'Resume post', 'POSTED'],
    ['restore', 'POSTED', 'Resume undo', 'REVERTED'],
  ] as const)(
    'truthfully resumes a PREPARED %s through its original endpoint and exact UUID',
    async (operation, transactionStatus, buttonName, terminalStatus) => {
      const persistedRequestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000602'
        : '00000000-0000-4000-8000-000000000601';
      const result = mutation({
        requestId: persistedRequestId,
        status: terminalStatus,
      });
      mocks.commit.mockResolvedValue(result);
      mocks.undoCategorization.mockResolvedValue(result);
      const user = userEvent.setup();
      await renderQueue(transaction({
        status: transactionStatus,
        activeCategorizationAttempt: {
          requestId: persistedRequestId,
          operation,
          status: 'PREPARED',
        },
      }));

      expect(screen.getByText(/prepared.*not sent/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /reconcile/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: buttonName }));

      if (operation === 'restore') {
        await waitFor(() => expect(mocks.undoCategorization).toHaveBeenCalledWith(
          'TRANSACTION_GENERIC',
          persistedRequestId,
        ));
        expect(mocks.commit).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(
          'TRANSACTION_GENERIC',
          4,
          persistedRequestId,
        ));
        expect(mocks.undoCategorization).not.toHaveBeenCalled();
      }
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.retryCategorization).not.toHaveBeenCalled();
      expect(mocks.requestId).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['recategorize', 'Posting…'],
    ['restore', 'Undoing…'],
  ] as const)(
    'labels %s reconciliation as verification, never %s',
    async (operation, forbiddenLabel) => {
      const pending = deferred<CategorizationMutationResult>();
      mocks.reconcile.mockReset().mockImplementationOnce(() => pending.promise);
      const persistedRequestId = operation === 'restore'
        ? '00000000-0000-4000-8000-000000000402'
        : '00000000-0000-4000-8000-000000000401';
      const row = {
        ...transaction({
          status: operation === 'restore' ? 'POSTED' : 'ERROR',
          error: operation === 'restore'
            ? null
            : { code: 'QBO_WRITE_UNCERTAIN', message: 'Verify the outcome.' },
        }),
        activeCategorizationAttempt: {
          requestId: persistedRequestId,
          operation,
          status: 'UNCERTAIN',
        },
      } as TransactionDto;
      const user = userEvent.setup();
      await renderQueue(row);

      await user.click(screen.getByRole('button', { name: /^reconcile$/i }));

      expect(screen.getByText('Verifying…')).toBeInTheDocument();
      expect(screen.queryByText(forbiddenLabel)).not.toBeInTheDocument();
    },
  );

  it('labels a reconciled outcome as verified and uses a new ID for undo', async () => {
    mocks.commit.mockResolvedValue(mutation({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
    }));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^post$/i }));
    await user.click(await screen.findByRole('button', { name: /reconcile/i }));

    expect(await screen.findByText(/verified in quickbooks/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => expect(mocks.undoCategorization).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      '00000000-0000-4000-8000-000000000202',
    ));
    expect(await screen.findByText(/reverted/i)).toBeInTheDocument();
  });

  it('preserves the legacy category, tag, and post flow when tax is disabled', async () => {
    mocks.taxReadiness = {
      status: 'unsupported',
      reason: 'Purchase tax is disabled.',
      usingSalesTax: false,
      refreshedAt: null,
      taxCodes: [],
      salesStatus: 'unsupported',
      salesReason: 'Sales tax is disabled.',
      salesTaxCodes: [],
    };
    const user = userEvent.setup();
    await renderQueue(transaction({
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
    }));

    expect(screen.getByText(/purchase tax is disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(mocks.legacyPost).toHaveBeenCalledWith('TRANSACTION_GENERIC'));
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it('does not send an unstaged tax-ready purchase through legacy bulk post', async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(screen.getAllByRole('checkbox')[1]!);
    const bulkPostButton = screen.getByRole('button', { name: /post 1 transaction/i });

    expect(bulkPostButton).toHaveStyle({ opacity: '0.45' });
    await user.click(bulkPostButton);

    expect(mocks.bulkPost).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'Tax-ready purchases must be previewed and posted individually',
    );
  });

  it('runs a sales-ready Deposit through the tax lifecycle with positive cents and Deposit undo copy', async () => {
    mocks.taxReadiness = SALES_READY;
    mocks.commit.mockResolvedValue(mutation({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: { code: 'QBO_WRITE_UNCERTAIN', message: 'Verify the outcome.' },
    }));
    mocks.stage.mockResolvedValue({
      ...STAGED,
      totals: { subtotalCents: 1000, taxCents: 50, totalCents: 1050 },
      lines: [{ ...STAGED.lines[0]!, subtotalCents: 1000, taxCents: 50, totalCents: 1050, taxCodeQboId: 'SALES_TAX_CODE' }],
    });
    const user = userEvent.setup();
    await renderQueue(deposit());

    expect(screen.getByLabelText('Sales tax for Generic customer receipt')).toHaveTextContent('Standard sales tax');
    expect(screen.queryByLabelText('Purchase tax for Generic customer receipt')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalled());
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({
        lines: [expect.objectContaining({ grossCents: 1050, taxCodeQboId: 'SALES_TAX_CODE' })],
      }),
    ));
    await user.click(await screen.findByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^reconcile$/i }));
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      '00000000-0000-4000-8000-000000000101',
    ));
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringMatching(/original deposit/i));
    await waitFor(() => expect(mocks.undoCategorization).toHaveBeenCalled());
  });

  it('keeps a sales-not-ready Deposit on the legacy workflow and leaves JournalEntry without tax controls', async () => {
    mocks.taxReadiness = { ...READY, salesStatus: 'needs_setup', salesReason: 'Sales tax needs setup.', salesTaxCodes: [] };
    const user = userEvent.setup();
    await renderQueue(deposit({ taxCalculation: null, taxCode: null, taxCodeQboId: null }));

    expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(mocks.legacyPost).toHaveBeenCalledWith('TRANSACTION_GENERIC'));

    mocks.taxReadiness = SALES_READY;
    await renderQueue(transaction({ qboType: 'JournalEntry', taxCalculation: null, taxCode: null, taxCodeQboId: null }));
    expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Purchase tax for Generic supplier')).not.toBeInTheDocument();
  });

  it('excludes a sales-ready Deposit from legacy bulk posting', async () => {
    mocks.taxReadiness = SALES_READY;
    const user = userEvent.setup();
    await renderQueue(deposit());

    await user.click(screen.getAllByRole('checkbox')[1]!);
    await user.click(screen.getByRole('button', { name: /post 1 transaction/i }));

    expect(mocks.bulkPost).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'Tax-ready transactions must be previewed and posted individually',
    );
  });

  it('keeps a reloaded tax-marked Deposit in the durable posting lifecycle when sales readiness is unavailable', async () => {
    mocks.taxReadiness = { ...READY, salesStatus: 'needs_setup', salesReason: 'Sales tax needs setup.', salesTaxCodes: [] };
    await renderQueue(deposit());

    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
    expect(mocks.legacyPost).not.toHaveBeenCalled();
  });

  it('uses categorization undo for a recently posted Deposit when sales readiness is unavailable', async () => {
    mocks.taxReadiness = { ...READY, salesStatus: 'needs_setup', salesReason: 'Sales tax needs setup.', salesTaxCodes: [] };
    const user = userEvent.setup();
    // Keep the fixture inside the server's 30-day undo window regardless of
    // when this suite runs.
    await renderQueue(deposit({
      status: 'POSTED',
      postedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }));

    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    await waitFor(() => expect(mocks.undoCategorization).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      '00000000-0000-4000-8000-000000000101',
    ));
    expect(mocks.legacyUndo).not.toHaveBeenCalled();
  });

  it('rejects the entire mixed bulk selection when a sales-ready Deposit is selected', async () => {
    mocks.taxReadiness = { ...SALES_READY, status: 'needs_setup', reason: 'Purchase tax needs setup.', taxCodes: [] };
    const user = userEvent.setup();
    await renderQueue([
      transaction({ id: 'TRANSACTION_LEGACY', taxCalculation: null, taxCode: null, taxCodeQboId: null }),
      deposit(),
    ]);

    await user.click(screen.getAllByRole('checkbox')[1]!);
    await user.click(screen.getAllByRole('checkbox')[2]!);
    await user.click(screen.getByRole('button', { name: /post 2 transactions/i }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'Tax-ready transactions must be previewed and posted individually',
    ));
    expect(mocks.bulkPost).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it.each(INVALID_SALES_CODE_CASES)(
    'does not stage an unsplit Deposit with a %s tax ID',
    async (_kind, taxCodeQboId, readiness) => {
      mocks.taxReadiness = readiness;
      await renderQueue(deposit({ taxCodeQboId, taxCalculation: 'TaxInclusive' }));

      expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );

  it.each(INVALID_SALES_CODE_CASES)(
    'does not stage a split Deposit with a %s tax ID',
    async (_kind, taxCodeQboId, readiness) => {
      mocks.taxReadiness = readiness;
      await renderQueue(deposit({
        category: null,
        categoryQboId: null,
        taxCode: null,
        taxCodeQboId: null,
        splits: [{
          amount: 10.5,
          category: 'Generic expense',
          categoryQboId: 'EXPENSE_ACCOUNT',
          taxCode: 'Stale tax code',
          taxCodeQboId,
          tagIds: [],
          memo: 'Generic split memo',
        }],
      }));

      expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );
  it('automatically stages No tax after category selection', async () => {
    const user = userEvent.setup();
    await renderQueue(transaction({
      category: null,
      categoryQboId: null,
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
    }));

    await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
    await user.click(screen.getByRole('option', { name: /Generic expense/ }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC',
      {
        expectedRevision: 4,
        taxCalculation: 'NotApplicable',
        lines: [{
          grossCents: -1050,
          categoryQboId: 'EXPENSE_ACCOUNT',
          taxCodeQboId: null,
          tagIds: [],
        }],
        tagIds: [],
      },
    ));
    expect(mocks.categorize).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /preview tax/i })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Purchase tax for Generic supplier' })).toHaveTextContent('No tax');
  });

  it('automatically restages when the tax code changes', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    await chooseControl(user, 'Purchase tax for Generic supplier', 'No tax');

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({
        expectedRevision: 5,
        taxCalculation: 'NotApplicable',
        lines: [expect.objectContaining({ taxCodeQboId: null })],
      }),
    );
  });

  it('automatically restages when tax calculation changes', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({ expectedRevision: 5, taxCalculation: 'TaxExcluded' }),
    );
  });

  it('automatically restages transaction tags', async () => {
    const tagId = '00000000-0000-4000-8000-000000000070';
    mocks.tags = [{
      id: tagId,
      companyId: 'COMPANY_GENERIC',
      name: 'Generic tag',
      color: '#667788',
    }];
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: '+ tag' }));
    await user.click(screen.getByRole('button', { name: 'Generic tag' }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({
        tagIds: [tagId],
        lines: [expect.objectContaining({ tagIds: [tagId] })],
      }),
    );
  });

  it('automatically restages saved split-line changes', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Split' }));
    await user.type(screen.getByLabelText('Memo for split line 1'), 'Allocation');
    await user.click(screen.getAllByRole('button', { name: /Remove split line/ })[1]!);
    await user.click(screen.getByRole('button', { name: 'Save split' }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({
        expectedRevision: 5,
        lines: [expect.objectContaining({ grossCents: -1050, memo: 'Allocation' })],
      }),
    );
  });

  it('discards an in-flight preview after saving a newer split draft', async () => {
    const first = deferred<StagedCategorization>();
    const second = deferred<StagedCategorization>();
    mocks.stage.mockReset().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await user.type(screen.getByLabelText('Memo for split line 1'), 'Updated allocation');
    await user.click(screen.getAllByRole('button', { name: /Remove split line/ })[1]!);
    await user.click(screen.getByRole('button', { name: 'Save split' }));
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(STAGED));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
    expect(mocks.stage).toHaveBeenLastCalledWith('TRANSACTION_GENERIC', expect.objectContaining({
      expectedRevision: 5,
      lines: [expect.objectContaining({ grossCents: -1050, memo: 'Updated allocation' })],
    }));
    await act(async () => second.resolve({ ...STAGED, revision: 6 }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^post$/i })).toBeEnabled());
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('automatically restages saved split tags', async () => {
    const tagId = '00000000-0000-4000-8000-000000000070';
    mocks.tags = [{
      id: tagId,
      companyId: 'COMPANY_GENERIC',
      name: 'Generic tag',
      color: '#667788',
    }];
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Split' }));
    await user.click(screen.getAllByRole('button', { name: 'Generic tag' })[0]!);
    await user.click(screen.getAllByRole('button', { name: /Remove split line/ })[1]!);
    await user.click(screen.getByRole('button', { name: 'Save split' }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({
        lines: [expect.objectContaining({ tagIds: [tagId] })],
      }),
    );
  });

  it('stages delayed A and only the latest queued B snapshot', async () => {
    const first = deferred<StagedCategorization>();
    const second = deferred<StagedCategorization>();
    mocks.stage
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const user = userEvent.setup();
    await renderQueue(transaction({
      category: null,
      categoryQboId: null,
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
    }));

    await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
    await user.click(screen.getByRole('option', { name: /Generic expense/ }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
    await user.click(screen.getByRole('option', { name: /Alternate expense/ }));

    await act(async () => first.resolve({ ...STAGED, taxCalculation: 'NotApplicable' }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({
        expectedRevision: 5,
        lines: [expect.objectContaining({ categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE' })],
      }),
    );
    await act(async () => second.resolve({
      ...STAGED,
      revision: 6,
      taxCalculation: 'NotApplicable',
      lines: [{ ...STAGED.lines[0]!, categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE', taxCodeQboId: null }],
    }));
  });

  it('shows an inline staging error and retries the exact desired snapshot', async () => {
    mocks.stage
      .mockReset()
      .mockRejectedValueOnce(new ApiError(400, 'Could not calculate this tax.', 'INVALID_INPUT'))
      .mockResolvedValueOnce(STAGED);
    const user = userEvent.setup();
    await renderQueue();

    expect(await screen.findByText('Could not calculate this tax.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry calculation' }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      {
        expectedRevision: 4,
        taxCalculation: 'TaxInclusive',
        lines: [{
          grossCents: -1050,
          categoryQboId: 'EXPENSE_ACCOUNT',
          taxCodeQboId: 'TAX_CODE_STANDARD',
          tagIds: [],
        }],
        tagIds: [],
      },
    );
    expect(await screen.findByText('Subtotal −$10.00')).toBeInTheDocument();
  });

  it('reloads and rebases after a lost staging response', async () => {
    const first = deferred<StagedCategorization>();
    mocks.stage
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ...STAGED, revision: 8 });
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    mocks.list.mockResolvedValueOnce({
      transactions: [transaction({ revision: 7 })],
      nextCursor: null,
      pendingCount: 1,
    });

    await act(async () => first.reject(new TypeError('Stage response lost')));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith(
      'TRANSACTION_GENERIC',
      expect.objectContaining({ expectedRevision: 7 }),
    );
  });

  it.each(['posted', 'active', 'missing'] as const)('refreshes server truth after an immutable %s staging conflict', async (kind) => {
    const first = deferred<StagedCategorization>();
    mocks.stage.mockReset().mockImplementationOnce(() => first.promise);
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    const latest = transaction({ revision: 7, payee: 'Updated supplier', status: kind === 'posted' ? 'POSTED' : 'PENDING',
      activeCategorizationAttempt: kind === 'active' ? { requestId: '00000000-0000-4000-8000-000000000909', operation: 'recategorize', status: 'PREPARED' } : null });
    mocks.list.mockResolvedValueOnce({ transactions: kind === 'missing' ? [] : [latest], nextCursor: null, pendingCount: 0 });
    await act(async () => first.reject(new ApiError(409, 'The transaction changed.', 'STALE_REVISION')));
    await waitFor(() => expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument());
    if (kind === 'posted') expect(screen.getByText('Posted — verified ✓')).toBeInTheDocument();
    if (kind === 'active') expect(screen.getByRole('button', { name: 'Resume post' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^post$/i })).not.toBeInTheDocument();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it('requires review of concurrent server edits instead of overwriting them on rebase', async () => {
    const first = deferred<StagedCategorization>();
    mocks.stage.mockReset().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ ...STAGED, revision: 8 });
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 7, payee: 'Updated supplier', amount: -21,
      category: 'Alternate expense', categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE', tagIds: ['TAG_GENERIC'] })], nextCursor: null, pendingCount: 1 });
    await act(async () => first.reject(new ApiError(409, 'The transaction changed.', 'STALE_REVISION')));
    expect(await screen.findByText('Updated supplier')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category for Updated supplier' })).toHaveTextContent('Alternate expense');
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Calculate tax for Updated supplier' }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenLastCalledWith('TRANSACTION_GENERIC', expect.objectContaining({ expectedRevision: 7,
      tagIds: ['TAG_GENERIC'], lines: [expect.objectContaining({ categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE', grossCents: -2100 })] }));
  });

  it('restages after an immutable active conflict resumes with a retryable outcome', async () => {
    const first = deferred<StagedCategorization>();
    mocks.stage.mockReset().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ ...STAGED, revision: 8 });
    mocks.commit.mockResolvedValue(mutation({ requestId: '00000000-0000-4000-8000-000000000909', ok: false, status: 'PENDING', outcome: 'RETRYABLE' }));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 7,
      activeCategorizationAttempt: { requestId: '00000000-0000-4000-8000-000000000909', operation: 'recategorize', status: 'PREPARED' } })], nextCursor: null, pendingCount: 1 });
    await act(async () => first.reject(new ApiError(409, 'The transaction changed.', 'STALE_REVISION')));
    await user.click(await screen.findByRole('button', { name: 'Resume post' }));
    await user.click(await screen.findByRole('button', { name: 'Restage categorization' }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(await waitForPostEnabled()).toBeEnabled();
  });

  it('reloads a mutation-blocked stage once to expose the active attempt', async () => {
    const first = deferred<StagedCategorization>();
    mocks.stage.mockReset().mockImplementationOnce(() => first.promise);
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 7,
      activeCategorizationAttempt: { requestId: '00000000-0000-4000-8000-000000000909', operation: 'recategorize', status: 'PREPARED' } })], nextCursor: null, pendingCount: 1 });
    await act(async () => first.reject(new ApiError(409, 'Resume the prepared write.', 'MUTATION_BLOCKED')));
    expect(await screen.findByRole('button', { name: 'Resume post' })).toBeEnabled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry calculation' })).not.toBeInTheDocument();
  });

  it('calculates only the active row on load and lets another row request a preview', async () => {
    mocks.list.mockResolvedValue({ transactions: Array.from({ length: 30 }, (_, i) => transaction({ id: 'transaction-' + i, payee: 'Supplier ' + i })), nextCursor: null, pendingCount: 30 });
    mocks.stage.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<Queue />);
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    expect(mocks.stage.mock.calls[0]?.[0]).toBe('transaction-0');
    await user.click(screen.getByRole('button', { name: 'Calculate tax for Supplier 20' }));
    expect(mocks.stage).toHaveBeenCalledTimes(2);
    expect(mocks.stage.mock.calls[1]?.[0]).toBe('transaction-20');
  });

  it('enables Post only after the exact latest desired snapshot is ready', async () => {
    const first = deferred<StagedCategorization>();
    const second = deferred<StagedCategorization>();
    mocks.stage
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
    await act(async () => first.resolve(STAGED));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();

    await act(async () => second.resolve({
      ...STAGED,
      revision: 6,
      taxCalculation: 'TaxExcluded',
      totals: { subtotalCents: -1050, taxCents: -53, totalCents: -1103 },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^post$/i })).toBeEnabled());
  });

  it('automatically replaces staged totals when the draft changes', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await screen.findByText(/subtotal.*10\.00/i);

    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /^post$/i })).toBeEnabled());
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('queues an updated saved split while staging is in flight', async () => {
    await expectInFlightChangeRestages(async (user) => {
      await user.click(screen.getByRole('button', { name: 'Split' }));
      await user.type(screen.getByLabelText('Memo for split line 1'), 'Allocation');
      const removeButtons = screen.getAllByRole('button', { name: /Remove split line/ });
      await user.click(removeButtons[1]!);
      await user.click(screen.getByRole('button', { name: 'Save split' }));
    });
  });

  it('refetches and automatically rebases a stale rejected stage', async () => {
    const pending = deferred<StagedCategorization>();
    mocks.stage
      .mockReset()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ ...STAGED, revision: 8 });
    const user = userEvent.setup();
    await renderQueue();
    mocks.list.mockResolvedValueOnce({
      transactions: [transaction({ revision: 7 })],
      nextCursor: null,
      pendingCount: 1,
    });

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
    await act(async () => pending.reject(new ApiError(
      409,
      'The transaction changed. Reload before continuing.',
      'STALE_REVISION',
    )));

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 7 });
  });

  it('preserves failed-post recovery when restage is unavailable during calculation', async () => {
    const pendingStage = deferred<StagedCategorization>();
    mocks.stage
      .mockReset()
      .mockResolvedValueOnce(STAGED)
      .mockReturnValueOnce(pendingStage.promise);
    mocks.commit.mockResolvedValue(mutation({
      ok: false,
      status: 'PENDING',
      outcome: 'RETRYABLE',
    }));
    const user = userEvent.setup();
    await renderQueue();
    await user.click(await waitForPostEnabled());
    const recoveryCopy = await screen.findByText(/not posted.*restage to retry/i);

    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Restage categorization' }));

    expect(recoveryCopy).toBeInTheDocument();
    expect(mocks.stage).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.requestId).toHaveBeenCalledTimes(1);
  });

  it('preserves failed-post recovery when the stage coordinator is in error', async () => {
    mocks.stage
      .mockReset()
      .mockResolvedValueOnce(STAGED)
      .mockRejectedValueOnce(new ApiError(400, 'Cannot calculate tax.', 'INVALID_INPUT'));
    mocks.commit.mockResolvedValue(mutation({
      ok: false,
      status: 'PENDING',
      outcome: 'RETRYABLE',
    }));
    const user = userEvent.setup();
    await renderQueue();
    await user.click(await waitForPostEnabled());

    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Restage categorization' }));

    expect(screen.getByText(/not posted.*restage to retry/i)).toBeInTheDocument();
    expect(mocks.stage).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.requestId).toHaveBeenCalledTimes(1);
  });

});

it('refreshes Queue rows and its count after read-only status checks without staging or posting', async () => {
  mocks.role = 'admin';
  const user = userEvent.setup();
  await renderQueue();
  await waitForPostEnabled();
  const stagesBeforeRefresh = mocks.stage.mock.calls.length;
  mocks.list.mockResolvedValue({ transactions: [], nextCursor: null });
  await user.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await waitFor(() => expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument());
  expect(mocks.setPendingCount).toHaveBeenLastCalledWith(0);
  expect(mocks.stage).toHaveBeenCalledTimes(stagesBeforeRefresh);expect(mocks.commit).not.toHaveBeenCalled();expect(mocks.legacyPost).not.toHaveBeenCalled();
});
it('adopts fresh Queue rows at the same revision after a status refresh', async () => {
  mocks.role = 'admin';
  const user = userEvent.setup();
  await renderQueue();
  await waitForPostEnabled();
  mocks.list.mockResolvedValue({
    transactions: [transaction({ payee: 'Updated generic supplier', revision: 5 })],
    nextCursor: null,
  });

  await user.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));

  expect(await screen.findByText('Updated generic supplier')).toBeInTheDocument();
  expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument();
});

it('keeps a newer locally staged revision when an in-flight status reload returns older rows', async () => {
  mocks.role = 'admin';
  const pending = deferred<{ transactions: TransactionDto[]; nextCursor: null }>();
  const user = userEvent.setup();
  await renderQueue();
  await waitForPostEnabled();
  mocks.stage.mockResolvedValue({ ...STAGED, revision: 6, taxCalculation: 'TaxExcluded' });
  mocks.list.mockReturnValueOnce(pending.promise);
  await user.click(screen.getByRole('button', { name: 'Check QuickBooks status' }));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

  await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
  await screen.findByText(/subtotal.*10\.00/i);
  await act(async () => pending.resolve({
    transactions: [transaction({ payee: 'Older generic supplier', revision: 5 })],
    nextCursor: null,
  }));

  expect(screen.getByText('Generic supplier')).toBeInTheDocument();
  expect(screen.queryByText('Older generic supplier')).not.toBeInTheDocument();
  await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax inclusive');
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(3));
  expect(mocks.stage.mock.calls[2]?.[1]).toMatchObject({ expectedRevision: 6 });
});

it('does not offer the provider status refresh to viewers', async () => {
  mocks.role = 'viewer';
  await renderQueue();
  expect(screen.queryByRole('button', { name: 'Check QuickBooks status' })).not.toBeInTheDocument();
});

async function waitForPostEnabled() { const post = screen.getByRole("button", { name: /^post$/i }); await waitFor(() => expect(post).toBeEnabled()); return post; }

async function chooseControl(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: string,
) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const search = screen.queryByRole('textbox', { name: label });
  if (search) await user.type(search, optionName);
  await user.click(screen.getByRole('option', { name: optionName }));
}


async function expectInFlightChangeRestages(
  change: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
  restaged: StagedCategorization = STAGED,
) {
  const pending = deferred<StagedCategorization>();
  mocks.stage
    .mockReset()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(restaged);
  const user = userEvent.setup();
  await renderQueue();
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

  await change(user);

  expect(screen.getByText('Calculating tax…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
  await act(async () => pending.resolve(STAGED));

  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
  expect(mocks.stage.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 5 });
  expect(await screen.findByText(/subtotal/i)).toBeInTheDocument();
}


describe('durable Queue recovery outcomes', () => {
  it('shows terminal rejection and requires a changed draft before another post', async () => {
    mocks.commit.mockResolvedValue(mutation({ ok: false, status: 'PENDING', outcome: 'REJECTED', error: { code: 'QBO_WRITE_REJECTED', message: 'QuickBooks rejected this write.' } }));
    const user = userEvent.setup();
    await renderQueue();
    await waitFor(() => expect(screen.getByRole('button', { name: /^post$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    expect(await screen.findByText('Rejected by QuickBooks — change categorization')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^post$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry verification/i })).not.toBeInTheDocument();
    await chooseControl(user, 'Tax calculation for Generic supplier', 'Tax exclusive');
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /^post$/i })).toBeEnabled();
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it('shows rejected Undo without presenting it as verified or retryable', async () => {
    mocks.undoCategorization.mockResolvedValue(mutation({ ok: false, status: 'POSTED', outcome: 'REJECTED' }));
    const user = userEvent.setup();
    await renderQueue(transaction({ status: 'POSTED' }));
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    expect(await screen.findByText('Undo rejected by QuickBooks — categorization remains posted')).toBeInTheDocument();
    expect(screen.queryByText('Reverted ✓')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|reconcile/i })).not.toBeInTheDocument();
    expect(mocks.retryCategorization).not.toHaveBeenCalled();
  });

  it.each(['recategorize', 'restore'] as const)('retries retained RETRYABLE %s with a new confirmed request and no reconciliation', async (operation) => {
    const requestId = '00000000-0000-4000-8000-000000000701';
    const status = operation === 'restore' ? 'POSTED' : 'PENDING';
    mocks.reconcile.mockRejectedValue(new ApiError(409, 'Recorded retry requires a new request.', 'RECONCILE_NOT_ALLOWED'));
    mocks.stage.mockResolvedValue({ ...STAGED, revision: 9 });
    mocks.undoCategorization.mockResolvedValue(mutation({ status: 'PENDING' }));
    const user = userEvent.setup();
    await renderQueue(transaction({ status, activeCategorizationAttempt: { requestId, operation, status: 'RETRYABLE' } }));
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Check retry status' })).not.toBeInTheDocument();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.requestId).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.undoCategorization).not.toHaveBeenCalled();
    if (operation === 'recategorize') {
      await user.click(await screen.findByRole('button', { name: 'Restage categorization' }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^post$/i })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: /^post$/i }));
      expect(window.confirm).toHaveBeenCalled();
      await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith('TRANSACTION_GENERIC', 9, '00000000-0000-4000-8000-000000000101'));
    } else {
      mocks.list.mockResolvedValue({ transactions: [transaction({ revision: 8 })], nextCursor: null });
      await user.click(await screen.findByRole('button', { name: 'Retry undo' }));
      expect(window.confirm).toHaveBeenCalled();
      await waitFor(() => expect(mocks.undoCategorization).toHaveBeenCalledWith('TRANSACTION_GENERIC', '00000000-0000-4000-8000-000000000101'));
    }
    expect(mocks.retryCategorization).not.toHaveBeenCalled();
    expect(mocks.requestId).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('does not send a new Undo when retry confirmation is cancelled', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const requestId = '00000000-0000-4000-8000-000000000701';
    mocks.reconcile.mockResolvedValue(mutation({ requestId, ok: false, status: 'POSTED', outcome: 'RETRYABLE' }));
    const user = userEvent.setup();
    await renderQueue(transaction({ status: 'POSTED', activeCategorizationAttempt: { requestId, operation: 'restore', status: 'RETRYABLE' } }));
    await user.click(await screen.findByRole('button', { name: 'Retry undo' }));
    expect(mocks.undoCategorization).not.toHaveBeenCalled();
    expect(mocks.requestId).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it('reloads the authoritative pending revision after verified Undo before staging again', async () => {
    mocks.undoCategorization.mockResolvedValue(mutation({ status: 'PENDING' }));
    const user = userEvent.setup();
    await renderQueue(transaction({ status: 'POSTED' }));
    mocks.list.mockResolvedValue({ transactions: [transaction({ revision: 8 })], nextCursor: null });
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith('TRANSACTION_GENERIC', expect.objectContaining({ expectedRevision: 8 })));
    expect(mocks.toast).toHaveBeenCalledWith('Undo verified in QuickBooks. Transaction returned to Queue.');
    expect(screen.queryByText('Reverted ✓')).not.toBeInTheDocument();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('keeps verified Undo distinct from a failed Queue refresh and retries only the read', async () => {
    mocks.undoCategorization.mockResolvedValue(mutation({ status: 'PENDING' }));
    const user = userEvent.setup();
    await renderQueue(transaction({ status: 'POSTED' }));
    mocks.list.mockRejectedValueOnce(new Error('Unavailable'));
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    expect(await screen.findByText('Undo verified — refresh Queue before editing')).toBeInTheDocument();
    expect(mocks.stage).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue({ transactions: [transaction({ revision: 8 })], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Refresh Queue' }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith('TRANSACTION_GENERIC', expect.objectContaining({ expectedRevision: 8 })));
    expect(mocks.undoCategorization).toHaveBeenCalledTimes(1);
    expect(mocks.retryCategorization).not.toHaveBeenCalled();
  });
});


describe('Queue fresh write safety recovery', () => {
  it.each(['recategorize', 'restore'] as const)('loads a persisted PREPARED %s after a fresh safety outage', async operation => {
    const requestId = '00000000-0000-4000-8000-000000000101';
    const error = new ApiError(503, 'QuickBooks write safety is temporarily unavailable.', 'QBO_WRITE_SAFETY_UNAVAILABLE');
    const send = operation === 'restore' ? mocks.undoCategorization : mocks.commit;
    send.mockRejectedValue(error);
    const user = userEvent.setup();
    const status = operation === 'restore' ? 'POSTED' : 'PENDING';
    await renderQueue(transaction({ status }));
    if (operation === 'recategorize') await waitForPostEnabled();
    mocks.list.mockResolvedValue({ transactions: [transaction({ status, revision: 6, activeCategorizationAttempt: { requestId, operation, status: 'PREPARED' } })], nextCursor: null });
    await user.click(screen.getByRole('button', { name: operation === 'restore' ? /^undo$/i : /^post$/i }));
    expect(await screen.findByRole('button', { name: operation === 'restore' ? 'Resume undo' : 'Resume post' })).toBeEnabled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it.each(['QBO_TRANSACTION_LOCKED', 'QBO_PERIOD_CLOSED', 'SUPERSEDED'])('removes a transaction after fresh provider rejection %s', async code => {
    mocks.commit.mockRejectedValue(new ApiError(409, 'The transaction is no longer writable.', code));
    const user = userEvent.setup();
    await renderQueue();
    await user.click(await waitForPostEnabled());
    await waitFor(() => expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument());
    expect(mocks.setPendingCount).toHaveBeenLastCalledWith(0);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed write response from the company the user has left', async () => {
    const pending = deferred<CategorizationMutationResult>();
    mocks.commit.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const view = await renderQueue();
    await user.click(await waitForPostEnabled());
    mocks.activeCompanyId = 'COMPANY_OTHER';
    mocks.list.mockResolvedValue({ transactions: [transaction({ id: 'TRANSACTION_OTHER', companyId: 'COMPANY_OTHER', payee: 'Other company supplier', category: null, categoryQboId: null })], nextCursor: null });
    view.rerender(<Queue />);
    await screen.findByText('Other company supplier');
    await act(async () => pending.reject(new ApiError(409, 'Old company error', 'SUPERSEDED')));
    expect(mocks.toast).not.toHaveBeenCalledWith('Old company error');
    expect(screen.getByText('Other company supplier')).toBeInTheDocument();
  });
});


describe('Queue mutation guard parity', () => {
  it.each([false, true])('checks both transfer legs before sending (counterpart active: %s)', async active => {
    const user = userEvent.setup();
    await renderQueue([
      transaction({ category: null, categoryQboId: null, transferCandidateId: 'TRANSACTION_MATE', bankAccount: 'Bank A' }),
      deposit({ id: 'TRANSACTION_MATE', category: null, categoryQboId: null, bankAccount: 'Bank B', activeCategorizationAttempt: active ? { requestId: '00000000-0000-4000-8000-000000000701', operation: 'recategorize', status: 'PREPARED' } : null }),
    ]);
    await user.click(screen.getByRole('link', { name: 'record as transfer' }));
    if (active) expect(mocks.transfer).not.toHaveBeenCalled();
    else await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith('TRANSACTION_GENERIC', 'TRANSACTION_MATE'));
  });

  it('describes a dry run as unsent rather than a verified QuickBooks write', async () => {
    mocks.commit.mockResolvedValue(mutation({ status: 'DRY_RUN', outcome: 'DRY_RUN' }));
    const user = userEvent.setup();
    await renderQueue();
    await user.click(await waitForPostEnabled());
    expect(await screen.findByText('Dry run — nothing sent')).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith('Dry run — payload logged, nothing sent to QuickBooks.');
    expect(screen.queryByText(/posted.*verified/i)).not.toBeInTheDocument();
  });
});


it('does not automatically stage a viewer transaction', async () => {
  mocks.role = 'viewer';
  await renderQueue();
  await act(async () => { await Promise.resolve(); });
  expect(mocks.stage).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
});


describe('targeted Queue mutation hydration', () => {
  it('resets the affected coordinator from the authoritative revision and preserves another local draft', async () => {
    const user = userEvent.setup();
    mocks.stage.mockImplementation(async (id, body) => ({ ...STAGED, transactionId: id, revision: body.expectedRevision + 1 }));
    await renderQueue([transaction(), transaction({ id: 'OTHER', payee: 'Other supplier', category: 'Alternate expense', categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE' })]);
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText('Other supplier'));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    const pending = deferred<{ transactions: TransactionDto[]; nextCursor: null }>();
    mocks.list.mockReturnValueOnce(pending.promise);
    act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
    expect(await screen.findByText('Refreshing transaction…')).toBeInTheDocument();
    await act(async () => pending.resolve({ transactions: [transaction({ revision: 9, category: null, categoryQboId: null, taxCodeQboId: null, taxCalculation: null }), transaction({ id: 'OTHER', payee: 'Other supplier', category: 'Generic expense' })], nextCursor: null }));
    await user.click(screen.getByText('Generic supplier'));
    expect(mocks.stage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('combobox', { name: /Category for Other supplier/ })).toHaveTextContent('Alternate expense');
    await user.click(screen.getByRole('combobox', { name: /Category for Generic supplier/ }));
    await user.click(screen.getByRole('option', { name: /Generic expense/ }));
    await waitFor(() => expect(mocks.stage).toHaveBeenLastCalledWith('TRANSACTION_GENERIC', expect.objectContaining({ expectedRevision: 9 })));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('keeps the affected row blocked after a failed read and retries only that read', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await waitForPostEnabled();
    mocks.list.mockRejectedValueOnce(new Error('Unavailable'));
    act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
    expect(await screen.findByText('Transaction changed — refresh before editing')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Category for Generic supplier/ })).toBeDisabled();
    mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 8, category: null, categoryQboId: null })], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Refresh transaction' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Category for Generic supplier/ })).toBeEnabled());
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.undoCategorization).not.toHaveBeenCalled();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it('announces a valid durable result without refetching or clearing its own ready draft', async () => {
    const user = userEvent.setup(); await renderQueue(); await waitForPostEnabled();
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(mocks.notifyQboMutation).toHaveBeenCalledWith('COMPANY_GENERIC', ['TRANSACTION_GENERIC'], expect.any(Symbol)));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });
});


describe('legacy Queue mutation producers', () => {
  it.each(['QBO_TRANSACTION_LOCKED', 'QBO_PERIOD_CLOSED', 'SUPERSEDED'])('removes legacy rows rejected with %s', async code => {
    mocks.taxReadiness = null;
    mocks.legacyPost.mockRejectedValue(new ApiError(409, 'No longer writable.', code));
    const user = userEvent.setup(); await renderQueue(transaction({ taxCalculation: null, taxCodeQboId: null }));
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument());
    expect(mocks.notifyQboMutation).toHaveBeenCalledWith('COMPANY_GENERIC', ['TRANSACTION_GENERIC'], expect.any(Symbol));
  });
  it('reports a legacy dry run truthfully and emits without refetching', async () => {
    mocks.taxReadiness = null; mocks.legacyPost.mockResolvedValue(transaction({ status: 'DRY_RUN', taxCalculation: null }));
    const user = userEvent.setup(); await renderQueue(transaction({ taxCalculation: null, taxCodeQboId: null }));
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Dry run — payload logged, nothing sent to QuickBooks.'));
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
  it('does not apply a late legacy response or toast after a company switch', async () => {
    mocks.taxReadiness = null; const pending = deferred<TransactionDto>(); mocks.legacyPost.mockReturnValue(pending.promise);
    const user = userEvent.setup(); const view = await renderQueue(transaction({ taxCalculation: null, taxCodeQboId: null }));
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    mocks.activeCompanyId = 'OTHER_COMPANY'; mocks.list.mockResolvedValue({ transactions: [transaction({ companyId: 'OTHER_COMPANY', payee: 'New company supplier' })], nextCursor: null });
    view.rerender(<Queue />); await screen.findByText('New company supplier');
    await act(async () => pending.resolve(transaction({ status: 'DRY_RUN', payee: 'Old response' })));
    expect(screen.queryByText('Old response')).not.toBeInTheDocument(); expect(mocks.toast).not.toHaveBeenCalled();
  });
});


describe('targeted mutation response fencing', () => {
  it('ignores an older overlapping notification response and late reads after unmount', async () => {
    const view = await renderQueue(); await waitForPostEnabled();
    const first = deferred<{ transactions: TransactionDto[]; nextCursor: null }>();
    const second = deferred<{ transactions: TransactionDto[]; nextCursor: null }>();
    mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    act(() => { mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']); mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']); });
    await act(async () => second.resolve({ transactions: [transaction({ revision: 12, payee: 'Latest supplier', category: null, categoryQboId: null })], nextCursor: null }));
    await screen.findByText('Latest supplier');
    await act(async () => first.resolve({ transactions: [transaction({ revision: 8, payee: 'Old supplier' })], nextCursor: null }));
    expect(screen.queryByText('Old supplier')).not.toBeInTheDocument();
    const last = deferred<{ transactions: TransactionDto[]; nextCursor: null }>(); mocks.list.mockReturnValueOnce(last.promise);
    act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC'])); view.unmount();
    await act(async () => last.reject(new Error('Unavailable'))); expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.mutationListeners.size).toBe(0);
  });

  it('does not let a disposed coordinator reload overwrite externally refreshed state', async () => {
    const stage = deferred<StagedCategorization>(); mocks.stage.mockReturnValueOnce(stage.promise);
    await renderQueue(); await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
    const oldReload = deferred<{ transactions: TransactionDto[]; nextCursor: null }>(); mocks.list.mockReturnValueOnce(oldReload.promise);
    await act(async () => stage.reject(new ApiError(409, 'Changed', 'STALE_REVISION')));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 12, payee: 'Authoritative supplier', category: null, categoryQboId: null })], nextCursor: null });
    act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
    await screen.findByText('Authoritative supplier');
    await act(async () => oldReload.resolve({ transactions: [transaction({ revision: 7, payee: 'Stale conflict supplier', category: 'Alternate expense', categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE' })], nextCursor: null }));
    expect(screen.queryByText('Stale conflict supplier')).not.toBeInTheDocument();
    expect(screen.getByText('Authoritative supplier')).toBeInTheDocument(); expect(mocks.stage).toHaveBeenCalledTimes(1);
  });
});


it('excludes an externally refreshing selected row from bulk posting', async () => {
  mocks.taxReadiness = null; const user = userEvent.setup(); await renderQueue(transaction({ taxCalculation: null, taxCodeQboId: null }));
  await user.click(screen.getAllByRole('checkbox')[1]!);
  const pending = deferred<{ transactions: TransactionDto[]; nextCursor: null }>(); mocks.list.mockReturnValueOnce(pending.promise);
  act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
  expect(await screen.findByText('Refreshing transaction…')).toBeInTheDocument();
  const post = screen.queryByRole('button', { name: /post 1 transaction/i });
  if (post) await user.click(post);
  expect(mocks.bulkPost).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ transactions: [], nextCursor: null }));
});


it.each(['requestId', 'transactionId'] as const)('rejects a success payload with a mismatched %s without notifying or patching status', async field => {
  const user = userEvent.setup(); mocks.commit.mockResolvedValue(mutation({ [field]: 'different-result' }));
  await renderQueue(); await waitForPostEnabled(); await user.click(screen.getByRole('button', { name: /^post$/i }));
  expect(await screen.findByText('Write status unresolved — reload required')).toBeInTheDocument();
  expect(screen.queryByText('Posted — verified ✓')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^undo$/i })).not.toBeInTheDocument();
  expect(mocks.notifyQboMutation).not.toHaveBeenCalled();
});


it('adds an externally undone transaction that was absent from Queue while preserving visible drafts', async () => {
  await renderQueue(transaction({ id: 'OTHER', payee: 'Visible supplier', category: 'Alternate expense', categoryQboId: 'EXPENSE_ACCOUNT_ALTERNATE' }));
  mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 9, category: null, categoryQboId: null }), transaction({ id: 'OTHER', payee: 'Visible supplier', category: 'Generic expense' })], nextCursor: null });
  act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
  expect(await screen.findByText('Generic supplier')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Category for Visible supplier' })).toHaveTextContent('Alternate expense');
});


it('hides a closed-period row while retaining recent posted feedback', async () => {
  mocks.list.mockResolvedValue({ transactions: [transaction({ payee: 'Closed supplier', bankAccount: 'Closed account', providerActionability: { disposition: 'BLOCKED_PERIOD_CLOSED', checkedAt: null, revision: 4, qboSyncToken: '1', qboType: 'Purchase', qboId: 'PURCHASE_GENERIC', txnDate: '2026-07-28', bankAccountQboId: null, bookCloseDate: '2026-08-01', cleared: null, reconciled: null, unavailableCode: null, unavailableReason: null } }), transaction({ id: 'POSTED', payee: 'Posted supplier', status: 'POSTED' })], nextCursor: null });
  render(<Queue />); await screen.findByText('Posted supplier');
  expect(screen.queryByText('Closed supplier')).not.toBeInTheDocument();
  expect(mocks.setPendingCount).toHaveBeenLastCalledWith(0);
  expect(screen.getByText(/0 transactions.*0.00 waiting/)).toBeInTheDocument();
  const user = userEvent.setup(); await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
  expect(screen.queryByRole('option', { name: 'Closed account' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await user.type(screen.getByPlaceholderText(/Search anything/), 'Posted');
  expect(screen.getByText('Posted supplier')).toBeInTheDocument();
  expect(mocks.stage).not.toHaveBeenCalled();
});


it('keeps newer notification hydration when the older initial load finishes last', async () => {
  const initial = deferred<{ transactions: TransactionDto[]; nextCursor: null }>();
  mocks.list.mockReturnValueOnce(initial.promise); render(<Queue />);
  mocks.list.mockResolvedValueOnce({ transactions: [transaction({ revision: 9, payee: 'Freshly undone supplier', category: null, categoryQboId: null })], nextCursor: null });
  act(() => mocks.notifyQboMutation('COMPANY_GENERIC', ['TRANSACTION_GENERIC']));
  await screen.findByText('Freshly undone supplier');
  await act(async () => initial.resolve({ transactions: [transaction({ status: 'POSTED', payee: 'Old initial supplier' })], nextCursor: null }));
  expect(screen.queryByText('Old initial supplier')).not.toBeInTheDocument();
  expect(screen.getByText('Freshly undone supplier')).toBeInTheDocument();
  expect(mocks.stage).not.toHaveBeenCalled();
});

it('offers a read-only recovery when a legacy post response mismatches its transaction', async () => {
  mocks.taxReadiness = null; mocks.legacyPost.mockResolvedValue(transaction({ id: 'WRONG', status: 'POSTED' }));
  const user = userEvent.setup(); await renderQueue(transaction({ taxCalculation: null, taxCodeQboId: null }));
  await user.click(screen.getByRole('button', { name: /^post$/i }));
  expect(await screen.findByText('Transaction changed — refresh before editing')).toBeInTheDocument();
  mocks.list.mockResolvedValueOnce({ transactions: [], nextCursor: null });
  await user.click(screen.getByRole('button', { name: 'Refresh transaction' }));
  await waitFor(() => expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument());
  expect(mocks.legacyPost).toHaveBeenCalledTimes(1); expect(mocks.notifyQboMutation).not.toHaveBeenCalled();
});


describe('Queue tax layout', () => {
  it('keeps tax controls and server totals ordered and allows wrapping instead of clipping', async () => {
    const style = installGlobalStyles();
    document.body.classList.add('rr');
    try {
      await renderQueue();
      await waitForPostEnabled();

      const taxCode = screen.getByRole('combobox', { name: 'Purchase tax for Generic supplier' });
      const calculation = screen.getByRole('combobox', {
        name: 'Tax calculation for Generic supplier',
      });
      const subtotal = await screen.findByText('Subtotal −$10.00');
      const tax = screen.getByText('Tax −$0.50');
      const total = screen.getByText('Total −$10.50');
      const taxLine = taxCode.closest('.queue-tax-line');

      expect(taxLine).not.toBeNull();
      expect(taxLine).toContainElement(calculation);
      expect(taxLine).toContainElement(subtotal);
      expect(taxCode.compareDocumentPosition(calculation) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
      expect(calculation.compareDocumentPosition(subtotal) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
      expect(getComputedStyle(taxLine!).display).toBe('flex');
      expect(getComputedStyle(taxLine!).flexWrap).toBe('wrap');
      expect(getComputedStyle(taxLine!).maxWidth).toBe('100%');
      expect(getComputedStyle(taxLine!).overflowX).not.toBe('auto');
      expect([subtotal, tax, total].map((label) => getComputedStyle(label).whiteSpace))
        .toEqual(['nowrap', 'nowrap', 'nowrap']);
    } finally {
      document.body.classList.remove('rr');
      style.remove();
    }
  });

  it('stacks the tax line inside a narrow mobile card', async () => {
    mockMobileMedia();
    const style = installGlobalStyles();
    document.body.classList.add('rr');
    try {
      await renderQueue();

      const taxCode = screen.getByRole('combobox', { name: 'Purchase tax for Generic supplier' });
      const taxLine = taxCode.closest<HTMLElement>('.queue-tax-line');
      expect(taxLine).toHaveClass('queue-tax-line-mobile');
      expect(document.querySelector('.queue-mobile-actions > span')).toHaveStyle({ flex: '1 1 150px' });
      expect(getComputedStyle(taxLine!).display).toBe('grid');
      expect(getComputedStyle(taxLine!).whiteSpace).toBe('normal');
    } finally {
      document.body.classList.remove('rr');
      style.remove();
    }
  });

  it('keeps recovery actions on one row in a shrinkable desktop status cell', async () => {
    mocks.commit.mockResolvedValue(mutation({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message: 'The write may have succeeded.',
      },
    }));
    const style = installGlobalStyles();
    document.body.classList.add('rr');
    try {
      const user = userEvent.setup();
      await renderQueue();
      await waitForPostEnabled();
      await user.click(screen.getByRole('button', { name: /^post$/i }));

      const recoveryCopy = await screen.findByText(/verify in quickbooks/i);
      const statusCell = recoveryCopy.closest<HTMLElement>('.queue-status-cell');
      const recoveryActions = screen.getByRole('button', { name: /^reconcile$/i })
        .closest<HTMLElement>('.queue-recovery-actions');

      expect(statusCell).not.toBeNull();
      expect(recoveryActions).not.toBeNull();
      expect(statusCell).toContainElement(recoveryActions);
      expect(getComputedStyle(statusCell!).minWidth).toBe('0px');
      expect(getComputedStyle(statusCell!).overflowWrap).toBe('anywhere');
      expect(getComputedStyle(recoveryActions!).flexWrap).toBe('nowrap');
    } finally {
      document.body.classList.remove('rr');
      style.remove();
    }
  });

  it('lets the mobile recovery cell take a bounded wrapping row', async () => {
    mockMobileMedia();
    mocks.commit.mockResolvedValue(mutation({ ok: false, status: 'ERROR', outcome: 'UNCERTAIN' }));
    const user = userEvent.setup();
    await renderQueue();
    await waitForPostEnabled();
      await user.click(screen.getByRole('button', { name: /^post$/i }));

    const statusCell = (await screen.findByText(/verify in quickbooks/i))
      .closest<HTMLElement>('.queue-status-cell');
    expect(statusCell?.parentElement).toHaveClass('queue-mobile-actions');
    expect(statusCell).toHaveStyle({ flex: '1 1 240px', maxWidth: '100%' });
  });

});

function mockMobileMedia() {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
}
  it('keeps apply-once distinct and prepares recurring intent only after the explicit action', async () => {
    const currentCase = {
      id: 'case-current', companyId: 'COMPANY_GENERIC', transactionId: 'TRANSACTION_GENERIC',
      vendorIdentityId: null, qboMutationAttemptId: 'attempt-current',
      action: { categoryQboId: 'EXPENSE_ACCOUNT', taxCalculation: 'TaxInclusive', taxCodeQboId: 'TAX_CODE_STANDARD', tagIds: [] },
      actionFingerprint: 'fingerprint', originIntent: 'apply_once', rationale: 'Verified receipt.',
      requiredEvidence: [], examples: [], counterexamples: [], citations: [],
      reviewer: { userId: 'user-1', configVersion: 'v1', decision: 'approved' },
      jurisdiction: 'CA-BC', currency: 'CAD',
      context: { transactionDirection: 'out', qboType: 'Purchase', sourceAccountName: 'Generic bank', businessPurpose: null },
      provenance: { source: 'qbo_verified', sourceId: 'attempt-current', actorId: 'user-1', recordedAt: '2026-08-30T00:00:00.000Z' },
      verifiedAt: '2026-08-30T00:00:00.000Z', invalidatedAt: null, invalidationReason: null,
    };
    mocks.currentCase.mockResolvedValue(currentCase);
    mocks.prepareFromCase.mockResolvedValue({
      ok: true, operationId: 'operation-1', companyId: 'COMPANY_GENERIC', mutation: 'create',
      originIntent: 'make_recurring', status: 'PREPARED', ruleId: 'rule-1', revision: null,
      rule: null, candidate: null, error: null,
      preview: {
        operationId: 'operation-1', companyId: 'COMPANY_GENERIC', ruleId: 'rule-1', candidateId: null,
        mutation: 'create', originIntent: 'make_recurring', currentRevision: 0, proposedRevision: 1,
        condition: { matchField: 'payee', matchText: 'Generic supplier' },
        action: currentCase.action, categoryName: 'Generic expense', taxCodeName: 'Standard purchase tax',
        direction: 'Purchase', autoPost: false, affectedPendingCount: 2, affectedProcessedCount: 1,
        sampleTransactions: [], conflicts: [], warnings: [],
        expiresAt: '2026-08-31T01:00:00.000Z', preparationDigest: 'digest',
      },
    });
    let resolveCommit!: (value: RuleMutationResult) => void;
    mocks.commitRuleOperation.mockReturnValue(new Promise<RuleMutationResult>((resolve) => { resolveCommit = resolve; }));
    const committed = {
      ok: true, operationId: 'operation-1', companyId: 'COMPANY_GENERIC', mutation: 'create',
      originIntent: 'make_recurring', status: 'COMMITTED', ruleId: 'rule-1', revision: 1,
      rule: null, candidate: null, preview: null, error: null,
    } as const;
    const user = userEvent.setup();
    await renderQueue();

    await user.click(await waitForPostEnabled());

    expect(await screen.findByRole('button', { name: 'Apply once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make recurring suggestion' })).toBeInTheDocument();
    expect(mocks.prepareFromCase).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Make recurring suggestion' }));
    await waitFor(() => expect(mocks.prepareFromCase).toHaveBeenCalledWith(
      'COMPANY_GENERIC',
      'case-current',
      {
        matchText: 'Generic supplier',
        idempotencyKey: '00000000-0000-4000-8000-000000000202',
      },
    ));
    expect(await screen.findByText(/auto-post remains off/i)).toBeInTheDocument();
    expect(screen.getByText(/2 pending.*1 processed/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm recurring suggestion' }));
    await waitFor(() => expect(mocks.commitRuleOperation).toHaveBeenCalledWith(
      'COMPANY_GENERIC',
      'operation-1',
      '00000000-0000-4000-8000-000000000202',
    ));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('confirm-dialog-backdrop'));
    expect(screen.getByRole('dialog', { name: 'Make recurring suggestion?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make recurring suggestion' })).not.toBeInTheDocument();

    await act(async () => resolveCommit(committed));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

it.each([
  { ok: false, status: 'POSTED' as const, outcome: 'VERIFIED' as const },
  { status: 'DRY_RUN' as const, outcome: 'DRY_RUN' as const },
  { ok: false, status: 'ERROR' as const, outcome: 'UNCERTAIN' as const },
  { ok: false, status: 'PENDING' as const, outcome: 'RETRYABLE' as const },
  { ok: false, status: 'PENDING' as const, outcome: 'REJECTED' as const },
])('does not offer recurring intent without durable verified success: %j', async result => {
  mocks.commit.mockResolvedValue(mutation(result));
  await renderQueue();
  await userEvent.click(await waitForPostEnabled());
  await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
  expect(mocks.currentCase).not.toHaveBeenCalled();
  expect(mocks.prepareFromCase).not.toHaveBeenCalled();
});
