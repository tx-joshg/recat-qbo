import { createHash } from 'node:crypto';
import type { StagedCategorization } from '@recat/shared';
import {
  QboSyncTokenConflict,
  type QboDepositExpectedState,
  type QboDepositPreparedWrite,
  type QboDepositSnapshot,
  type QboPreparedWrite,
  type QboRef,
  type RawDeposit,
  type RawDepositLine,
} from './types.js';

export type QboDepositPreparationCode =
  | 'QBO_AMOUNT_UNSAFE'
  | 'QBO_DEPOSIT_UNSUPPORTED'
  | 'QBO_REFERENCE_MISSING'
  | 'QBO_STATE_DRIFT';

export class QboDepositPreparationError extends Error {
  constructor(
    public readonly code: QboDepositPreparationCode,
    message: string,
  ) {
    super(message);
    this.name = 'QboDepositPreparationError';
  }
}

const MAX_EXACT_MONEY_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 100);

function preparationError(code: QboDepositPreparationCode, message: string): never {
  throw new QboDepositPreparationError(code, message);
}

function exactCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Transaction money must be a finite number.');
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (
    !Number.isSafeInteger(cents) ||
    Math.abs(cents) > MAX_EXACT_MONEY_CENTS ||
    Math.abs(scaled - cents) > 1e-7
  ) {
    return preparationError(
      'QBO_AMOUNT_UNSAFE',
      'Transaction money is not representable as exact safe cents.',
    );
  }
  return cents;
}

function moneyFromCents(cents: number): number {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_EXACT_MONEY_CENTS) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared transaction cents exceed the exact money range.');
  }
  const money = cents / 100;
  if (exactCents(money) !== cents) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared transaction cents cannot be serialized exactly.');
  }
  return money;
}

function safeCentSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_EXACT_MONEY_CENTS) {
      return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared transaction cents are unsafe.');
    }
    total += value;
    if (!Number.isSafeInteger(total) || Math.abs(total) > MAX_EXACT_MONEY_CENTS) {
      return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared transaction cent total is unsafe.');
    }
  }
  return total;
}

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return preparationError('QBO_REFERENCE_MISSING', `Transaction ${label} is missing.`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (null === value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function normalizedClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function requestHash(body: RawDeposit): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function preservedDepositEntity(raw: RawDeposit): Record<string, unknown> {
  const {
    Id: _id,
    SyncToken: _syncToken,
    TotalAmt: _total,
    Line: _lines,
    GlobalTaxCalculation: _taxMode,
    TxnTaxDetail: _taxDetail,
    HomeTotalAmt: _homeTotal,
    MetaData: _metadata,
    status: _status,
    sparse: _sparse,
    domain: _domain,
    ...preserved
  } = raw;
  return preserved;
}

function stableTargetLine(raw: RawDepositLine): Record<string, unknown> {
  const detail = raw.DepositLineDetail;
  return {
    amount: raw.Amount ?? null,
    description: raw.Description ?? null,
    detailType: raw.DetailType ?? null,
    accountQboId: detail?.AccountRef?.value ?? null,
    entityQboId: detail?.Entity?.value ?? null,
    paymentMethodQboId: detail?.PaymentMethodRef?.value ?? null,
    classQboId: detail?.ClassRef?.value ?? null,
    taxCodeQboId: detail?.TaxCodeRef?.value ?? null,
    taxApplicableOn: detail?.TaxApplicableOn ?? null,
  };
}

function snapshotLine(raw: RawDepositLine): QboDepositSnapshot['lines'][number] {
  const detail = raw.DepositLineDetail;
  return {
    id: raw.Id ?? null,
    amountCents: exactCents(raw.Amount ?? 0),
    description: raw.Description ?? null,
    accountQboId: detail?.AccountRef?.value ?? null,
    entityQboId: detail?.Entity?.value ?? null,
    paymentMethodQboId: detail?.PaymentMethodRef?.value ?? null,
    classQboId: detail?.ClassRef?.value ?? null,
    taxCodeQboId: detail?.TaxCodeRef?.value ?? null,
    taxApplicableOn: detail?.TaxApplicableOn ?? null,
    rawHash: fingerprint(raw),
    targetHash: fingerprint(stableTargetLine(raw)),
  };
}

export function mapDepositSnapshot(raw: RawDeposit): QboDepositSnapshot {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray(raw.Line) ||
    typeof raw.Id !== 'string' ||
    raw.Id.trim() === '' ||
    typeof raw.SyncToken !== 'string' ||
    raw.SyncToken.trim() === '' ||
    typeof raw.TxnDate !== 'string' ||
    raw.TxnDate.trim() === '' ||
    raw.TotalAmt === undefined
  ) {
    return preparationError(
      'QBO_DEPOSIT_UNSUPPORTED',
      'Transaction is missing a complete identity, date, total, SyncToken, or Line array.',
    );
  }
  const depositToAccountQboId = requiredIdentity(
    raw.DepositToAccountRef?.value,
    'deposit account reference',
  );
  const lines = raw.Line.map(snapshotLine);
  const totalCents = exactCents(raw.TotalAmt);
  const derivedTotalTaxCents =
    raw.GlobalTaxCalculation === undefined
      ? null
      : safeCentSum([
          totalCents,
          -safeCentSum(lines.map((line) => line.amountCents)),
        ]);
  return {
    qboId: raw.Id,
    syncToken: raw.SyncToken,
    totalCents,
    depositToAccountQboId,
    date: raw.TxnDate,
    globalTaxCalculation: raw.GlobalTaxCalculation ?? null,
    totalTaxCents:
      raw.TxnTaxDetail?.TotalTax === undefined
        ? derivedTotalTaxCents
        : exactCents(raw.TxnTaxDetail.TotalTax),
    preservedHash: fingerprint(preservedDepositEntity(raw)),
    lines,
  };
}

function canonicalSnapshotLine(line: QboDepositSnapshot['lines'][number]): string {
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

function targetSnapshotLine(line: QboDepositSnapshot['lines'][number]): string {
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

function assertSnapshotEqualsBefore(actual: QboDepositSnapshot, before: QboDepositSnapshot): void {
  if (actual.syncToken !== before.syncToken) throw new QboSyncTokenConflict();
  if (
    canonicalJson({ ...actual, syncToken: undefined }) !==
    canonicalJson({ ...before, syncToken: undefined })
  ) {
    preparationError('QBO_STATE_DRIFT', 'Transaction changed after its before snapshot was stored.');
  }
}

function expectedBase(
  snapshot: QboDepositSnapshot,
  globalTaxCalculation: string | null,
  totalTaxCents: number | null,
): Omit<QboDepositExpectedState, 'targetLines' | 'untouchedLineHashes'> {
  return {
    qboId: snapshot.qboId,
    totalCents: snapshot.totalCents,
    depositToAccountQboId: snapshot.depositToAccountQboId,
    date: snapshot.date,
    globalTaxCalculation,
    totalTaxCents,
    preservedHash: snapshot.preservedHash,
  };
}

interface PreservedLineFields {
  entity?: QboRef;
  paymentMethod?: QboRef;
  classRef?: QboRef;
}

const RESTORABLE_LINE_FIELDS = new Set([
  'Id',
  'LineNum',
  'Amount',
  'Description',
  'DetailType',
  'DepositLineDetail',
  'CustomExtensions',
]);

const RESTORABLE_DETAIL_FIELDS = new Set([
  'AccountRef',
  'Entity',
  'PaymentMethodRef',
  'ClassRef',
  'TaxCodeRef',
  'TaxApplicableOn',
]);
const RESTORABLE_REFERENCE_FIELDS = new Set(['value', 'name']);
const DETAIL_REFERENCE_FIELDS = [
  'AccountRef',
  'Entity',
  'PaymentMethodRef',
  'ClassRef',
  'TaxCodeRef',
] as const;

function hasUnsupportedReferenceField(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).some((field) => !RESTORABLE_REFERENCE_FIELDS.has(field));
}

function assertRestorableHoldingLine(line: RawDepositLine): void {
  const unsupportedLineField = Object.keys(line).find(
    (field) => !RESTORABLE_LINE_FIELDS.has(field),
  );
  const unsupportedCustomExtensions = line.CustomExtensions !== undefined &&
    (!Array.isArray(line.CustomExtensions) || line.CustomExtensions.length !== 0);
  const detail = line.DepositLineDetail;
  const unsupportedDetailField = detail === undefined
    ? undefined
    : Object.keys(detail).find((field) => !RESTORABLE_DETAIL_FIELDS.has(field));
  const unsupportedReferenceField = detail === undefined
    ? undefined
    : DETAIL_REFERENCE_FIELDS.find((field) => hasUnsupportedReferenceField(detail[field]));
  if (
    unsupportedLineField === undefined &&
    !unsupportedCustomExtensions &&
    unsupportedDetailField === undefined &&
    unsupportedReferenceField === undefined
  ) return;
  preparationError(
    'QBO_DEPOSIT_UNSUPPORTED',
    'Holding transaction line contains fields that cannot be preserved through verified undo.',
  );
}

function optionalReference(value: unknown, label: string): QboRef | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return preparationError('QBO_REFERENCE_MISSING', `Transaction ${label} is malformed.`);
  }
  const reference = value as Record<string, unknown>;
  requiredIdentity(reference.value, label);
  if (reference.name !== undefined && typeof reference.name !== 'string') {
    return preparationError('QBO_REFERENCE_MISSING', `Transaction ${label} is malformed.`);
  }
  return normalizedClone(value as QboRef);
}

function stagedLineToRaw(
  line: StagedCategorization['lines'][number],
  taxCalculation: StagedCategorization['taxCalculation'],
  preserved: PreservedLineFields,
  replacedLine?: RawDepositLine,
  preserveReplacedLineId = true,
): RawDepositLine {
  const accountQboId = requiredIdentity(line.categoryQboId, 'category account reference');
  const description = line.memo ?? replacedLine?.Description;
  if (line.idx < 0 || !Number.isSafeInteger(line.idx)) {
    preparationError('QBO_DEPOSIT_UNSUPPORTED', 'Transaction split indexes must be non-negative integers.');
  }
  const detail: NonNullable<RawDepositLine['DepositLineDetail']> = {
    AccountRef: { value: accountQboId },
    ...(preserved.entity === undefined ? {} : { Entity: preserved.entity }),
    ...(preserved.paymentMethod === undefined
      ? {}
      : { PaymentMethodRef: preserved.paymentMethod }),
    ...(preserved.classRef === undefined ? {} : { ClassRef: preserved.classRef }),
  };
  if (taxCalculation !== 'NotApplicable') {
    detail.TaxCodeRef = {
      value: requiredIdentity(line.taxCodeQboId, 'tax code reference'),
    };
    detail.TaxApplicableOn = 'Sales';
  } else if (line.taxCodeQboId !== null) {
    preparationError('QBO_DEPOSIT_UNSUPPORTED', 'NotApplicable transaction lines cannot carry a tax code.');
  }
  return {
    ...(replacedLine?.Id === undefined || !preserveReplacedLineId
      ? {}
      : { Id: requiredIdentity(replacedLine.Id, 'holding line id') }),
    // QBO Deposit lines are net amounts even when GlobalTaxCalculation says
    // TaxInclusive; QBO computes and adds the selected sales tax separately.
    Amount: moneyFromCents(line.subtotalCents),
    DetailType: 'DepositLineDetail',
    ...(description === undefined ? {} : { Description: description }),
    DepositLineDetail: detail,
  };
}

function assertStagedAmounts(
  staged: StagedCategorization,
  current: QboDepositSnapshot,
  holdingLineIndexes: readonly number[],
): void {
  if (staged.lines.length === 0) {
    preparationError('QBO_DEPOSIT_UNSUPPORTED', 'Prepared transaction requires at least one split line.');
  }
  if (staged.lines.some((line, position) => line.idx !== position)) {
    preparationError('QBO_DEPOSIT_UNSUPPORTED', 'Prepared transaction split indexes must be contiguous.');
  }
  for (const line of staged.lines) {
    safeCentSum([line.subtotalCents, line.taxCents, line.totalCents]);
    if (safeCentSum([line.subtotalCents, line.taxCents]) !== line.totalCents) {
      preparationError('QBO_STATE_DRIFT', 'Prepared transaction split tax cents do not balance.');
    }
    if (
      line.subtotalCents < 0 ||
      line.taxCents < 0 ||
      line.totalCents <= 0
    ) {
      preparationError('QBO_DEPOSIT_UNSUPPORTED', 'Prepared transaction cents must be positive.');
    }
    if (staged.taxCalculation === 'NotApplicable' && line.taxCents !== 0) {
      preparationError(
        'QBO_DEPOSIT_UNSUPPORTED',
        'NotApplicable transaction lines must have zero tax cents.',
      );
    }
  }
  const totals = {
    subtotalCents: safeCentSum(staged.lines.map((line) => line.subtotalCents)),
    taxCents: safeCentSum(staged.lines.map((line) => line.taxCents)),
    totalCents: safeCentSum(staged.lines.map((line) => line.totalCents)),
  };
  if (canonicalJson(totals) !== canonicalJson(staged.totals)) {
    preparationError('QBO_STATE_DRIFT', 'Prepared transaction totals do not match its split lines.');
  }
  const holdingTotal = safeCentSum(
    holdingLineIndexes.map((index) => current.lines[index]!.amountCents),
  );
  if (holdingTotal !== staged.totals.totalCents) {
    preparationError(
      'QBO_STATE_DRIFT',
      'Prepared transaction total changed from the holding-account amount.',
    );
  }
}

function preservedFields(lines: readonly RawDepositLine[]): PreservedLineFields {
  const modeled = lines.map((line) => ({
    entity: optionalReference(line.DepositLineDetail?.Entity, 'payer reference'),
    paymentMethod: optionalReference(
      line.DepositLineDetail?.PaymentMethodRef,
      'payment method reference',
    ),
    classRef: optionalReference(line.DepositLineDetail?.ClassRef, 'class reference'),
  }));
  const first = modeled[0]!;
  if (modeled.some((candidate) => canonicalJson(candidate) !== canonicalJson(first))) {
    preparationError(
      'QBO_DEPOSIT_UNSUPPORTED',
      'Holding transaction lines have incompatible payer, payment method, or class fields.',
    );
  }
  return normalizedClone(first);
}

export function prepareDepositRecategorization(args: {
  current: RawDeposit;
  holdingAccountQboIds: readonly string[];
  staged: StagedCategorization;
  before: QboDepositSnapshot;
  requestId: string;
}): QboDepositPreparedWrite {
  requiredIdentity(args.requestId, 'request id');
  if (args.holdingAccountQboIds.length === 0) {
    preparationError('QBO_REFERENCE_MISSING', 'Transaction holding-account references are missing.');
  }
  const holdingIds = new Set(
    args.holdingAccountQboIds.map((id) => requiredIdentity(id, 'holding account reference')),
  );
  const current = mapDepositSnapshot(args.current);
  assertSnapshotEqualsBefore(current, args.before);

  const holdingLineIndexes: number[] = [];
  const holdingRawLines: RawDepositLine[] = [];
  const keptRawLines: RawDepositLine[] = [];
  const keptSnapshotLines: QboDepositSnapshot['lines'] = [];
  for (const [index, rawLine] of args.current.Line!.entries()) {
    const accountQboId = rawLine.DepositLineDetail?.AccountRef?.value;
    if (accountQboId !== undefined && holdingIds.has(accountQboId)) {
      if (
        rawLine.DetailType !== 'DepositLineDetail' ||
        rawLine.Id === undefined ||
        rawLine.Amount === undefined ||
        accountQboId.trim() === ''
      ) {
        preparationError('QBO_DEPOSIT_UNSUPPORTED', 'Holding transaction line has an unsupported shape.');
      }
      assertRestorableHoldingLine(rawLine);
      exactCents(rawLine.Amount);
      holdingLineIndexes.push(index);
      holdingRawLines.push(rawLine);
    } else {
      keptRawLines.push(rawLine);
      keptSnapshotLines.push(current.lines[index]!);
    }
  }
  if (holdingLineIndexes.length === 0) {
    preparationError('QBO_STATE_DRIFT', 'Transaction no longer has an eligible holding-account line.');
  }
  if (
    args.staged.lines.length !== holdingRawLines.length
    && holdingRawLines.length !== 1
  ) {
    preparationError(
      'QBO_DEPOSIT_UNSUPPORTED',
      'Prepared transaction must update every holding-account line in place.',
    );
  }
  assertStagedAmounts(args.staged, current, holdingLineIndexes);

  const keptTaxBearing = keptSnapshotLines.some(
    (line) => line.taxCodeQboId !== null || line.taxApplicableOn !== null,
  );
  if (keptTaxBearing && args.staged.taxCalculation !== current.globalTaxCalculation) {
    preparationError(
      'QBO_DEPOSIT_UNSUPPORTED',
      'Transaction tax mode cannot change while untouched tax-bearing lines remain.',
    );
  }
  const replacedTaxBearing = holdingLineIndexes.some(
    (index) =>
      current.lines[index]!.taxCodeQboId !== null ||
      current.lines[index]!.taxApplicableOn !== null,
  );
  const keptNonzeroTaxBearing = keptSnapshotLines.some(
    (line) =>
      line.amountCents !== 0 &&
      (line.taxCodeQboId !== null || line.taxApplicableOn !== null),
  );
  let keptTaxCents: number;
  if (!keptNonzeroTaxBearing) {
    keptTaxCents = 0;
  } else if (current.totalTaxCents !== null && !replacedTaxBearing) {
    keptTaxCents = current.totalTaxCents;
  } else {
    preparationError(
      'QBO_DEPOSIT_UNSUPPORTED',
      'Transaction tax for untouched lines cannot be proven exactly.',
    );
  }

  const preserved = preservedFields(holdingRawLines);
  const newRawLines = args.staged.lines.map((line, index) =>
    stagedLineToRaw(
      line,
      args.staged.taxCalculation,
      preserved,
      holdingRawLines[holdingRawLines.length === 1 ? 0 : index],
      holdingRawLines.length !== 1 || index === 0,
    ));
  const newSnapshotLines = newRawLines.map(snapshotLine);
  const totalTaxCents = safeCentSum([keptTaxCents, args.staged.totals.taxCents]);
  const {
    TxnTaxDetail: _staleTaxDetail,
    HomeTotalAmt: _homeTotal,
    status: _cdcStatus,
    ...writeable
  } = args.current;
  const body: RawDeposit = normalizedClone({
    ...writeable,
    SyncToken: current.syncToken,
    Line: [...keptRawLines, ...newRawLines],
    GlobalTaxCalculation: args.staged.taxCalculation,
  });
  return deepFreeze({
    operation: 'recategorize',
    qboType: 'Deposit',
    qboId: current.qboId,
    requestId: args.requestId,
    requestHash: requestHash(body),
    body,
    before: normalizedClone(args.before),
    expected: {
      ...expectedBase(current, args.staged.taxCalculation, totalTaxCents),
      targetLines: newSnapshotLines,
      untouchedLineHashes: keptSnapshotLines.map(canonicalSnapshotLine),
    },
  });
}

function assertExpectedCurrent(
  expected: QboDepositExpectedState,
  actual: QboDepositSnapshot,
): number[] {
  if (
    actual.qboId !== expected.qboId ||
    actual.totalCents !== expected.totalCents ||
    actual.depositToAccountQboId !== expected.depositToAccountQboId ||
    actual.date !== expected.date ||
    actual.globalTaxCalculation !== expected.globalTaxCalculation ||
    actual.totalTaxCents !== expected.totalTaxCents ||
    actual.preservedHash !== expected.preservedHash
  ) {
    return preparationError('QBO_STATE_DRIFT', 'Transaction fields drifted before restore preparation.');
  }
  const remaining = actual.lines.map((line, index) => ({ line, index }));
  for (const untouchedHash of expected.untouchedLineHashes) {
    const index = remaining.findIndex(
      ({ line }) => canonicalSnapshotLine(line) === untouchedHash,
    );
    if (index === -1) {
      return preparationError('QBO_STATE_DRIFT', 'Untouched transaction lines drifted before restore.');
    }
    remaining.splice(index, 1);
  }
  const targetIndexes: number[] = [];
  for (const target of expected.targetLines) {
    const index = remaining.findIndex(
      ({ line }) =>
        (target.id === null || line.id === target.id) &&
        targetSnapshotLine(line) === targetSnapshotLine(target),
    );
    if (index === -1) {
      return preparationError('QBO_STATE_DRIFT', 'Prepared transaction target line drifted before restore.');
    }
    targetIndexes.push(remaining[index]!.index);
    remaining.splice(index, 1);
  }
  if (remaining.length !== 0) {
    return preparationError('QBO_STATE_DRIFT', 'Unexpected transaction lines appeared before restore.');
  }
  return targetIndexes;
}

function beforeTargetLines(
  prepared: QboDepositPreparedWrite,
): QboDepositSnapshot['lines'] {
  const remaining = [...prepared.before.lines];
  for (const untouchedHash of prepared.expected.untouchedLineHashes) {
    const index = remaining.findIndex(
      (line) => canonicalSnapshotLine(line) === untouchedHash,
    );
    if (index === -1) {
      return preparationError(
        'QBO_DEPOSIT_UNSUPPORTED',
        'Stored before snapshot cannot identify restore target lines.',
      );
    }
    remaining.splice(index, 1);
  }
  if (remaining.length === 0) {
    preparationError('QBO_DEPOSIT_UNSUPPORTED', 'Stored before snapshot has no restore target lines.');
  }
  return remaining;
}

function snapshotLineToRaw(line: QboDepositSnapshot['lines'][number]): RawDepositLine {
  const accountQboId = requiredIdentity(line.accountQboId, 'restore account reference');
  return {
    ...(line.id === null ? {} : { Id: line.id }),
    Amount: moneyFromCents(line.amountCents),
    ...(line.description === null ? {} : { Description: line.description }),
    DetailType: 'DepositLineDetail',
    DepositLineDetail: {
      AccountRef: { value: accountQboId },
      ...(line.entityQboId === null ? {} : { Entity: { value: line.entityQboId } }),
      ...(line.paymentMethodQboId === null
        ? {}
        : { PaymentMethodRef: { value: line.paymentMethodQboId } }),
      ...(line.classQboId === null ? {} : { ClassRef: { value: line.classQboId } }),
      ...(line.taxCodeQboId === null ? {} : { TaxCodeRef: { value: line.taxCodeQboId } }),
      ...(line.taxApplicableOn === null ? {} : { TaxApplicableOn: line.taxApplicableOn }),
    },
  };
}

function restoreLinesInBeforeOrder(
  before: QboDepositSnapshot,
  keptRaw: readonly RawDepositLine[],
  keptSnapshot: readonly QboDepositSnapshot['lines'][number][],
): RawDepositLine[] {
  const untouched = keptSnapshot.map((snapshot, index) => ({
    hash: canonicalSnapshotLine(snapshot),
    raw: keptRaw[index]!,
  }));
  return before.lines.map((line) => {
    const hash = canonicalSnapshotLine(line);
    const untouchedIndex = untouched.findIndex((candidate) => candidate.hash === hash);
    if (untouchedIndex === -1) return snapshotLineToRaw(line);
    const [match] = untouched.splice(untouchedIndex, 1);
    return match!.raw;
  });
}

export function prepareDepositRestore(args: {
  current: RawDeposit;
  prepared: QboPreparedWrite;
  requestId: string;
}): QboDepositPreparedWrite {
  requiredIdentity(args.requestId, 'request id');
  if (args.prepared.operation !== 'recategorize' || args.prepared.qboType !== 'Deposit') {
    preparationError(
      'QBO_DEPOSIT_UNSUPPORTED',
      'Only a prepared Deposit recategorization can be restored.',
    );
  }
  const current = mapDepositSnapshot(args.current);
  const targetIndexes = new Set(assertExpectedCurrent(args.prepared.expected, current));
  const targetsBefore = beforeTargetLines(args.prepared);
  const keptRaw = args.current.Line!.filter((_line, index) => !targetIndexes.has(index));
  const keptSnapshot = current.lines.filter((_line, index) => !targetIndexes.has(index));
  const restoredLines = restoreLinesInBeforeOrder(args.prepared.before, keptRaw, keptSnapshot);
  const {
    TxnTaxDetail: _staleTaxDetail,
    HomeTotalAmt: _homeTotal,
    status: _cdcStatus,
    ...writeable
  } = args.current;
  const body: RawDeposit = normalizedClone({
    ...writeable,
    SyncToken: current.syncToken,
    Line: restoredLines,
    GlobalTaxCalculation: args.prepared.before.globalTaxCalculation ?? undefined,
  });
  return deepFreeze({
    operation: 'restore',
    qboType: 'Deposit',
    qboId: current.qboId,
    requestId: args.requestId,
    requestHash: requestHash(body),
    body,
    before: normalizedClone(current),
    expected: {
      ...expectedBase(
        args.prepared.before,
        args.prepared.before.globalTaxCalculation,
        args.prepared.before.totalTaxCents,
      ),
      targetLines: targetsBefore.map((line) => snapshotLine(snapshotLineToRaw(line))),
      untouchedLineHashes: keptSnapshot.map(canonicalSnapshotLine),
    },
  });
}
