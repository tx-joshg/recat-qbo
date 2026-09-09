import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassificationCasePastDecision,
  HistoricalObservationPastDecision,
} from '@recat/shared';

const mocks = vi.hoisted(() => ({
  pastDecisions: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  classificationMemory: { pastDecisions: mocks.pastDecisions },
}));

import PastDecisionsSection from './PastDecisionsSection';

function verifiedCaseItem(
  overrides: Partial<ClassificationCasePastDecision> = {},
): ClassificationCasePastDecision {
  return {
    kind: 'classification_case',
    id: 'case-1',
    companyId: 'company-a',
    transactionId: 'transaction-case-1',
    payee: 'Northwind Fuel',
    memo: 'Fleet card',
    actionSummary: {
      categoryName: 'Vehicle fuel', taxCalculation: 'TaxInclusive',
      taxCodeName: 'GST purchase', tagNames: ['Reviewed'],
    },
    rationale: 'Receipt and route log support business fuel.',
    verifiedAt: '2026-08-30T12:00:00.000Z',
    invalidatedAt: null,
    invalidationReason: null,
    advisory: false,
    executable: false,
    ...overrides,
  };
}

function observationItem(
  overrides: Partial<HistoricalObservationPastDecision> = {},
): HistoricalObservationPastDecision {
  return {
    kind: 'historical_observation',
    id: 'observation-1',
    companyId: 'company-a',
    transactionId: 'transaction-observation-1',
    qboType: 'Purchase',
    qboId: 'qbo-action-id-must-not-render',
    payee: 'Northwind Market',
    memo: null,
    actionSummary: {
      categoryName: 'Office expense', taxCalculation: 'NotApplicable',
      taxCodeName: null, tagNames: [],
    },
    sourceStatus: 'POSTED',
    observedRecatRevision: 4,
    observedQboRevision: '7',
    observedAt: '2026-08-29T12:00:00.000Z',
    supersededByCaseId: 'case-1',
    advisory: true,
    executable: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pastDecisions.mockReset();
  mocks.pastDecisions.mockResolvedValue({ items: [], nextCursor: null });
});

describe('PastDecisionsSection', () => {
  it('labels verified cases and advisory observations without exposing observation actions', async () => {
    mocks.pastDecisions.mockResolvedValue({
      items: [verifiedCaseItem({ invalidatedAt: '2026-08-31T12:00:00.000Z', invalidationReason: 'Corrected receipt' }), observationItem()],
      nextCursor: null,
    });

    render(<PastDecisionsSection companyId="company-a" />);

    expect(await screen.findByText('Verified decision')).toBeInTheDocument();
    expect(screen.getByText('Advisory historical observation')).toBeInTheDocument();
    expect(screen.getByText(/Observed Recat revision 4/i)).toBeInTheDocument();
    expect(screen.getByText(/Observed QBO revision 7/i)).toBeInTheDocument();
    expect(screen.getByText(/Superseded by verified decision/i)).toBeInTheDocument();
    expect(screen.getByText(/Invalidated: Corrected receipt/i)).toBeInTheDocument();
    expect(screen.queryByText('qbo-action-id-must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /activate|edit|apply|prepare|commit/i })).not.toBeInTheDocument();
  });

  it('renders an intentional empty state', async () => {
    render(<PastDecisionsSection companyId="company-a" />);

    expect(await screen.findByText(
      'No prior decisions or historical observations are available for this company.',
    )).toBeInTheDocument();
  });

  it('retries a failed first page and appends a deduplicated next page', async () => {
    mocks.pastDecisions
      .mockRejectedValueOnce(new Error('Past decisions are unavailable.'))
      .mockResolvedValueOnce({ items: [verifiedCaseItem()], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [verifiedCaseItem(), observationItem()], nextCursor: null });
    const user = userEvent.setup();

    render(<PastDecisionsSection companyId="company-a" />);
    await user.click(await screen.findByRole('button', { name: 'Retry past decisions' }));
    await user.click(await screen.findByRole('button', { name: 'Load more past decisions' }));

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(mocks.pastDecisions).toHaveBeenLastCalledWith('company-a', {
      kind: 'all', limit: 20, cursor: 'cursor-2',
    });
  });

  it('discards a late page from the previous company', async () => {
    const companyA = deferred<{ items: ClassificationCasePastDecision[]; nextCursor: null }>();
    mocks.pastDecisions
      .mockReturnValueOnce(companyA.promise)
      .mockResolvedValueOnce({ items: [verifiedCaseItem({ companyId: 'company-b', payee: 'Company B Vendor' })], nextCursor: null });
    const view = render(<PastDecisionsSection companyId="company-a" />);

    await waitFor(() => expect(mocks.pastDecisions).toHaveBeenCalledWith('company-a', {
      kind: 'all', limit: 20,
    }));
    view.rerender(<PastDecisionsSection companyId="company-b" />);
    expect(await screen.findByText('Company B Vendor')).toBeInTheDocument();
    await act(async () => companyA.resolve({ items: [verifiedCaseItem({ payee: 'Company A Vendor' })], nextCursor: null }));

    expect(screen.queryByText('Company A Vendor')).not.toBeInTheDocument();
    expect(screen.getByText('Company B Vendor')).toBeInTheDocument();
  });
});

it('preserves earlier decisions and retries the same cursor after a next-page failure', async () => {
  mocks.pastDecisions.mockResolvedValueOnce({ items: [verifiedCaseItem()], nextCursor: 'cursor-2' })
    .mockRejectedValueOnce(new Error('Temporary page failure'))
    .mockResolvedValueOnce({ items: [observationItem()], nextCursor: null });
  render(<PastDecisionsSection companyId="company-a" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Load more past decisions' }));
  expect(screen.getByText('Verified decision')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retry past decisions' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(mocks.pastDecisions.mock.calls[2]).toEqual(mocks.pastDecisions.mock.calls[1]);
});

it('caps visible past decisions at 100 and explains that more exist', async () => {
  mocks.pastDecisions.mockImplementation(async (_company, params) => {
    const offset = params.cursor ? Number(params.cursor) : 0;
    return { items: Array.from({ length: 20 }, (_, i) => verifiedCaseItem({ id: `case-${offset + i}` })), nextCursor: String(offset + 20) };
  });
  render(<PastDecisionsSection companyId="company-a" />);
  for (let i = 0; i < 4; i++) await userEvent.click(await screen.findByRole('button', { name: 'Load more past decisions' }));
  expect(screen.getAllByRole('article')).toHaveLength(100);
  expect(screen.queryByRole('button', { name: 'Load more past decisions' })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Showing first 100 past decisions; more records exist.');
  expect(mocks.pastDecisions).toHaveBeenCalledTimes(5);
});
