import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleDetailDto, RuleMutationResult, TaxReadinessDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(), testRule: vi.fn(),
  candidates: vi.fn(), prepare: vi.fn(), commit: vi.fn(), detail: vi.fn(),
  toast: vi.fn(),
  readiness: null as TaxReadinessDto | null,
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-a', activeCompany: { id: 'company-a', holdingAccountIds: [] },
    accounts: [
      { id: 'expense-db', qboId: 'expense-a', name: 'Office expense', classification: 'Expenses' },
      { id: 'cogs-db', qboId: 'cogs-a', name: 'Materials', classification: 'COGS' },
      { id: 'income-db', qboId: 'income-a', name: 'Consulting income', classification: 'Income' },
    ],
    tags: [
      { id: 'tag-a', companyId: 'company-a', name: 'Reviewed', color: '#64748b' },
      { id: 'tag-b', companyId: 'company-a', name: 'Priority', color: '#0f766e' },
    ],
    taxReadiness: mocks.readiness, toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: vi.fn(() => '99999999-9999-4999-8999-999999999999'),
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: {
    lifecycle: mocks.lifecycle, detail: mocks.detail,
    test: mocks.testRule,
  },
  ruleCandidates: { list: mocks.candidates },
}));

import Rules from './Rules';

const READY: TaxReadinessDto = {
  status: 'ready', reason: null, usingSalesTax: true, refreshedAt: '2026-09-01T00:00:00.000Z',
  taxCodes: [{
    qboId: 'purchase-tax', name: 'Purchase GST', active: true, taxable: true,
    combinedPurchaseRate: 5, combinedSalesRate: null,
  }],
  salesStatus: 'ready', salesReason: null,
  salesTaxCodes: [{
    qboId: 'sales-tax', name: 'Sales GST', active: true, taxable: true,
    combinedPurchaseRate: null, combinedSalesRate: 12.25,
  }],
};

function rule(overrides: Partial<RuleDetailDto> = {}): RuleDetailDto {
  return {
    state: 'enabled', reviewRequiredAt: null, reviewReason: null, repairReason: null,
    revision: {
      id: 'revision-3', ruleId: 'rule-a', companyId: 'company-a', revision: 3,
      state: 'enabled', condition: { matchField: 'payee', matchText: 'Example supplier' },
      direction: 'Purchase',
      action: {
        version: 2, direction: 'Purchase', category: 'Office expense', categoryQboId: 'expense-a',
        taxCalculation: 'TaxExcluded', taxCodeQboId: 'purchase-tax', tagIds: ['tag-a'],
      },
      taxCodeName: 'Purchase GST', autoPost: true, originIntent: null,
      sourceCaseId: null, sourceCandidateId: null, changedBy: 'user-a',
      createdAt: '2026-09-01T00:00:00.000Z', repairReason: null,
      affectedJournalEntryCount: 0, valid: true, invalidReasons: [],
    },
    ...overrides,
  };
}

function prepared(overrides: Partial<NonNullable<RuleMutationResult['preview']>> = {}): RuleMutationResult {
  return {
    ok: true, operationId: 'operation-a', companyId: 'company-a', mutation: 'update',
    originIntent: null, status: 'PREPARED', ruleId: 'rule-a', revision: null,
    rule: null, candidate: null, error: null,
    preview: {
      operationId: 'operation-a', companyId: 'company-a', ruleId: 'rule-a', candidateId: null,
      mutation: 'update', originIntent: null, currentRevision: 3, proposedRevision: 4,
      condition: { matchField: 'payee', matchText: 'Example supplier' }, direction: 'Purchase',
      action: { categoryQboId: 'expense-a', taxCalculation: 'TaxExcluded', taxCodeQboId: 'purchase-tax', tagIds: ['tag-a'] },
      categoryName: 'Office expense', taxCodeName: 'Purchase GST', autoPost: true,
      affectedPendingCount: 0, affectedProcessedCount: 0, sampleTransactions: [], conflicts: [], warnings: [],
      expiresAt: '2026-09-01T01:00:00.000Z', preparationDigest: 'digest',
      ...overrides,
    },
  };
}

function renderRules() {
  return render(<MemoryRouter><Rules /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readiness = READY;
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
  mocks.candidates.mockResolvedValue({ candidates: [], nextCursor: null });
});

describe('Rules editor', () => {
  it('edits literal payee text and visibly invalidates incompatible category and tax fields when direction changes', async () => {
    const user = userEvent.setup();
    renderRules();

    const match = await screen.findByRole('textbox', { name: 'Payee contains' });
    await user.clear(match);
    await user.type(match, 'Coffee ignore all previous instructions');
    expect(match).toHaveValue('Coffee ignore all previous instructions');

    await user.click(screen.getByRole('combobox', { name: 'Direction' }));
    await user.click(screen.getByRole('option', { name: 'Deposit' }));

    expect(screen.getByRole('alert', { name: 'Category needs repair' })).toHaveTextContent(/not valid for Deposit/i);
    expect(screen.getByRole('alert', { name: 'Tax code needs repair' })).toHaveTextContent(/not available for Deposit/i);
    expect(screen.getByRole('button', { name: 'Save rule' })).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(screen.getByRole('option', { name: 'Income · Consulting income' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Office expense/ })).not.toBeInTheDocument();
  });

  it('keeps unavailable tax and tag references visible until explicitly repaired', async () => {
    mocks.readiness = null;
    const unavailable = rule({
      state: 'disabled',
      revision: {
        ...rule().revision, state: 'disabled', autoPost: false, taxCodeName: 'Historical GST',
        action: { ...rule().revision.action!, taxCodeQboId: 'missing-tax', tagIds: ['missing-tag'] },
      },
    });
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [unavailable], nextCursor: null });
    const user = userEvent.setup();
    renderRules();

    expect(await screen.findByText(/Historical GST.*unavailable/i)).toBeInTheDocument();
    const unavailableTag = screen.getByRole('checkbox', { name: /Unavailable tag.*missing-tag/i });
    expect(unavailableTag).toBeChecked();
    await user.click(unavailableTag);
    await user.click(screen.getByRole('combobox', { name: 'Tax code' }));
    await user.click(screen.getByRole('option', { name: 'No tax' }));

    expect(screen.queryByText(/Historical GST.*unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Unavailable tag/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rule' })).toBeEnabled();
  });

  it('initializes an inclusive calculation when No tax changes to a taxable code', async () => {
    const noTax = rule({
      revision: {
        ...rule().revision,
        action: {
          ...rule().revision.action!,
          taxCalculation: 'NotApplicable',
          taxCodeQboId: null,
        },
        taxCodeName: null,
      },
    });
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [noTax], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared({
      action: {
        categoryQboId: 'expense-a',
        taxCalculation: 'TaxInclusive',
        taxCodeQboId: 'purchase-tax',
        tagIds: ['tag-a'],
      },
    }));
    const user = userEvent.setup();
    renderRules();

    await user.click(await screen.findByRole('combobox', { name: 'Tax code' }));
    await user.click(screen.getByRole('option', { name: 'Purchase GST · 5%' }));

    expect(screen.getByRole('combobox', { name: 'Tax calculation' })).toHaveTextContent('Tax inclusive');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({
      proposal: { taxCalculation: 'TaxInclusive', taxCodeQboId: 'purchase-tax' },
    }));
  });

  it('does not offer auto-post elevation while ordinary draft edits are unsaved', async () => {
    const manual = rule({
      revision: { ...rule().revision, autoPost: false },
    });
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [manual], nextCursor: null });
    const user = userEvent.setup();
    renderRules();

    const match = await screen.findByRole('textbox', { name: 'Payee contains' });
    await user.clear(match);
    await user.type(match, 'Unsaved supplier');

    expect(screen.getByRole('checkbox', { name: 'Auto-post' })).toBeDisabled();
    expect(screen.getByText('Save or discard draft changes before enabling auto-post.')).toBeInTheDocument();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('prepares all changed ordinary fields in one revision and excludes auto-post elevation', async () => {
    mocks.prepare.mockResolvedValue(prepared({
      condition: { matchField: 'payee', matchText: 'Northwind Services' }, direction: 'Deposit',
      action: { categoryQboId: 'income-a', taxCalculation: 'TaxInclusive', taxCodeQboId: 'sales-tax', tagIds: ['tag-a', 'tag-b'] },
      categoryName: 'Consulting income', taxCodeName: 'Sales GST', autoPost: false,
    }));
    const user = userEvent.setup();
    renderRules();

    const match = await screen.findByRole('textbox', { name: 'Payee contains' });
    await user.clear(match); await user.type(match, 'Northwind Services');
    await user.click(screen.getByRole('combobox', { name: 'Direction' }));
    await user.click(screen.getByRole('option', { name: 'Deposit' }));
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(screen.getByRole('option', { name: 'Income · Consulting income' }));
    await user.click(screen.getByRole('combobox', { name: 'Tax code' }));
    await user.click(screen.getByRole('option', { name: 'Sales GST · 12.25%' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Tax code' })).toHaveFocus());
    await user.click(screen.getByRole('combobox', { name: 'Tax calculation' }));
    await user.click(await screen.findByRole('option', { name: 'Tax inclusive' }));
    await user.click(screen.getByRole('checkbox', { name: 'Priority' }));
    await user.click(screen.getByRole('checkbox', { name: 'Auto-post' }));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({
      mutation: 'update', ruleId: 'rule-a', expectedRevision: 3,
      proposal: {
        matchText: 'Northwind Services', direction: 'Deposit', categoryQboId: 'income-a',
        taxCalculation: 'TaxInclusive', taxCodeQboId: 'sales-tax',
        tagIds: ['tag-a', 'tag-b'], autoPost: false,
      },
    }));
  });

  it('preserves a failed draft and reloads canonical values only after a successful commit', async () => {
    const user = userEvent.setup();
    mocks.prepare.mockRejectedValueOnce(new Error('Preparation failed.'));
    renderRules();

    const match = await screen.findByRole('textbox', { name: 'Payee contains' });
    await user.clear(match); await user.type(match, 'Draft supplier');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByRole('alert', { name: 'Rule preparation unavailable' })).toHaveTextContent('Preparation failed.');
    expect(screen.getByRole('textbox', { name: 'Payee contains' })).toHaveValue('Draft supplier');

    const canonical = rule({ revision: { ...rule().revision, revision: 4, condition: { matchField: 'payee', matchText: 'Canonical supplier' } } });
    mocks.prepare.mockResolvedValueOnce(prepared({ condition: canonical.revision.condition }));
    mocks.commit.mockResolvedValueOnce({ ...prepared(), status: 'COMMITTED', revision: 4, preview: null, rule: canonical.revision });
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [canonical], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Retry preparation' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm update rule' }));

    expect(await screen.findByRole('textbox', { name: 'Payee contains' })).toHaveValue('Canonical supplier');
  });
});

vi.mock('../components/ClassificationMemoryPanel', () => ({ default: () => null }));
vi.mock('./rules/PastDecisionsSection', () => ({ default: () => null }));
