import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render as renderWithoutRouter, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassificationSearchHit } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  health: vi.fn(),
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message);
    }
  }
  return {
    ApiError,
    classificationMemory: {
      search: mocks.search,
      health: mocks.health,
    },
  };
});

import { ApiError, type ClassificationSearchPageDto } from '../lib/api';
import ClassificationMemoryPanel from './ClassificationMemoryPanel';

function renderPanel(ui: ReactElement) { return renderWithoutRouter(ui, { wrapper: MemoryRouter }); }

async function chooseControl(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: string,
) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const search = screen.queryByRole('textbox', { name: label });
  if (search) await user.type(search, optionName);
  await user.click(screen.getByRole('option', { name: optionName }));
}

function hit(overrides: Partial<ClassificationSearchHit> = {}): ClassificationSearchHit {
  return {
    id: 'hit-1',
    sourceId: 'case-1',
    kind: 'classification_case',
    companyId: 'company-1',
    companyName: 'Northwind Books',
    companyRelation: 'current',
    executable: true,
    advisory: false,
    matchedIn: ['alias', 'case'],
    score: 0.91,
    vendorIdentityId: 'vendor-1',
    vendorName: 'Northwind Fuel',
    action: {
      categoryQboId: 'account-1',
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'tax-1',
      tagIds: [],
    },
    actionSummary: {
      categoryName: 'Vehicle fuel',
      taxCalculation: 'TaxInclusive',
      taxCodeName: 'GST purchase',
      tagNames: ['Reviewed'],
    },
    originIntent: 'apply_once',
    evidenceCount: 4,
    conflictingEvidenceCount: 1,
    conflicts: [{
      id: 'conflict-1',
      companyId: 'company-1',
      sourceId: 'case-2',
      kind: 'case',
      reason: 'Receipt showed a personal purchase.',
      action: null,
      actionSummary: null,
      evidenceCount: 1,
    }],
    provenance: {
      source: 'qbo_verified',
      sourceId: 'attempt-1',
      actorId: 'user-1',
      recordedAt: '2026-08-30T12:00:00.000Z',
    },
    rationale: 'Receipt and route log support business fuel.',
    examples: [],
    counterexamples: ['Personal weekend purchase'],
    jurisdiction: 'CA-BC',
    currency: 'CAD',
    verifiedAt: '2026-08-30T12:00:00.000Z',
    ruleRevision: null,
    observation: null,
    ...overrides,
  };
}

const healthy = {
  configured: true,
  provider: 'voyage',
  model: 'voyage-4-large',
  dimensions: 1024,
  vectorAvailable: true,
  expectedGeneration: 'generation-1',
  indexedGeneration: 'generation-1',
  activeGeneration: 'generation-1',
  expectedState: 'ready',
  embedded: 8,
  skipped: 0,
  backlog: 0,
  progress: 1,
  lastSuccessAt: '2026-08-30T12:00:00.000Z',
  lastError: null,
  latestAttemptGeneration: 'generation-1',
  latestAttemptState: 'ready',
  latestAttemptAt: '2026-08-30T12:00:00.000Z',
  latestAttemptError: null,
  currentCorpusRevision: '8',
  indexedCorpusRevision: '8',
  expectedCorpusRevision: '8',
  latestAttemptCorpusRevision: '8',
};

function noMatchPage(query: string): ClassificationSearchPageDto {
  return {
    query,
    companyId: 'company-1',
    scope: 'current_company',
    mode: 'exact',
    requestedMode: 'exact',
    degraded: false,
    degradedReason: null,
    status: 'no_match',
    noMatch: true,
    total: 0,
    items: [],
    nextCursor: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockReset();
  mocks.health.mockReset();
  mocks.health.mockResolvedValue(healthy);
  mocks.search.mockResolvedValue({
    query: 'Northwind Fuel',
    companyId: 'company-1',
    scope: 'current_company',
    mode: 'hybrid',
    requestedMode: 'auto',
    degraded: false,
    degradedReason: null,
    status: 'matched',
    noMatch: false,
    total: 1,
    items: [hit()],
    nextCursor: null,
  });
});

describe('ClassificationMemoryPanel', () => {
  it('keeps Search mode accessible while naming the visible action Search rules', () => {
    renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="Northwind Fuel" />);

    expect(screen.getByLabelText('Search mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search rules' })).toBeInTheDocument();
  });

  it('searches with transaction context and renders bounded provenance with source navigation', async () => {
    renderPanel(
      <ClassificationMemoryPanel
        companyId="company-1"
        initialQuery="Northwind Fuel"
        transactionId="transaction-1"
        title="Similar Decisions"
        autoSearch
      />,
    );

    await waitFor(() => expect(mocks.search).toHaveBeenCalledWith('company-1', {
      query: 'Northwind Fuel',
      mode: 'auto',
      scope: 'current_company',
      transactionId: 'transaction-1',
      limit: 20,
    }));
    expect(screen.getByText('Northwind Books')).toBeInTheDocument();
    expect(screen.getByText(/alias.*case/i)).toBeInTheDocument();
    expect(screen.getByText(/Vehicle fuel.*GST purchase/i)).toBeInTheDocument();
    expect(screen.getByText(/Receipt and route log support business fuel/i)).toBeInTheDocument();
    expect(screen.getByText(/4 verified evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/1 conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/Receipt showed a personal purchase/i)).toBeInTheDocument();
    expect(screen.getByText(/verified Aug 30, 2026/i)).toBeInTheDocument();
    expect(screen.getByText('Executable')).toBeInTheDocument();
    expect(screen.getByText(/Verified decision.*Matched in alias.*case/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open source case/i })).toHaveAttribute(
      'href',
      '/rules?source=classification_case&sourceId=case-1',
    );
  });

  it('labels request result and semantic index status as separate facts', async () => {
    mocks.search.mockResolvedValue({
      query: 'fuel', companyId: 'company-1', scope: 'current_company',
      mode: 'lexical', requestedMode: 'auto', degraded: true,
      degradedReason: 'semantic_unavailable', status: 'matched', noMatch: false,
      total: 1, items: [hit()], nextCursor: null,
    });

    renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="fuel" autoSearch />);

    expect(await screen.findByText(/this search: lexical fallback/i)).toBeInTheDocument();
    expect(screen.getByText(/semantic index status: ready/i)).toBeInTheDocument();
  });

  it('labels historical observations as advisory and exposes no source write control', async () => {
    mocks.search.mockResolvedValueOnce({
      query: 'northwind', companyId: 'company-1', scope: 'current_company',
      mode: 'lexical', requestedMode: 'auto', degraded: false, degradedReason: null,
      status: 'matched', noMatch: false, total: 1, nextCursor: null,
      items: [hit({
        id: 'historical_observation:observation-1', sourceId: 'observation-1',
        kind: 'historical_observation', executable: false, advisory: true,
        matchedIn: ['observation'], action: null, originIntent: null, evidenceCount: 0,
        provenance: {
          source: 'historical_observation', sourceId: 'observation-1', actorId: null,
          recordedAt: '2026-08-30T12:00:00.000Z',
        },
        rationale: null, verifiedAt: null,
        observation: {
          sourceTransactionId: 'transaction-1', sourceQboType: 'Purchase', sourceQboId: 'purchase-1',
          sourceTransactionRevision: 1, sourceQboSyncToken: '1', sourceStatus: 'POSTED',
          sourceUpdatedAt: '2026-08-30T12:00:00.000Z', observedAt: '2026-08-30T12:00:00.000Z',
        },
      })],
    });

    const view = renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="northwind" autoSearch />);

    await screen.findByText(/Matched in Observation/);
    expect(view.container.querySelector('article')).toHaveTextContent('Advisory historical observation');
    expect(screen.getByText('Advisory')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open source observation/i })).toHaveAttribute(
      'href',
      '/rules?source=historical_observation&sourceId=observation-1',
    );
    expect(screen.queryByText('Executable')).not.toBeInTheDocument();
  });

  it('explains a completed no-match without disabling manual categorization', async () => {
    mocks.search.mockResolvedValueOnce({ ...noMatchPage('unknown'), requestedMode: 'auto' });
    renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="unknown" autoSearch />);

    expect(await screen.findByText(
      'No prior matching rule or decision was found. Manual categorization is still available.',
    )).toBeInTheDocument();
  });

  it('distinguishes explicit semantic unavailability from a full request failure', async () => {
    const user = userEvent.setup();
    mocks.search.mockRejectedValueOnce(new ApiError(503, 'Semantic classification search is unavailable.', 'SEMANTIC_UNAVAILABLE'));
    renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="fuel" />);
    await user.click(screen.getByRole('combobox', { name: 'Search mode' }));
    await user.click(screen.getByRole('option', { name: 'Semantic' }));
    await user.click(screen.getByRole('button', { name: 'Search rules' }));
    expect(await screen.findByText(/semantic search is unavailable/i)).toBeInTheDocument();

    mocks.search.mockRejectedValueOnce(new ApiError(503, 'Classification search is temporarily unavailable.', 'COMPANY_UNAVAILABLE'));
    await user.click(screen.getByRole('button', { name: 'Search rules' }));
    expect(await screen.findByText(/could not search prior decisions/i)).toBeInTheDocument();
  });

  it('invalidates an in-flight result when company context changes', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.search.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    mocks.search.mockResolvedValueOnce({
      query: 'new supplier', companyId: 'company-2', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({
        id: 'hit-new', companyId: 'company-2', companyName: 'New Company',
        vendorName: 'New supplier', sourceId: 'case-new',
      })], nextCursor: null,
    });
    const view = renderPanel(
      <ClassificationMemoryPanel companyId="company-1" initialQuery="old supplier" autoSearch />,
    );
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent(/Searching prior decisions/i);

    view.rerender(
      <ClassificationMemoryPanel companyId="company-2" initialQuery="new supplier" autoSearch />,
    );
    expect(await screen.findByText('New Company')).toBeInTheDocument();

    resolveOld({
      query: 'old supplier', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({ companyName: 'Old Company' })], nextCursor: null,
    });
    await waitFor(() => expect(screen.queryByText('Old Company')).not.toBeInTheDocument());
  });

  it('fences a late automatic base search when the active transaction changes', async () => {
    let resolveOld!: (value: ClassificationSearchPageDto) => void;
    mocks.search.mockImplementationOnce(() => new Promise<ClassificationSearchPageDto>((resolve) => {
      resolveOld = resolve;
    }));
    mocks.search.mockResolvedValueOnce({
      query: 'new supplier', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({
        id: 'hit-new', companyName: 'New Company', vendorName: 'New supplier', sourceId: 'case-new',
      })], nextCursor: null,
    });
    const view = renderPanel(
      <ClassificationMemoryPanel
        companyId="company-1"
        initialQuery="old supplier"
        transactionId="transaction-old"
        autoSearch
      />,
    );
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));

    view.rerender(
      <ClassificationMemoryPanel
        companyId="company-1"
        initialQuery="new supplier"
        transactionId="transaction-new"
        autoSearch
      />,
    );
    expect(await screen.findByText('New Company')).toBeInTheDocument();

    resolveOld({
      query: 'old supplier', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({ companyName: 'Old Company' })], nextCursor: null,
    });
    await waitFor(() => expect(screen.queryByText('Old Company')).not.toBeInTheDocument());
  });

  it('loads bounded search pages with the same context and deduplicates hits', async () => {
    mocks.search.mockResolvedValueOnce({
      query: 'Northwind Fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [hit()], nextCursor: 'cursor-1',
    }).mockResolvedValueOnce({
      query: 'Northwind Fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [
        hit(),
        hit({ id: 'hit-2', sourceId: 'rule-2', kind: 'rule', vendorName: 'Northwind Repairs' }),
      ], nextCursor: null,
    });
    const user = userEvent.setup();
    renderPanel(
      <ClassificationMemoryPanel
        companyId="company-1"
        initialQuery="Northwind Fuel"
        transactionId="transaction-1"
        autoSearch
      />,
    );

    await user.click(await screen.findByRole('button', { name: /load more.*1 of 2/i }));
    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith('company-1', {
      query: 'Northwind Fuel', mode: 'auto', scope: 'current_company',
      transactionId: 'transaction-1', limit: 20, cursor: 'cursor-1',
    }));
    expect(await screen.findByText('Northwind Repairs')).toBeInTheDocument();
    expect(screen.getAllByText('Northwind Fuel')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('fences a late page when query or mode changes', async () => {
    let resolvePage!: (value: unknown) => void;
    mocks.search.mockResolvedValueOnce({
      query: 'fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [hit()], nextCursor: 'cursor-1',
    }).mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const user = userEvent.setup();
    renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="fuel" autoSearch />);
    await user.click(await screen.findByRole('button', { name: /load more/i }));

    await user.clear(screen.getByLabelText('Classification search'));
    await user.type(screen.getByLabelText('Classification search'), 'repairs');
    await chooseControl(user, 'Search mode', 'Exact');
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Northwind Books')).not.toBeInTheDocument();
    resolvePage({
      query: 'fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [hit({ id: 'late', vendorName: 'Late stale result' })], nextCursor: null,
    });

    await waitFor(() => expect(screen.queryByText('Late stale result')).not.toBeInTheDocument());
  });

  it('does not invent navigation for vendor-only knowledge hits', async () => {
    mocks.search.mockResolvedValue({
      query: 'Northwind', companyId: 'company-1', scope: 'current_company', mode: 'exact',
      requestedMode: 'exact', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({
        kind: 'vendor_identity', sourceId: 'vendor-1', action: null, actionSummary: null,
      })], nextCursor: null,
    });
    const user = userEvent.setup();
    renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="Northwind" />);
    await chooseControl(user, 'Search mode', 'Exact');
    await user.click(screen.getByRole('button', { name: 'Search rules' }));

    expect(await screen.findByText('Northwind Books')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open source/i })).not.toBeInTheDocument();
  });
});

it.each(['companyId', 'query', 'requestedMode'] as const)('does not show a first page for a mismatched %s', async field => {
  mocks.search.mockResolvedValue({
    ...noMatchPage('Northwind Fuel'), requestedMode: 'auto', status: 'matched', noMatch: false,
    total: 1, items: [hit()], [field]: 'unrelated',
  });
  renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery="Northwind Fuel" autoSearch />);
  expect(await screen.findByText(/Could not search prior decisions/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Open case/i })).not.toBeInTheDocument();
});


it('normalizes manual search to the server NFC query contract', async () => {
  mocks.search.mockResolvedValue({ ...noMatchPage('Café supplies'), requestedMode: 'auto' });
  renderPanel(<ClassificationMemoryPanel companyId="company-1" initialQuery={'Cafe\u0301 supplies'} />);
  await userEvent.click(screen.getByRole('button', { name: 'Search rules' }));
  expect(mocks.search).toHaveBeenCalledWith('company-1', expect.objectContaining({ query: 'Café supplies' }));
  expect(await screen.findByText(/No prior matching rule or decision was found/)).toBeInTheDocument();
});
