import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuleCandidateDto, RuleDetailDto, RuleMutationKind, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(), detail: vi.fn(), testRule: vi.fn(), revisions: vi.fn(), affected: vi.fn(),
  candidates: vi.fn(), getCandidate: vi.fn(), prepare: vi.fn(), commit: vi.fn(),
  toast: vi.fn(),
  activeCompanyId: 'company-a' as string | null,
  activeCompany: { id: 'company-a', holdingAccountIds: ['holding-designated'] } as { id: string; holdingAccountIds: string[] } | null,
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: mocks.activeCompanyId, activeCompany: mocks.activeCompany,
    accounts: [
      { id: 'expense-db', qboId: 'expense-a', name: 'Office expense', classification: 'Expenses' },
      { id: 'holding-localized', qboId: 'holding-localized', name: 'Uncategorised Expense', classification: 'Expenses' },
      { id: 'holding-designated', qboId: 'holding-designated', name: 'Pending Review', classification: 'Expenses' },
    ],
    tags: [{ id: 'tag-a', companyId: 'company-a', name: 'Reviewed', color: '#64748b' }],
    taxReadiness: {
      status: 'ready', reason: null, usingSalesTax: true, refreshedAt: '2026-09-01T00:00:00.000Z', taxCodes: [],
      salesStatus: 'ready', salesReason: null, salesTaxCodes: [],
    },
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: vi.fn(() => '99999999-9999-4999-8999-999999999999'),
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: {
    lifecycle: mocks.lifecycle, detail: mocks.detail,
    test: mocks.testRule, revisions: mocks.revisions, affectedTransactions: mocks.affected,
  },
  ruleCandidates: { list: mocks.candidates, get: mocks.getCandidate },
}));

import Rules from './Rules';

function rule(overrides: Partial<RuleDetailDto> = {}): RuleDetailDto {
  return {
    state: 'enabled', reviewRequiredAt: null, reviewReason: null, repairReason: null,
    revision: {
      id: 'revision-3', ruleId: 'rule-a', companyId: 'company-a', revision: 3,
      state: 'enabled', condition: { matchField: 'payee', matchText: 'Generic supplier' }, direction: 'Purchase',
      action: {
        version: 2, direction: 'Purchase', category: 'Office expense', categoryQboId: 'expense-a',
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
      },
      taxCodeName: null, autoPost: false, originIntent: null, sourceCaseId: null,
      sourceCandidateId: null, changedBy: 'user-a', createdAt: '2026-09-01T00:00:00.000Z',
      repairReason: null, affectedJournalEntryCount: 0, valid: true, invalidReasons: [],
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<RuleCandidateDto> = {}): RuleCandidateDto {
  return {
    id: 'candidate-a', companyId: 'company-a', state: 'ready', matchField: 'payee',
    matchText: 'northwind market', category: 'Office expense', categoryQboId: 'expense-a',
    taxCalculation: 'NotApplicable', taxCode: null, taxCodeQboId: null, tagIds: ['tag-a'],
    evidenceCount: 3, conflictingEvidenceCount: 0, evidenceThreshold: 3,
    schemaVersion: 'rule-candidate-v1', configVersion: 'config-neutral', staleReasons: [],
    canActivate: true, activatedRuleId: null,
    provenance: { user: 2, autopilot: 1, mcp: 0 },
    evidence: [{ transactionId: 'transaction-a', source: 'user', observedAt: '2026-09-01T00:00:00.000Z' }],
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function prepared(mutation: RuleMutationKind): RuleMutationResult {
  return {
    ok: true, operationId: `operation-${mutation}`, companyId: 'company-a', mutation,
    originIntent: mutation.includes('candidate') ? 'auto_candidate' : null,
    status: 'PREPARED', ruleId: mutation.includes('candidate') ? null : 'rule-a',
    revision: null, rule: null, candidate: null, error: null,
    preview: {
      operationId: `operation-${mutation}`, companyId: 'company-a',
      ruleId: mutation.includes('candidate') ? null : 'rule-a',
      candidateId: mutation.includes('candidate') ? 'candidate-a' : null,
      mutation, originIntent: mutation.includes('candidate') ? 'auto_candidate' : null,
      currentRevision: mutation.includes('candidate') ? 0 : 3, proposedRevision: 4,
      condition: { matchField: 'payee', matchText: 'northwind market' }, direction: 'Purchase',
      action: { categoryQboId: 'expense-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: ['tag-a'] },
      categoryName: 'Office expense', taxCodeName: null, autoPost: false,
      affectedPendingCount: 2, affectedProcessedCount: 1, sampleTransactions: [], conflicts: [], warnings: [],
      expiresAt: '2026-09-01T01:00:00.000Z', preparationDigest: 'digest',
    },
  };
}

function renderRules() { return render(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>); }



beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/rules');
  mocks.activeCompanyId = 'company-a';
  mocks.activeCompany = { id: 'company-a', holdingAccountIds: [] };
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
  mocks.candidates.mockResolvedValue({ candidates: [candidate()], nextCursor: null });
  mocks.revisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.affected.mockResolvedValue({ items: [], nextCursor: null, matchedCount: 0, pendingCount: 0, processedCount: 0 });
});

it.each([
  ['legacy', /need migration/], ['bridge', /migration is not finished/], ['paused', /changes are paused/],
] as const)('keeps %s rules and history readable while new edits are disabled', async (runtimeMode, copy) => {
  mocks.lifecycle.mockResolvedValue({ runtimeMode, items: [rule()], nextCursor: null });
  renderRules();
  expect(await screen.findByRole('status', { name: 'Rule editing status' })).toHaveTextContent(copy);
  expect(screen.getByRole('button', { name: 'Enabled' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Category' })).toBeDisabled();
  expect(await screen.findByRole('button', { name: 'Activate rule' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Rule lifecycle' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: 'View history for Generic supplier' }));
  expect(await screen.findByRole('heading', { name: 'Revision history' })).toBeInTheDocument();
  expect(mocks.revisions).toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each(['legacy', 'bridge', 'paused'])('does not offer creation from an empty %s rule list', async runtimeMode => {
  mocks.lifecycle.mockResolvedValue({ runtimeMode, items: [], nextCursor: null });
  renderRules();
  await screen.findByRole('status', { name: 'Rule editing status' });
  expect(screen.queryByRole('link', { name: 'Create rule from Queue' })).not.toBeInTheDocument();
});

it('enables canonical actions and creation only after the status read completes', async () => {
  let resolve!: (value: unknown) => void;
  mocks.lifecycle.mockReturnValue(new Promise(done => { resolve = done; }));
  renderRules();
  expect(await screen.findByRole('button', { name: 'Activate rule' })).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Rule editing status' })).toHaveTextContent('Checking');
  await act(async () => resolve({ runtimeMode: 'canonical', items: [], nextCursor: null }));
  expect(screen.getByRole('button', { name: 'Activate rule' })).toBeEnabled();
  expect(screen.getByRole('link', { name: 'Create rule from Queue' })).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Rule editing status' })).not.toBeInTheDocument();
});

it.each(['missing', 'failed'])('keeps new actions unavailable when the status is %s', async kind => {
  if (kind === 'failed') mocks.lifecycle.mockRejectedValue(new Error('Unavailable'));
  else mocks.lifecycle.mockResolvedValue({ items: [rule()], nextCursor: null });
  renderRules();
  expect(await screen.findByRole('button', { name: 'Activate rule' })).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Rule editing status' })).toHaveTextContent('unavailable');
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('never inherits canonical editing permission while another company is loading', async () => {
  const view = renderRules();
  expect(await screen.findByRole('button', { name: 'Activate rule' })).toBeEnabled();
  let resolve!: (value: unknown) => void;
  mocks.lifecycle.mockReturnValue(new Promise(done => { resolve = done; }));
  mocks.activeCompanyId = 'company-b'; mocks.activeCompany = { id: 'company-b', holdingAccountIds: [] };
  mocks.candidates.mockResolvedValue({ candidates: [candidate({ companyId: 'company-b' })], nextCursor: null });
  view.rerender(<MemoryRouter><Rules /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Activate rule' })).toBeDisabled();
  await act(async () => resolve({ runtimeMode: 'paused', items: [], nextCursor: null }));
  expect(screen.getByRole('status', { name: 'Rule editing status' })).toHaveTextContent('changes are paused');
  expect(screen.getByRole('button', { name: 'Activate rule' })).toBeDisabled();
});

it('keeps the same pending operation retry available after a paused status read', async () => {
  mocks.lifecycle.mockResolvedValueOnce({ runtimeMode: 'canonical', items: [rule()], nextCursor: 'page-2' })
    .mockResolvedValue({ runtimeMode: 'paused', items: [], nextCursor: null });
  mocks.prepare.mockResolvedValueOnce(prepared('disable')).mockResolvedValue({ ...prepared('disable'), status: 'REPLAYED', preview: null });
  mocks.commit.mockRejectedValueOnce(new Error('Commit response lost.'));
  renderRules();
  await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  await screen.findByRole('button', { name: 'Retry preparation' });
  await userEvent.click(screen.getByRole('button', { name: 'Load more rules' }));
  expect(await screen.findByRole('status', { name: 'Rule editing status' })).toHaveTextContent('changes are paused');
  await userEvent.click(screen.getByRole('button', { name: 'Retry preparation' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry preparation' })).not.toBeInTheDocument());
  expect(mocks.prepare.mock.calls[1]).toEqual(mocks.prepare.mock.calls[0]);
  expect(mocks.commit).toHaveBeenCalledTimes(1);
});

it('ignores a late canonical status after switching companies or clearing the company', async () => {
  let resolve!: (value: unknown) => void;
  mocks.lifecycle.mockReturnValueOnce(new Promise(done => { resolve = done; }))
    .mockResolvedValue({ runtimeMode: 'paused', items: [], nextCursor: null });
  const view = renderRules();
  await screen.findByRole('button', { name: 'Activate rule' });
  mocks.activeCompanyId = 'company-b'; mocks.activeCompany = { id: 'company-b', holdingAccountIds: [] };
  mocks.candidates.mockResolvedValue({ candidates: [candidate({ companyId: 'company-b' })], nextCursor: null });
  view.rerender(<MemoryRouter><Rules /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('status', { name: 'Rule editing status' })).toHaveTextContent('changes are paused'));
  await act(async () => resolve({ runtimeMode: 'canonical', items: [rule()], nextCursor: null }));
  expect(screen.getByRole('button', { name: 'Activate rule' })).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Rule editing status' })).toHaveTextContent('changes are paused');
  mocks.activeCompanyId = null; mocks.activeCompany = null;
  view.rerender(<MemoryRouter><Rules /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Activate rule' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Create rule from Queue' })).not.toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
