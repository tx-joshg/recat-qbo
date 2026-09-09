import {
  McpServer,
  type JSONObject,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import type { Tracer } from '@opentelemetry/api';
import { z } from 'zod-v4';
import type { McpPrincipal } from './auth.js';
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  getTransaction,
  listCategories,
  listCompanies,
  listRules,
  listTags,
  listTaxCodes,
  listTransactions,
  listTransferCandidates,
} from '../services/companyReads.js';
import type {
  CompanyReadRuleDto,
  CompanyReadTransactionDto,
  CompanyReadDto,
  Page,
  TaxCodePage,
  TransactionListInput,
  TransactionPage,
  TransferCandidateDto,
} from '../services/companyReads.js';
import type { QboAccountDto, TagDto } from '@recat/shared';
import type { McpToolLogger } from './observability.js';
import { observeMcpToolCall } from './observability.js';
import {
  safeInvalidToolFailure,
  safeToolFailure,
  toolSuccess,
} from './result.js';
import {
  MCP_AUTHORED_SCHEMA_BOUNDS,
  toBoundedJsonSchema,
} from './schemaBounds.js';
import { extractMcpTraceContext, type McpTraceContext } from './trace.js';
import {
  mcpMutationOperations,
  mutationToolDefinitions,
  type McpMutationOperations,
} from './mutationTools.js';

export const READ_TOOL_NAMES = [
  'get_identity',
  'list_companies',
  'list_transactions',
  'get_transaction',
  'list_categories',
  'list_tax_codes',
  'list_tags',
  'list_rules',
  'list_transfer_candidates',
] as const;

export interface CompanyReadOperations {
  listCompanies(userId: string, input?: { limit?: number; cursor?: string }): Promise<Page<CompanyReadDto>>;
  listTransactions(
    userId: string,
    companyId: string,
    input?: TransactionListInput,
  ): Promise<TransactionPage>;
  getTransaction(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<CompanyReadTransactionDto>;
  listCategories(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<QboAccountDto>>;
  listTaxCodes(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<TaxCodePage>;
  listTags(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<TagDto>>;
  listRules(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<CompanyReadRuleDto>>;
  listTransferCandidates(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<TransferCandidateDto>>;
}

export const companyReads: CompanyReadOperations = Object.freeze({
  listCompanies,
  listTransactions,
  getTransaction,
  listCategories,
  listTaxCodes,
  listTags,
  listRules,
  listTransferCandidates,
});

export interface RecatMcpContext {
  principal: McpPrincipal;
  era: 'legacy' | 'modern';
  reads?: CompanyReadOperations;
  mutations?: McpMutationOperations;
  requestId?: string;
  traceId?: string;
  traceContext?: McpTraceContext;
  tracer?: Tracer;
  log?: McpToolLogger;
}

const ID_MAX = 128;
const CURSOR_MAX = 2_048;
const SEARCH_MAX = 200;
const ACCOUNT_MAX = 120;
const annotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

class InvalidMcpToolOutputError extends Error {
  constructor() {
    super('MCP tool output failed schema validation');
    this.name = 'InvalidMcpToolOutputError';
  }
}

const id = z.string().min(1).max(ID_MAX);
const cursor = z.string().min(1).max(CURSOR_MAX).optional();
const limit = z.number().int().min(1).max(MAX_READ_LIMIT).default(DEFAULT_READ_LIMIT).optional();
const pageInput = {
  limit,
  cursor,
};
const companyInput = {
  companyId: id,
  ...pageInput,
};
const emptyInput = z.strictObject({});
const listCompaniesInput = z.strictObject(pageInput);
const companyPageInput = z.strictObject(companyInput);
const listTransactionsInput = z.strictObject({
  ...companyInput,
  status: z.enum([
    'PENDING',
    'POSTING',
    'POSTED',
    'DRY_RUN',
    'ERROR',
    'SUPERSEDED',
    'REVERTED',
  ]).optional(),
  search: z.string().max(SEARCH_MAX).optional(),
  account: z.string().max(ACCOUNT_MAX).optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
}).superRefine((input, issue) => {
  if (input.startDate === undefined || input.endDate === undefined) return;
  const start = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${input.endDate}T00:00:00.000Z`);
  const spanDays = (end - start) / (24 * 60 * 60 * 1_000);
  if (spanDays < 0) {
    issue.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'endDate must not be before startDate',
    });
  } else if (spanDays > 366) {
    issue.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'date range must not exceed 366 days',
    });
  }
});
const getTransactionInput = z.strictObject({
  companyId: id,
  transactionId: id,
});

const text = z.string().max(2_048);
const isoDate = z.string().max(64);
const nullableText = text.nullable();
const nullableIsoDate = isoDate.nullable();
const role = z.enum(['viewer', 'categorizer', 'admin']);
const transactionStatus = z.enum([
  'PENDING',
  'POSTING',
  'POSTED',
  'DRY_RUN',
  'ERROR',
  'SUPERSEDED',
  'REVERTED',
]);
const taxCalculation = z.enum([
  'TaxInclusive',
  'TaxExcluded',
  'NotApplicable',
]);
const suggestion = z.strictObject({
  category: text,
  categoryQboId: text.optional(),
  source: z.enum(['rule', 'history', 'ai']),
  ruleId: id.optional(),
  matchedRules: z.number().int().nonnegative().optional(),
  winnerMatchText: text.optional(),
});
const split = z.strictObject({
  amount: z.number().finite(),
  category: text,
  categoryQboId: text.optional(),
  taxCode: nullableText.optional(),
  taxCodeQboId: nullableText.optional(),
  tagIds: z.array(id).max(MAX_READ_LIMIT),
  memo: text.optional(),
});
const transaction = z.strictObject({
  id,
  companyId: id,
  qboId: text,
  qboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
  date: isoDate,
  payee: text,
  memo: nullableText,
  amount: z.number().finite(),
  bankAccount: text,
  status: transactionStatus,
  revision: z.number().int().nonnegative(),
  category: nullableText,
  categoryQboId: nullableText,
  taxCalculation: taxCalculation.nullable(),
  taxCode: nullableText,
  taxCodeQboId: nullableText,
  splits: z.array(split).max(MAX_READ_LIMIT).nullable(),
  tagIds: z.array(id).max(MAX_READ_LIMIT),
  suggestion: suggestion.nullable(),
  error: z.strictObject({ code: text, message: text }).nullable(),
  postedAt: nullableIsoDate,
  postedBy: nullableText,
  activeCategorizationAttempt: z.strictObject({
    requestId: id,
    operation: z.enum(['recategorize', 'restore']),
    status: z.enum(['PREPARED', 'COMMITTING', 'UNCERTAIN']),
  }).nullable(),
  transferCandidateId: id.nullable().optional(),
});
const transactionRead = transaction.extend({
  verification: z.strictObject({
    status: z.enum(['verified', 'dry-run', 'failed', 'uncertain', 'unknown']),
    outcome: z.enum(['VERIFIED', 'DRY_RUN', 'RETRYABLE', 'UNCERTAIN', 'UNCHANGED']).nullable(),
    summary: text,
  }),
});
const company = z.strictObject({
  id,
  realmId: text,
  legalName: text,
  nickname: text,
  env: z.enum(['sandbox', 'production']),
  syncMode: z.enum(['polling', 'webhook']),
  pollIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(30), z.literal(60)]),
  holdingAccountIds: z.array(text).max(MAX_READ_LIMIT),
  dryRun: z.boolean(),
  tagsRequired: z.boolean(),
  connectedAt: isoDate,
  disconnectedAt: nullableIsoDate,
  lastSyncedAt: nullableIsoDate,
  role,
});
const category = z.strictObject({
  id,
  qboId: text,
  name: text,
  fullName: text,
  classification: text,
  active: z.boolean(),
});
const taxCode = z.strictObject({
  qboId: text,
  name: text,
  active: z.boolean(),
  taxable: z.boolean().nullable(),
  combinedPurchaseRate: z.number().finite().nullable(),
  combinedSalesRate: z.number().finite().nullable(),
});
const tag = z.strictObject({
  id,
  companyId: id,
  name: text,
  color: text,
  usageCount: z.number().int().nonnegative().optional(),
});
const ruleOutput = z.strictObject({
  id,
  companyId: id,
  priority: z.number().int(),
  matchField: z.literal('payee'),
  matchText: text,
  category: text,
  categoryQboId: nullableText,
  taxCalculation: taxCalculation.nullable(),
  taxCode: nullableText,
  taxCodeQboId: nullableText,
  tagIds: z.array(id).max(MAX_READ_LIMIT),
  autoPost: z.boolean(),
  createdAt: isoDate,
  reviewRequiredAt: nullableIsoDate,
  reviewReason: nullableText,
  origin: z.strictObject({
    candidateId: id,
    evidenceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    schemaVersion: text,
    configVersion: text,
  }).nullable(),
  valid: z.boolean(),
  invalidReasons: z.array(text).max(4),
});
const pageOutput = <T extends z.ZodType>(item: T) => z.strictObject({
  items: z.array(item).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
});
const transactionPageOutput = z.strictObject({
  items: z.array(transactionRead).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
  pendingCount: z.number().int().nonnegative(),
});
const taxPageOutput = z.strictObject({
  status: z.enum(['unsupported', 'needs_setup', 'ready']),
  reason: z.string().max(500).nullable(),
  usingSalesTax: z.boolean().nullable(),
  refreshedAt: z.string().max(64).nullable(),
  items: z.array(taxCode).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
});
const transactionOutput = z.strictObject({ transaction: transactionRead });
const identityOutput = z.strictObject({
  identity: z.strictObject({
    userId: id,
    tokenPrefix: z.string().min(1).max(16),
    isInstanceAdmin: z.boolean(),
    memberships: z.array(z.strictObject({
      companyId: id,
      role: z.enum(['viewer', 'categorizer', 'admin']),
    })).max(100),
    totalMemberships: z.number().int().nonnegative(),
    membershipsTruncated: z.boolean(),
  }),
});
const companyListOutput = pageOutput(company);
const categoryListOutput = pageOutput(category);
const tagListOutput = pageOutput(tag);
const ruleListOutput = pageOutput(ruleOutput);
const transferCandidateListOutput = pageOutput(
  z.strictObject({ a: transaction, b: transaction }),
);

const authoredToolSchemas: ReadonlyArray<readonly [z.ZodType, z.ZodType]> = [
  [emptyInput, identityOutput],
  [listCompaniesInput, companyListOutput],
  [listTransactionsInput, transactionPageOutput],
  [getTransactionInput, transactionOutput],
  [companyPageInput, categoryListOutput],
  [companyPageInput, taxPageOutput],
  [companyPageInput, tagListOutput],
  [companyPageInput, ruleListOutput],
  [companyPageInput, transferCandidateListOutput],
];

// These schemas are static authored definitions. Validate them once at module
// initialization so a per-request wall-clock deadline cannot fail under load.
for (const [inputSchema, outputSchema] of authoredToolSchemas) {
  toBoundedJsonSchema(inputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
  toBoundedJsonSchema(outputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
}

function asJson(value: unknown): JSONObject {
  return value as JSONObject;
}

function inputWithoutCompany<T extends { companyId: string }>(
  input: T,
): Omit<T, 'companyId'> {
  const { companyId: _companyId, ...rest } = input;
  return rest;
}

export function createRecatMcpServer(context: RecatMcpContext): McpServer {
  const reads = context.reads ?? companyReads;
  const mutations = context.mutations ?? mcpMutationOperations;
  const requestId = context.requestId ?? randomUUID();
  const traceContext = context.traceContext ?? (
    context.traceId === undefined
      ? extractMcpTraceContext({})
      : Object.freeze({
          traceId: context.traceId,
          baggage: Object.freeze({}),
        })
  );
  const log = context.log ?? ((event) => console.info('[recat] mcp', event));
  const server = new McpServer(
    { name: 'recat-qbo', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: false } },
      cacheHints: {
        'server/discover': { ttlMs: 0, cacheScope: 'private' },
        'tools/list': { ttlMs: 0, cacheScope: 'private' },
      },
    },
  );

  const register = <T extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: T,
    outputSchema: z.ZodObject,
    operation: (input: z.output<T>) => Promise<unknown>,
    toolAnnotations: ToolAnnotations = annotations,
  ): void => {
    const callback = async (input: z.output<T>, sdkContext: ServerContext) => {
      const tokenPrefixPolicy =
        name === 'prepare_transfer' || name === 'commit_transfer'
          ? 'redact'
          : name === 'get_operation' || name === 'retry_operation'
            ? 'redact-for-transfer-result'
            : 'include';
      try {
        const value = await observeMcpToolCall(
          {
            requestId,
            traceId: traceContext.traceId,
            tokenPrefix: context.principal.tokenPrefix,
            tokenPrefixPolicy,
            method: sdkContext.mcpReq.method,
            tool: name,
            era: context.era,
            traceContext,
            tracer: context.tracer,
          },
          log,
          async () => {
            const operationValue = await operation(input);
            const parsed = outputSchema.safeParse(operationValue);
            if (!parsed.success) throw new InvalidMcpToolOutputError();
            return parsed.data;
          },
        );
        return toolSuccess(asJson(value));
      } catch (error) {
        if (error instanceof InvalidMcpToolOutputError) {
          return safeInvalidToolFailure(requestId);
        }
        return safeToolFailure(error, requestId);
      }
    };
    // SDK v2's callback conditional type cannot preserve a generic Zod
    // object's output through this local registration helper.
    server.registerTool(name, {
      description,
      inputSchema,
      outputSchema,
      annotations: toolAnnotations,
    }, callback as never);
  };

  register('get_identity', 'Return the authenticated Recat identity.', emptyInput, identityOutput, async () => {
    const memberships = context.principal.memberships
      .map(({ companyId, role }) => ({ companyId, role }))
      .sort((first, second) =>
        first.companyId.localeCompare(second.companyId) ||
        first.role.localeCompare(second.role),
      );
    return {
      identity: {
        userId: context.principal.userId,
        tokenPrefix: context.principal.tokenPrefix,
        isInstanceAdmin: context.principal.isInstanceAdmin,
        memberships: memberships.slice(0, 100),
        totalMemberships: memberships.length,
        membershipsTruncated: memberships.length > 100,
      },
    };
  });
  register('list_companies', 'List companies visible to the authenticated user.', listCompaniesInput, companyListOutput,
    (input) => reads.listCompanies(context.principal.userId, input));
  register('list_transactions', 'List bounded transactions for a company.', listTransactionsInput, transactionPageOutput,
    (input) => reads.listTransactions(
      context.principal.userId,
      input.companyId,
      inputWithoutCompany(input),
    ));
  register('get_transaction', 'Get one visible transaction.', getTransactionInput, transactionOutput,
    async (input) => ({
      transaction: await reads.getTransaction(
        context.principal.userId,
        input.companyId,
        input.transactionId,
      ),
    }));
  register('list_categories', 'List active category accounts.', companyPageInput, categoryListOutput,
    (input) => reads.listCategories(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_tax_codes', 'List eligible tax codes and readiness.', companyPageInput, taxPageOutput,
    (input) => reads.listTaxCodes(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_tags', 'List company tags.', companyPageInput, tagListOutput,
    (input) => reads.listTags(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_rules', 'List categorization rules visible to categorizers.', companyPageInput, ruleListOutput,
    (input) => reads.listRules(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_transfer_candidates', 'List bounded transfer candidate pairs.', companyPageInput, transferCandidateListOutput,
    (input) => reads.listTransferCandidates(context.principal.userId, input.companyId, inputWithoutCompany(input)));

  for (const definition of mutationToolDefinitions) {
    register(
      definition.name,
      definition.description,
      definition.inputSchema,
      definition.outputSchema,
      (input) => definition.invoke(mutations, context.principal, input),
      definition.annotations,
    );
  }

  return server;
}
