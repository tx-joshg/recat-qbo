import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleAffectedTransactionPageDto, RuleRevisionPageDto, RuleRevisionReadDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({ revisions: vi.fn(), affectedTransactions: vi.fn() }));
vi.mock('../../lib/api', async () => ({ ...await vi.importActual<typeof import('../../lib/api')>('../../lib/api'), rules: mocks }));
import { ApiError } from '../../lib/api';
import RuleDetailsRegion from './RuleDetailsRegion';

function revision(number: number, overrides: Partial<RuleRevisionReadDto> = {}): RuleRevisionReadDto {
  return {
    id: `revision-${number}`, companyId: 'company-a', ruleId: 'rule-a', revision: number,
    state: 'enabled', condition: { matchField: 'payee', matchText: 'Example supplier' }, direction: 'Purchase',
    action: { categoryQboId: 'expense', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
    categoryName: 'Office', taxCodeName: null, autoPost: false, priority: 0,
    originIntent: 'make_recurring', sourceCaseId: null, sourceCandidateId: null, changedBy: 'user-a',
    createdAt: `2026-09-0${number}T12:00:00.000Z`, retiredAt: null, canonicalVersion: 2,
    repairReason: null, affectedJournalEntryCount: null, valid: true, invalidReasons: [], ...overrides,
  };
}

function history(items = [revision(1)], nextCursor: string | null = null): RuleRevisionPageDto {
  return { items, nextCursor };
}

function affected(payee = 'Example supplier Fuel', nextCursor: string | null = null): RuleAffectedTransactionPageDto {
  return {
    matchedCount: 3, pendingCount: 1, processedCount: 2, nextCursor,
    items: [{ transactionId: payee, qboType: 'Purchase', qboId: payee, date: '2026-09-01',
      payee, memo: 'Fleet card', amountCents: -1250, status: 'POSTED', ruleWins: false, winningRuleId: 'other-rule' }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const props = { companyId: 'company-a', ruleId: 'rule-a', matchText: 'Example supplier' };
const open = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'View history for Example supplier' }));

beforeEach(() => {
  mocks.revisions.mockReset().mockResolvedValue(history());
  mocks.affectedTransactions.mockReset().mockResolvedValue(affected());
});

describe('RuleDetailsRegion', () => {
  it('starts closed and loads both bounded sections in parallel through one labelled control', async () => {
    const pendingHistory = deferred<RuleRevisionPageDto>();
    mocks.revisions.mockReturnValue(pendingHistory.promise);
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    const button = screen.getByRole('button', { name: 'View history for Example supplier' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(mocks.revisions).not.toHaveBeenCalled();
    expect(mocks.affectedTransactions).not.toHaveBeenCalled();
    await open(user);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'View history for Example supplier' })).toBeInTheDocument();
    expect(await screen.findByText(/Example supplier Fuel/)).toBeInTheDocument();
    expect(screen.getByText('Loading revision history…')).toBeInTheDocument();
    expect(mocks.revisions).toHaveBeenCalledWith('company-a', 'rule-a', undefined, 100);
    expect(mocks.affectedTransactions).toHaveBeenCalledWith('company-a', 'rule-a', { status: 'all', limit: 20 });
    expect(screen.queryByRole('button', { name: 'View affected transactions' })).not.toBeInTheDocument();
    await act(async () => pendingHistory.resolve(history()));
  });

  it.each(['history', 'affected', 'both'] as const)('discards late %s responses after collapse and refetches on reopen', async (pending) => {
    const lateHistory = deferred<RuleRevisionPageDto>();
    const lateAffected = deferred<RuleAffectedTransactionPageDto>();
    if (pending !== 'affected') mocks.revisions.mockReturnValueOnce(lateHistory.promise);
    if (pending !== 'history') mocks.affectedTransactions.mockReturnValueOnce(lateAffected.promise);
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    await open(user);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    await open(user);
    expect(await screen.findByText(/Example supplier Fuel/)).toBeInTheDocument();
    await act(async () => {
      lateHistory.resolve(history([revision(8)]));
      lateAffected.resolve(affected('Late response vendor'));
    });
    expect(screen.queryByText(/Late response vendor/)).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Revision 8' })).not.toBeInTheDocument();
    expect(mocks.revisions).toHaveBeenCalledTimes(2);
    expect(mocks.affectedTransactions).toHaveBeenCalledTimes(2);
    await open(user);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it.each(['history', 'affected'] as const)('retries failed %s without reloading the successful section', async (side) => {
    (side === 'history' ? mocks.revisions : mocks.affectedTransactions).mockRejectedValueOnce(new Error('Temporary failure'));
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary failure');
    if (side === 'history') expect(screen.getByText(/Example supplier Fuel/)).toBeInTheDocument();
    else expect(screen.getByRole('article', { name: 'Revision 1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: side === 'history' ? 'Retry revision history' : 'Retry affected transactions' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.revisions).toHaveBeenCalledTimes(side === 'history' ? 2 : 1);
    expect(mocks.affectedTransactions).toHaveBeenCalledTimes(side === 'affected' ? 2 : 1);
  });

  it('shows newest-first material changes, immutable retirement provenance, and truncation honestly', async () => {
    mocks.revisions.mockResolvedValue(history([
      revision(2, { state: 'retired', retiredAt: '2026-09-02T12:00:00.000Z', autoPost: false }),
      revision(3, { direction: 'Deposit', categoryName: 'Sales', autoPost: true }),
    ], 'older'));
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    const entries = within(screen.getByRole('region')).getAllByRole('article', { name: /Revision/ });
    expect(entries.map((entry) => entry.getAttribute('aria-label'))).toEqual(['Revision 3', 'Revision 2']);
    expect(entries[0]).toHaveTextContent('direction Purchase → Deposit');
    expect(entries[0]).toHaveTextContent('category Office → Sales');
    expect(entries[0]).toHaveTextContent('state retired → enabled');
    expect(entries[0]).toHaveTextContent('auto-post off → on');
    expect(entries[1]).toHaveTextContent('Older comparison unavailable');
    expect(screen.getByLabelText('Revision history truncated')).toHaveTextContent('older history exists');
  });

  it('keeps legacy null provenance and unavailable actions readable', async () => {
    mocks.revisions.mockResolvedValue(history([revision(1, { originIntent: null, action: null, valid: false, invalidReasons: ['Category unavailable'] })]));
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    expect(await screen.findByText(/Provenance: legacy provenance/)).toBeInTheDocument();
    expect(screen.getByText('Historical action unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Invalid revision: Category unavailable')).toBeInTheDocument();
  });

  it('shows material action identifier, tax, tag, validity and source details without hiding historical references', async () => {
    mocks.revisions.mockResolvedValue(history([
      revision(2, {
        condition: { matchField: 'payee', matchText: 'Example supplier Fleet' },
        action: { categoryQboId: 'expense-new', taxCalculation: 'TaxInclusive', taxCodeQboId: 'gst-new', tagIds: ['tag-new'] },
        taxCodeName: 'GST', valid: false, invalidReasons: ['Tax unavailable'], repairReason: 'Tax reference removed',
        sourceCaseId: 'case-2', sourceCandidateId: 'candidate-2', changedBy: 'reviewer-2',
      }),
      revision(1, { action: { categoryQboId: 'expense-old', taxCalculation: 'TaxExcluded', taxCodeQboId: 'gst-old', tagIds: ['tag-old'] }, taxCodeName: 'GST' }),
    ]));
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    const newest = screen.getByRole('article', { name: 'Revision 2' });
    expect(newest).toHaveTextContent('match Example supplier → Example supplier Fleet');
    expect(newest).toHaveTextContent('category QBO ID expense-old → expense-new');
    expect(newest).toHaveTextContent('tax calculation TaxExcluded → TaxInclusive');
    expect(newest).toHaveTextContent('tax code QBO ID gst-old → gst-new');
    expect(newest).toHaveTextContent('tags tag-old → tag-new');
    expect(newest).toHaveTextContent('validity valid → invalid');
    expect(newest).toHaveTextContent('repair reason none → Tax reference removed');
    expect(newest).toHaveTextContent('source case case-2 · source candidate candidate-2 · actor reviewer-2');
  });

  it('filters processed outcomes, preserves POSTED/DRY_RUN and appends deduplicated bounded pages', async () => {
    const processed = affected('Posted vendor', 'next-page');
    const next = affected('Dry-run vendor');
    next.items[0]!.status = 'DRY_RUN';
    next.items.unshift(processed.items[0]!);
    mocks.affectedTransactions.mockResolvedValueOnce(affected()).mockResolvedValueOnce(processed).mockResolvedValueOnce(next);
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    expect(screen.getByText('3 matched · 1 pending · 2 processed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Processed' }));
    expect(screen.getByRole('button', { name: 'Processed' }).style.background).toBe('var(--okB)');
    expect(screen.getByRole('button', { name: 'Processed' }).style.color).toBe('var(--okT)');
    expect(mocks.affectedTransactions).toHaveBeenLastCalledWith('company-a', 'rule-a', { status: 'processed', limit: 20 });
    await user.click(screen.getByRole('button', { name: 'Load more affected transactions' }));
    expect(mocks.affectedTransactions).toHaveBeenLastCalledWith('company-a', 'rule-a', { status: 'processed', limit: 20, cursor: 'next-page' });
    expect(screen.getAllByText(/Posted vendor/)).toHaveLength(1);
    expect(screen.getByText('POSTED')).toBeInTheDocument();
    expect(screen.getByText('DRY_RUN')).toBeInTheDocument();
    expect(screen.getAllByText('−$12.50')).toHaveLength(2);
  });

  it('rejects old-filter responses and does not reload history when selecting a filter', async () => {
    const late = deferred<RuleAffectedTransactionPageDto>();
    mocks.affectedTransactions.mockReturnValueOnce(late.promise).mockResolvedValueOnce(affected('Pending vendor'));
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Pending' }));
    await act(async () => late.resolve(affected('Stale all vendor')));
    expect(screen.queryByText(/Stale all vendor/)).not.toBeInTheDocument();
    expect(screen.getByText(/Pending vendor/)).toBeInTheDocument();
    expect(mocks.revisions).toHaveBeenCalledTimes(1);
  });

  it.each([
    { companyId: 'company-b', ruleId: 'rule-a', revision: 1 },
    { companyId: 'company-a', ruleId: 'rule-b', revision: 1 },
    { companyId: 'company-a', ruleId: 'rule-a', revision: 2 },
  ])('invalidates requests and closes when identity changes to %j', async (identity) => {
    const late = deferred<RuleRevisionPageDto>();
    mocks.revisions.mockReturnValueOnce(late.promise);
    const user = userEvent.setup();
    const { rerender } = render(<RuleDetailsRegion {...props} revision={1} />);
    await open(user);
    rerender(<RuleDetailsRegion {...props} {...identity} />);
    await act(async () => late.resolve(history([revision(9)])));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    await open(user);
    expect(mocks.revisions).toHaveBeenLastCalledWith(identity.companyId, identity.ruleId, undefined, 100);
    expect(screen.queryByRole('article', { name: 'Revision 9' })).not.toBeInTheDocument();
  });

  it('keeps earlier affected pages when retrying a failed next page', async () => {
    mocks.affectedTransactions.mockResolvedValueOnce(affected('First vendor', 'cursor-2'))
      .mockRejectedValueOnce(new Error('Next page failed')).mockResolvedValueOnce(affected('Second vendor'));
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Load more affected transactions' }));
    expect(screen.getByText(/First vendor/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry affected transactions' }));
    expect(screen.getByText(/First vendor/)).toBeInTheDocument();
    expect(screen.getByText(/Second vendor/)).toBeInTheDocument();
    expect(mocks.affectedTransactions).toHaveBeenLastCalledWith('company-a', 'rule-a', { status: 'all', limit: 20, cursor: 'cursor-2' });
  });

  it('shows empty states and never invents a competing winner', async () => {
    mocks.revisions.mockResolvedValue(history([]));
    const noWinner = affected();
    noWinner.items[0]!.winningRuleId = null;
    mocks.affectedTransactions.mockResolvedValueOnce(noWinner).mockResolvedValueOnce({ ...noWinner, items: [] });
    const user = userEvent.setup();
    render(<RuleDetailsRegion {...props} />);
    await open(user);
    expect(screen.getByText('No revisions recorded.')).toBeInTheDocument();
    expect(screen.queryByText('Another enabled rule currently wins')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pending' }));
    expect(screen.getByText('No affected transactions match this filter.')).toBeInTheDocument();
  });
});


it('restarts the current filter after a cursor expires without retaining the stale population', async () => {
  mocks.affectedTransactions.mockResolvedValueOnce(affected('Initial supplier'))
    .mockResolvedValueOnce(affected('Old processed supplier', 'stale-cursor'))
    .mockRejectedValueOnce(new ApiError(400, 'Affected transaction population changed; restart pagination', 'INVALID_CURSOR'))
    .mockResolvedValueOnce(affected('Current processed supplier'));
  const user = userEvent.setup(); render(<RuleDetailsRegion {...props} />); await open(user);
  await user.click(screen.getByRole('button', { name: 'Processed' }));
  await user.click(screen.getByRole('button', { name: 'Load more affected transactions' }));
  expect(screen.getByText(/Old processed supplier/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry affected transactions' }));
  expect(mocks.affectedTransactions).toHaveBeenLastCalledWith('company-a', 'rule-a', { status: 'processed', limit: 20 });
  expect(screen.queryByText(/Old processed supplier/)).not.toBeInTheDocument();
  expect(await screen.findByText(/Current processed supplier/)).toBeInTheDocument();
  expect(mocks.revisions).toHaveBeenCalledTimes(1);
});

it('always identifies the year in revision creation and retirement dates', async () => {
  mocks.revisions.mockResolvedValue(history([revision(2, { retiredAt: '2026-09-03T12:00:00Z' })]));
  const user = userEvent.setup(); render(<RuleDetailsRegion {...props} />); await open(user);
  expect(await screen.findByRole('article', { name: 'Revision 2' })).toHaveTextContent('Sep 2, 2026');
  expect(screen.getByRole('article', { name: 'Revision 2' })).toHaveTextContent('retired at Sep 3, 2026');
});
