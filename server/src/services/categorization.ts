import type { Prisma, PrismaClient } from '@prisma/client';
import type { CategorizeBody, TaxCalculation } from '@recat/shared';
import { randomUUID } from 'node:crypto';
import { ruleSuggestion } from './suggestions.js';
import { validateSplits } from './writeback.js';
import { lockCompanyRuleBoundary } from './ruleBoundary.js';

export type StagingErrorCode =
  | 'TXN_NOT_FOUND'
  | 'BAD_STATUS'
  | 'BAD_SPLITS'
  | 'BAD_TAGS'
  | 'BAD_CATEGORY_ACCOUNT'
  | 'TAX_MODE_UNSUPPORTED'
  | 'TAX_MODE_REQUIRED'
  | 'TAX_CODE_REQUIRED'
  | 'TAX_CODE_INVALID'
  | 'TAX_CODE_INACTIVE'
  | 'TAX_CODE_NOT_PURCHASE'
  | 'TAX_OUT_OF_SCOPE_REQUIRED'
  | 'STALE_TRANSACTION'
  | 'DETERMINISTIC_RULE';

export class StagingError extends Error {
  constructor(
    readonly code: StagingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StagingError';
  }
}

type TaxReader = Pick<PrismaClient, 'qboTaxCode'> | Pick<Prisma.TransactionClient, 'qboTaxCode'>;

export interface ValidatedTaxCode {
  qboId: string;
  name: string;
  taxable: boolean | null;
}

export async function validatePurchaseTaxDecision(
  db: TaxReader,
  companyId: string,
  qboType: string,
  taxCalculation: TaxCalculation | null,
  taxCodeQboIds: (string | null | undefined)[],
): Promise<ValidatedTaxCode[]> {
  const selected = taxCodeQboIds.filter((id): id is string => Boolean(id));
  if (taxCalculation === null) {
    if (selected.length > 0) {
      throw new StagingError('TAX_MODE_REQUIRED', 'Choose a tax calculation mode before a TaxCode.');
    }
    return [];
  }
  if (qboType !== 'Purchase') {
    throw new StagingError('TAX_MODE_UNSUPPORTED', 'Tax treatment is currently supported only for Purchase transactions.');
  }
  if (selected.length !== taxCodeQboIds.length) {
    throw new StagingError('TAX_CODE_REQUIRED', 'Every Purchase line needs a tax code.');
  }
  const uniqueIds = [...new Set(selected)];
  const rows = await db.qboTaxCode.findMany({
    where: { companyId, qboId: { in: uniqueIds } },
  });
  const byId = new Map(rows.map((row) => [row.qboId, row]));
  return selected.map((id) => {
    const row = byId.get(id);
    if (!row) throw new StagingError('TAX_CODE_INVALID', `TaxCode '${id}' does not belong to this company.`);
    if (!row.active) throw new StagingError('TAX_CODE_INACTIVE', `QuickBooks TaxCode ${row.name} is inactive.`);
    const purchaseRates = Array.isArray(row.purchaseTaxRateList) ? row.purchaseTaxRateList : [];
    if (row.taxable !== false && purchaseRates.length === 0) {
      throw new StagingError('TAX_CODE_NOT_PURCHASE', `QuickBooks TaxCode ${row.name} is not purchase-applicable.`);
    }
    if (taxCalculation === 'NotApplicable' && row.taxable !== false) {
      throw new StagingError(
        'TAX_OUT_OF_SCOPE_REQUIRED',
        'NotApplicable lines must use a non-taxable QuickBooks code.',
      );
    }
    return { qboId: row.qboId, name: row.name, taxable: row.taxable };
  });
}

async function resolveCategory(
  tx: Prisma.TransactionClient,
  companyId: string,
  name: string,
  given: string | null | undefined,
): Promise<string | null> {
  const account = given
    ? await tx.qboAccount.findFirst({ where: { companyId, qboId: given, active: true } })
    : await tx.qboAccount.findFirst({ where: { companyId, name, active: true } });
  if (!account) {
    throw new StagingError(
      'BAD_CATEGORY_ACCOUNT',
      given
        ? `Category account '${given}' is not active for this company.`
        : `Unknown category '${name}' — re-sync the chart of accounts.`,
    );
  }
  return account.qboId;
}

export type CategorizationSource = 'human' | 'rule' | 'autopilot';

export interface StageCategorizationOptions {
  actor: { id: string | null; label: string };
  source: CategorizationSource;
  /** Optimistic concurrency guard captured before model/user think-time. */
  expectedUpdatedAt?: Date | string;
  /** Human acceptance of a matching rule inherits that rule's tags. */
  applyMatchingRuleTags?: boolean;
  /** Autopilot may stage only while no current deterministic rule matches. */
  requireNoMatchingRule?: boolean;
}

/**
 * Remove an autopilot-only local staging change when the worker loses its
 * write lease before any QuickBooks request starts. The timestamp is the
 * staging result itself, so a later human/rule edit wins and is never cleared.
 */
export async function rollbackAutopilotStaging(
  db: PrismaClient,
  txnId: string,
  stagedUpdatedAt: Date,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const txn = await tx.transaction.findUnique({
      where: { id: txnId },
      select: { companyId: true, status: true, updatedAt: true },
    });
    if (!txn) return false;

    await lockCompanyRuleBoundary(tx, txn.companyId);
    const claimed = await tx.transaction.updateMany({
      where: {
        id: txnId,
        status: 'PENDING',
        updatedAt: stagedUpdatedAt,
      },
      data: { updatedAt: new Date() },
    });
    if (claimed.count !== 1) return false;

    await tx.transaction.update({
      where: { id: txnId },
      data: {
        category: null,
        categoryQboId: null,
        taxCalculation: null,
        taxCode: null,
        taxCodeQboId: null,
        splitLines: { deleteMany: {} },
        txnTags: { deleteMany: {} },
      },
    });
    return true;
  });
}

/**
 * Shared browser/rule/agent staging boundary. It never writes to QuickBooks.
 * All ownership checks and field/tag replacement commit atomically.
 */
export async function stageCategorization(
  db: PrismaClient,
  txnId: string,
  body: CategorizeBody,
  options: StageCategorizationOptions = {
    actor: { id: null, label: 'system' },
    source: 'human',
  },
): Promise<{ id: string; updatedAt: Date }> {
  return db.$transaction(async (tx) => {
    const txn = await tx.transaction.findUnique({
      where: { id: txnId },
      include: { splitLines: true },
    });
    if (!txn) throw new StagingError('TXN_NOT_FOUND', `Transaction ${txnId} not found.`);
    // Every staging path locks Company before it can lock/update Transaction.
    // Rule mutations and autopilot use the same order, avoiding a
    // Company↔Transaction deadlock when a human edit races a live decision.
    await lockCompanyRuleBoundary(tx, txn.companyId);
    if (options.requireNoMatchingRule) {
      const rules = await tx.rule.findMany({
        where: { companyId: txn.companyId },
        include: { ruleTags: true },
      });
      if (ruleSuggestion(txn.payee, rules) !== null) {
        throw new StagingError(
          'DETERMINISTIC_RULE',
          'A deterministic rule now covers this transaction.',
        );
      }
    }
    if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
      throw new StagingError('BAD_STATUS', `Cannot edit a transaction in status ${txn.status}.`);
    }
    if (
      options.expectedUpdatedAt !== undefined &&
      txn.updatedAt.getTime() !== new Date(options.expectedUpdatedAt).getTime()
    ) {
      throw new StagingError(
        'STALE_TRANSACTION',
        'This transaction changed after categorization began. Refresh and try again.',
      );
    }

    const taxCalculation =
      body.taxCalculation !== undefined
        ? body.taxCalculation
        : (txn.taxCalculation as TaxCalculation | null);
    const data: Prisma.TransactionUpdateInput = {};

    if (body.splits && body.splits.length > 0) {
      const splitCheck = validateSplits(Number(txn.amount), body.splits);
      if (!splitCheck.ok) {
        throw new StagingError('BAD_SPLITS', splitCheck.message ?? 'Split amounts must add up.');
      }
      const tagIds = [...new Set(body.splits.flatMap((split) => split.tagIds))];
      if (tagIds.length > 0) {
        const count = await tx.tag.count({ where: { companyId: txn.companyId, id: { in: tagIds } } });
        if (count !== tagIds.length) throw new StagingError('BAD_TAGS', 'One or more tags do not belong to this company.');
      }
      const taxCodes = await validatePurchaseTaxDecision(
        tx,
        txn.companyId,
        txn.qboType,
        taxCalculation,
        body.splits.map((split) => split.taxCodeQboId),
      );
      const lines: Prisma.SplitLineCreateWithoutTxnInput[] = [];
      for (const [index, split] of body.splits.entries()) {
        const categoryQboId = await resolveCategory(
          tx,
          txn.companyId,
          split.category,
          split.categoryQboId,
        );
        lines.push({
          idx: index,
          amount: split.amount,
          category: split.category,
          categoryQboId,
          memo: split.memo ?? null,
          taxCode: taxCodes[index]?.name ?? null,
          taxCodeQboId: taxCodes[index]?.qboId ?? null,
          tags: { create: [...new Set(split.tagIds)].map((tagId) => ({ tagId })) },
        });
      }
      data.splitLines = { deleteMany: {}, create: lines };
      data.category = null;
      data.categoryQboId = null;
      data.taxCode = null;
      data.taxCodeQboId = null;
      data.taxCalculation = taxCalculation;
    } else {
      if (body.splits === null) data.splitLines = { deleteMany: {} };
      if (body.category !== undefined) {
        if (body.category === null) {
          data.category = null;
          data.categoryQboId = null;
        } else {
          data.category = body.category;
          data.categoryQboId = await resolveCategory(
            tx,
            txn.companyId,
            body.category,
            body.categoryQboId,
          );
          data.splitLines = { deleteMany: {} };
        }
      }
      if (
        body.taxCalculation !== undefined ||
        body.taxCodeQboId !== undefined ||
        body.taxCode !== undefined
      ) {
        const taxCodes = await validatePurchaseTaxDecision(
          tx,
          txn.companyId,
          txn.qboType,
          taxCalculation,
          [body.taxCodeQboId ?? null],
        );
        data.taxCalculation = taxCalculation;
        data.taxCode = taxCodes[0]?.name ?? null;
        data.taxCodeQboId = taxCodes[0]?.qboId ?? null;
      }
    }

    if (body.tagIds !== undefined) {
      const tagIds = [...new Set(body.tagIds)];
      const count = await tx.tag.count({ where: { companyId: txn.companyId, id: { in: tagIds } } });
      if (count !== tagIds.length) throw new StagingError('BAD_TAGS', 'One or more tags do not belong to this company.');
      data.txnTags = { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) };
    }
    const claimed = await tx.transaction.updateMany({
      where: {
        id: txnId,
        status: txn.status,
        updatedAt: txn.updatedAt,
      },
      data: { updatedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new StagingError(
        'STALE_TRANSACTION',
        'This transaction changed while categorization was being staged. Refresh and try again.',
      );
    }
    const updated = await tx.transaction.update({
      where: { id: txnId },
      data,
      select: { id: true, updatedAt: true },
    });

    if (
      options.source === 'human' &&
      options.applyMatchingRuleTags === true &&
      body.category !== null &&
      body.category !== undefined
    ) {
      const rules = await tx.rule.findMany({
        where: { companyId: txn.companyId },
        include: { ruleTags: true },
      });
      const match = ruleSuggestion(txn.payee, rules);
      if (match?.ruleId !== undefined && match.category === body.category) {
        const rule = rules.find((candidate) => candidate.id === match.ruleId);
        for (const ruleTag of rule?.ruleTags ?? []) {
          await tx.txnTag.upsert({
            where: { txnId_tagId: { txnId, tagId: ruleTag.tagId } },
            create: { txnId, tagId: ruleTag.tagId },
            update: {},
          });
        }
      }
    }

    // A human edit can make a previously ineligible transaction eligible
    // again (for example, removing its final tag). Persist a queue
    // reconciliation request in the same transaction so a quiet company does
    // not depend on another webhook or manual sync to revive the job.
    if (options.source === 'human') {
      await tx.company.update({
        where: { id: txn.companyId },
        data: { agentReconcileToken: randomUUID() },
      });
    }

    // Actor/source are deliberately accepted here even though staging is not a
    // QBO mutation. They bind every caller to the same future audit boundary.
    void options.actor;
    return updated;
  });
}
