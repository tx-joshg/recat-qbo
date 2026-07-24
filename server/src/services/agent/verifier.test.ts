import { describe, expect, it } from 'vitest';
import { FakeAgentModel } from './fakeModel.js';
import type { AgentToolContext } from './context.js';
import { runVerifier, verifierResultSchema } from './verifier.js';

const context: AgentToolContext = {
  schemaVersion: 'recat-agent-context-v1',
  companyId: 'co-1',
  transactionId: 'txn-1',
  expectedUpdatedAt: new Date('2026-07-23T10:00:00Z'),
  transaction: {
    id: 'txn-1',
    qboType: 'Purchase',
    qboSyncToken: '2',
    date: '2026-07-23T00:00:00.000Z',
    payee: 'Webflow',
    memo: 'Monthly plan',
    amount: -29,
    bankAccount: 'Visa',
  },
  holdingAccountQboIds: ['holding-1'],
  originalLines: [],
};

const proposed = {
  kind: 'categorize' as const,
  taxCalculation: 'TaxInclusive' as const,
  lines: [{ grossAmount: -29, categoryQboId: 'software', taxCodeQboId: 'gst' }],
  rationale: 'Recurring software.',
  evidence: ['Payee history'],
  confidence: 0.98,
};
const validation = {
  ok: true,
  code: 'AGENT_VALID',
  message: 'valid',
  checkedAt: '2026-07-23T10:00:01.000Z',
  resolvedLines: [
    {
      grossAmount: -29,
      categoryQboId: 'software',
      category: 'Expenses · Software',
      taxCodeQboId: 'gst',
      taxCode: 'GST 5%',
    },
  ],
};

describe('runVerifier', () => {
  it('records an independent structured agreement without mutation tools', async () => {
    const model = new FakeAgentModel([
      { kind: 'decision', value: { verdict: 'agree', rationale: 'Matches repeated history.' } },
    ]);

    await expect(runVerifier(model, context, proposed, validation, new AbortController().signal)).resolves.toEqual({
      verdict: 'agree',
      rationale: 'Matches repeated history.',
    });
    expect(model.inputs[0]?.tools).toEqual([]);
    expect(model.inputs[0]?.transaction).toMatchObject({
      proposed,
      resolvedDecision: {
        resolvedLines: [
          expect.objectContaining({
            category: 'Expenses · Software',
            categoryQboId: 'software',
            taxCode: 'GST 5%',
            taxCodeQboId: 'gst',
          }),
        ],
      },
    });
  });

  it('requires a complete correction with a correction verdict', () => {
    expect(
      verifierResultSchema.safeParse({ verdict: 'correction', rationale: 'Wrong tax code.' }).success,
    ).toBe(false);
    expect(
      verifierResultSchema.safeParse({
        verdict: 'disagree',
        rationale: 'Insufficient evidence.',
        correction: proposed,
      }).success,
    ).toBe(false);
  });
});
