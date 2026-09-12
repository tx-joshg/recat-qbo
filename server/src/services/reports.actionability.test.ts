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
    transactionActionability: {},
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

describe('dashboardData provider status counts', () => {
  it('reports only transactions that belong in the interactive queue', async () => {
    const checkedAt = new Date();
    const date = new Date('2026-04-02T00:00:00.000Z');
    const row = (id: string, amount: number, disposition: string) => ({
      id,
      companyId: 'company-1',
      revision: 2,
      qboSyncToken: '0',
      qboType: 'Purchase',
      qboId: id,
      date,
      amount,
      providerActionability: {
        companyId: 'company-1',
        transactionId: id,
        disposition,
        checkedAt,
        revision: 2,
        qboSyncToken: '0',
        qboType: 'Purchase',
        qboId: id,
        txnDate: date,
      },
    });
    mocks.transactionFindMany.mockResolvedValue([
      row('writable', -125, 'WRITABLE'),
      row('unknown', 75, 'UNKNOWN'),
      row('cleared', -50, 'BLOCKED_CLEARED'),
      row('closed', -900, 'BLOCKED_PERIOD_CLOSED'),
      { ...row('stale', -100, 'BLOCKED_PERIOD_CLOSED'), qboSyncToken: 'changed' },
    ]);
    mocks.qboGetStatement.mockResolvedValue(monthlyStatement());

    const result = await dashboardData('company-1');

    expect(result.pendingCount).toBe(4);
    expect(result.pendingTotal).toBe(350);
  });

});
