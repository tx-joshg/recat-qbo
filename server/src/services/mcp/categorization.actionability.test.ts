import { describe, expect, it, vi } from 'vitest';
import type { CategorizationProposal, StageCategorizationInput } from '@recat/shared';
import type { McpPrincipal } from '../../mcp/auth.js';
import type { CategorizationStagingWorkflow } from '../categorization.js';
import {
  prepareMcpCategorization,
  type McpCategorizationDeps,
  type PrepareMcpCategorizationInput,
} from './categorization.js';

const NOW = new Date('2026-08-30T18:00:00.000Z');
const principal: McpPrincipal = {
  tokenId: '11111111-1111-4111-8111-111111111111',
  tokenPrefix: 'rct_example1',
  userId: '22222222-2222-4222-8222-222222222222',
  isInstanceAdmin: false,
  memberships: [{ companyId: '33333333-3333-4333-8333-333333333333', role: 'categorizer' }],
};
const companyId = principal.memberships[0]!.companyId;
const transactionId = '44444444-4444-4444-8444-444444444444';
const proposal: CategorizationProposal = {
  taxCalculation: 'NotApplicable',
  lines: [{ grossCents: -100, categoryQboId: 'account-1', tagIds: [] }],
  tagIds: [],
};

describe('MCP prepare provider actionability gate', () => {
  it('allows a legacy cleared transaction through the prepare gate', async () => {
    const operationLookup = vi.fn().mockResolvedValue(null);
    const createOperation = vi.fn();
    const current = {
      id: transactionId,
      companyId,
      revision: 0,
      qboSyncToken: '7',
      qboType: 'Purchase',
      qboId: 'qbo-1',
      date: '2026-08-01',
    };
    const store = {
      mcpToken: {
        findFirst: vi.fn().mockResolvedValue({
          id: principal.tokenId,
          user: { isInstanceAdmin: false },
        }),
      },
      company: { findUnique: vi.fn().mockResolvedValue({ disconnectedAt: null }) },
      membership: { findUnique: vi.fn().mockResolvedValue({ role: 'categorizer' }) },
      transaction: { findFirst: vi.fn().mockResolvedValue(current) },
      transactionActionability: {
        findUnique: vi.fn().mockResolvedValue({
          companyId,
          transactionId,
          disposition: 'BLOCKED_CLEARED',
          checkedAt: NOW,
          revision: 0,
          qboSyncToken: '7',
          qboType: 'Purchase',
          qboId: 'qbo-1',
          txnDate: '2026-08-01',
          bankAccountQboId: 'bank-1',
          bookCloseDate: null,
          cleared: true,
          reconciled: false,
          unavailableCode: null,
          unavailableReason: null,
        }),
      },
      mcpOperation: { findFirst: operationLookup },
    };
    const stage = vi.fn(async <T>(
      input: StageCategorizationInput,
      workflow: CategorizationStagingWorkflow<T>,
    ) => workflow.beforeValidation(store as never, input));
    const deps: McpCategorizationDeps = {
      stage: stage as never,
      authorizationStore: store as never,
      createOperation: createOperation as never,
      now: () => NOW,
    };
    const input: PrepareMcpCategorizationInput = {
      companyId,
      transactionId,
      expectedRevision: 0,
      idempotencyKey: 'prepare-blocked',
      proposal,
    };

    await expect(prepareMcpCategorization(principal, input, deps))
      .resolves.toEqual({ kind: 'continue' });
    expect(stage).toHaveBeenCalledTimes(1);
    expect(operationLookup).toHaveBeenCalledTimes(1);
    expect(createOperation).not.toHaveBeenCalled();
  });
});
