// Demo financial series — the design prototype's dashboard/report numbers
// (prototype lines 1044–1065), stored per company as AppConfig rows
// (`demo:fin/plBases/bs:<companyId>`) and read by services/reports.ts.
//
// Installed in two places: the local demo seed (seed.ts) and the OAuth
// callback when a demo company is connected through the wizard — so any
// deployment that adds a demo company gets the full dashboard/reports
// experience, not just the queue.

import { prisma } from '../lib/prisma.js';
import { MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from '../lib/qbo/mock.js';

interface DemoSeries {
  fin: unknown;
  plBases: unknown;
  bs: unknown;
}

const SERIES: Record<string, DemoSeries> = {
  [MOCK_REALM_HARBOR]: {
    fin: {
      months: ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
      rev: [38.2, 41.5, 44.1, 47.9, 52.3, 24.6],
      exp: [31.4, 33.0, 35.2, 36.8, 39.1, 19.8],
      breakdown: [['Payroll wages', 8.1], ['Rent', 4.2], ['Food purchases', 3.4], ['Beverage purchases', 1.8], ['Utilities', 1.1]],
      pl: { income: 24.6, cogs: 7.2, expenses: 12.6 },
    },
    plBases: {
      'Sales — food': 28.0, 'Sales — beverage': 19.5, 'Catering income': 4.0,
      'Food purchases': 9.8, 'Beverage purchases': 4.6, 'Packaging & supplies': 1.6,
      'Advertising & marketing': 0.9, 'Bank fees': 0.2, 'Equipment rental': 0.6,
      'Insurance': 0.7, 'Meals & entertainment': 0.3, 'Merchant fees': 1.4,
      'Office supplies': 0.3, 'Payroll wages': 11.5, 'Payroll taxes': 1.2,
      'Professional services': 0.5, 'Rent': 4.2, 'Repairs & maintenance': 0.6,
      'Software subscriptions': 0.4, 'Utilities': 1.1, 'Vehicle fuel': 0.3,
    },
    bs: {
      assets: [['Checking ·4821', 24.5, 1.8], ['Savings ·9917', 40.0, 0.5], ['Undeposited funds', 2.1, 0.1], ['Equipment, net of depreciation', 18.6, -0.3]],
      liab: [['Visa ·0392 (credit card)', 3.2, 0.15], ['Payroll liabilities', 2.4, 0.05], ['Sales tax payable', 1.1, 0.08]],
      equity: [['Owner contributions', 30.0], ['Retained earnings', 38.0]],
    },
  },
  [MOCK_REALM_BLUEBIRD]: {
    fin: {
      months: ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
      rev: [18.4, 19.2, 21.0, 20.6, 22.8, 11.2],
      exp: [14.1, 14.8, 15.5, 15.9, 16.6, 8.4],
      breakdown: [['Payroll wages', 4.6], ['Rent', 1.9], ['Salon supplies', 1.1], ['Advertising & marketing', 0.5], ['Utilities', 0.3]],
      pl: { income: 11.2, cogs: 1.9, expenses: 6.5 },
    },
    plBases: {
      'Service revenue': 16.5, 'Retail sales': 4.8,
      'Salon supplies': 2.1, 'Retail products': 1.4,
      'Advertising & marketing': 0.5, 'Education & training': 0.3, 'Insurance': 0.4,
      'Laundry & linens': 0.4, 'Merchant fees': 0.7, 'Payroll wages': 7.6,
      'Rent': 3.1, 'Software subscriptions': 0.3, 'Utilities': 0.5,
    },
    bs: {
      assets: [['Checking ·7702', 12.2, 0.9], ['Undeposited funds', 0.8, 0.05], ['Salon equipment, net', 9.4, -0.15]],
      liab: [['Visa ·5518 (credit card)', 1.6, 0.1], ['Payroll liabilities', 1.2, 0.03], ['Sales tax payable', 0.5, 0.04]],
      equity: [['Owner contributions', 12.0], ['Retained earnings', 6.5]],
    },
  },
};

async function upsertAppConfig(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await prisma.appConfig.upsert({
    where: { key },
    create: { key, value: json, encrypted: false },
    update: { value: json },
  });
}

/**
 * Install the demo financial series for one connected demo company.
 * Idempotent (upserts). No-op for a non-mock realmId.
 */
export async function installDemoFinancials(companyId: string, realmId: string): Promise<void> {
  const series = SERIES[realmId];
  if (!series) return;
  await upsertAppConfig(`demo:fin:${companyId}`, series.fin);
  await upsertAppConfig(`demo:plBases:${companyId}`, series.plBases);
  await upsertAppConfig(`demo:bs:${companyId}`, series.bs);
}
