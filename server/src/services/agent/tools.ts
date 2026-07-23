import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { isAllowedPurchaseAccount } from './decision.js';
import type { AgentToolContext } from './context.js';
import { isTransferPair } from '../transfers.js';
import { normalizePayee } from '../suggestions.js';

export const AGENT_TOOL_RESULT_SCHEMA_VERSION = 'recat-tool-result-v1';

export interface AgentToolDefinition {
  name:
    | 'get_transaction'
    | 'get_original_line_context'
    | 'find_similar_transactions'
    | 'get_payee_history'
    | 'list_allowed_accounts'
    | 'list_purchase_tax_codes'
    | 'find_transfer_candidates';
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolSuccess {
  ok: true;
  schemaVersion: typeof AGENT_TOOL_RESULT_SCHEMA_VERSION;
  truncated: boolean;
  hasMore: boolean;
  data: unknown;
}

export interface AgentToolFailure {
  ok: false;
  schemaVersion: typeof AGENT_TOOL_RESULT_SCHEMA_VERSION;
  error: { code: 'TOOL_UNKNOWN' | 'TOOL_ARGS' | 'TOOL_FAILED'; message: string };
}

export type AgentToolResult = AgentToolSuccess | AgentToolFailure;

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'get_transaction',
    description: 'Return the one transaction bound to this run.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_original_line_context',
    description: 'Return sanitized original QuickBooks line context for the bound Purchase.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'find_similar_transactions',
    description: 'Find bounded same-company transactions similar to a short payee query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          anyOf: [
            { type: 'string', minLength: 1, maxLength: 120 },
            { type: 'null' },
          ],
        },
        limit: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 20 },
            { type: 'null' },
          ],
        },
      },
      required: ['query', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_payee_history',
    description: 'Return bounded posted history for the bound transaction payee.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 20 },
            { type: 'null' },
          ],
        },
      },
      required: ['limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_allowed_accounts',
    description:
      'List one bounded page of active, non-holding accounts permitted for Purchase categorization.',
    parameters: {
      type: 'object',
      properties: {
        offset: {
          anyOf: [
            { type: 'integer', minimum: 0, maximum: 10_000 },
            { type: 'null' },
          ],
        },
        limit: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 40 },
            { type: 'null' },
          ],
        },
      },
      required: ['offset', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_purchase_tax_codes',
    description: 'List one bounded page of active company TaxCodes applicable to Purchases.',
    parameters: {
      type: 'object',
      properties: {
        offset: {
          anyOf: [
            { type: 'integer', minimum: 0, maximum: 10_000 },
            { type: 'null' },
          ],
        },
        limit: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 40 },
            { type: 'null' },
          ],
        },
      },
      required: ['offset', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_transfer_candidates',
    description: 'Return a currently valid equal-and-opposite transfer candidate, if any.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

const emptyArgs = z.object({}).strict();
const similarArgs = z
  .object({
    query: z.string().trim().min(1).max(120).nullish(),
    limit: z.number().int().min(1).max(20).nullish(),
  })
  .strict();
const historyArgs = z.object({ limit: z.number().int().min(1).max(20).nullish() }).strict();
const accountPageArgs = z
  .object({
    offset: z.number().int().min(0).max(10_000).nullish(),
    limit: z.number().int().min(1).max(40).nullish(),
  })
  .strict();
const taxCodePageArgs = accountPageArgs;

function success(data: unknown, hasMore = false): AgentToolSuccess {
  return {
    ok: true,
    schemaVersion: AGENT_TOOL_RESULT_SCHEMA_VERSION,
    truncated: hasMore,
    hasMore,
    data,
  };
}

function safeFailure(code: AgentToolFailure['error']['code'], message: string): AgentToolFailure {
  return {
    ok: false,
    schemaVersion: AGENT_TOOL_RESULT_SCHEMA_VERSION,
    error: { code, message },
  };
}

export interface AgentToolRegistry {
  definitions: AgentToolDefinition[];
  execute(name: string, args: unknown): Promise<AgentToolResult>;
}

export function createAgentToolRegistry(
  db: PrismaClient,
  context: AgentToolContext,
): AgentToolRegistry {
  const execute = async (name: string, rawArgs: unknown): Promise<AgentToolResult> => {
    try {
      switch (name) {
        case 'get_transaction': {
          emptyArgs.parse(rawArgs);
          return success(context.transaction);
        }
        case 'get_original_line_context': {
          emptyArgs.parse(rawArgs);
          return success(context.originalLines, context.originalLines.length >= 100);
        }
        case 'find_similar_transactions': {
          const args = similarArgs.parse(rawArgs);
          const limit = args.limit ?? 10;
          const query = args.query ?? context.transaction.payee;
          const rows = await db.transaction.findMany({
            where: {
              companyId: context.companyId,
              id: { not: context.transactionId },
              payee: { contains: query, mode: 'insensitive' },
              status: { in: ['POSTED', 'DRY_RUN', 'PENDING'] },
            },
            orderBy: [{ date: 'desc' }, { id: 'asc' }],
            take: limit + 1,
            select: {
              id: true,
              date: true,
              payee: true,
              memo: true,
              amount: true,
              bankAccount: true,
              status: true,
              category: true,
              categoryQboId: true,
              taxCalculation: true,
              taxCode: true,
              taxCodeQboId: true,
            },
          });
          const hasMore = rows.length > limit;
          return success(
            rows.slice(0, limit).map((row) => ({ ...row, amount: Number(row.amount), date: row.date.toISOString() })),
            hasMore,
          );
        }
        case 'get_payee_history': {
          const args = historyArgs.parse(rawArgs);
          const limit = args.limit ?? 10;
          const normalizedPayee = normalizePayee(context.transaction.payee);
          const query = normalizedPayee.split(' ')[0] || context.transaction.payee;
          const scanLimit = Math.min(201, Math.max(limit * 10 + 1, 51));
          const rows = await db.transaction.findMany({
            where: {
              companyId: context.companyId,
              id: { not: context.transactionId },
              payee: { contains: query, mode: 'insensitive' },
              status: 'POSTED',
            },
            orderBy: [{ postedAt: 'desc' }, { id: 'asc' }],
            take: scanLimit,
            select: {
              id: true,
              date: true,
              payee: true,
              memo: true,
              amount: true,
              category: true,
              categoryQboId: true,
              taxCalculation: true,
              taxCode: true,
              taxCodeQboId: true,
            },
          });
          const exact = rows.filter(
            (row) => normalizePayee(row.payee) === normalizedPayee,
          );
          const hasMore = exact.length > limit || rows.length === scanLimit;
          return success(
            exact.slice(0, limit).map((row) => ({ ...row, amount: Number(row.amount), date: row.date.toISOString() })),
            hasMore,
          );
        }
        case 'list_allowed_accounts': {
          const args = accountPageArgs.parse(rawArgs);
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 40;
          const scanSize = limit + 1;
          const rows = await db.qboAccount.findMany({
            where: { companyId: context.companyId, active: true },
            orderBy: [{ fullName: 'asc' }, { qboId: 'asc' }],
            skip: offset,
            take: scanSize,
            select: {
              qboId: true,
              name: true,
              fullName: true,
              classification: true,
              accountType: true,
              active: true,
            },
          });
          const allowed = rows.slice(0, limit).filter((row) =>
            isAllowedPurchaseAccount(row, context.holdingAccountQboIds),
          );
          const hasMore = rows.length > limit;
          return success(
            {
              items: allowed,
              nextOffset: hasMore ? offset + limit : null,
            },
            hasMore,
          );
        }
        case 'list_purchase_tax_codes': {
          const args = taxCodePageArgs.parse(rawArgs);
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 40;
          const rows = await db.qboTaxCode.findMany({
            where: { companyId: context.companyId, active: true },
            orderBy: [{ name: 'asc' }, { qboId: 'asc' }],
            skip: offset,
            take: limit + 1,
            select: {
              qboId: true,
              name: true,
              description: true,
              active: true,
              taxable: true,
              purchaseTaxRateList: true,
            },
          });
          const applicable = rows.slice(0, limit).filter(
            (row) =>
              row.taxable === false ||
              (Array.isArray(row.purchaseTaxRateList) && row.purchaseTaxRateList.length > 0),
          );
          const hasMore = rows.length > limit;
          return success(
            {
              items: applicable.map(({ purchaseTaxRateList, ...row }) => ({
                ...row,
                purchaseRateCount: Array.isArray(purchaseTaxRateList)
                  ? purchaseTaxRateList.length
                  : 0,
              })),
              nextOffset: hasMore ? offset + limit : null,
            },
            hasMore,
          );
        }
        case 'find_transfer_candidates': {
          emptyArgs.parse(rawArgs);
          const bound = {
            id: context.transactionId,
            amount: context.transaction.amount,
            bankAccount: context.transaction.bankAccount,
            date: new Date(context.transaction.date),
          };
          const windowMs = 3 * 24 * 60 * 60 * 1000;
          const rows = await db.transaction.findMany({
            where: {
              companyId: context.companyId,
              id: { not: context.transactionId },
              status: 'PENDING',
              category: null,
              splitLines: { none: {} },
              amount: -context.transaction.amount,
              bankAccount: { not: context.transaction.bankAccount },
              date: {
                gte: new Date(bound.date.getTime() - windowMs),
                lte: new Date(bound.date.getTime() + windowMs),
              },
            },
            orderBy: [{ date: 'asc' }, { id: 'asc' }],
            take: 101,
            select: { id: true, amount: true, bankAccount: true, date: true, payee: true },
          });
          const candidates = rows
            .filter((row) =>
              isTransferPair(bound, {
                id: row.id,
                amount: Number(row.amount),
                bankAccount: row.bankAccount,
                date: row.date,
              }),
            )
            .sort(
              (a, b) =>
                Math.abs(a.date.getTime() - bound.date.getTime()) -
                  Math.abs(b.date.getTime() - bound.date.getTime()) ||
                a.id.localeCompare(b.id),
            );
          const counterpart = candidates[0];
          return success(
            counterpart
              ? [
                  {
                    id: counterpart.id,
                    amount: Number(counterpart.amount),
                    bankAccount: counterpart.bankAccount,
                    date: counterpart.date.toISOString(),
                    payee: counterpart.payee,
                  },
                ]
              : [],
            rows.length > 100,
          );
        }
        default:
          return safeFailure('TOOL_UNKNOWN', 'Unknown read-only tool.');
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        return safeFailure('TOOL_ARGS', 'Tool arguments did not match the declared schema.');
      }
      return safeFailure('TOOL_FAILED', 'The read-only tool could not complete.');
    }
  };
  return { definitions: AGENT_TOOL_DEFINITIONS, execute };
}
