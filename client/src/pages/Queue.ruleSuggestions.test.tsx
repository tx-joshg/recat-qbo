import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RuleSuggestionDto,
  StagedCategorization,
  TaxReadinessDto,
  TransactionDto,
} from '@recat/shared';

const TAG_ID = '00000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
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
  transfer: vi.fn(),
  bulkPost: vi.fn(),
  sync: vi.fn(),
  currentCase: vi.fn(),
  prepareFromCase: vi.fn(),
  commitRuleOperation: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  taxReadiness: null as TaxReadinessDto | null,
  mutationListener: null as null | ((event: { companyId: string; transactionIds: string[] }) => void),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

const readiness: TaxReadinessDto = {
  status: 'ready',
  reason: null,
  usingSalesTax: true,
  refreshedAt: '2026-09-01T00:00:00.000Z',
  taxCodes: [{
    qboId: 'PURCHASE_TAX',
    name: 'GST',
    active: true,
    taxable: true,
    combinedPurchaseRate: 5,
    combinedSalesRate: null,
  }],
  salesStatus: 'ready',
  salesReason: null,
  salesTaxCodes: [],
};

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: {
      id: 'COMPANY_GENERIC', nickname: 'Generic company', holdingAccountIds: [], lastSyncedAt: null,
    },
    activeCompanyId: 'COMPANY_GENERIC',
    role: 'admin',
    accounts: [{
      id: 'ACCOUNT_MEALS', qboId: 'EXPENSE_ACCOUNT', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses', active: true,
    }],
    tags: [{ id: TAG_ID, companyId: 'COMPANY_GENERIC', name: 'Office', color: '#fff' }],
    setPendingCount: vi.fn(),
    refreshCompanies: vi.fn().mockResolvedValue(undefined),
    dryRun: false,
    tagsRequired: false,
    taxReadiness: mocks.taxReadiness,
    toast: mocks.toast,
    notifyQboMutation: vi.fn(),
    subscribeQboMutations: (listener: typeof mocks.mutationListener) => { mocks.mutationListener = listener; return () => { mocks.mutationListener = null; }; },
  }),
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message);
    }
  }
  return {
    ApiError,
    createCategorizationRequestId: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    companies: { sync: mocks.sync },
    classificationMemory: {
      currentCase: mocks.currentCase,
    },
    ruleOperations: {
      prepareFromCase: mocks.prepareFromCase,
      commit: mocks.commitRuleOperation,
    },
    reports: { bankAccounts: mocks.bankAccounts },
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
      transfer: mocks.transfer,
      bulkPost: mocks.bulkPost,
    },
  };
});

import Queue from './Queue';
import { ApiError } from '../lib/api';

const ruleSuggestion: RuleSuggestionDto = {
  source: 'rule',
  version: 2,
  ruleId: '00000000-0000-4000-8000-000000000010',
  ruleRevision: 7,
  action: {
    version: 2,
    direction: 'Purchase',
    category: 'Meals',
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCalculation: 'TaxExcluded',
    taxCodeQboId: 'PURCHASE_TAX',
    tagIds: [TAG_ID],
  },
  autoPost: false,
};

function transaction(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'TRANSACTION_GENERIC', companyId: 'COMPANY_GENERIC', qboId: 'PURCHASE_GENERIC',
    qboType: 'Purchase', date: '2026-09-01T00:00:00.000Z', payee: 'Coffee House', memo: null,
    amount: -10.5, bankAccount: 'Generic bank', status: 'PENDING', revision: 4,
    category: null, categoryQboId: null, taxCalculation: null, taxCode: null,
    taxCodeQboId: null, splits: null, tagIds: [], suggestion: ruleSuggestion,
    error: null, postedAt: null, postedBy: null, activeCategorizationAttempt: null,
    providerActionability: { disposition: 'WRITABLE' },
    ...overrides,
  } as TransactionDto;
}

const staged: StagedCategorization = {
  transactionId: 'TRANSACTION_GENERIC', revision: 5, taxCalculation: 'TaxExcluded',
  totals: { subtotalCents: -1_000, taxCents: -50, totalCents: -1_050 },
  lines: [{
    idx: 0, subtotalCents: -1_000, taxCents: -50, totalCents: -1_050,
    categoryQboId: 'EXPENSE_ACCOUNT', taxCodeQboId: 'PURCHASE_TAX', memo: null,
    tagIds: [TAG_ID],
  }],
  tagIds: [TAG_ID],
};

async function renderQueue(row = transaction()) {
  mocks.list.mockResolvedValue({ transactions: [row], nextCursor: null, pendingCount: 1 });
  render(<Queue />);
  await screen.findByText('Coffee House');
}

async function selectSuggestion() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Category for Coffee House' }));
  await user.click(screen.getByRole('option', { name: /Expenses.*Meals/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taxReadiness = readiness;
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  mocks.bankAccounts.mockResolvedValue(['Generic bank']);
  mocks.currentCase.mockResolvedValue(null);
  mocks.stage.mockResolvedValue(staged);
});

describe('Queue rule suggestions', () => {
  it('applies one complete revision through serialized categorization staging', async () => {
    await renderQueue();
    await selectSuggestion();

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith('TRANSACTION_GENERIC', {
      expectedRevision: 4,
      ruleSuggestion,
    }));
    expect(mocks.categorize).not.toHaveBeenCalled();
    expect(await screen.findByText('Office')).toBeInTheDocument();
  });

  it('refetches a stale rule application and never falls back to legacy categorize', async () => {
    mocks.stage.mockRejectedValueOnce(
      new ApiError(409, 'This rule suggestion changed. Reload before continuing.', 'STALE_RULE_SUGGESTION'),
    );
    mocks.list
      .mockResolvedValueOnce({ transactions: [transaction()], nextCursor: null, pendingCount: 1 })
      .mockResolvedValue({
        transactions: [transaction({ suggestion: null })], nextCursor: null, pendingCount: 1,
      });
    render(<Queue />);
    await screen.findByText('Coffee House');
    await selectSuggestion();

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect(mocks.categorize).not.toHaveBeenCalled();
  });

  it('still stages an exact no-tax rule when company tax readiness is unavailable', async () => {
    mocks.taxReadiness = {
      ...readiness,
      status: 'needs_setup',
      reason: 'Tax metadata is unavailable.',
      usingSalesTax: null,
      taxCodes: [],
    };
    const noTaxSuggestion: RuleSuggestionDto = {
      ...ruleSuggestion,
      action: {
        ...ruleSuggestion.action,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
      },
    };

    await renderQueue(transaction({ suggestion: noTaxSuggestion }));
    await selectSuggestion();

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith('TRANSACTION_GENERIC', {
      expectedRevision: 4,
      ruleSuggestion: noTaxSuggestion,
    }));
    expect(mocks.categorize).not.toHaveBeenCalled();
  });

  it('does not replay a rejected proof when reload returns the same rule identity', async () => {
    mocks.stage.mockRejectedValueOnce(
      new ApiError(409, 'This rule suggestion changed. Reload before continuing.', 'STALE_RULE_SUGGESTION'),
    );
    await renderQueue();
    await selectSuggestion();

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect(mocks.categorize).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();

    await selectSuggestion();
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
  });
});


it('clears the canonical proof after an authoritative external transaction refresh', async () => {
  await renderQueue(); await selectSuggestion();
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));
  mocks.list.mockResolvedValue({ transactions: [transaction({ revision: 9, category: 'Meals', categoryQboId: 'EXPENSE_ACCOUNT', taxCalculation: 'TaxExcluded', taxCodeQboId: 'PURCHASE_TAX', tagIds: [TAG_ID], suggestion: null })], pendingCount: 1, nextCursor: null });
  await act(async () => mocks.mutationListener?.({ companyId: 'COMPANY_GENERIC', transactionIds: ['TRANSACTION_GENERIC'] }));
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(2));
  expect(mocks.stage.mock.calls[1]![1]).toMatchObject({ expectedRevision: 9, taxCalculation: 'TaxExcluded', lines: [{ categoryQboId: 'EXPENSE_ACCOUNT' }] });
  expect(mocks.stage.mock.calls[1]![1]).not.toHaveProperty('ruleSuggestion');
});

vi.mock('../components/ClassificationMemoryPanel', () => ({ default: () => null }));
