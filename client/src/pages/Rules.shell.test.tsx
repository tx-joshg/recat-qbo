import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuleDetailDto, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  revisions: vi.fn(), affectedTransactions: vi.fn(),
  lifecycleRules: vi.fn(),
  listCandidates: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),

  testRule: vi.fn(),
  intentId: vi.fn(),



  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'COMPANY_GENERIC',
    activeCompany: { id: 'COMPANY_GENERIC', holdingAccountIds: [] },
    accounts: [
      { qboId: 'ACCOUNT_GENERIC', name: 'Office expense', classification: 'Expenses' },
      { qboId: 'ACCOUNT_TRAVEL', name: 'Travel expense', classification: 'Expenses' },
    ],
    tags: [],
    taxReadiness: { status: 'ready', reason: null, usingSalesTax: true, refreshedAt: '2026-07-30T00:00:00.000Z', taxCodes: [], salesStatus: 'ready', salesReason: null, salesTaxCodes: [] },
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: mocks.intentId,
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: { lifecycle: mocks.lifecycleRules, test: mocks.testRule, revisions: mocks.revisions, affectedTransactions: mocks.affectedTransactions },
  ruleCandidates: { list: mocks.listCandidates },
}));

import Rules from './Rules';

function ruleDetail(): RuleDetailDto {
  return {
    state: 'enabled',
    reviewRequiredAt: null,
    reviewReason: null,
    repairReason: null,
    revision: {
      id: 'revision-3', ruleId: 'rule-1', companyId: 'COMPANY_GENERIC', revision: 3,
      state: 'enabled', condition: { matchField: 'payee', matchText: 'Generic supplier' },
      direction: 'Purchase',
      action: { version: 2, direction: 'Purchase', category: 'Office expense', categoryQboId: 'ACCOUNT_GENERIC', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      taxCodeName: null, autoPost: false,
      originIntent: null, sourceCaseId: null, sourceCandidateId: null, changedBy: null,
      createdAt: '2026-08-30T00:00:00.000Z', repairReason: null,
      affectedJournalEntryCount: 0, valid: true, invalidReasons: [],
    },
  };
}

function prepared(): RuleMutationResult {
  return {
    ok: true, operationId: 'operation-update', companyId: 'COMPANY_GENERIC', mutation: 'update',
    originIntent: null, status: 'PREPARED', ruleId: 'rule-1', revision: null, rule: null,
    candidate: null, error: null,
    preview: {
      operationId: 'operation-update', companyId: 'COMPANY_GENERIC', ruleId: 'rule-1', candidateId: null,
      mutation: 'update', originIntent: null, currentRevision: 3, proposedRevision: 4,
      condition: { matchField: 'payee', matchText: 'Generic supplier' }, direction: 'Purchase',
      action: { categoryQboId: 'ACCOUNT_GENERIC', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] }, categoryName: 'Office expense', taxCodeName: null,
      autoPost: false, affectedPendingCount: 0, affectedProcessedCount: 0,
      sampleTransactions: [], conflicts: [], warnings: [], expiresAt: '2026-08-31T01:00:00.000Z', preparationDigest: 'digest',
    },
  };
}

function renderRules() {
  return render(<MemoryRouter><Rules /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycleRules.mockResolvedValue({ runtimeMode: 'canonical', items: [], nextCursor: null });
  mocks.listCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.intentId.mockReturnValue('99999999-9999-4999-8999-999999999999');
});

it('renders the standard responsive Rules shell and an intentional zero-rules state', async () => {
  renderRules();

  expect(await screen.findByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
  expect(screen.getByText(/match vendors and apply structured categorization rules/i)).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'No rules' })).toHaveTextContent(/No rules match this state/);
  expect(screen.getByRole('link', { name: 'Create rule from Queue' })).toHaveAttribute('href', '/');
});

it('does not prepare an update when the current rule category is reselected', async () => {
  mocks.lifecycleRules.mockResolvedValue({ runtimeMode: 'canonical', items: [ruleDetail()], nextCursor: null });
  const user = userEvent.setup();
  renderRules();

  await user.click(await screen.findByRole('combobox', { name: 'Category' }));
  await user.click(screen.getByRole('option', { name: 'Expenses · Office expense' }));

  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('changes lifecycle through the shared Select and prepares a category update through the shared Combobox', async () => {
  mocks.lifecycleRules.mockResolvedValue({ runtimeMode: 'canonical', items: [ruleDetail()], nextCursor: null });
  mocks.prepare.mockResolvedValue(prepared());
  const user = userEvent.setup();
  renderRules();

  await user.click(await screen.findByRole('combobox', { name: 'Rule lifecycle' }));
  await user.click(screen.getByRole('option', { name: 'Enabled' }));
  await waitFor(() => expect(mocks.lifecycleRules).toHaveBeenCalledWith('COMPANY_GENERIC', 'enabled', undefined, 100));

  await user.click(screen.getByRole('combobox', { name: 'Category' }));
  await user.type(screen.getByRole('textbox', { name: 'Category' }), 'travel');
  await user.keyboard('{ArrowDown}{Enter}');
  await user.click(screen.getByRole('button', { name: 'Save rule' }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', expect.objectContaining({
    mutation: 'update', ruleId: 'rule-1', proposal: { categoryQboId: 'ACCOUNT_TRAVEL' },
  })));
});

it('has no native select anywhere in the Rules render tree', async () => {
  renderRules();
  await screen.findByText(/No rules match this state/);
  expect(document.querySelectorAll('select')).toHaveLength(0);
});


it('loads history and affected rows from the same footer as the editor actions', async () => {
  mocks.lifecycleRules.mockResolvedValue({ runtimeMode: 'canonical', items: [ruleDetail()], nextCursor: null });
  mocks.revisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.affectedTransactions.mockResolvedValue({ items: [], nextCursor: null, matchedCount: 0, pendingCount: 0, processedCount: 0 });
  renderRules();
  const history = await screen.findByRole('button', { name: /View history for/ });
  expect(history.parentElement).toBe(screen.getByRole('button', { name: 'Test rule' }).parentElement);
  expect(history.parentElement).toBe(screen.getByRole('button', { name: 'Save rule' }).parentElement);
  await userEvent.click(history);
  expect(mocks.revisions).toHaveBeenCalledWith('COMPANY_GENERIC', 'rule-1', undefined, 100);
  expect(mocks.affectedTransactions).toHaveBeenCalledWith('COMPANY_GENERIC', 'rule-1', { status: 'all', limit: 20 });
  expect(await screen.findByText('No revisions recorded.')).toBeInTheDocument();
});

vi.mock('../components/ClassificationMemoryPanel', () => ({ default: () => null }));
vi.mock('./rules/PastDecisionsSection', () => ({ default: () => null }));
