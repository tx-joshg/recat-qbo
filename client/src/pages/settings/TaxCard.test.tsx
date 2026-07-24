import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshTax: vi.fn(),
  toast: vi.fn(),
  refreshedAt: new Date(2026, 3, 3, 10, 33).toISOString(),
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    taxProfile: {
      status: 'ready',
      usingSalesTax: true,
      lastRefreshedAt: mocks.refreshedAt,
      reason: null,
    },
    taxCodes: Array.from({ length: 9 }, (_, index) => ({
      qboId: String(index + 1),
      name: `Code ${index + 1}`,
      description: null,
      active: true,
      taxable: true,
      purchaseApplicable: true,
    })),
    refreshTax: mocks.refreshTax,
    toast: mocks.toast,
  }),
}));

vi.mock('../../lib/api', () => ({
  tax: { refresh: vi.fn() },
}));

import TaxCard from './TaxCard';

beforeEach(() => vi.clearAllMocks());

describe('TaxCard summary copy', () => {
  it('capitalizes Ready and renders a stable full refresh timestamp', () => {
    render(<TaxCard isAdmin />);

    expect(screen.getByText(/9 purchase tax codes/)).toHaveTextContent(
      'Ready · 9 purchase tax codes · refreshed 2026-04-03 at 10:33 AM',
    );
  });
});
