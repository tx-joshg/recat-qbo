import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleCandidateDto, RuleDetailDto, RuleMutationKind, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(), detail: vi.fn(), testRule: vi.fn(),
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
    test: mocks.testRule,
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
  vi.clearAllMocks();
  mocks.activeCompanyId = 'company-a';
  mocks.activeCompany = { id: 'company-a', holdingAccountIds: ['holding-designated'] };
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [], nextCursor: null });
  mocks.detail.mockResolvedValue(rule());
  mocks.candidates.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.getCandidate.mockResolvedValue(candidate());
  window.history.replaceState({}, '', '/rules');
});

describe('Rules candidate review', () => {
  it('excludes configured and localized holding accounts from rule destinations', async () => {
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
    const user = userEvent.setup();
    renderRules();

    await user.click(await screen.findByRole('combobox', { name: 'Category' }));
    expect(screen.getByRole('option', { name: 'Expenses · Office expense' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Uncategorised Expense|Pending Review/ })).not.toBeInTheDocument();
  });

  it('explains candidate provenance and activates through prepare then commit', async () => {
    const ready = candidate();
    mocks.candidates.mockResolvedValueOnce({ candidates: [ready], nextCursor: null })
      .mockResolvedValue({ candidates: [], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('activate_candidate'));
    mocks.commit.mockResolvedValue({
      ...prepared('activate_candidate'), status: 'COMMITTED', preview: null,
      candidate: { candidateId: ready.id, state: 'activated', ruleId: 'rule-created' },
    });
    const user = userEvent.setup();
    renderRules();

    expect(await screen.findByText('northwind market')).toBeInTheDocument();
    expect(screen.getByText(/3 verified outcomes.*2 reviewed by a person.*1 by autopilot/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activate rule' }));
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', {
      mutation: 'activate_candidate', candidateId: ready.id, expectedRevision: 0,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    });
    expect(screen.getByText(/2 pending.*1 processed/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm activate candidate' }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalled());
    expect(screen.queryByText('northwind market')).not.toBeInTheDocument();
  });

  it('shows conflicting evidence and stale references without activation', async () => {
    mocks.candidates.mockResolvedValue({
      candidates: [candidate({ state: 'conflict', canActivate: false, conflictingEvidenceCount: 1, staleReasons: ['Category unavailable.'] })],
      nextCursor: null,
    });
    renderRules();
    expect(await screen.findByText(/1 conflicting outcome/i)).toBeInTheDocument();
    expect(screen.getByText('Category unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate rule' })).not.toBeInTheDocument();
  });

  it('rehydrates a linked rule that is outside the current state page', async () => {
    const linked = rule({ revision: { ...rule().revision, ruleId: 'rule-linked', condition: { matchField: 'payee', matchText: 'Linked supplier' } } });
    mocks.detail.mockResolvedValue(linked);
    window.history.replaceState({}, '', '/rules?source=rule&sourceId=rule-linked');
    renderRules();
    expect(await screen.findByText('Linked supplier')).toBeInTheDocument();
    expect(mocks.detail).toHaveBeenCalledWith('company-a', 'rule-linked');
  });

  it('routes a linked disabled rule requiring reactivation review through Review and save only', async () => {
    const linked = rule({
      state: 'disabled',
      reviewReason: 'This rule requires review before reactivation.',
      revision: { ...rule().revision, state: 'disabled', ruleId: 'rule-linked', condition: { matchField: 'payee', matchText: 'Linked supplier' } },
    });
    mocks.detail.mockResolvedValue(linked);
    window.history.replaceState({}, '', '/rules?source=rule&sourceId=rule-linked');
    renderRules();
    expect(await screen.findByText('Linked supplier')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save rule' })).not.toBeInTheDocument();
    expect(screen.getByText(/This rule requires review before reactivation/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review and save' }));
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({
      mutation: 'review', ruleId: 'rule-linked', proposal: expect.objectContaining({ reviewReason: 'Reviewed and saved.' }),
    }));
  });

  it('tests the current draft with its required direction', async () => {
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
    mocks.testRule.mockResolvedValue({
      matches: [], pendingCount: 4, processedCount: 2,
      conflicts: [{ ruleId: 'other', matchText: 'supplier', category: 'Travel', priority: 2 }],
    });
    renderRules();
    await userEvent.click(await screen.findByRole('button', { name: 'Test rule' }));
    expect(mocks.testRule).toHaveBeenCalledWith('company-a', 'Generic supplier', 'Purchase');
    expect(await screen.findByText(/4 pending.*2 processed.*1 conflicts/i)).toBeInTheDocument();
  });

  it('dismisses a candidate through the governed preview', async () => {
    mocks.candidates.mockResolvedValue({ candidates: [candidate()], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('dismiss_candidate'));
    mocks.commit.mockResolvedValue({
      ...prepared('dismiss_candidate'), status: 'COMMITTED', preview: null,
      candidate: { candidateId: 'candidate-a', state: 'dismissed', ruleId: null },
    });
    const user = userEvent.setup();
    renderRules();
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({ mutation: 'dismiss_candidate' }));
    await user.click(screen.getByRole('button', { name: 'Confirm dismiss candidate' }));
    expect(mocks.commit).toHaveBeenCalled();
  });

  it('loads and deduplicates bounded candidate pages', async () => {
    const first = candidate();
    const second = candidate({ id: 'candidate-b', matchText: 'contoso services' });
    mocks.candidates.mockImplementation(async (_companyId: string, cursor?: string) => cursor
      ? { candidates: [first, second], nextCursor: null }
      : { candidates: [first], nextCursor: 'next' });
    renderRules();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more candidates' }));
    expect(await screen.findByText('contoso services')).toBeInTheDocument();
    expect(screen.getAllByText('northwind market')).toHaveLength(1);
  });

  it('keeps a candidate load failure visible and retries it independently', async () => {
    mocks.candidates.mockRejectedValueOnce(new Error('Candidates failed.'))
      .mockResolvedValueOnce({ candidates: [candidate()], nextCursor: null });
    const user = userEvent.setup();
    renderRules();

    expect(await screen.findByRole('alert', { name: 'Candidates unavailable' }))
      .toHaveTextContent('Candidates failed.');
    await user.click(screen.getByRole('button', { name: 'Retry candidates' }));

    expect(await screen.findByText('northwind market')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Candidates unavailable' })).not.toBeInTheDocument();
  });

  it('caps visible lifecycle pages at 200 rules and stops before another request', async () => {
    const allRules = Array.from({ length: 300 }, (_, index) => rule({
      revision: {
        ...rule().revision,
        id: `revision-cap-${index}`,
        ruleId: `rule-cap-${index}`,
        condition: { matchField: 'payee', matchText: `Capped supplier ${index}` },
      },
    }));
    mocks.lifecycle.mockImplementation(async (_companyId: string, _state: string, cursor?: string) => {
      if (!cursor) return { runtimeMode: 'canonical', items: allRules.slice(0, 100), nextCursor: 'rule-page-2' };
      if (cursor === 'rule-page-2') return { runtimeMode: 'canonical', items: allRules.slice(100, 200), nextCursor: 'rule-page-3' };
      return { runtimeMode: 'canonical', items: allRules.slice(200), nextCursor: null };
    });
    const user = userEvent.setup();
    renderRules();

    await user.click(await screen.findByRole('button', { name: 'Load more rules' }));

    expect(await screen.findByText('Capped supplier 199')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="rule-rule-cap-"]')).toHaveLength(200);
    expect(screen.getByRole('status', { name: 'Rule lifecycle truncated' }))
      .toHaveTextContent(/showing first 200 rules.*more rules exist/i);
    expect(screen.queryByRole('button', { name: 'Load more rules' })).not.toBeInTheDocument();
    expect(mocks.lifecycle).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('caps visible candidate pages at 100 candidates and stops before another request', async () => {
    const allCandidates = Array.from({ length: 120 }, (_, index) => candidate({
      id: `candidate-cap-${index}`,
      matchText: `Capped candidate ${index}`,
    }));
    mocks.candidates.mockImplementation(async (_companyId: string, cursor?: string) => {
      const page = cursor ? Number(cursor.replace('candidate-page-', '')) : 0;
      return {
        candidates: allCandidates.slice(page * 20, page * 20 + 20),
        nextCursor: `candidate-page-${page + 1}`,
      };
    });
    const user = userEvent.setup();
    renderRules();

    for (let page = 1; page < 5; page += 1) {
      await user.click(await screen.findByRole('button', { name: 'Load more candidates' }));
    }

    expect(await screen.findByText('Capped candidate 99')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="rule-candidate-candidate-cap-"]')).toHaveLength(100);
    expect(screen.getByRole('status', { name: 'Rule candidates truncated' }))
      .toHaveTextContent(/showing newest 100 candidates.*older candidates exist/i);
    expect(screen.queryByRole('button', { name: 'Load more candidates' })).not.toBeInTheDocument();
    expect(mocks.candidates).toHaveBeenCalledTimes(5);
  }, 30_000);

  it('fences late lifecycle and candidate pages after a company switch', async () => {
    let resolveRules!: (value: { runtimeMode: 'canonical', items: RuleDetailDto[]; nextCursor: null }) => void;
    let resolveCandidates!: (value: { candidates: RuleCandidateDto[]; nextCursor: null }) => void;
    mocks.lifecycle.mockImplementation((companyId: string, _state: string, cursor?: string) => {
      if (companyId === 'company-b') return Promise.resolve({ runtimeMode: 'canonical', items: [], nextCursor: null });
      if (cursor) return new Promise((resolve) => { resolveRules = resolve; });
      return Promise.resolve({ runtimeMode: 'canonical', items: [rule()], nextCursor: 'old-rule-page' });
    });
    mocks.candidates.mockImplementation((companyId: string, cursor?: string) => {
      if (companyId === 'company-b') return Promise.resolve({ candidates: [], nextCursor: null });
      if (cursor) return new Promise((resolve) => { resolveCandidates = resolve; });
      return Promise.resolve({ candidates: [candidate()], nextCursor: 'old-candidate-page' });
    });
    const user = userEvent.setup();
    const view = renderRules();
    await user.click(await screen.findByRole('button', { name: 'Load more rules' }));
    await user.click(screen.getByRole('button', { name: 'Load more candidates' }));

    mocks.activeCompanyId = 'company-b';
    mocks.activeCompany = { id: 'company-b', holdingAccountIds: [] };
    view.rerender(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
    await waitFor(() => expect(mocks.candidates).toHaveBeenCalledWith('company-b'));

    await act(async () => {
      resolveRules({ runtimeMode: 'canonical', items: [rule({ revision: { ...rule().revision, ruleId: 'late-rule', condition: { matchField: 'payee', matchText: 'Late old rule' } } })], nextCursor: null });
      resolveCandidates({ candidates: [candidate({ id: 'late-candidate', matchText: 'Late old candidate' })], nextCursor: null });
    });

    expect(screen.queryByText('Late old rule')).not.toBeInTheDocument();
    expect(screen.queryByText('Late old candidate')).not.toBeInTheDocument();
  });

  it('clears a linked candidate after activation so stale actions cannot reappear', async () => {
    const linked = candidate({ id: 'candidate-linked', matchText: 'Linked candidate' });
    window.history.replaceState({}, '', `/rules?source=rule_candidate&sourceId=${linked.id}`);
    mocks.getCandidate.mockResolvedValue(linked);
    mocks.prepare.mockResolvedValue({ ...prepared('activate_candidate'), preview: { ...prepared('activate_candidate').preview!, candidateId: linked.id } });
    mocks.commit.mockResolvedValue({
      ...prepared('activate_candidate'), status: 'COMMITTED', preview: null,
      candidate: { candidateId: linked.id, state: 'activated', ruleId: 'rule-created' },
    });
    const user = userEvent.setup();
    renderRules();

    const region = await screen.findByRole('region', { name: 'Linked source candidate' });
    await user.click(screen.getByRole('button', { name: 'Activate rule' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm activate candidate' }));

    await waitFor(() => expect(region).not.toBeInTheDocument());
    expect(screen.queryByText('Linked candidate')).not.toBeInTheDocument();
  });

  it('keeps the next candidate page reachable while acting on the final visible candidate', async () => {
    const ready = candidate();
    mocks.candidates.mockResolvedValue({ candidates: [ready], nextCursor: 'next-candidate-page' });
    mocks.prepare.mockResolvedValue(prepared('activate_candidate'));
    renderRules();

    await userEvent.click(await screen.findByRole('button', { name: 'Activate rule' }));

    expect(await screen.findByRole('button', { name: 'Load more candidates' })).toBeInTheDocument();
  });

  it('ignores a completed candidate action after the active company changes', async () => {
    const ready = candidate();
    let resolveActivation!: (value: RuleMutationResult) => void;
    mocks.candidates.mockImplementation(async (companyId: string) => ({
      candidates: companyId === 'company-a' ? [ready] : [], nextCursor: null,
    }));
    mocks.prepare.mockReturnValue(new Promise<RuleMutationResult>((resolve) => { resolveActivation = resolve; }));
    const view = renderRules();
    await userEvent.click(await screen.findByRole('button', { name: 'Activate rule' }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());

    mocks.activeCompanyId = 'company-b';
    mocks.activeCompany = { id: 'company-b', holdingAccountIds: [] };
    view.rerender(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
    await waitFor(() => expect(mocks.candidates).toHaveBeenCalledWith('company-b'));

    await act(async () => resolveActivation(prepared('activate_candidate')));

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm activate candidate' })).not.toBeInTheDocument();
    expect(mocks.toast).not.toHaveBeenCalledWith('Rule activated — auto-post remains off');
  });
});

it('does not commit a late immediate operation after the Rules page unmounts', async () => {
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
  let resolve!: (value: RuleMutationResult) => void;
  mocks.prepare.mockReturnValue(new Promise<RuleMutationResult>(done => { resolve = done; }));
  const view = render(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  view.unmount();
  await act(async () => resolve(prepared('disable')));
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('does not restore a stale test result after switching away and back', async () => {
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
  let resolve!: (value: unknown) => void;
  mocks.testRule.mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Test rule' }));
  mocks.activeCompanyId = 'company-b';
  view.rerender(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
  mocks.activeCompanyId = 'company-a';
  view.rerender(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Rules /></MemoryRouter>);
  await act(async () => resolve({ pendingCount: 777, processedCount: 0, conflicts: [], matches: [] }));
  expect(screen.queryByText(/777 pending/)).not.toBeInTheDocument();
});

vi.mock('../components/ClassificationMemoryPanel', () => ({ default: () => null }));
vi.mock('./rules/PastDecisionsSection', () => ({ default: () => null }));
