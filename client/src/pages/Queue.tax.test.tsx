import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CategorizationMutationResult,
  StagedCategorization,
  TaxReadinessDto,
  TransactionDto,
} from '@recat/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
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
  sync: vi.fn(),
  rulesCreate: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  setPendingCount: vi.fn(),
  refreshCompanies: vi.fn(),
  requestId: vi.fn(),
  activeCompanyId: 'COMPANY_GENERIC',
  taxReadiness: null as TaxReadinessDto | null,
  tags: [] as Array<{ id: string; companyId: string; name: string; color: string }>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: {
      id: mocks.activeCompanyId,
      nickname: 'Generic company',
      holdingAccountIds: [],
      lastSyncedAt: null,
    },
    activeCompanyId: mocks.activeCompanyId,
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
    rules: { create: mocks.rulesCreate },
    transactions: {
      list: mocks.list,
      categorize: mocks.categorize,
      stageCategorization: mocks.stage,
      commitCategorization: mocks.commit,
      reconcileCategorization: mocks.reconcile,
      retryCategorization: mocks.retryCategorization,
      undoCategorization: mocks.undoCategorization,
      post: mocks.legacyPost,
      undo: mocks.legacyUndo,
      retry: mocks.retry,
      transfer: vi.fn(),
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

async function expectInFlightChangeInvalidates(
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
  await user.click(screen.getByRole('button', { name: /preview tax/i }));

  await change(user);

  expect(screen.getByRole('button', { name: /calculating/i })).toBeDisabled();
  await act(async () => pending.resolve(STAGED));
  expect(screen.queryByText(/subtotal.*10\.00/i)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /preview tax/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /preview tax/i }));
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
  expect(mocks.stage.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 5 });
  expect(await screen.findByText(/subtotal/i)).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReset();
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
  mocks.taxReadiness = READY;
  mocks.activeCompanyId = 'COMPANY_GENERIC';
  mocks.tags = [];
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

    await user.click(screen.getByRole('button', {
      name: 'Expenses · Generic expense',
    }));

    expect(screen.queryByRole('button', {
      name: /Uncategorised Expense/,
    })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: /Alternate expense/,
    })).toBeInTheDocument();

    // A user's own account that merely mentions the term is not QuickBooks'
    // holding account, and hiding it would remove a destination they created
    // on purpose with nothing to explain where it went.
    expect(screen.getByRole('button', {
      name: /Old Uncategorized Costs/,
    })).toBeInTheDocument();
  });

  it.each([-1, 1])('stages proven source gross with direction %s instead of mirrored net', async (sign) => {
    const user = userEvent.setup();
    await renderQueue(transaction({ amount: sign * 100, sourceGrossCents: sign * 11200 }));
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
      'TRANSACTION_GENERIC', expect.objectContaining({
        lines: [expect.objectContaining({ grossCents: sign * 11200 })],
      }),
    ));
  });

  it('stages exact cents at the current revision, previews server totals, and commits that revision', async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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

    await user.click(screen.getByRole('button', { name: /preview tax/i }));

    expect(await screen.findByText('Subtotal +$10.00')).toBeInTheDocument();
    expect(screen.getByText('Tax +$0.50')).toBeInTheDocument();
    expect(screen.getByText('Total +$10.50')).toBeInTheDocument();
  });

  it('confirms the staged QuickBooks totals before allocating a commit UUID', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    await renderQueue();
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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

  it('invalidates a staged preview when the draft changes and requires restaging', async () => {
    const user = userEvent.setup();
    await renderQueue();
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
    await screen.findByText(/subtotal.*10\.00/i);

    await user.selectOptions(
      screen.getByLabelText('Tax calculation for Generic supplier'),
      'TaxExcluded',
    );

    expect(screen.queryByText(/subtotal.*10\.00/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^post$/i })).toBeDisabled();
    expect(mocks.commit).not.toHaveBeenCalled();
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

    await user.click(screen.getByRole('button', { name: /preview tax/i }));
    await user.selectOptions(
      screen.getByLabelText('Tax calculation for Generic supplier'),
      'TaxExcluded',
    );
    expect(screen.getByRole('button', { name: /calculating/i })).toBeDisabled();
    await act(async () => first.resolve(STAGED));

    expect(screen.queryByText(/subtotal.*10\.00/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview tax/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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
    await expectInFlightChangeInvalidates(async (user) => {
      await user.click(screen.getByRole('button', { name: 'Expenses · Generic expense' }));
      await user.click(screen.getByRole('button', { name: /Alternate expense/ }));
    });
  });

  it('invalidates an in-flight preview when a row tag changes', async () => {
    mocks.tags = [{
      id: '00000000-0000-4000-8000-000000000070',
      companyId: 'COMPANY_GENERIC',
      name: 'Generic tag',
      color: '#667788',
    }];
    await expectInFlightChangeInvalidates(async (user) => {
      await user.click(screen.getByRole('button', { name: '+ tag' }));
      await user.click(screen.getByRole('button', { name: 'Generic tag' }));
    });
  });

  it('invalidates an in-flight preview when the tax code changes', async () => {
    await expectInFlightChangeInvalidates(async (user) => {
      await user.selectOptions(
        screen.getByLabelText('Purchase tax for Generic supplier'),
        '',
      );
    });
  });

  it('invalidates an in-flight preview when the split draft is saved', async () => {
    await expectInFlightChangeInvalidates(async (user) => {
      await user.click(screen.getByRole('button', { name: 'Split' }));
      const removeButtons = screen.getAllByRole('button', { name: '×' });
      await user.click(removeButtons[1]!);
      await user.click(screen.getByRole('button', { name: 'Save split' }));
    });
  });

  it('refetches a stale rejected stage before allowing another preview', async () => {
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

    await user.click(screen.getByRole('button', { name: /preview tax/i }));
    await user.selectOptions(
      screen.getByLabelText('Tax calculation for Generic supplier'),
      'TaxExcluded',
    );
    await act(async () => pending.reject(new ApiError(
      409,
      'The transaction changed. Reload before continuing.',
      'STALE_REVISION',
    )));

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole('button', { name: /preview tax/i }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
    expect(mocks.stage.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 7 });
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
      ).toHaveValue(expectedCalculation);
      await user.click(screen.getByRole('button', { name: /preview tax/i }));

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
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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

      expect(screen.getByRole('button', {
        name: 'Expenses · Generic expense',
      })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '+ tag' })).toBeDisabled();
      expect(screen.getByLabelText('Purchase tax for Generic supplier')).toBeDisabled();
      expect(screen.getByLabelText('Tax calculation for Generic supplier')).toBeDisabled();
      expect(screen.getByRole('button', { name: /preview tax/i })).toBeDisabled();
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
        expect(await screen.findByText(/posted.*verified/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^undo$/i })).toBeEnabled();
        expect(screen.queryByRole('button', { name: /^reconcile$/i })).not.toBeInTheDocument();
      } else {
        expect(await screen.findByText(/not posted.*restage to retry/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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
    await user.click(screen.getByRole('button', { name: /preview tax/i }));
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

  it('uses categorization undo for a reloaded posted Deposit when sales readiness is unavailable', async () => {
    mocks.taxReadiness = { ...READY, salesStatus: 'needs_setup', salesReason: 'Sales tax needs setup.', salesTaxCodes: [] };
    const user = userEvent.setup();
    await renderQueue(deposit({ status: 'POSTED', postedAt: '2026-07-28T00:00:00.000Z' }));

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

      expect(screen.getByRole('button', { name: /preview tax/i })).toBeDisabled();
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

      expect(screen.getByRole('button', { name: /preview tax/i })).toBeDisabled();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );
});
