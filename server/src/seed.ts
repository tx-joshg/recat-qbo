// Demo seed — run with `npm run seed -w server` and QBO_MOCK=true.
//
// Idempotent (safe to re-run): creates the demo team, connects both mock
// realms, seeds tags/rules, runs the real initial sync against the mock
// QuickBooks so Transactions mirror the mock realm, then layers on the
// prototype's txn extras, audit entries, sync log, and the demo financial
// series used by dashboard/reports in mock mode.

import { Prisma } from '@prisma/client';
import { prisma } from './lib/prisma.js';
import { env } from './env.js';
import { MockQboClient, MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from './lib/qbo/mock.js';
import { syncCompany } from './services/sync.js';

if (!env.QBO_MOCK) {
  console.error('The demo seed only makes sense in mock mode — set QBO_MOCK=true and re-run.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function upsertUser(email: string, name: string, isInstanceAdmin: boolean, invitePending = false) {
  return prisma.user.upsert({
    where: { email },
    create: { email, name, isInstanceAdmin, invitePending },
    update: { name, isInstanceAdmin, invitePending },
  });
}

async function upsertMembership(userId: string, companyId: string, role: 'admin' | 'categorizer' | 'viewer') {
  await prisma.membership.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId, role },
    update: { role },
  });
}

async function findOrCreateTag(companyId: string, name: string, color: string) {
  const existing = await prisma.tag.findFirst({ where: { companyId, name } });
  if (existing) return existing;
  return prisma.tag.create({ data: { companyId, name, color } });
}

async function tagTxn(companyId: string, qboType: string, qboId: string, tagIds: string[]) {
  const txn = await prisma.transaction.findUnique({
    where: { companyId_qboType_qboId: { companyId, qboType, qboId } },
  });
  if (!txn) {
    console.warn(`seed: txn ${qboType}/${qboId} not found for tagging`);
    return;
  }
  for (const tagId of tagIds) {
    await prisma.txnTag.upsert({
      where: { txnId_tagId: { txnId: txn.id, tagId } },
      create: { txnId: txn.id, tagId },
      update: {},
    });
  }
}

async function upsertAppConfig(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await prisma.appConfig.upsert({
    where: { key },
    create: { key, value: json, encrypted: false },
    update: { value: json },
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Seeding demo data (mock QuickBooks)…');

  // ---- team ----
  // Josh runs the instance (isInstanceAdmin) AND carries an explicit admin
  // membership in both companies; Maria categorizes and Dana views everywhere.
  const josh = await upsertUser('josh@harbormain.coffee', 'Josh M.', true);
  const maria = await upsertUser('maria@harbormain.coffee', 'Maria K.', false);
  const dana = await upsertUser('dana@harbormain.coffee', 'Dana W.', false, true);

  // ---- companies (both mock realms "connected") ----
  // Holding accounts = the mock realm's 'Ask My Accountant' + 'Uncategorized
  // Expense' ids (see mock.ts account tables).
  const harbor = await prisma.company.upsert({
    where: { realmId: MOCK_REALM_HARBOR },
    create: {
      realmId: MOCK_REALM_HARBOR,
      legalName: 'Harbor & Main Coffee Co.',
      nickname: 'Harbor & Main Coffee',
      env: 'sandbox',
      syncMode: 'polling',
      pollIntervalMin: 10,
      holdingAccountIds: ['4', '5'],
      dryRun: true,
      tagsRequired: false,
    },
    update: {
      legalName: 'Harbor & Main Coffee Co.',
      nickname: 'Harbor & Main Coffee',
      holdingAccountIds: ['4', '5'],
      disconnectedAt: null,
    },
  });
  const bluebird = await prisma.company.upsert({
    where: { realmId: MOCK_REALM_BLUEBIRD },
    create: {
      realmId: MOCK_REALM_BLUEBIRD,
      legalName: 'Bluebird Salon LLC',
      nickname: 'Bluebird Salon',
      env: 'sandbox',
      syncMode: 'polling',
      pollIntervalMin: 10,
      holdingAccountIds: ['3', '4'],
      dryRun: true,
      tagsRequired: false,
    },
    update: {
      legalName: 'Bluebird Salon LLC',
      nickname: 'Bluebird Salon',
      holdingAccountIds: ['3', '4'],
      disconnectedAt: null,
    },
  });

  // ---- memberships (per-company roles) ----
  for (const company of [harbor, bluebird]) {
    await upsertMembership(josh.id, company.id, 'admin');
    await upsertMembership(maria.id, company.id, 'categorizer');
    await upsertMembership(dana.id, company.id, 'viewer');
  }

  // ---- tags (per prototype) ----
  const foodTruck = await findOrCreateTag(harbor.id, 'Food truck', '#8a6d1f');
  const catering = await findOrCreateTag(harbor.id, 'Catering', '#3e5c76');
  const reimbursable = await findOrCreateTag(harbor.id, 'Reimbursable', '#a13b2e');
  await findOrCreateTag(harbor.id, '2nd location', '#7d5ba6');
  await findOrCreateTag(bluebird.id, 'Booth rental', '#3e5c76');
  const retail = await findOrCreateTag(bluebird.id, 'Retail', '#8a6d1f');

  // ---- rules (per prototype; category ids from the mock chart of accounts) ----
  const syscoRule =
    (await prisma.rule.findFirst({ where: { companyId: harbor.id, matchText: 'SYSCO' } })) ??
    (await prisma.rule.create({
      data: {
        companyId: harbor.id,
        matchField: 'payee',
        matchText: 'SYSCO',
        category: 'Food purchases',
        categoryQboId: '10',
        autoPost: false,
        createdById: josh.id,
      },
    }));
  await prisma.ruleTag.upsert({
    where: { ruleId_tagId: { ruleId: syscoRule.id, tagId: foodTruck.id } },
    create: { ruleId: syscoRule.id, tagId: foodTruck.id },
    update: {},
  });
  const cintasRule = await prisma.rule.findFirst({ where: { companyId: bluebird.id, matchText: 'CINTAS' } });
  if (!cintasRule) {
    await prisma.rule.create({
      data: {
        companyId: bluebird.id,
        matchField: 'payee',
        matchText: 'CINTAS',
        category: 'Laundry & linens',
        categoryQboId: '13',
        autoPost: false,
        createdById: josh.id,
      },
    });
  }

  // ---- initial sync (mirrors the mock realms into Transactions) ----
  console.log('Running initial sync for both companies…');
  await syncCompany(harbor.id, 'initial');
  await syncCompany(bluebird.id, 'initial');

  // ---- prototype txn extras ----
  // History-source suggestion snapshots per the prototype's demo data
  // (`suggest:` fields). The live pipeline can't derive these — the demo has
  // no posted history for these payees — so they're seeded and preserved by
  // refreshSuggestions until real history supersedes them.
  const seedSuggestion = async (
    companyId: string,
    qboType: string,
    qboId: string,
    category: string,
  ): Promise<void> => {
    const acct = await prisma.qboAccount.findFirst({ where: { companyId, name: category } });
    await prisma.transaction.updateMany({
      where: { companyId, qboType, qboId, status: 'PENDING' },
      data: {
        suggestion: { category, categoryQboId: acct?.qboId, source: 'history' } as Prisma.InputJsonValue,
      },
    });
  };
  await seedSuggestion(harbor.id, 'Deposit', '1', 'Sales — beverage'); // SQ *SQUARE INC
  await seedSuggestion(harbor.id, 'Purchase', '9', 'Utilities'); // COMCAST BUSINESS
  await seedSuggestion(harbor.id, 'Deposit', '10', 'Sales — beverage'); // SQ *SQUARE INC
  await seedSuggestion(harbor.id, 'Purchase', '11', 'Packaging & supplies'); // ULINE
  await seedSuggestion(bluebird.id, 'Deposit', '13', 'Service revenue'); // SQ co2
  await seedSuggestion(bluebird.id, 'Purchase', '14', 'Salon supplies'); // SALLY BEAUTY

  await tagTxn(harbor.id, 'Purchase', '2', [foodTruck.id]); // SYSCO
  await tagTxn(harbor.id, 'Purchase', '4', [reimbursable.id]); // AMZN
  await tagTxn(harbor.id, 'Deposit', '10', [catering.id]); // SQ settlement
  await tagTxn(harbor.id, 'Purchase', '11', [foodTruck.id]); // ULINE
  await tagTxn(bluebird.id, 'Purchase', '14', [retail.id]); // SALLY BEAUTY

  // T6 WEBFLOW.COM — already POSTED as 'Software subscriptions'. We move it in
  // the mock realm too (the audit trail for it is seeded below, matching the
  // prototype), so the mock books stay consistent with the local status.
  const webflow = await prisma.transaction.findUnique({
    where: { companyId_qboType_qboId: { companyId: harbor.id, qboType: 'Purchase', qboId: '6' } },
  });
  if (webflow) {
    const harborClient = new MockQboClient(MOCK_REALM_HARBOR, ['4', '5']);
    const fresh = await harborClient.fetchTxn('Purchase', '6');
    let syncToken = webflow.qboSyncToken;
    if (fresh) {
      const stillHolding = fresh.lines.some((l) => l.accountQboId === '4' || l.accountQboId === '5');
      if (stillHolding) {
        const result = await harborClient.recategorize(fresh, [
          { amount: Number(webflow.amount), accountQboId: '25' }, // Software subscriptions
        ]);
        syncToken = result.newSyncToken;
      } else {
        syncToken = fresh.syncToken;
      }
    }
    await prisma.transaction.update({
      where: { id: webflow.id },
      data: {
        status: 'POSTED',
        category: 'Software subscriptions',
        categoryQboId: '25',
        qboSyncToken: syncToken,
        postedAt: new Date('2026-07-12T09:41:00'),
        postedByUserId: maria.id,
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  // T7 TST* THE LOCAL TAP — stuck in ERROR with a SyncToken conflict.
  await prisma.transaction.updateMany({
    where: { companyId: harbor.id, qboType: 'Purchase', qboId: '7' },
    data: {
      status: 'ERROR',
      category: 'Meals & entertainment',
      categoryQboId: '17',
      errorCode: 'SYNC_TOKEN_CONFLICT',
      errorMessage: 'SyncToken conflict — this transaction was edited in QuickBooks after our last sync.',
    },
  });

  // ---- audit entries (prototype lines 1005–1013, mapped to 2026 dates) ----
  const localTap = await prisma.transaction.findUnique({
    where: { companyId_qboType_qboId: { companyId: harbor.id, qboType: 'Purchase', qboId: '7' } },
  });
  const auditSeed: {
    companyId: string;
    at: Date;
    actorId: string | null;
    actorLabel: string;
    txnId: string | null;
    payee: string;
    amount: number;
    action: string;
    before: string;
    after: string;
  }[] = [
    { companyId: harbor.id, at: new Date('2026-07-12T09:41:00'), actorId: maria.id, actorLabel: 'Maria K.', txnId: webflow?.id ?? null, payee: 'WEBFLOW.COM', amount: -29.0, action: 'posted', before: 'Ask My Accountant', after: 'Expenses · Software subscriptions' },
    { companyId: harbor.id, at: new Date('2026-07-11T16:12:00'), actorId: josh.id, actorLabel: 'Josh M.', txnId: localTap?.id ?? null, payee: 'TST* THE LOCAL TAP', amount: -84.6, action: 'error', before: 'Ask My Accountant', after: 'Expenses · Meals & entertainment' },
    { companyId: harbor.id, at: new Date('2026-07-10T09:02:00'), actorId: maria.id, actorLabel: 'Maria K.', txnId: null, payee: 'COSTCO WHSE #1123', amount: -96.4, action: 'posted', before: 'Ask My Accountant', after: 'COGS · Packaging & supplies' },
    { companyId: harbor.id, at: new Date('2026-07-09T02:00:00'), actorId: null, actorLabel: 'system', txnId: null, payee: 'CHEVRON 00234', amount: -61.15, action: 'superseded', before: 'Ask My Accountant', after: 'fixed inside QuickBooks' },
    { companyId: harbor.id, at: new Date('2026-07-08T11:20:00'), actorId: maria.id, actorLabel: 'Maria K.', txnId: null, payee: 'ULINE SHIP SUPPLIES', amount: -187.22, action: 'dry-run', before: 'Ask My Accountant', after: 'COGS · Packaging & supplies' },
    { companyId: bluebird.id, at: new Date('2026-07-07T15:30:00'), actorId: josh.id, actorLabel: 'Josh M.', txnId: null, payee: 'CINTAS CORP', amount: -89.0, action: 'posted', before: 'Ask My Accountant', after: 'Expenses · Laundry & linens' },
    { companyId: bluebird.id, at: new Date('2026-07-05T10:12:00'), actorId: josh.id, actorLabel: 'Josh M.', txnId: null, payee: 'SALLY BEAUTY 442', amount: -167.85, action: 'posted', before: 'Ask My Accountant', after: 'COGS · Salon supplies' },
  ];
  for (const entry of auditSeed) {
    const exists = await prisma.auditEntry.findFirst({
      where: { companyId: entry.companyId, payee: entry.payee, action: entry.action, at: entry.at },
    });
    if (exists) continue;
    await prisma.auditEntry.create({
      data: {
        companyId: entry.companyId,
        at: entry.at,
        actorId: entry.actorId,
        actorLabel: entry.actorLabel,
        txnId: entry.txnId,
        payee: entry.payee,
        amount: new Prisma.Decimal(entry.amount),
        action: entry.action,
        before: entry.before,
        after: entry.after,
      },
    });
  }

  // ---- sync log (prototype lines 1019–1024, relative times from "now") ----
  const now = Date.now();
  const today = new Date();
  const at = (h: number, m: number, daysAgo = 0) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, h, m);
  const syncLogSeed = [
    { companyId: harbor.id, kind: 'poll', ok: true, message: '2 new transactions, 1 dropped (categorized in QBO)', at: new Date(now - 4 * 60 * 1000) },
    { companyId: harbor.id, kind: 'manual', ok: true, message: 'Chart of accounts refreshed — 42 accounts', at: at(8, 14) },
    { companyId: harbor.id, kind: 'nightly', ok: true, message: 'Full reconcile — no drift', at: at(2, 0) },
    { companyId: harbor.id, kind: 'poll', ok: false, message: 'Token expired; refreshed and retried OK', at: at(18, 40, 1) },
  ];
  for (const entry of syncLogSeed) {
    const exists = await prisma.syncLog.findFirst({
      where: { companyId: entry.companyId, kind: entry.kind, message: entry.message },
    });
    if (exists) continue;
    await prisma.syncLog.create({ data: entry });
  }

  // ---- demo financial series (prototype lines 1044–1065) — read by the
  //      reports service in mock mode ----
  await upsertAppConfig(`demo:fin:${harbor.id}`, {
    months: ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
    rev: [38.2, 41.5, 44.1, 47.9, 52.3, 24.6],
    exp: [31.4, 33.0, 35.2, 36.8, 39.1, 19.8],
    breakdown: [['Payroll wages', 8.1], ['Rent', 4.2], ['Food purchases', 3.4], ['Beverage purchases', 1.8], ['Utilities', 1.1]],
    pl: { income: 24.6, cogs: 7.2, expenses: 12.6 },
  });
  await upsertAppConfig(`demo:fin:${bluebird.id}`, {
    months: ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
    rev: [18.4, 19.2, 21.0, 20.6, 22.8, 11.2],
    exp: [14.1, 14.8, 15.5, 15.9, 16.6, 8.4],
    breakdown: [['Payroll wages', 4.6], ['Rent', 1.9], ['Salon supplies', 1.1], ['Advertising & marketing', 0.5], ['Utilities', 0.3]],
    pl: { income: 11.2, cogs: 1.9, expenses: 6.5 },
  });
  await upsertAppConfig(`demo:plBases:${harbor.id}`, {
    'Sales — food': 28.0, 'Sales — beverage': 19.5, 'Catering income': 4.0,
    'Food purchases': 9.8, 'Beverage purchases': 4.6, 'Packaging & supplies': 1.6,
    'Advertising & marketing': 0.9, 'Bank fees': 0.2, 'Equipment rental': 0.6,
    'Insurance': 0.7, 'Meals & entertainment': 0.3, 'Merchant fees': 1.4,
    'Office supplies': 0.3, 'Payroll wages': 11.5, 'Payroll taxes': 1.2,
    'Professional services': 0.5, 'Rent': 4.2, 'Repairs & maintenance': 0.6,
    'Software subscriptions': 0.4, 'Utilities': 1.1, 'Vehicle fuel': 0.3,
  });
  await upsertAppConfig(`demo:plBases:${bluebird.id}`, {
    'Service revenue': 16.5, 'Retail sales': 4.8,
    'Salon supplies': 2.1, 'Retail products': 1.4,
    'Advertising & marketing': 0.5, 'Education & training': 0.3, 'Insurance': 0.4,
    'Laundry & linens': 0.4, 'Merchant fees': 0.7, 'Payroll wages': 7.6,
    'Rent': 3.1, 'Software subscriptions': 0.3, 'Utilities': 0.5,
  });
  await upsertAppConfig(`demo:bs:${harbor.id}`, {
    assets: [['Checking ·4821', 24.5, 1.8], ['Savings ·9917', 40.0, 0.5], ['Undeposited funds', 2.1, 0.1], ['Equipment, net of depreciation', 18.6, -0.3]],
    liab: [['Visa ·0392 (credit card)', 3.2, 0.15], ['Payroll liabilities', 2.4, 0.05], ['Sales tax payable', 1.1, 0.08]],
    equity: [['Owner contributions', 30.0], ['Retained earnings', 38.0]],
  });
  await upsertAppConfig(`demo:bs:${bluebird.id}`, {
    assets: [['Checking ·7702', 12.2, 0.9], ['Undeposited funds', 0.8, 0.05], ['Salon equipment, net', 9.4, -0.15]],
    liab: [['Visa ·5518 (credit card)', 1.6, 0.1], ['Payroll liabilities', 1.2, 0.03], ['Sales tax payable', 0.5, 0.04]],
    equity: [['Owner contributions', 12.0], ['Retained earnings', 6.5]],
  });

  const txnCount = await prisma.transaction.count();
  console.log(`Seed complete: 3 users, 2 companies, ${txnCount} transactions.`);
  console.log('Log in as josh@harbormain.coffee (admin) or maria@harbormain.coffee (categorizer).');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
