import { describe, expect, it, vi } from 'vitest';
import { classificationSearchForCompany } from './classificationSearch.js';

describe('classificationSearchForCompany', () => {
  it('rejects a non-canonical injected dependency result at the outer boundary', async () => {
    const bound = classificationSearchForCompany('company-a', async () => ({ hits: [] }));
    await expect(bound({
      query: 'Coffee', mode: 'auto', limit: 1,
      transaction: {
        transactionId: 'transaction-a', date: '2026-08-31', signedAmountCents: -1,
        currency: 'CAD', sourceAccountName: null, payee: 'Coffee', memo: null,
        transactionDirection: 'out', qboType: null, transactionPeriod: '2026-08',
        jurisdiction: null, taxStatus: 'ready',
      },
    })).rejects.toThrow('Check the classification request');
  });
  it('binds internal-agent search to the job company and current-company scope', async () => {
    const search = vi.fn(async () => ({
      query: 'Coffee', companyId: 'company-a', scope: 'current_company',
      mode: 'lexical', requestedMode: 'auto', degraded: true,
      degradedReason: 'semantic_unavailable', status: 'matched', noMatch: false,
      hits: [{
        id: 'historical_observation:observation-a', sourceId: 'observation-a',
        kind: 'historical_observation', companyId: 'company-a', companyName: 'Company A',
        companyRelation: 'current', executable: false, advisory: true,
        matchedIn: ['observation'], score: 1, vendorIdentityId: null, vendorName: 'Coffee',
        action: null,
        actionSummary: { categoryName: 'Meals', taxCalculation: 'NotApplicable', taxCodeName: null, tagNames: [] },
        originIntent: null, evidenceCount: 0, conflictingEvidenceCount: 0, conflicts: [],
        provenance: {
          source: 'historical_observation', sourceId: 'observation-a', actorId: null,
          recordedAt: '2026-08-31T00:00:00.000Z',
        },
        rationale: null, examples: [], counterexamples: [], jurisdiction: null, currency: 'CAD',
        verifiedAt: null, ruleRevision: null,
        observation: {
          sourceTransactionId: 'transaction-history', sourceQboType: 'Purchase',
          sourceQboId: 'purchase-history', sourceTransactionRevision: 1, sourceQboSyncToken: '1',
          sourceStatus: 'POSTED', sourceUpdatedAt: '2026-08-31T00:00:00.000Z',
          observedAt: '2026-08-31T00:00:00.000Z',
        },
      }], total: 1,
    }));
    const bound = classificationSearchForCompany('company-a', search);

    const result = await bound({
      query: 'Coffee',
      mode: 'auto',
      limit: 12,
      transaction: {
        transactionId: 'transaction-a',
        date: '2026-08-31',
        signedAmountCents: -1_200,
        currency: 'CAD',
        sourceAccountName: null,
        payee: 'Coffee shop',
        memo: null,
        transactionDirection: 'out',
        qboType: null,
        transactionPeriod: '2026-08',
        jurisdiction: null,
        taxStatus: 'ready',
      },
    });

    expect(search).toHaveBeenCalledWith({
      query: 'Coffee',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'auto',
      limit: 12,
      accessibleCompanyIds: ['company-a'],
      excludeTransactionId: 'transaction-a',
      context: {
        transactionDirection: 'out',
        currency: 'CAD',
        transactionPeriod: '2026-08',
      },
    });
    expect(result.hits).toEqual([expect.objectContaining({
      kind: 'historical_observation', advisory: true, executable: false, action: null,
    })]);
  });
});
