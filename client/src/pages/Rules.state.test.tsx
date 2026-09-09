import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleDetailDto, RuleMutationKind, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(), prepare: vi.fn(), commit: vi.fn(), candidates: vi.fn(),
  testRule: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-a', activeCompany: { id: 'company-a', holdingAccountIds: [] },
    accounts: [{ id: 'expense-db', qboId: 'expense-a', name: 'Office expense', classification: 'Expenses' }],
    tags: [], taxReadiness: {
      status: 'ready', reason: null, usingSalesTax: true, refreshedAt: '2026-09-01T00:00:00.000Z', taxCodes: [],
      salesStatus: 'ready', salesReason: null, salesTaxCodes: [],
    }, toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: vi.fn(() => '99999999-9999-4999-8999-999999999999'),
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: {
    lifecycle: mocks.lifecycle, test: mocks.testRule,

  },
  ruleCandidates: { list: mocks.candidates },
}));

import Rules from './Rules';

function rule(state: 'enabled' | 'disabled' = 'enabled', extra: Partial<RuleDetailDto> = {}): RuleDetailDto {
  return {
    state, reviewRequiredAt: null, reviewReason: null, repairReason: null,
    revision: {
      id: 'revision-3', ruleId: 'rule-a', companyId: 'company-a', revision: 3, state,
      condition: { matchField: 'payee', matchText: 'Example supplier' }, direction: 'Purchase',
      action: {
        version: 2, direction: 'Purchase', category: 'Office expense', categoryQboId: 'expense-a',
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
      },
      taxCodeName: null, autoPost: state === 'enabled', originIntent: null,
      sourceCaseId: null, sourceCandidateId: null, changedBy: 'user-a',
      createdAt: '2026-09-01T00:00:00.000Z', repairReason: null,
      affectedJournalEntryCount: 0, valid: true, invalidReasons: [],
    },
    ...extra,
  };
}

function result(mutation: RuleMutationKind, conflicts: NonNullable<RuleMutationResult['preview']>['conflicts'] = []): RuleMutationResult {
  const current = rule(mutation === 'enable' ? 'disabled' : 'enabled');
  return {
    ok: true, operationId: `operation-${mutation}`, companyId: 'company-a', mutation,
    originIntent: null, status: 'PREPARED', ruleId: 'rule-a', revision: null,
    rule: null, candidate: null, error: null,
    preview: {
      operationId: `operation-${mutation}`, companyId: 'company-a', ruleId: 'rule-a', candidateId: null,
      mutation, originIntent: null, currentRevision: 3, proposedRevision: 4,
      condition: current.revision.condition, direction: 'Purchase',
      action: { categoryQboId: 'expense-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      categoryName: 'Office expense', taxCodeName: null, autoPost: false,
      affectedPendingCount: 2, affectedProcessedCount: 0, sampleTransactions: [], conflicts, warnings: [],
      expiresAt: '2026-09-01T01:00:00.000Z', preparationDigest: 'digest',
    },
  };
}

function committed(mutation: RuleMutationKind, state: 'enabled' | 'disabled'): RuleMutationResult {
  const canonical = rule(state);
  return { ...result(mutation), status: 'COMMITTED', revision: 4, preview: null, rule: { ...canonical.revision, revision: 4, autoPost: false } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderRules() { return render(<MemoryRouter><Rules /></MemoryRouter>); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule()], nextCursor: null });
  mocks.candidates.mockResolvedValue({ candidates: [], nextCursor: null });
});

describe('Rules two-state control', () => {
  it('disables in one click, turns auto-post off, and commits without confirmation', async () => {
    mocks.prepare.mockResolvedValue(result('disable'));
    mocks.commit.mockResolvedValue(committed('disable', 'disabled'));
    mocks.lifecycle.mockResolvedValueOnce({ runtimeMode: 'canonical', items: [rule()], nextCursor: null })
      .mockResolvedValue({ runtimeMode: 'canonical', items: [rule('disabled')], nextCursor: null });
    renderRules();

    await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({
      mutation: 'disable', proposal: { autoPost: false },
    })));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(
      'company-a', 'operation-disable', '99999999-9999-4999-8999-999999999999',
    ));
    expect(screen.queryByRole('button', { name: /Confirm disable/i })).not.toBeInTheDocument();
  });

  it('enables immediately without overlap and waits for confirmation when an enabled rule overlaps', async () => {
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule('disabled')], nextCursor: null });
    mocks.prepare.mockResolvedValueOnce(result('enable'));
    mocks.commit.mockResolvedValueOnce(committed('enable', 'enabled'));
    const user = userEvent.setup();
    const view = renderRules();

    await user.click(await screen.findByRole('button', { name: 'Disabled' }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    view.unmount();

    vi.clearAllMocks();
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule('disabled')], nextCursor: null });
    mocks.candidates.mockResolvedValue({ candidates: [], nextCursor: null });
    mocks.prepare.mockResolvedValue(result('enable', [{
      id: 'conflict-a', companyId: 'company-a', sourceId: 'rule-b', kind: 'rule',
      reason: 'An enabled rule overlaps this match.', action: null, actionSummary: null, evidenceCount: 1,
    }]));
    mocks.commit.mockResolvedValue(committed('enable', 'enabled'));
    renderRules();

    await user.click(await screen.findByRole('button', { name: 'Disabled' }));
    expect(await screen.findByText(/enabled rule overlaps/i)).toBeInTheDocument();
    expect(mocks.commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm enable rule' }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
  });

  it('keeps the canonical pill while busy and adopts the reloaded state after commit', async () => {
    const pending = deferred<RuleMutationResult>();
    mocks.prepare.mockReturnValue(pending.promise);
    renderRules();
    const pill = await screen.findByRole('button', { name: 'Enabled' });

    await userEvent.click(pill);
    expect(screen.getByRole('button', { name: 'Enabled' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Disabled' })).not.toBeInTheDocument();

    mocks.commit.mockResolvedValue(committed('disable', 'disabled'));
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule('disabled')], nextCursor: null });
    await act(async () => pending.resolve(result('disable')));
    expect(await screen.findByRole('button', { name: 'Disabled' })).toBeInTheDocument();
  });

  it('preserves the canonical state and offers retry after an immediate commit fails', async () => {
    mocks.prepare.mockResolvedValue(result('disable'));
    mocks.commit.mockRejectedValueOnce(new Error('Commit failed.'));
    const user = userEvent.setup();
    renderRules();

    await user.click(await screen.findByRole('button', { name: 'Enabled' }));

    expect(await screen.findByRole('alert', { name: 'Rule preparation unavailable' }))
      .toHaveTextContent('Commit failed.');
    expect(screen.getByRole('button', { name: 'Enabled' })).toBeInTheDocument();

    mocks.commit.mockResolvedValueOnce(committed('disable', 'disabled'));
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule('disabled')], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Retry preparation' }));

    expect(await screen.findByRole('button', { name: 'Disabled' })).toBeInTheDocument();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledTimes(2);
  });

  it('allows unchanged Review and save and keeps the reviewed rule Disabled with auto-post off', async () => {
    const held = rule('disabled', { reviewRequiredAt: '2026-09-01T00:00:00.000Z', reviewReason: 'Needs review', repairReason: 'Needs review' });
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [held], nextCursor: null });
    mocks.prepare.mockResolvedValue(result('review'));
    renderRules();

    const reviewButton = await screen.findByRole('button', { name: 'Review and save' });
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save rule' })).not.toBeInTheDocument();
    await userEvent.click(reviewButton);
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({
      mutation: 'review', ruleId: 'rule-a', proposal: expect.objectContaining({ reviewReason: 'Reviewed and saved.' }),
    }));
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeInTheDocument();
  });

  it('requires a separate confirmation for auto-post elevation', async () => {
    const disabledAutoPost = rule('enabled');
    disabledAutoPost.revision.autoPost = false;
    mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [disabledAutoPost], nextCursor: null });
    mocks.prepare.mockResolvedValue(result('update'));
    renderRules();

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Auto-post' }));
    expect(mocks.prepare).toHaveBeenCalledWith('company-a', expect.objectContaining({
      mutation: 'update', proposal: { autoPost: true },
    }));
    expect(await screen.findByRole('button', { name: 'Confirm enable auto-post' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rule' })).toBeDisabled();
  });

  it('uses only two lifecycle terms and exposes no obsolete lifecycle or priority controls', async () => {
    renderRules();
    expect(await screen.findByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Rule lifecycle' }));
    expect(screen.getByRole('option', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Enabled' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Disabled' })).toBeInTheDocument();
    for (const name of [/Executable/i, /Advisory/i, /Retire/i, /Move up/i, /Move down/i, /^Enable /i, /^Disable /i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });
});

it.each(['companyId', 'operationId'] as const)('keeps a mismatched %s commit unresolved', async field => {
  mocks.prepare.mockResolvedValue(result('disable'));
  mocks.commit.mockResolvedValue({ ...committed('disable', 'disabled'), [field]: 'different-result' });
  renderRules(); await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
  expect(mocks.lifecycle).toHaveBeenCalledTimes(1);
  expect(mocks.toast).not.toHaveBeenCalledWith('Rule disabled');
  expect(screen.getByRole('alert', { name: 'Rule preparation unavailable' })).toBeInTheDocument();
});

it('does not commit a preview for another company', async () => {
  mocks.prepare.mockResolvedValue({ ...result('disable'), companyId: 'company-b' });
  renderRules(); await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(screen.getByRole('alert', { name: 'Rule preparation unavailable' })).toBeInTheDocument();
});

it('finishes a lost commit from a terminal prepare replay without committing twice', async () => {
  mocks.prepare.mockResolvedValueOnce(result('disable'))
    .mockResolvedValue({ ...committed('disable', 'disabled'), status: 'REPLAYED' });
  mocks.commit.mockRejectedValueOnce(new Error('Response lost.'));
  renderRules();
  await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  await screen.findByRole('alert', { name: 'Rule preparation unavailable' });
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [rule('disabled')], nextCursor: null });
  await userEvent.click(screen.getByRole('button', { name: 'Retry preparation' }));
  expect(await screen.findByRole('button', { name: 'Disabled' })).toBeInTheDocument();
  expect(mocks.prepare.mock.calls[1]).toEqual(mocks.prepare.mock.calls[0]);
  expect(mocks.commit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Retry preparation' })).not.toBeInTheDocument();
});

it.each(['companyId', 'ruleId', 'mutation'] as const)('does not accept a terminal prepare replay with mismatched %s', async field => {
  mocks.prepare.mockResolvedValue({ ...committed('disable', 'disabled'), status: 'REPLAYED', [field]: 'unrelated' });
  renderRules();
  await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  expect(await screen.findByRole('alert', { name: 'Rule preparation unavailable' })).toBeInTheDocument();
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.lifecycle).toHaveBeenCalledTimes(1);
});

it('disables conflicting actions while a failed preparation remains unresolved', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('Preparation unavailable.'));
  renderRules();
  await userEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  await screen.findByRole('alert', { name: 'Rule preparation unavailable' });
  expect(screen.getByRole('button', { name: 'Enabled' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retry preparation' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel preparation' }));
  expect(screen.getByRole('button', { name: 'Enabled' })).toBeEnabled();
});

it.each(['COMMITTED', 'REPLAYED'] as const)('clears obsolete rule test counts after %s', async status => {
  mocks.testRule.mockResolvedValue({ pendingCount: 2, processedCount: 1, conflicts: [], matches: [] });
  mocks.prepare.mockResolvedValue(status === 'REPLAYED'
    ? { ...committed('disable', 'disabled'), status } : result('disable'));
  mocks.commit.mockResolvedValue(committed('disable', 'disabled'));
  renderRules();
  await userEvent.click(await screen.findByRole('button', { name: 'Test rule' }));
  expect(await screen.findByText('2 pending · 1 processed · 0 conflicts')).toBeInTheDocument();
  const changed = rule('disabled');
  changed.revision = { ...changed.revision, id: 'revision-4', revision: 4 };
  mocks.lifecycle.mockResolvedValue({ runtimeMode: 'canonical', items: [changed], nextCursor: null });
  await userEvent.click(screen.getByRole('button', { name: 'Enabled' }));
  await screen.findByRole('button', { name: 'Disabled' });
  expect(screen.queryByText('2 pending · 1 processed · 0 conflicts')).not.toBeInTheDocument();
});
