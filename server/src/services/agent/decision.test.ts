import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { parseAgentDecision, validateAgentDecision } from './decision.js';

const validCategorize = {
  kind: 'categorize',
  taxCalculation: 'TaxInclusive',
  lines: [
    {
      grossAmount: -29,
      categoryQboId: 'acct-software',
      taxCodeQboId: 'tax-gst',
      memo: 'Monthly plan',
    },
  ],
  rationale: 'Recurring software vendor and matching prior entries.',
  evidence: ['Payee history: 8 verified matches'],
  confidence: 0.98,
} as const;

describe('AgentDecision schema', () => {
  it.each([
    validCategorize,
    {
      kind: 'transfer',
      counterpartTransactionId: 'txn-2',
      rationale: 'Opposite bank movement on the same date.',
      evidence: ['Equal and opposite amount'],
      confidence: 0.99,
    },
    {
      kind: 'skip',
      reasonCode: 'NEEDS_RECEIPT',
      rationale: 'The payee is ambiguous.',
      requestedContext: ['receipt'],
    },
  ])('accepts a strict %s decision', (decision) => {
    expect(parseAgentDecision(decision)).toEqual(decision);
  });

  it.each([
    [{ ...validCategorize, proseCategory: 'Software' }, /unrecognized/i],
    [{ ...validCategorize, confidence: 1.1 }, /less than or equal/i],
    [{ ...validCategorize, lines: [{ ...validCategorize.lines[0], grossAmount: -29.001 }] }, /decimal/i],
    [{ ...validCategorize, lines: [{ ...validCategorize.lines[0], categoryQboId: '' }] }, /too_small/i],
    [{ ...validCategorize, rationale: 'x'.repeat(2_001) }, /too_big/i],
    [{ ...validCategorize, evidence: Array.from({ length: 21 }, () => 'x') }, /too_big/i],
  ])('rejects malformed or oversized decisions', (decision, pattern) => {
    expect(() => parseAgentDecision(decision)).toThrow(pattern);
  });
});

function validationDb(options: {
  updatedAt?: Date;
  category?: string | null;
  taxCalculation?: string | null;
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  amount?: number;
  payee?: string;
  memo?: string | null;
  accountCompanyMatch?: boolean;
  counterpart?: null | { id: string; amount: number; bankAccount: string; date: Date };
  transferCandidates?: Array<{ id: string; amount: number; bankAccount: string; date: Date }>;
}) {
  const updatedAt = options.updatedAt ?? new Date('2026-07-23T12:00:00Z');
  const row = {
    id: 'txn-1',
    companyId: 'co-1',
    qboType: 'Purchase',
    status: 'PENDING',
    updatedAt,
    category: options.category ?? null,
    taxCalculation: options.taxCalculation ?? null,
    taxCode: options.taxCode ?? null,
    taxCodeQboId: options.taxCodeQboId ?? null,
    splitLines: [],
    txnTags: [],
    amount: options.amount ?? -29,
    payee: options.payee ?? 'Webflow',
    memo: options.memo ?? null,
    bankAccount: 'Visa',
    date: new Date('2026-07-23'),
    company: { holdingAccountIds: ['holding-1'] },
  };
  return {
    transaction: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(row)
        .mockResolvedValue(options.counterpart ?? null),
      findMany: vi.fn(async () => options.transferCandidates ?? []),
    },
    qboAccount: {
      findMany: vi.fn(async () =>
        options.accountCompanyMatch === false
          ? []
          : [
              {
                qboId: 'acct-software',
                name: 'Software',
                fullName: 'Expenses · Software',
                active: true,
                classification: 'Expense',
                accountType: 'Expense',
              },
            ],
      ),
    },
    qboTaxCode: {
      findMany: vi.fn(async () => [
        {
          qboId: 'tax-gst',
          name: 'GST 5%',
          active: true,
          taxable: true,
          purchaseTaxRateList: [{ taxRateQboId: 'rate-gst' }],
        },
      ]),
    },
  } as unknown as PrismaClient;
}

describe('validateAgentDecision', () => {
  const context = {
    companyId: 'co-1',
    transactionId: 'txn-1',
    expectedUpdatedAt: new Date('2026-07-23T12:00:00Z'),
  };

  it('resolves company-owned account and tax IDs for a valid Purchase decision', async () => {
    await expect(
      validateAgentDecision(validationDb({}), context, parseAgentDecision(validCategorize)),
    ).resolves.toMatchObject({
      ok: true,
      code: 'AGENT_VALID',
      resolvedLines: [
        {
          categoryQboId: 'acct-software',
          category: 'Software',
          taxCodeQboId: 'tax-gst',
        },
      ],
    });
  });

  it('rejects any intervening transaction edit and human staging before account lookup', async () => {
    await expect(
      validateAgentDecision(
        validationDb({ updatedAt: new Date('2026-07-23T12:01:00Z') }),
        context,
        parseAgentDecision(validCategorize),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_STALE_INPUT',
    });
    await expect(
      validateAgentDecision(
        validationDb({ category: 'Human choice' }),
        context,
        parseAgentDecision(validCategorize),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_HUMAN_STAGED' });
    await expect(
      validateAgentDecision(
        validationDb({ taxCodeQboId: 'tax-human' }),
        context,
        parseAgentDecision(validCategorize),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_HUMAN_STAGED' });
  });

  it('rejects cross-company/disallowed accounts and gross mismatch', async () => {
    await expect(
      validateAgentDecision(
        validationDb({ accountCompanyMatch: false }),
        context,
        parseAgentDecision(validCategorize),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_ACCOUNT_INVALID' });
    await expect(
      validateAgentDecision(
        validationDb({}),
        context,
        parseAgentDecision({
          ...validCategorize,
          lines: [{ ...validCategorize.lines[0], grossAmount: -28 }],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_GROSS_MISMATCH' });
  });

  it('keeps Purchase refunds and credits in human review', async () => {
    await expect(
      validateAgentDecision(
        validationDb({ amount: 29 }),
        context,
        parseAgentDecision({
          ...validCategorize,
          lines: [{ ...validCategorize.lines[0], grossAmount: 29 }],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_REFUND_REVIEW_REQUIRED' });
  });

  it('keeps payroll-like purchases in human review', async () => {
    const db = validationDb({});
    vi.mocked(db.transaction.findFirst).mockReset().mockResolvedValue({
      id: 'txn-1',
      companyId: 'co-1',
      qboType: 'Purchase',
      status: 'PENDING',
      updatedAt: new Date('2026-07-23T12:00:00Z'),
      category: null,
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
      splitLines: [],
      txnTags: [],
      amount: -2900,
      bankAccount: 'Checking',
      date: new Date('2026-07-23'),
      payee: 'ADP PAYROLL',
      company: { holdingAccountIds: ['holding-1'] },
    } as never);

    await expect(
      validateAgentDecision(db, context, parseAgentDecision(validCategorize)),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_PAYROLL_REVIEW_REQUIRED' });
    expect(db.qboAccount.findMany).not.toHaveBeenCalled();
  });

  it('keeps payroll markers in generic bank-feed memos in human review', async () => {
    const db = validationDb({
      payee: 'ACH DEBIT',
      memo: 'GUSTO PAYROLL 2026-07-23',
      amount: -2900,
    });

    await expect(
      validateAgentDecision(db, context, parseAgentDecision(validCategorize)),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_PAYROLL_REVIEW_REQUIRED' });
    expect(db.qboAccount.findMany).not.toHaveBeenCalled();
  });

  it('keeps apparent transfers in human review even when the model categorizes them', async () => {
    const db = validationDb({
      transferCandidates: [
        {
          id: 'txn-2',
          amount: 29,
          bankAccount: 'Checking',
          date: new Date('2026-07-22'),
        },
      ],
    });

    await expect(
      validateAgentDecision(db, context, parseAgentDecision(validCategorize)),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_TRANSFER_REVIEW_REQUIRED' });
    expect(db.qboAccount.findMany).not.toHaveBeenCalled();
  });

  it('rejects a credit-card destination so transfers cannot masquerade as categories', async () => {
    const db = validationDb({});
    vi.mocked(db.qboAccount.findMany).mockResolvedValue([
      {
        id: 'qbo-account-row',
        companyId: 'co-1',
        qboId: 'acct-software',
        name: 'Corporate Visa',
        fullName: 'Corporate Visa',
        active: true,
        classification: 'CreditCard',
        accountType: 'Credit Card',
        updatedAt: new Date('2026-07-23T12:00:00Z'),
      },
    ]);

    await expect(
      validateAgentDecision(db, context, parseAgentDecision(validCategorize)),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_ACCOUNT_INVALID' });
  });

  it('reuses transfer invariants and company scope', async () => {
    const counterpart = {
      id: 'txn-2',
      amount: 29,
      bankAccount: 'Checking',
      date: new Date('2026-07-23'),
    };
    const decision = parseAgentDecision({
      kind: 'transfer',
      counterpartTransactionId: 'txn-2',
      rationale: 'Equal opposite movement.',
      evidence: ['same date'],
      confidence: 0.99,
    });
    await expect(
      validateAgentDecision(validationDb({ counterpart }), context, decision),
    ).resolves.toMatchObject({ ok: true, transferCounterpartId: 'txn-2' });
  });
});
