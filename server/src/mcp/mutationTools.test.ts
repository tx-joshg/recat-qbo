import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MUTATION_TOOL_NAMES,
  type McpMutationOperations,
} from './mutationTools.js';
import { createRecatMcpServer } from './readTools.js';

const principal = Object.freeze({
  tokenId: 'token-a',
  tokenPrefix: 'rct_SAFE',
  userId: 'user-a',
  isInstanceAdmin: false,
  memberships: Object.freeze([{
    companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'categorizer',
  }]),
});
const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const transactionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const undoOperationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const counterpartTransactionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const transferOperationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const preparedCategorization = {
  operationId,
  expiresAt: '2026-07-29T20:15:00.000Z',
  sourceRevision: 2,
  preparedRevision: 3,
  preview: {
    transactionId,
    revision: 3,
    taxDisposition: 'set' as const,
    taxCalculation: 'TaxInclusive' as const,
    totals: {
      subtotalCents: -1_000,
      taxCents: -50,
      totalCents: -1_050,
    },
    lines: [{
      idx: 0,
      subtotalCents: -1_000,
      taxCents: -50,
      totalCents: -1_050,
      categoryQboId: 'expense-account',
      taxCodeQboId: 'tax-code',
    }],
    transactionTagCount: 1,
    lineTagCount: 1,
  },
  warnings: [],
};

const operation = {
  operationId,
  kind: 'categorization' as const,
  companyId,
  transactionId,
  sourceRevision: 2,
  preparedRevision: 3,
  expiresAt: '2026-07-29T20:15:00.000Z',
  state: 'prepared' as const,
  phase: 'awaiting_commit' as const,
  result: null,
  error: null,
  actions: {
    canCommit: true,
    canRetry: false,
    requiresReconciliation: false,
  },
};

const preparedUndo = {
  operationId: undoOperationId,
  sourceOperationId: operationId,
  expiresAt: '2026-07-29T20:15:00.000Z',
  preview: {
    action: 'restore_purchase_categorization' as const,
    resultingStatus: 'PENDING' as const,
    direction: 'purchase' as const,
    totalCents: -1_050,
    totalTaxCents: -50,
    lineCount: 1,
    restorationDigest: 'a'.repeat(64),
  },
  warnings: [],
};

const preparedTransfer = {
  operationId: transferOperationId,
  expiresAt: '2026-07-29T20:15:00.000Z',
  preview: {
    action: 'record_transfer' as const,
    direction: 'between_accounts' as const,
    totalCents: 1_050,
    legCount: 2 as const,
    preparationDigest: 'b'.repeat(64),
  },
};

const transferOperation = {
  operationId: transferOperationId,
  kind: 'transfer' as const,
  expiresAt: '2026-07-29T20:15:00.000Z',
  state: 'prepared' as const,
  phase: 'awaiting_commit' as const,
  result: {
    complete: false,
    firstLeg: { outcome: 'IN_PROGRESS' as const },
    secondLeg: { outcome: 'IN_PROGRESS' as const },
  },
  error: null,
  actions: {
    canCommit: true,
    canRetry: false,
    requiresReconciliation: false,
  },
};

const preparedTaxRefund = {
  operationId: '77777777-7777-4777-8777-777777777777',
  expiresAt: '2026-09-04T22:15:00.000Z',
  capability: 'manual_required' as const,
  preview: {
    action: 'record_gst_hst_refund' as const,
    operatorPath: 'Sales Tax > Filed > Record refund' as const,
    sourceDepositQboId: 'TEST-DEPOSIT-1',
    taxAgencyQboId: 'CRA',
    filedReturnRef: '2025-Q4',
    filingEvidenceSha256: 'a'.repeat(64),
    suspenseAccountQboId: '55',
    bankAccountQboId: 'BANK-1',
    refundDate: '2026-01-15',
    principalCents: 123_456,
    interestCents: 0,
    interestAccountQboId: null,
    totalBankCreditCents: 123_456,
    existingDepositTreatment: 'replace_or_match_before_verification' as const,
  },
  warnings: [
    'Manual QuickBooks Tax Centre action required; preparation does not post the refund.',
  ],
};

const cancelledTaxRefund = {
  operationId: preparedTaxRefund.operationId,
  state: 'cancelled' as const,
  cancelledAt: '2026-09-04T22:05:00.000Z',
};

const acknowledgedTaxRefund = {
  operationId: preparedTaxRefund.operationId,
  state: 'reconciliation_required' as const,
  manualRecordedAt: '2026-09-04T22:06:00.000Z',
};

const ruleOperationId = '11111111-1111-4111-8111-111111111111';
const ruleId = '22222222-2222-4222-8222-222222222222';


const rulePreview = {
  operationId: ruleOperationId,
  companyId,
  ruleId,
  candidateId: null,
  mutation: 'create' as const,
  originIntent: 'make_recurring' as const,
  currentRevision: 0,
  proposedRevision: 1,
  condition: { matchField: 'payee' as const, matchText: 'Harbour Supply' },
  direction: 'Purchase' as const,
  action: {
    categoryQboId: 'expense-account',
    taxCalculation: 'NotApplicable' as const,
    taxCodeQboId: null,
    tagIds: [],
  },
  categoryName: 'Operating expense',
  taxCodeName: null,
  autoPost: false,
  affectedPendingCount: 1,
  affectedProcessedCount: 0,
  sampleTransactions: [],
  conflicts: [],
  warnings: [],
  expiresAt: '2026-08-31T20:15:00.000Z',
  preparationDigest: 'c'.repeat(64),
};

const preparedRuleChange = {
  ok: true,
  operationId: ruleOperationId,
  companyId,
  mutation: 'create' as const,
  originIntent: 'make_recurring' as const,
  status: 'PREPARED' as const,
  ruleId,
  revision: 1,
  rule: null,
  candidate: null,
  preview: rulePreview,
  error: null,
};

const committedRuleChange = {
  ...preparedRuleChange,
  status: 'COMMITTED' as const,
  rule: {
    id: '33333333-3333-4333-8333-333333333333',
    ruleId,
    companyId,
    revision: 1,
    state: 'enabled' as const,
    condition: rulePreview.condition,
    direction: rulePreview.direction,
    action: { ...rulePreview.action, version: 2 as const, direction: rulePreview.direction, category: rulePreview.categoryName },
    taxCodeName: null,
    autoPost: false,
    originIntent: 'make_recurring' as const,
    sourceCaseId: null,
    sourceCandidateId: null,
    changedBy: principal.userId,
    createdAt: '2026-08-31T20:01:00.000Z',
    repairReason: null,
    affectedJournalEntryCount: 0,
  },
};

function mutations(
  overrides: Partial<McpMutationOperations> = {},
): McpMutationOperations {
  return {
    prepareCategorization: vi.fn().mockResolvedValue(preparedCategorization),
    getPreparedCategorization: vi.fn().mockResolvedValue(preparedCategorization),
    commitCategorization: vi.fn().mockResolvedValue(operation),
    getOperation: vi.fn().mockResolvedValue(operation),
    retryOperation: vi.fn().mockResolvedValue(operation),
    prepareUndo: vi.fn().mockResolvedValue(preparedUndo),
    commitUndo: vi.fn().mockResolvedValue({
      ...operation,
      operationId: undoOperationId,
      kind: 'undo',
    }),
    prepareTransfer: vi.fn().mockResolvedValue(preparedTransfer),
    commitTransfer: vi.fn().mockResolvedValue(transferOperation),
    prepareTaxRefund: vi.fn().mockResolvedValue(preparedTaxRefund),
    cancelTaxRefund: vi.fn().mockResolvedValue(cancelledTaxRefund),
    acknowledgeTaxRefundRecorded: vi.fn().mockResolvedValue(acknowledgedTaxRefund),
    prepareRuleChange: vi.fn().mockResolvedValue(preparedRuleChange),
    commitRuleChange: vi.fn().mockResolvedValue(committedRuleChange),
    ...overrides,
  };
}

async function legacy(
  handler: ReturnType<typeof createMcpHandler>,
  method: string,
  params: object,
): Promise<Record<string, any>> {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : text;
  return JSON.parse(payload ?? '') as Record<string, any>;
}

function handler(
  operations: McpMutationOperations,
  log = vi.fn(),
): ReturnType<typeof createMcpHandler> {
  return createMcpHandler(
    () => createRecatMcpServer({
      principal,
      era: 'legacy',
      mutations: operations,
      requestId: 'safe-request-id',
      log,
    }),
    { legacy: 'stateless' },
  );
}

describe('Recat MCP mutation tools', () => {
  it('exposes a strict manual-required GST/HST refund preparation', async () => {
    const operations = mutations();
    const server = handler(operations);
    const request = {
      companyId,
      transactionId,
      expectedRevision: 0,
      idempotencyKey: 'example-refund',
      taxAgencyQboId: 'CRA',
      filedReturnRef: '2025-Q4',
      filingEvidenceSha256: 'a'.repeat(64),
      suspenseAccountQboId: '55',
      bankAccountQboId: 'BANK-1',
      refundDate: '2026-01-15',
      principalCents: 123_456,
    };

    const response = await legacy(server, 'tools/call', {
      name: 'prepare_tax_refund',
      arguments: request,
    });

    expect(response.result.isError).not.toBe(true);
    expect(operations.prepareTaxRefund).toHaveBeenCalledWith(principal, request);
    expect(MUTATION_TOOL_NAMES).toContain('prepare_tax_refund');

    const cancelRequest = {
      operationId: preparedTaxRefund.operationId,
      confirmNoQuickBooksAction: true,
    } as const;
    const cancelled = await legacy(server, 'tools/call', {
      name: 'cancel_tax_refund',
      arguments: cancelRequest,
    });
    expect(cancelled.result.isError).not.toBe(true);
    expect(operations.cancelTaxRefund).toHaveBeenCalledWith(principal, cancelRequest);
    expect(MUTATION_TOOL_NAMES).toContain('cancel_tax_refund');

    const acknowledgeRequest = {
      operationId: preparedTaxRefund.operationId,
      confirmQuickBooksActionPerformed: true,
    } as const;
    const acknowledged = await legacy(server, 'tools/call', {
      name: 'acknowledge_tax_refund_recorded',
      arguments: acknowledgeRequest,
    });
    expect(acknowledged.result.isError).not.toBe(true);
    expect(operations.acknowledgeTaxRefundRecorded).toHaveBeenCalledWith(
      principal,
      acknowledgeRequest,
    );
  });

  it('routes exact prepared-categorization recovery to its owner-scoped operation', async () => {
    const operations = mutations();
    const server = handler(operations);
    const input = {
      companyId,
      transactionId,
      idempotencyKey: 'prepare-one',
    };

    const response = await legacy(server, 'tools/call', {
      name: 'get_prepared_categorization',
      arguments: input,
    });

    expect(response.result.isError).not.toBe(true);
    expect(operations.getPreparedCategorization).toHaveBeenCalledWith(principal, input);
  });

  it('exposes read-only prepared-categorization recovery', () => {
    expect(MUTATION_TOOL_NAMES).toContain('get_prepared_categorization');
  });

  it('publishes recursively strict bounded input and output schemas', async () => {
    const body = await legacy(handler(mutations()), 'tools/list', {});
    const tools = body.result.tools as Array<Record<string, any>>;
    const mutationTools = tools.filter((tool) =>
      MUTATION_TOOL_NAMES.includes(tool.name),
    );

    expect(mutationTools.map((tool) => tool.name)).toEqual(MUTATION_TOOL_NAMES);
    expect(mutationTools.every((tool) =>
      tool.inputSchema.additionalProperties === false
      && tool.outputSchema.additionalProperties === false,
    )).toBe(true);

    const prepare = mutationTools[0]!;
    expect(prepare.inputSchema.required).toEqual([
      'companyId',
      'transactionId',
      'expectedRevision',
      'idempotencyKey',
      'proposal',
    ]);
    expect(prepare.inputSchema.properties.expectedRevision).toMatchObject({
      minimum: 0,
      maximum: 2_147_483_646,
    });
    expect(prepare.inputSchema.properties.idempotencyKey.maxLength).toBe(128);
    expect(prepare.inputSchema.properties.proposal.additionalProperties).toBe(false);
    expect(prepare.inputSchema.properties.proposal.properties.lines).toMatchObject({
      minItems: 1,
      maxItems: 20,
    });
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .additionalProperties,
    ).toBe(false);
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .properties.categoryQboId.maxLength,
    ).toBe(120);
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .properties.memo.maxLength,
    ).toBe(500);
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .properties.tagIds.maxItems,
    ).toBe(50);
    expect(prepare.outputSchema.properties.preview.additionalProperties).toBe(false);
    expect(
      prepare.outputSchema.properties.preview.properties.lines.maxItems,
    ).toBe(20);

    const operationSchema = mutationTools.find((tool) => tool.name === 'commit_categorization')!.outputSchema;
    expect(operationSchema.properties.actions.additionalProperties).toBe(false);
    expect(operationSchema.properties.result.anyOf).toHaveLength(2);
    expect(operationSchema.properties.error.anyOf).toHaveLength(2);

    const undoSchema = mutationTools.find((tool) => tool.name === 'prepare_undo')!.outputSchema;
    expect(undoSchema.properties.preview.additionalProperties).toBe(false);
    expect(
      undoSchema.properties.preview.properties.restorationDigest.pattern,
    ).toBe('^[0-9a-f]{64}$');

    const prepareTransfer = mutationTools.find((tool) =>
      tool.name === 'prepare_transfer')!;
    expect(prepareTransfer.inputSchema.required).toEqual([
      'companyId',
      'transactionId',
      'counterpartTransactionId',
      'expectedRevision',
      'counterpartExpectedRevision',
    ]);
    expect(prepareTransfer.inputSchema.additionalProperties).toBe(false);
    expect(prepareTransfer.outputSchema.properties.preview.additionalProperties)
      .toBe(false);
    expect(prepareTransfer.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(mutationTools.some((tool) => tool.name === 'post_transfer')).toBe(false);
  });

  it('routes all eight operations with the fresh principal and sanitized DTOs', async () => {
    const operations = mutations();
    const server = handler(operations);
    const proposal = {
      taxCalculation: 'TaxInclusive',
      lines: [{
        grossCents: -1_050,
        categoryQboId: 'expense-account',
        taxCodeQboId: 'tax-code',
        memo: 'bounded memo',
        tagIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
      }],
      tagIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
    };
    const calls = [
      ['prepare_categorization', {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'prepare-one',
        proposal,
      }],
      ['commit_categorization', {
        operationId,
        idempotencyKey: 'prepare-one',
      }],
      ['get_operation', { operationId }],
      ['retry_operation', { operationId }],
      ['prepare_undo', {
        operationId,
        idempotencyKey: 'undo-one',
      }],
      ['commit_undo', {
        operationId: undoOperationId,
        idempotencyKey: 'undo-one',
      }],
      ['prepare_transfer', {
        companyId,
        transactionId,
        counterpartTransactionId,
        expectedRevision: 2,
        counterpartExpectedRevision: 4,
        idempotencyKey: 'transfer-one',
      }],
      ['commit_transfer', {
        operationId: transferOperationId,
        idempotencyKey: 'transfer-one',
      }],
    ] as const;

    for (const [name, arguments_] of calls) {
      const response = await legacy(server, 'tools/call', {
        name,
        arguments: arguments_,
      });
      expect(response.result.isError, name).not.toBe(true);
    }

    expect(operations.prepareCategorization).toHaveBeenCalledWith(
      principal,
      calls[0][1],
    );
    expect(operations.commitCategorization).toHaveBeenCalledWith(
      principal,
      calls[1][1],
    );
    expect(operations.getOperation).toHaveBeenCalledWith(principal, calls[2][1]);
    expect(operations.retryOperation).toHaveBeenCalledWith(principal, calls[3][1]);
    expect(operations.prepareUndo).toHaveBeenCalledWith(principal, calls[4][1]);
    expect(operations.commitUndo).toHaveBeenCalledWith(principal, calls[5][1]);
    expect(operations.prepareTransfer).toHaveBeenCalledWith(principal, calls[6][1]);
    expect(operations.commitTransfer).toHaveBeenCalledWith(principal, calls[7][1]);
  });

  it('accepts one exact preserve-current proposal and returns its reviewable references', async () => {
    const proposal = {
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      lines: [{
        grossCents: -4_320,
        categoryQboId: '42',
        taxCodeQboId: 'NON',
        tagIds: [],
      }],
      tagIds: [],
    };
    const operations = mutations({
      prepareCategorization: vi.fn().mockResolvedValue({
        ...preparedCategorization,
        preview: {
          ...preparedCategorization.preview,
          taxDisposition: 'preserve_current',
          taxCalculation: 'NotApplicable',
          totals: {
            subtotalCents: -4_320,
            taxCents: 0,
            totalCents: -4_320,
          },
          lines: [{
            idx: 0,
            subtotalCents: -4_320,
            taxCents: 0,
            totalCents: -4_320,
            categoryQboId: '42',
            taxCodeQboId: 'NON',
          }],
          transactionTagCount: 0,
          lineTagCount: 0,
        },
      }),
    });

    const response = await legacy(handler(operations), 'tools/call', {
      name: 'prepare_categorization',
      arguments: {
        companyId,
        transactionId,
        expectedRevision: 0,
        idempotencyKey: 'preserve-non',
        proposal,
      },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.preview).toMatchObject({
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      lines: [{
        categoryQboId: '42',
        taxCodeQboId: 'NON',
      }],
    });
    expect(operations.prepareCategorization).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ proposal }),
    );
  });

  it('accepts tax-inclusive preserve-current without requiring the source code inventory', async () => {
    const proposal = {
      taxDisposition: 'preserve_current',
      taxCalculation: 'TaxInclusive',
      lines: [{
        grossCents: -4_320,
        categoryQboId: '99',
        taxCodeQboId: '7',
        tagIds: [],
      }],
      tagIds: [],
    };
    const operations = mutations({
      prepareCategorization: vi.fn().mockResolvedValue({
        ...preparedCategorization,
        preview: {
          ...preparedCategorization.preview,
          taxDisposition: 'preserve_current',
          taxCalculation: 'TaxInclusive',
          totals: { subtotalCents: -4_320, taxCents: 0, totalCents: -4_320 },
          lines: [{
            idx: 0,
            subtotalCents: -4_320,
            taxCents: 0,
            totalCents: -4_320,
            categoryQboId: '99',
            taxCodeQboId: '7',
          }],
          transactionTagCount: 0,
          lineTagCount: 0,
        },
      }),
    });

    const response = await legacy(handler(operations), 'tools/call', {
      name: 'prepare_categorization',
      arguments: {
        companyId,
        transactionId,
        expectedRevision: 0,
        idempotencyKey: 'preserve-tax-inclusive',
        proposal,
      },
    });

    expect(response.result.isError).not.toBe(true);
    expect(operations.prepareCategorization).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ proposal }),
    );
  });

  it('rejects preserve-current proposals that could change anything besides one category', async () => {
    const valid = {
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      lines: [{
        grossCents: -4_320,
        categoryQboId: '42',
        taxCodeQboId: 'NON',
        tagIds: [],
      }],
      tagIds: [],
    };
    const invalidProposals = [
      { ...valid, lines: [{ ...valid.lines[0], taxCodeQboId: undefined }] },
      { ...valid, lines: [{ ...valid.lines[0], taxCodeQboId: null }] },
      { ...valid, lines: [...valid.lines, { ...valid.lines[0] }] },
      { ...valid, lines: [{ ...valid.lines[0], memo: 'do not change' }] },
      { ...valid, tagIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] },
      {
        ...valid,
        lines: [{
          ...valid.lines[0],
          tagIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
        }],
      },
      { ...valid, privateExtra: true },
    ];
    const operations = mutations();
    const server = handler(operations);

    for (const [index, proposal] of invalidProposals.entries()) {
      const response = await legacy(server, 'tools/call', {
        name: 'prepare_categorization',
        arguments: {
          companyId,
          transactionId,
          expectedRevision: 0,
          idempotencyKey: `invalid-preserve-${index}`,
          proposal,
        },
      });
      expect(response.result.isError, `case ${index}`).toBe(true);
    }
    expect(operations.prepareCategorization).not.toHaveBeenCalled();
  });

  it('accepts an explicit literal NON for a set NotApplicable split', async () => {
    const operations = mutations();
    const proposal = {
      taxDisposition: 'set',
      taxCalculation: 'NotApplicable',
      lines: [
        {
          grossCents: -400,
          categoryQboId: 'expense-a',
          taxCodeQboId: 'NON',
          tagIds: [],
        },
        {
          grossCents: -600,
          categoryQboId: 'expense-b',
          taxCodeQboId: 'NON',
          tagIds: [],
        },
      ],
      tagIds: [],
    };

    const response = await legacy(handler(operations), 'tools/call', {
      name: 'prepare_categorization',
      arguments: {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'explicit-non-split',
        proposal,
      },
    });

    expect(response.result.isError).not.toBe(true);
    expect(operations.prepareCategorization).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ proposal }),
    );
  });

  it('rejects a non-NON tax reference for a set NotApplicable split', async () => {
    const operations = mutations();
    const response = await legacy(handler(operations), 'tools/call', {
      name: 'prepare_categorization',
      arguments: {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'not-non-split',
        proposal: {
          taxDisposition: 'set',
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            taxCodeQboId: 'OTHER',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
    });

    expect(response.result.isError).toBe(true);
    expect(operations.prepareCategorization).not.toHaveBeenCalled();
  });

  it('rejects extra keys and contradictory tax inputs before service dispatch', async () => {
    const operations = mutations();
    const server = handler(operations);
    const invalidInputs = [
      {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'not-applicable',
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            taxCodeQboId: 'must-not-survive',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
      {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'tax-required',
        proposal: {
          taxCalculation: 'TaxExcluded',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            taxCodeQboId: null,
            tagIds: [],
          }],
          tagIds: [],
        },
      },
      {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'extra-key',
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            tagIds: [],
            privateExtra: true,
          }],
          tagIds: [],
        },
      },
    ];

    for (const arguments_ of invalidInputs) {
      const response = await legacy(server, 'tools/call', {
        name: 'prepare_categorization',
        arguments: arguments_,
      });
      expect(response.result.isError).toBe(true);
    }
    expect(operations.prepareCategorization).not.toHaveBeenCalled();
  });

  it('fails closed on invalid service output without logging payload details', async () => {
    const sentinel = 'PRIVATE_MUTATION_OUTPUT_SENTINEL';
    const operations = mutations({
      getOperation: vi.fn().mockResolvedValue({
        ...operation,
        privateUnexpected: sentinel.repeat(10_000),
      }),
    });
    const log = vi.fn();

    const response = await legacy(handler(operations, log), 'tools/call', {
      name: 'get_operation',
      arguments: { operationId },
    });

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'INVALID_INPUT',
          requestId: 'safe-request-id',
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });

  it('redacts transfer token attribution from success and error observability logs', async () => {
    const log = vi.fn();
    const operations = mutations({
      getOperation: vi.fn().mockResolvedValueOnce(transferOperation)
        .mockResolvedValueOnce(operation),
      retryOperation: vi.fn().mockResolvedValue(transferOperation),
      commitTransfer: vi.fn().mockRejectedValue(new Error('provider failure')),
    });
    const server = handler(operations, log);

    const calls = [
      ['prepare_transfer', {
        companyId,
        transactionId,
        counterpartTransactionId,
        expectedRevision: 2,
        counterpartExpectedRevision: 4,
        idempotencyKey: 'transfer-observability',
      }],
      ['commit_transfer', {
        operationId: transferOperationId,
        idempotencyKey: 'transfer-observability',
      }],
      ['get_operation', { operationId: transferOperationId }],
      ['retry_operation', { operationId: transferOperationId }],
      ['get_operation', { operationId }],
    ] as const;

    for (const [name, arguments_] of calls) {
      await legacy(server, 'tools/call', { name, arguments: arguments_ });
    }

    const events = log.mock.calls.map(([event]) => event as {
      outcome: 'success' | 'error';
      tokenPrefix: string;
      tool: string;
    });
    expect(events.slice(0, 4).map((event) => ({
      outcome: event.outcome,
      tokenPrefix: event.tokenPrefix,
      tool: event.tool,
    }))).toEqual([
      {
        outcome: 'success',
        tokenPrefix: 'redacted',
        tool: 'prepare_transfer',
      },
      {
        outcome: 'error',
        tokenPrefix: 'redacted',
        tool: 'commit_transfer',
      },
      {
        outcome: 'success',
        tokenPrefix: 'redacted',
        tool: 'get_operation',
      },
      {
        outcome: 'success',
        tokenPrefix: 'redacted',
        tool: 'retry_operation',
      },
    ]);
    expect(events[4]).toMatchObject({
      outcome: 'success',
      tokenPrefix: principal.tokenPrefix,
      tool: 'get_operation',
    });
  });
  it('prepares and commits a complete owned rule change through strict MCP schemas', async () => {
    const operations = mutations();
    const server = handler(operations);
    const input = {
      companyId, mutation: 'create', expectedRevision: 0, idempotencyKey: 'rule-create',
      proposal: { matchText: 'Synthetic merchant', direction: 'Purchase',
        categoryQboId: 'expense-account', taxCalculation: 'NotApplicable',
        taxCodeQboId: null, tagIds: [], autoPost: false },
    };
    const prepared = await legacy(server, 'tools/call', { name: 'prepare_rule_change', arguments: input });
    expect(prepared.result.isError).not.toBe(true);
    expect(prepared.result.structuredContent).toMatchObject(preparedRuleChange);
    expect(operations.prepareRuleChange).toHaveBeenCalledWith(principal, input);
    const commit = { operationId: ruleOperationId, idempotencyKey: 'rule-commit' };
    const result = await legacy(server, 'tools/call', { name: 'commit_rule_change', arguments: commit });
    expect(result.result.isError).not.toBe(true);
    expect(result.result.structuredContent).toMatchObject(committedRuleChange);
    expect(operations.commitRuleChange).toHaveBeenCalledWith(principal, commit);

    for (const invalid of [
      { ...input, ruleId },
      { ...input, proposal: { ...input.proposal, autoPost: true } },
      { ...input, proposal: { ...input.proposal, taxCodeQboId: 'unexpected-tax' } },
    ]) {
      const rejected = await legacy(server, 'tools/call', { name: 'prepare_rule_change', arguments: invalid });
      expect(rejected.result.isError).toBe(true);
    }
    expect(operations.prepareRuleChange).toHaveBeenCalledTimes(1);
  });

});
