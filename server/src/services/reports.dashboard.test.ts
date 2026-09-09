import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QboStatement } from '../lib/qbo/types.js';

const mocks = vi.hoisted(() => ({
  appConfigFindUnique: vi.fn(),
  qboAccountFindMany: vi.fn(),
  qboGetStatement: vi.fn(),
  transactionFindMany: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    appConfig: { findUnique: mocks.appConfigFindUnique },
    qboAccount: { findMany: mocks.qboAccountFindMany },
    transaction: { findMany: mocks.transactionFindMany },
  },
}));

vi.mock('../lib/qbo/factory.js', () => ({
  isMockRealmId: vi.fn(),
  qboFactory: {
    forCompany: vi.fn(async () => ({ getStatement: mocks.qboGetStatement })),
  },
}));

let dashboardData: typeof import('./reports.js').dashboardData;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.appConfigFindUnique.mockResolvedValue(null);
  mocks.qboAccountFindMany.mockResolvedValue([]);
  mocks.transactionFindMany.mockResolvedValue([]);
  ({ dashboardData } = await import('./reports.js'));
});

function monthlyStatement(): QboStatement {
  return {
    columns: [
      { label: 'Apr 2026' },
      { label: 'May 2026' },
      { label: 'Jun 2026' },
      { label: 'Jul 2026' },
      { label: 'Aug 2026' },
      { label: 'Sep 2026' },
      { label: 'Total' },
    ],
    rows: [
      { label: 'Total Income', kind: 'total', indent: false, values: [100, 200, 300, 400, 500, 600, 2100] },
      {
        label: 'Total Cost of Goods Sold',
        kind: 'total',
        indent: false,
        values: [10, 20, 30, 40, 50, 60, 210],
      },
      { label: 'Net Income', kind: 'grand', indent: false, values: [50, 100, 150, 200, 250, 300, 1050] },
    ],
  };
}

describe('dashboardData provenance', () => {
  it('labels complete QBO dashboard data', async () => {
    mocks.appConfigFindUnique.mockResolvedValue(null);
    mocks.transactionFindMany.mockResolvedValue([]);
    mocks.qboGetStatement.mockResolvedValue(monthlyStatement());

    const result = await dashboardData('company-1');

    expect(result.source).toBe('quickbooks');
    expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.rev).toHaveLength(6);
  });

  it('labels zero local fallback after QBO failure', async () => {
    mocks.appConfigFindUnique.mockResolvedValue(null);
    mocks.transactionFindMany.mockResolvedValue([]);
    mocks.qboGetStatement.mockRejectedValue(new Error('RAW_QBO_BODY_SENTINEL'));
    mocks.qboAccountFindMany.mockResolvedValue([]);

    const result = await dashboardData('company-1');

    expect(result.source).toBe('local_fallback');
    expect(result.rev).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.exp).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('does not manufacture a zero dashboard when local fallback fails', async () => {
    mocks.appConfigFindUnique.mockResolvedValue(null);
    mocks.transactionFindMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('LOCAL_DATABASE_SENTINEL'));
    mocks.qboGetStatement.mockRejectedValue(new Error('RAW_QBO_BODY_SENTINEL'));

    await expect(dashboardData('company-1')).rejects.toThrow('LOCAL_DATABASE_SENTINEL');
  });
});
