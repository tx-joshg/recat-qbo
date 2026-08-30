import type { CompanyReadTransactionDto } from './companyReads.js';
import { getTransaction } from './companyReads.js';
import type { QboClient, QboTxn } from '../lib/qbo/types.js';
import {
  assertQboWriteAllowed,
  QboWriteSafetyError,
  type QboWriteSafetyTarget,
} from '../lib/qbo/writeSafety.js';

export type QboWriteSafetyBlockCode =
  | 'QBO_PERIOD_CLOSED'
  | 'QBO_TRANSACTION_LOCKED';

export interface WriteSafetyReadResult {
  transactionId: string;
  revision: number;
  qboId: string;
  qboType: 'Purchase' | 'Deposit';
  qboSyncToken: string;
  txnDate: string;
  bankAccountQboId: string;
  bookCloseDate: string | null;
  cleared: boolean;
  reconciled: boolean;
  writable: boolean;
  blockCode: QboWriteSafetyBlockCode | null;
}

export interface WriteSafetyReadOperations {
  getWriteSafety(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<WriteSafetyReadResult>;
}

export interface WriteSafetyReadDeps {
  getTransaction(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<CompanyReadTransactionDto>;
  qboForCompany(companyId: string): Promise<QboClient>;
}

function unavailable(message?: string): never {
  throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE', message);
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function exactCents(value: number): number {
  return Math.round(value * 100);
}

function targetFor(txn: QboTxn): QboWriteSafetyTarget {
  if (txn.qboType === 'JournalEntry') {
    return unavailable('QuickBooks write-safety preflight supports purchases and deposits only.');
  }
  const raw = txn.raw;
  const accountRef = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>)[txn.qboType === 'Purchase' ? 'AccountRef' : 'DepositToAccountRef']
    : undefined;
  const bankAccountQboId = accountRef && typeof accountRef === 'object'
    ? (accountRef as Record<string, unknown>).value
    : undefined;
  if (typeof bankAccountQboId !== 'string' || bankAccountQboId.length === 0) {
    return unavailable('QuickBooks payment-account identity is unavailable for the safety preflight.');
  }
  return {
    qboType: txn.qboType,
    qboId: txn.qboId,
    txnDate: txn.date,
    bankAccountQboId,
  };
}

function assertCurrentIdentity(
  recat: CompanyReadTransactionDto,
  current: QboTxn,
): void {
  if (
    current.qboId !== recat.qboId
    || current.qboType !== recat.qboType
    || current.date !== dateOnly(recat.date)
    || exactCents(current.amount) !== exactCents(recat.amount)
  ) {
    unavailable('The current QuickBooks transaction no longer matches the Recat transaction.');
  }
}

export function createWriteSafetyReadOperations(
  deps: WriteSafetyReadDeps,
): WriteSafetyReadOperations {
  return Object.freeze({
    async getWriteSafety(userId: string, companyId: string, transactionId: string) {
      const recat = await deps.getTransaction(userId, companyId, transactionId);
      if (recat.qboType === 'JournalEntry') {
        return unavailable('QuickBooks write-safety preflight supports purchases and deposits only.');
      }
      const client = await deps.qboForCompany(companyId);
      const current = await client.fetchTxn(recat.qboType, recat.qboId);
      if (!current) {
        return unavailable('The current QuickBooks transaction is unavailable for the safety preflight.');
      }
      assertCurrentIdentity(recat, current);
      const target = targetFor(current);
      const evidence = await client.fetchWriteSafety(target);
      let blockCode: QboWriteSafetyBlockCode | null = null;
      try {
        assertQboWriteAllowed(target, evidence);
      } catch (error) {
        if (
          error instanceof QboWriteSafetyError
          && (error.code === 'QBO_PERIOD_CLOSED' || error.code === 'QBO_TRANSACTION_LOCKED')
        ) {
          blockCode = error.code;
        } else {
          throw error;
        }
      }
      return {
        transactionId: recat.id,
        revision: recat.revision,
        qboId: current.qboId,
        qboType: target.qboType,
        qboSyncToken: current.syncToken,
        txnDate: current.date,
        bankAccountQboId: target.bankAccountQboId,
        bookCloseDate: evidence.bookCloseDate,
        cleared: evidence.cleared,
        reconciled: evidence.reconciled,
        writable: blockCode === null,
        blockCode,
      };
    },
  });
}

export const writeSafetyReads = createWriteSafetyReadOperations({
  getTransaction,
  qboForCompany: async (companyId) => {
    const { qboFactory } = await import('../lib/qbo/factory.js');
    return qboFactory.forCompany(companyId);
  },
});
