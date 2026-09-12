import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HistoricalObservationPastDecision, RuleDetailDto, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  revisions: vi.fn(),
  testRule: vi.fn(),
  affectedTransactions: vi.fn(),
  listCandidates: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  intentId: vi.fn(),
  search: vi.fn(),
  health: vi.fn(),
  pastDecisions: vi.fn(),
  getObservation: vi.fn(),
  getCase: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'COMPANY_GENERIC',
    activeCompany: { id: 'COMPANY_GENERIC', holdingAccountIds: [] },
    accounts: [{ qboId: 'ACCOUNT_GENERIC', name: 'Office expense', classification: 'Expenses' }],
    tags: [],
    taxReadiness: null,
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: mocks.intentId,
  classificationMemory: {
    search: mocks.search,
    health: mocks.health,
    pastDecisions: mocks.pastDecisions,
    getObservation: mocks.getObservation,
    getCase: mocks.getCase,
  },
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: {
    lifecycle: mocks.lifecycle,
    revisions: mocks.revisions,
    test: mocks.testRule,
    affectedTransactions: mocks.affectedTransactions,
  },
  ruleCandidates: { list: mocks.listCandidates },
}));

import Rules from './Rules';

function rule(): RuleDetailDto {
  return {
    state: 'enabled', reviewRequiredAt: null, reviewReason: null, repairReason: null,
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

function observation(): HistoricalObservationPastDecision {
  return {
    kind: 'historical_observation', id: 'observation-a', companyId: 'COMPANY_GENERIC',
    transactionId: 'transaction-a', qboType: 'Purchase', qboId: 'purchase-a',
    payee: 'Historical supplier', memo: null,
    actionSummary: { categoryName: 'Office expense', taxCalculation: 'NotApplicable', taxCodeName: null, tagNames: [] },
    sourceStatus: 'POSTED', observedRecatRevision: 4, observedQboRevision: '7',
    observedAt: '2026-08-30T00:00:00.000Z', supersededByCaseId: null,
    advisory: true, executable: false,
  };
}

function prepared(): RuleMutationResult {
  return {
    ok: true, operationId: 'operation-disable', companyId: 'COMPANY_GENERIC', mutation: 'disable',
    originIntent: null, status: 'PREPARED', ruleId: 'rule-1', revision: null, rule: null, candidate: null, error: null,
    preview: {
      operationId: 'operation-disable', companyId: 'COMPANY_GENERIC', ruleId: 'rule-1', candidateId: null,
      mutation: 'disable', originIntent: null, currentRevision: 3, proposedRevision: 4,
      condition: rule().revision.condition, direction: 'Purchase',
      action: { categoryQboId: 'ACCOUNT_GENERIC', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] }, categoryName: 'Office expense', taxCodeName: null,
      autoPost: false, affectedPendingCount: 0, affectedProcessedCount: 0, sampleTransactions: [], conflicts: [], warnings: [],
      expiresAt: '2026-09-01T01:00:00.000Z', preparationDigest: 'digest',
    },
  };
}

function renderRules() {
  return render(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/rules');
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
  mocks.revisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.testRule.mockResolvedValue({ pendingCount: 0, processedCount: 0, conflicts: [], matches: [] });
  mocks.affectedTransactions.mockResolvedValue({ items: [], nextCursor: null, matchedCount: 0, pendingCount: 0, processedCount: 0 });
  mocks.listCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.search.mockResolvedValue({
    query: 'supplier', companyId: 'COMPANY_GENERIC', scope: 'current_company', mode: 'hybrid', requestedMode: 'hybrid',
    degraded: false, degradedReason: null, status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
  });
  mocks.health.mockResolvedValue({ configured: false, vectorAvailable: false, backlog: 0, progress: 0 });
  mocks.pastDecisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.intentId.mockReturnValue('99999999-9999-4999-8999-999999999999');
  mocks.prepare.mockResolvedValue(prepared());
});

it('keeps the four rules-browser surfaces distinct and opens an exact advisory source', async () => {
  window.history.replaceState({}, '', '/rules?source=historical_observation&sourceId=observation-a');
  mocks.getObservation.mockResolvedValue(observation());

  renderRules();

  expect(await screen.findByRole('heading', { level: 2, name: 'Rules' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Past Decisions' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Learned Candidates' })).toBeInTheDocument();
  expect(await screen.findByText('Advisory historical observation')).toBeInTheDocument();
  expect(mocks.getObservation).toHaveBeenCalledWith('COMPANY_GENERIC', 'observation-a');
});

it('keeps a rule edit on the existing governed prepare then commit path', async () => {
  renderRules();
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Enabled' }));

  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', expect.objectContaining({
    mutation: 'disable', ruleId: 'rule-1', expectedRevision: 3, proposal: { autoPost: false },
  })));
  expect(mocks.commit).toHaveBeenCalledWith(
    'COMPANY_GENERIC', 'operation-disable', '99999999-9999-4999-8999-999999999999',
  );
});


it('opens a superseding verified case through same-page router navigation', async () => {
  window.history.replaceState({}, '', '/rules?source=historical_observation&sourceId=observation-a');
  mocks.getObservation.mockResolvedValue({ ...observation(), supersededByCaseId: 'case-a' });
  mocks.getCase.mockResolvedValue({ id: 'case-a', companyId: 'COMPANY_GENERIC', rationale: 'Verified replacement',
    verifiedAt: '2026-09-01T00:00:00Z', context: { sourceAccountName: 'Operating account' }, originIntent: 'apply_once', citations: [] });
  renderRules();
  await userEvent.click(await screen.findByRole('link', { name: 'Superseded by verified decision' }));
  expect(await screen.findByText('Verified replacement')).toBeInTheDocument();
  expect(mocks.getCase).toHaveBeenCalledWith('COMPANY_GENERIC', 'case-a');
  expect(screen.queryByRole('region', { name: 'Source historical observation' })).not.toBeInTheDocument();
});

it('preserves the current search while opening a source record through the router', async () => {
  mocks.getObservation.mockResolvedValue(observation());
  mocks.search.mockResolvedValue({ query: 'tracked supplier', companyId: 'COMPANY_GENERIC', scope: 'current_company',
    mode: 'lexical', requestedMode: 'auto', degraded: false, degradedReason: null, noMatch: false, status: 'matched', total: 1, nextCursor: null,
    items: [{ id: 'hit-a', sourceId: 'observation-a', kind: 'historical_observation', vendorName: 'Search result supplier', companyName: 'Example company',
      executable: false, matchedIn: ['observation'], evidenceCount: 0, conflictingEvidenceCount: 0, conflicts: [], verifiedAt: null,
      actionSummary: observation().actionSummary, rationale: null }],
  });
  renderRules();
  await userEvent.type(screen.getByRole('textbox', { name: 'Classification search' }), 'tracked supplier');
  await userEvent.click(screen.getByRole('button', { name: 'Search rules' }));
  await userEvent.click(await screen.findByRole('link', { name: 'Open source observation' }));
  expect(await screen.findByRole('region', { name: 'Source historical observation' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Classification search' })).toHaveValue('tracked supplier');
  expect(screen.getByText('Search result supplier')).toBeInTheDocument();
});
