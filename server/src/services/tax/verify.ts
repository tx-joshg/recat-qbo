import type {
  QboDepositExpectedState,
  QboDepositSnapshot,
  QboPreparedWrite,
  QboPurchaseExpectedState,
  QboPurchaseSnapshot,
} from '../../lib/qbo/types.js';
import {
  purchaseTargetLineMatches,
  purchaseTotalTaxMatches,
} from '../../lib/qbo/purchaseTax.js';

type PurchaseLine = QboPurchaseSnapshot['lines'][number];
type DepositLine = QboDepositSnapshot['lines'][number];

export type ExpectedPurchaseResult = QboPurchaseExpectedState;
export type ExpectedDepositResult = QboDepositExpectedState;

export type VerificationResult =
  | { ok: true }
  | { ok: false; code: 'QBO_STATE_DRIFT'; message: string };
export type PurchaseVerification = VerificationResult;

export function canonicalPurchaseLineHash(line: PurchaseLine): string {
  return JSON.stringify([
    line.rawHash,
    line.id,
    line.amountCents,
    line.description,
    line.accountQboId,
    line.customerQboId,
    line.classQboId,
    line.taxCodeQboId,
    line.taxAmountCents,
    line.taxInclusiveCents,
  ]);
}

function targetLineHash(line: PurchaseLine): string {
  return JSON.stringify([
    line.amountCents,
    line.description,
    line.accountQboId,
    line.customerQboId,
    line.classQboId,
    line.taxCodeQboId,
    effectiveLineTaxCents(line),
    line.taxInclusiveCents,
  ]);
}

function effectiveLineTaxCents(line: PurchaseLine): number | null {
  if (line.taxAmountCents !== null) return line.taxAmountCents;
  if (line.taxInclusiveCents === null) return null;
  return line.taxInclusiveCents - line.amountCents;
}

function omittedInclusiveTotalTaxMatches(
  expectedTotalTaxCents: number | null,
  actual: QboPurchaseSnapshot,
): boolean {
  if (actual.totalTaxCents === expectedTotalTaxCents) return true;
  if (
    actual.totalTaxCents !== null
    || expectedTotalTaxCents === null
    || actual.globalTaxCalculation !== 'TaxInclusive'
  ) {
    return false;
  }
  let derivedTotalTaxCents = 0;
  for (const line of actual.lines) {
    const lineTaxCents = effectiveLineTaxCents(line);
    if (lineTaxCents === null) {
      if (line.taxCodeQboId !== null) return false;
      continue;
    }
    derivedTotalTaxCents += lineTaxCents;
  }
  return derivedTotalTaxCents === expectedTotalTaxCents;
}
export function canonicalDepositLineHash(line: DepositLine): string {
  return JSON.stringify([
    line.rawHash,
    line.id,
    line.amountCents,
    line.description,
    line.accountQboId,
    line.entityQboId,
    line.paymentMethodQboId,
    line.classQboId,
    line.taxCodeQboId,
    line.taxApplicableOn,
  ]);
}

function targetDepositLineHash(line: DepositLine): string {
  return JSON.stringify([
    line.targetHash,
    line.amountCents,
    line.description,
    line.accountQboId,
    line.entityQboId,
    line.paymentMethodQboId,
    line.classQboId,
    line.taxCodeQboId,
    line.taxApplicableOn,
  ]);
}

function drift(message: string): VerificationResult {
  return { ok: false, code: 'QBO_STATE_DRIFT', message };
}

export function verifyPurchaseResult(
  expected: ExpectedPurchaseResult,
  actual: QboPurchaseSnapshot,
): PurchaseVerification {
  if (actual.qboId !== expected.qboId) return drift('Purchase ID changed.');
  if (actual.totalCents !== expected.totalCents) return drift('Purchase total changed.');
  if (actual.accountQboId !== expected.accountQboId) return drift('Purchase account changed.');
  if (actual.date !== expected.date) return drift('Purchase date changed.');
  if (actual.direction !== expected.direction) return drift('Purchase direction changed.');
  if (actual.globalTaxCalculation !== expected.globalTaxCalculation) return drift('Purchase global tax mode changed.');
  if (
    expected.taxDisposition === 'preserve_current'
    && (
      typeof expected.preservedHash !== 'string'
      || expected.preservedHash !== actual.preservedHash
    )
  ) {
    return drift('Purchase preserved fields changed.');
  }
  if (
    !purchaseTotalTaxMatches(
      expected.globalTaxCalculation,
      expected.totalTaxCents,
      actual.totalTaxCents,
    )
    && !omittedInclusiveTotalTaxMatches(expected.totalTaxCents, actual)
  ) {
    return drift('Purchase total tax changed.');
  }

  const remainingLines = [...actual.lines];
  for (const targetLine of expected.targetLines) {
    const targetIndex = remainingLines.findIndex((line) =>
      purchaseTargetLineMatches(
        expected.globalTaxCalculation,
        expected.totalTaxCents,
        actual.totalTaxCents,
        targetLine,
        line,
        expected.taxDisposition,
      ) || (
        expected.taxDisposition !== 'preserve_current'
        && targetLineHash(line) === targetLineHash(targetLine)
      ));
    if (targetIndex === -1) return drift('Expected target Purchase line is missing or changed.');
    remainingLines.splice(targetIndex, 1);
  }

  const actualUntouchedHashes = remainingLines.map(canonicalPurchaseLineHash).sort();
  const expectedUntouchedHashes = [...expected.untouchedLineHashes].sort();
  if (
    actualUntouchedHashes.length !== expectedUntouchedHashes.length ||
    actualUntouchedHashes.some((hash, index) => hash !== expectedUntouchedHashes[index])
  ) {
    return drift('Untouched Purchase lines changed.');
  }

  return { ok: true };
}

export function verifyDepositResult(
  expected: ExpectedDepositResult,
  actual: QboDepositSnapshot,
): VerificationResult {
  if (actual.qboId !== expected.qboId) return drift('Deposit ID changed.');
  if (actual.totalCents !== expected.totalCents) return drift('Deposit total changed.');
  if (actual.depositToAccountQboId !== expected.depositToAccountQboId) {
    return drift('Deposit account changed.');
  }
  if (actual.date !== expected.date) return drift('Deposit date changed.');
  if (actual.globalTaxCalculation !== expected.globalTaxCalculation) {
    return drift('Deposit global tax mode changed.');
  }
  if (actual.totalTaxCents !== expected.totalTaxCents) return drift('Deposit total tax changed.');
  if (actual.preservedHash !== expected.preservedHash) {
    return drift('Deposit preserved fields changed.');
  }

  const remainingLines = [...actual.lines];
  for (const untouchedHash of expected.untouchedLineHashes) {
    const untouchedIndex = remainingLines.findIndex(
      (line) => canonicalDepositLineHash(line) === untouchedHash,
    );
    if (untouchedIndex === -1) return drift('Untouched Deposit lines changed.');
    remainingLines.splice(untouchedIndex, 1);
  }
  for (const targetLine of expected.targetLines) {
    const targetIndex = remainingLines.findIndex(
      (line) =>
        (targetLine.id === null || line.id === targetLine.id) &&
        targetDepositLineHash(line) === targetDepositLineHash(targetLine),
    );
    if (targetIndex === -1) return drift('Expected target Deposit line is missing or changed.');
    remainingLines.splice(targetIndex, 1);
  }

  if (remainingLines.length !== 0) {
    return drift('Untouched Deposit lines changed.');
  }

  return { ok: true };
}

function isPurchaseSnapshot(
  actual: QboPurchaseSnapshot | QboDepositSnapshot,
): actual is QboPurchaseSnapshot {
  return (
    'accountQboId' in actual &&
    'direction' in actual &&
    !('depositToAccountQboId' in actual)
  );
}

function isDepositSnapshot(
  actual: QboPurchaseSnapshot | QboDepositSnapshot,
): actual is QboDepositSnapshot {
  return (
    'depositToAccountQboId' in actual &&
    !('accountQboId' in actual) &&
    !('direction' in actual)
  );
}

export function verifyPreparedResult(
  prepared: QboPreparedWrite,
  actual: QboPurchaseSnapshot | QboDepositSnapshot,
): VerificationResult {
  if (prepared.qboType === 'Purchase') {
    if (!isPurchaseSnapshot(actual)) {
      return drift('Prepared Purchase received a mismatched snapshot kind.');
    }
    return verifyPurchaseResult(prepared.expected, actual);
  }
  if (prepared.qboType === 'Deposit') {
    if (!isDepositSnapshot(actual)) {
      return drift('Prepared Deposit received a mismatched snapshot kind.');
    }
    return verifyDepositResult(prepared.expected, actual);
  }
  return drift('Prepared write has an unsupported transaction kind.');
}
