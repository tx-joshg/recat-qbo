// MockQboClient — in-memory "Intuit" used when QBO_MOCK=true.
//
// Two realms mirror the design prototype's demo data exactly
// (design_handoff_recat/Recat.dc.html): Harbor & Main Coffee Co. and
// Bluebird Salon LLC. State is a module-level singleton so it survives across
// requests within one server process, and it is MUTABLE: recategorize moves a
// txn's lines out of the holding account, moveToAccount puts them back,
// createTransfer records an entity, and every write bumps the SyncToken —
// stale tokens throw QboSyncTokenConflict just like the real API.

import {
  QboSyncTokenConflict,
  type QboAccountInfo,
  type QboAccountTxn,
  type QboClient,
  type QboCompanyInfo,
  type QboStatement,
  type QboTokenSet,
  type QboTxn,
  type QboWriteResult,
} from './types.js';

export const MOCK_REALM_HARBOR = '9341002287640001';
export const MOCK_REALM_BLUEBIRD = '4471889011230002';

// ---------------------------------------------------------------------------
// Realm state
// ---------------------------------------------------------------------------

interface MockAccount {
  qboId: string;
  name: string;
  /** normalized bucket (Income | COGS | Expenses | Bank | CreditCard) */
  classification: string;
  accountType: string;
  /** colon path, per QBO FullyQualifiedName convention */
  fullName: string;
}

interface MockLine {
  id: string;
  /** positive, QBO line convention */
  amount: number;
  accountQboId: string;
  memo?: string;
}

interface MockTxnEntity {
  qboId: string;
  qboType: QboTxn['qboType'];
  syncToken: number;
  date: string; // YYYY-MM-DD
  payee: string;
  memo?: string;
  /** signed; + = money in */
  amount: number;
  bankAccountQboId: string;
  /** ALL category-side lines; writes replace only the holding-account ones */
  lines: MockLine[];
  lastUpdated: string; // ISO
  deleted?: boolean;
}

interface MockTransfer {
  qboId: string;
  amount: number;
  fromAccountQboId: string;
  toAccountQboId: string;
  date: string;
  memo?: string;
  lastUpdated: string;
}

export interface MockRealm {
  realmId: string;
  legalName: string;
  accounts: MockAccount[];
  txns: MockTxnEntity[];
  transfers: MockTransfer[];
  nextId: number;
}

function acct(qboId: string, name: string, classification: string, accountType: string): MockAccount {
  // Bank/credit-card/holding accounts are top-level in QBO, so their
  // FullyQualifiedName is just the name; category accounts get a group path.
  const grouped = classification === 'Income' || classification === 'COGS' || classification === 'Expenses';
  const holding = name === 'Ask My Accountant' || name.startsWith('Uncategorized');
  return {
    qboId,
    name,
    classification,
    accountType,
    fullName: grouped && !holding ? `${classification}:${name}` : name,
  };
}

interface TxnSeed {
  id: string;
  type: QboTxn['qboType'];
  date: string;
  payee: string;
  memo: string;
  amount: number;
  bankId: string;
}

function seedTxn(seed: TxnSeed, holdingId: string): MockTxnEntity {
  return {
    qboId: seed.id,
    qboType: seed.type,
    syncToken: 0,
    date: seed.date,
    payee: seed.payee,
    memo: seed.memo || undefined,
    amount: seed.amount,
    bankAccountQboId: seed.bankId,
    // Every pending demo txn sits in 'Ask My Accountant', exactly as in the
    // prototype.
    lines: [{ id: '1', amount: Math.abs(seed.amount), accountQboId: holdingId }],
    lastUpdated: `${seed.date}T08:00:00.000Z`,
  };
}

function buildHarborRealm(): MockRealm {
  const accounts: MockAccount[] = [
    acct('1', 'Checking ·4821', 'Bank', 'Bank'),
    acct('2', 'Visa ·0392', 'CreditCard', 'Credit Card'),
    acct('3', 'Savings ·9917', 'Bank', 'Bank'),
    acct('4', 'Ask My Accountant', 'Expenses', 'Other Expense'),
    acct('5', 'Uncategorized Expense', 'Expenses', 'Other Expense'),
    acct('6', 'Uncategorized Income', 'Income', 'Other Income'),
    acct('7', 'Sales — food', 'Income', 'Income'),
    acct('8', 'Sales — beverage', 'Income', 'Income'),
    acct('9', 'Catering income', 'Income', 'Income'),
    acct('10', 'Food purchases', 'COGS', 'Cost of Goods Sold'),
    acct('11', 'Beverage purchases', 'COGS', 'Cost of Goods Sold'),
    acct('12', 'Packaging & supplies', 'COGS', 'Cost of Goods Sold'),
    acct('13', 'Advertising & marketing', 'Expenses', 'Expense'),
    acct('14', 'Bank fees', 'Expenses', 'Expense'),
    acct('15', 'Equipment rental', 'Expenses', 'Expense'),
    acct('16', 'Insurance', 'Expenses', 'Expense'),
    acct('17', 'Meals & entertainment', 'Expenses', 'Expense'),
    acct('18', 'Merchant fees', 'Expenses', 'Expense'),
    acct('19', 'Office supplies', 'Expenses', 'Expense'),
    acct('20', 'Payroll wages', 'Expenses', 'Expense'),
    acct('21', 'Payroll taxes', 'Expenses', 'Expense'),
    acct('22', 'Professional services', 'Expenses', 'Expense'),
    acct('23', 'Rent', 'Expenses', 'Expense'),
    acct('24', 'Repairs & maintenance', 'Expenses', 'Expense'),
    acct('25', 'Software subscriptions', 'Expenses', 'Expense'),
    acct('26', 'Utilities', 'Expenses', 'Expense'),
    acct('27', 'Vehicle fuel', 'Expenses', 'Expense'),
  ];
  const HOLDING = '4'; // Ask My Accountant
  const seeds: TxnSeed[] = [
    { id: '1', type: 'Deposit', date: '2026-06-30', payee: 'SQ *SQUARE INC', memo: 'Daily card settlement', amount: 1842.5, bankId: '1' },
    { id: '2', type: 'Purchase', date: '2026-07-01', payee: 'SYSCO FOODS #212', memo: 'Weekly order', amount: -486.12, bankId: '1' },
    { id: '3', type: 'Purchase', date: '2026-07-01', payee: 'SHELL OIL 5742', memo: '', amount: -52.4, bankId: '2' },
    { id: '4', type: 'Purchase', date: '2026-07-02', payee: 'AMZN MKTP US*2K4', memo: 'Espresso machine gaskets', amount: -128.99, bankId: '2' },
    { id: '5', type: 'Purchase', date: '2026-07-03', payee: 'GUSTO PAYROLL', memo: '', amount: -3214.77, bankId: '1' },
    { id: '6', type: 'Purchase', date: '2026-07-05', payee: 'WEBFLOW.COM', memo: '', amount: -29.0, bankId: '2' },
    { id: '7', type: 'Purchase', date: '2026-07-07', payee: 'TST* THE LOCAL TAP', memo: '', amount: -84.6, bankId: '2' },
    { id: '8', type: 'Purchase', date: '2026-07-08', payee: 'USPS PO 4471', memo: '', amount: -18.4, bankId: '2' },
    { id: '9', type: 'Purchase', date: '2026-07-09', payee: 'COMCAST BUSINESS', memo: '', amount: -149.85, bankId: '1' },
    { id: '10', type: 'Deposit', date: '2026-07-10', payee: 'SQ *SQUARE INC', memo: 'Daily card settlement', amount: 2103.2, bankId: '1' },
    { id: '11', type: 'Purchase', date: '2026-07-11', payee: 'ULINE SHIP SUPPLIES', memo: '', amount: -212.06, bankId: '2' },
    { id: '12', type: 'Deposit', date: '2026-07-12', payee: 'STRIPE PAYOUT', memo: '', amount: 640.0, bankId: '1' },
    { id: '17', type: 'Purchase', date: '2026-07-13', payee: 'ONLINE TRANSFER REF #8841', memo: 'Card payment', amount: -750.0, bankId: '1' },
    { id: '18', type: 'Deposit', date: '2026-07-13', payee: 'ONLINE TRANSFER REF #8841', memo: 'Card payment', amount: 750.0, bankId: '2' },
  ];
  return {
    realmId: MOCK_REALM_HARBOR,
    legalName: 'Harbor & Main Coffee Co.',
    accounts,
    txns: seeds.map((s) => seedTxn(s, HOLDING)),
    transfers: [],
    nextId: 1000,
  };
}

function buildBluebirdRealm(): MockRealm {
  const accounts: MockAccount[] = [
    acct('1', 'Checking ·7702', 'Bank', 'Bank'),
    acct('2', 'Visa ·5518', 'CreditCard', 'Credit Card'),
    acct('3', 'Ask My Accountant', 'Expenses', 'Other Expense'),
    acct('4', 'Uncategorized Expense', 'Expenses', 'Other Expense'),
    acct('5', 'Uncategorized Income', 'Income', 'Other Income'),
    acct('6', 'Service revenue', 'Income', 'Income'),
    acct('7', 'Retail sales', 'Income', 'Income'),
    acct('8', 'Salon supplies', 'COGS', 'Cost of Goods Sold'),
    acct('9', 'Retail products', 'COGS', 'Cost of Goods Sold'),
    acct('10', 'Advertising & marketing', 'Expenses', 'Expense'),
    acct('11', 'Education & training', 'Expenses', 'Expense'),
    acct('12', 'Insurance', 'Expenses', 'Expense'),
    acct('13', 'Laundry & linens', 'Expenses', 'Expense'),
    acct('14', 'Merchant fees', 'Expenses', 'Expense'),
    acct('15', 'Payroll wages', 'Expenses', 'Expense'),
    acct('16', 'Rent', 'Expenses', 'Expense'),
    acct('17', 'Software subscriptions', 'Expenses', 'Expense'),
    acct('18', 'Utilities', 'Expenses', 'Expense'),
  ];
  const HOLDING = '3'; // Ask My Accountant
  const seeds: TxnSeed[] = [
    { id: '13', type: 'Deposit', date: '2026-07-09', payee: 'SQ *SQUARE INC', memo: 'Daily card settlement', amount: 987.4, bankId: '1' },
    { id: '14', type: 'Purchase', date: '2026-07-10', payee: 'SALLY BEAUTY 442', memo: 'Color stock', amount: -214.3, bankId: '1' },
    { id: '15', type: 'Purchase', date: '2026-07-11', payee: 'CINTAS CORP', memo: 'Towel service', amount: -89.0, bankId: '1' },
    { id: '16', type: 'Purchase', date: '2026-07-12', payee: 'META ADS', memo: 'July boost', amount: -150.0, bankId: '2' },
  ];
  return {
    realmId: MOCK_REALM_BLUEBIRD,
    legalName: 'Bluebird Salon LLC',
    accounts,
    txns: seeds.map((s) => seedTxn(s, HOLDING)),
    transfers: [],
    nextId: 1000,
  };
}

function buildRealms(): Map<string, MockRealm> {
  return new Map([
    [MOCK_REALM_HARBOR, buildHarborRealm()],
    [MOCK_REALM_BLUEBIRD, buildBluebirdRealm()],
  ]);
}

// Module-level singleton — one fake Intuit per server process. Mutations are
// additionally persisted to the database (AppConfig `mock:realm:<realmId>`)
// so demo state stays coherent across server restarts and between the seed
// process and the dev server. Persistence is best-effort and disabled under
// tests (pure in-memory there).
let realms = buildRealms();
let hydrated = false;

function persistenceEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.VITEST === undefined;
}

const realmKey = (realmId: string) => `mock:realm:${realmId}`;

/** Load persisted realm mutations once per process (lazy, best-effort). */
export async function ensureMockRealmsHydrated(): Promise<void> {
  if (hydrated || !persistenceEnabled()) return;
  hydrated = true;
  try {
    const { prisma } = await import('../prisma.js');
    for (const realmId of [MOCK_REALM_HARBOR, MOCK_REALM_BLUEBIRD]) {
      const row = await prisma.appConfig.findUnique({ where: { key: realmKey(realmId) } });
      if (row) realms.set(realmId, JSON.parse(row.value) as MockRealm);
    }
  } catch (err) {
    console.warn('[mock-qbo] could not hydrate persisted realm state:', err);
  }
}

/** Write-through after a mutation (best-effort). */
export async function persistMockRealm(realmId: string): Promise<void> {
  if (!persistenceEnabled()) return;
  try {
    const { prisma } = await import('../prisma.js');
    const value = JSON.stringify(realms.get(realmId));
    await prisma.appConfig.upsert({
      where: { key: realmKey(realmId) },
      create: { key: realmKey(realmId), value, encrypted: false },
      update: { value },
    });
  } catch (err) {
    console.warn('[mock-qbo] could not persist realm state:', err);
  }
}

export function getMockRealm(realmId: string): MockRealm {
  const realm = realms.get(realmId);
  if (!realm) {
    throw new Error(
      `Unknown mock realm "${realmId}" — mock mode only knows ${MOCK_REALM_HARBOR} (Harbor & Main) and ${MOCK_REALM_BLUEBIRD} (Bluebird Salon)`,
    );
  }
  return realm;
}

/** Reset all mock realm state (tests). */
export function resetMockRealms(): void {
  realms = buildRealms();
  hydrated = false;
}

// ---------------------------------------------------------------------------
// Mock OAuth
// ---------------------------------------------------------------------------

/**
 * Mock consent URL — relative on purpose; the routes layer renders a fake
 * consent page at this path and redirects back to /auth/qbo/callback.
 */
export function mockAuthorizeUrl(state: string): string {
  return `/auth/qbo/mock-consent?state=${encodeURIComponent(state)}`;
}

/**
 * Which realm a mock auth code connects: 'mock-harbor' / 'mock-bluebird' pick
 * explicitly; anything else connects Harbor first, then Bluebird.
 */
export function resolveMockRealmId(code: string, connectedRealmIds: string[]): string {
  if (code === 'mock-harbor') return MOCK_REALM_HARBOR;
  if (code === 'mock-bluebird') return MOCK_REALM_BLUEBIRD;
  return connectedRealmIds.includes(MOCK_REALM_HARBOR) ? MOCK_REALM_BLUEBIRD : MOCK_REALM_HARBOR;
}

export function mockTokenSet(): QboTokenSet {
  return {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class MockQboClient implements QboClient {
  readonly realmId: string;
  private readonly holdingIds: ReadonlySet<string>;

  constructor(realmId: string, holdingAccountQboIds: string[]) {
    // Validates eagerly so a bad Company row fails loudly at construction.
    getMockRealm(realmId);
    this.realmId = realmId;
    this.holdingIds = new Set(holdingAccountQboIds);
  }

  private get realm(): MockRealm {
    return getMockRealm(this.realmId);
  }

  private accountById(qboId: string): MockAccount | undefined {
    return this.realm.accounts.find((a) => a.qboId === qboId);
  }

  /**
   * Mirror the real client's mapping: QboTxn.lines is ONLY the lines posting
   * to `filterIds` (holding accounts), and amount is the signed sum of those
   * lines — not the entity total.
   */
  private toQboTxn(e: MockTxnEntity, filterIds: ReadonlySet<string>): QboTxn {
    const holdingLines = e.lines.filter((l) => filterIds.has(l.accountQboId));
    const sum = round2(holdingLines.reduce((a, l) => a + l.amount, 0));
    return {
      qboId: e.qboId,
      qboType: e.qboType,
      syncToken: String(e.syncToken),
      date: e.date,
      payee: e.payee,
      memo: e.memo,
      // Keep the entity's natural sign (+ = money in).
      amount: e.amount < 0 ? -sum : sum,
      bankAccount: this.accountById(e.bankAccountQboId)?.name ?? '',
      lines: holdingLines.map((l) => ({
        id: l.id,
        amount: l.amount,
        accountQboId: l.accountQboId,
        accountName: this.accountById(l.accountQboId)?.name ?? '',
        memo: l.memo,
      })),
      raw: JSON.parse(JSON.stringify(e)) as unknown,
    };
  }

  private findEntity(qboType: QboTxn['qboType'], qboId: string): MockTxnEntity | undefined {
    return this.realm.txns.find((t) => t.qboType === qboType && t.qboId === qboId && !t.deleted);
  }

  // ---- reads ----

  async getCompanyInfo(): Promise<QboCompanyInfo> {
    await ensureMockRealmsHydrated();
    return { realmId: this.realmId, legalName: this.realm.legalName };
  }

  async listAccounts(): Promise<QboAccountInfo[]> {
    await ensureMockRealmsHydrated();
    return this.realm.accounts.map((a) => ({
      qboId: a.qboId,
      name: a.name,
      fullName: a.fullName,
      classification: a.classification,
      accountType: a.accountType,
      active: true,
    }));
  }

  async listTxnsInAccounts(accountQboIds: string[]): Promise<QboTxn[]> {
    await ensureMockRealmsHydrated();
    // Like the real client: the caller's ids (not the instance holding set)
    // are the line filter, so the setup wizard can probe candidate accounts.
    const ids = new Set(accountQboIds);
    return this.realm.txns
      .filter((t) => !t.deleted && t.lines.some((l) => ids.has(l.accountQboId)))
      .map((t) => this.toQboTxn(t, ids));
  }

  async changedSince(isoTimestamp: string): Promise<{ txns: QboTxn[]; deletedQboIds: { qboType: string; qboId: string }[] }> {
    await ensureMockRealmsHydrated();
    const since = Date.parse(isoTimestamp);
    const changed = this.realm.txns.filter((t) => Date.parse(t.lastUpdated) > since);
    return {
      txns: changed.filter((t) => !t.deleted).map((t) => this.toQboTxn(t, this.holdingIds)),
      deletedQboIds: changed.filter((t) => t.deleted).map((t) => ({ qboType: t.qboType, qboId: t.qboId })),
    };
  }

  async fetchTxn(qboType: QboTxn['qboType'], qboId: string): Promise<QboTxn | null> {
    await ensureMockRealmsHydrated();
    const entity = this.findEntity(qboType, qboId);
    return entity ? this.toQboTxn(entity, this.holdingIds) : null;
  }

  async getStatement(): Promise<QboStatement> {
    // Demo statements are synthesized in services/reports.ts from the seeded
    // series (demo:plBases / demo:bs) so every screen matches the design
    // prototype — the service never routes here in mock mode.
    throw new Error('MockQboClient.getStatement is not used in mock mode — demo statements come from services/reports.ts');
  }

  async getAccountTransactions(params: {
    accountQboId: string;
    startDate: string;
    endDate: string;
  }): Promise<QboAccountTxn[]> {
    await ensureMockRealmsHydrated();
    // Entities whose CATEGORY lines post to the account within the range —
    // i.e. what a categorization already moved there. Demo P&L rows without a
    // mirrored entity return [] (expected demo artifact before posts).
    return this.realm.txns
      .filter(
        (t) =>
          !t.deleted &&
          t.date >= params.startDate &&
          t.date <= params.endDate &&
          t.lines.some((l) => l.accountQboId === params.accountQboId),
      )
      .map((t) => {
        const sum = round2(
          t.lines.reduce((a, l) => (l.accountQboId === params.accountQboId ? a + l.amount : a), 0),
        );
        return {
          date: t.date,
          payee: t.payee,
          ...(t.memo !== undefined ? { memo: t.memo } : {}),
          // Keep the entity's natural sign (+ = money in), like toQboTxn.
          amount: t.amount < 0 ? -sum : sum,
          txnType: t.qboType,
          qboId: t.qboId,
        };
      });
  }

  // ---- writes (all bump SyncToken; stale tokens conflict, like real QBO) ----

  /**
   * Shared write path mirroring RealQboClient.replaceLines: replace ONLY the
   * lines posting to `replaceIds`, preserving every other line verbatim.
   */
  private replaceLines(
    txn: QboTxn,
    replaceIds: ReadonlySet<string>,
    newLines: { amount: number; accountQboId: string; memo?: string }[],
  ): QboWriteResult {
    const entity = this.findEntity(txn.qboType, txn.qboId);
    if (!entity) throw new Error(`Mock QBO: ${txn.qboType} ${txn.qboId} not found`);
    if (String(entity.syncToken) !== txn.syncToken) throw new QboSyncTokenConflict();
    for (const s of newLines) {
      if (!this.accountById(s.accountQboId)) {
        throw new Error(`Mock QBO: unknown account id "${s.accountQboId}" in realm ${this.realmId}`);
      }
    }
    const keep = entity.lines.filter((l) => !replaceIds.has(l.accountQboId));
    entity.lines = [
      ...keep,
      ...newLines.map((s, i) => ({
        id: String(keep.length + i + 1),
        amount: round2(Math.abs(s.amount)),
        accountQboId: s.accountQboId,
        memo: s.memo,
      })),
    ];
    entity.syncToken += 1;
    entity.lastUpdated = new Date().toISOString();
    return { ok: true, newSyncToken: String(entity.syncToken) };
  }

  async recategorize(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
  ): Promise<QboWriteResult> {
    await ensureMockRealmsHydrated();
    const result = this.replaceLines(txn, this.holdingIds, splits);
    await persistMockRealm(this.realmId);
    return result;
  }

  async moveToAccount(txn: QboTxn, accountQboId: string, fromAccountQboIds: string[]): Promise<QboWriteResult> {
    await ensureMockRealmsHydrated();
    const replaceIds = new Set(fromAccountQboIds);
    const entity = this.findEntity(txn.qboType, txn.qboId);
    if (!entity) throw new Error(`Mock QBO: ${txn.qboType} ${txn.qboId} not found`);
    const sum = round2(
      entity.lines.reduce((a, l) => (replaceIds.has(l.accountQboId) ? a + l.amount : a), 0),
    );
    if (sum <= 0) {
      throw new Error(
        'Undo found no lines posting to the previously chosen categories — this transaction was edited in QuickBooks. Verify it there.',
      );
    }
    const result = this.replaceLines(txn, replaceIds, [{ amount: sum, accountQboId }]);
    await persistMockRealm(this.realmId);
    return result;
  }

  async createTransfer(args: {
    amount: number;
    fromAccountQboId: string;
    toAccountQboId: string;
    date: string;
    memo?: string;
  }): Promise<{ qboId: string }> {
    await ensureMockRealmsHydrated();
    const realm = this.realm;
    const qboId = `transfer-${realm.nextId++}`;
    realm.transfers.push({
      qboId,
      amount: round2(Math.abs(args.amount)),
      fromAccountQboId: args.fromAccountQboId,
      toAccountQboId: args.toAccountQboId,
      date: args.date,
      memo: args.memo,
      lastUpdated: new Date().toISOString(),
    });
    await persistMockRealm(this.realmId);
    return { qboId };
  }
}
