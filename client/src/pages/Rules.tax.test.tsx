import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'COMPANY_GENERIC',
    accounts: [{
      qboId: 'EXPENSE_ACCOUNT',
      name: 'Generic expense',
      classification: 'Expenses',
    }],
    tags: [],
    taxReadiness: {
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-07-28T00:00:00.000Z',
      taxCodes: [{
        qboId: 'TAX_CODE_STANDARD',
        name: 'Standard purchase tax',
        active: true,
        taxable: true,
        combinedPurchaseRate: 5,
        combinedSalesRate: null,
      }],
      salesStatus: 'needs_setup',
      salesReason: null,
      salesTaxCodes: [],
    },
    toast: mocks.toast,
    activeCompany: { id: 'COMPANY_GENERIC', holdingAccountIds: [] },
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: vi.fn(() => '99999999-9999-4999-8999-999999999999'),
  ruleOperations: { prepare: vi.fn(), commit: vi.fn() },
  rules: {
    lifecycle: mocks.list,

    test: vi.fn(),
  },
  ruleCandidates: {
    list: vi.fn().mockResolvedValue({ candidates: [], nextCursor: null }),
  },
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ search: '' }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { href: to, ...props }, children),
}));

import Rules from './Rules';

describe('Rules historical tax validation', () => {
  it('shows an invalid stored tax reference instead of silently applying it', async () => {
    mocks.list.mockResolvedValue({ runtimeMode: 'canonical', items: [{
      state: 'disabled',
      reviewRequiredAt: null,
      reviewReason: null,
      repairReason: 'Tax reference unavailable: Historical purchase tax.',
      revision: {
        id: 'REVISION_GENERIC', ruleId: 'RULE_GENERIC', companyId: 'COMPANY_GENERIC',
        revision: 2, state: 'enabled', condition: { matchField: 'payee', matchText: 'Generic supplier' },
        direction: 'Purchase', action: null, taxCodeName: 'Historical purchase tax',
        autoPost: false, originIntent: null, sourceCaseId: null,
        sourceCandidateId: null, changedBy: null, createdAt: '2026-07-28T00:00:00.000Z',
        repairReason: 'Tax reference unavailable: Historical purchase tax.', affectedJournalEntryCount: 0, valid: false,
        invalidReasons: ['Tax reference unavailable: Historical purchase tax.'],
      },
    }], nextCursor: null });

    render(<Rules />);

    expect(
      await screen.findByText(/tax reference unavailable.*historical purchase tax/i),
    ).toBeInTheDocument();
  });
});

vi.mock('../components/ClassificationMemoryPanel', () => ({ default: () => null }));
vi.mock('./rules/PastDecisionsSection', () => ({ default: () => null }));
