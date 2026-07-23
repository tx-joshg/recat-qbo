import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  test: vi.fn(),
  ruleCandidates: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  rules: {
    list: mocks.list,
    create: mocks.create,
    test: mocks.test,
  },
  autopilot: {
    ruleCandidates: mocks.ruleCandidates,
  },
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    accounts: [
      {
        id: 'account-1',
        qboId: '42',
        name: 'Web Hosting',
        fullName: 'Expenses · Web Hosting',
        classification: 'Expenses',
        active: true,
      },
    ],
    tags: [
      { id: 'tag-ops', name: 'Operations', color: '#2f5d50' },
      { id: 'tag-ca', name: 'Canada', color: '#b7791f' },
    ],
    taxCodes: [],
    taxProfile: {
      status: 'unsupported',
      usingSalesTax: false,
      lastRefreshedAt: null,
      reason: null,
    },
    role: 'admin',
    toast: mocks.toast,
  }),
}));

import Rules from './Rules';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.ruleCandidates.mockResolvedValue([]);
  mocks.create.mockResolvedValue({
    id: 'rule-1',
    companyId: 'company-1',
    matchText: 'digital ocean',
    category: 'Web Hosting',
    categoryQboId: '42',
    tagIds: ['tag-ops'],
    autoPost: false,
    priority: 0,
    taxCalculation: null,
    taxCode: null,
    taxCodeQboId: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  });
});

describe('Rules new-rule tags', () => {
  it('selects tags in the add row and sends them with the new rule', async () => {
    const user = userEvent.setup();
    render(<Rules />);

    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('company-1'));
    await user.type(screen.getByPlaceholderText('Payee contains…'), 'digital ocean');
    await user.selectOptions(screen.getByRole('combobox'), 'Web Hosting');
    await user.click(screen.getByRole('button', { name: 'Tags for new rule' }));
    await user.click(screen.getByRole('button', { name: 'Operations' }));

    expect(screen.getByRole('button', { name: 'Tags for new rule' })).toHaveTextContent(
      'Operations',
    );
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith('company-1', {
        matchText: 'digital ocean',
        category: 'Web Hosting',
        categoryQboId: '42',
        tagIds: ['tag-ops'],
        autoPost: false,
      }),
    );
  });
});
