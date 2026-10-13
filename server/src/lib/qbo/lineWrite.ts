import { createHash } from 'node:crypto';
import type {
  QboLineWriteResult,
  QboLineWriteSnapshot,
  QboLineWriteSplit,
  QboPreparedLineWrite,
  QboTxn,
  RawDeposit,
  RawDepositLine,
  RawJournalEntry,
  RawJournalEntryLine,
  RawPurchase,
  RawPurchaseLine,
} from './types.js';

const GENERATED_TOP_LEVEL_FIELDS = new Set([
  'Id',
  'SyncToken',
  'MetaData',
  'domain',
  'sparse',
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error('Prepared line write contains malformed Unicode.');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Prepared line write contains malformed Unicode.');
    }
  }
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertWellFormedUnicode(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('Prepared line write contains an invalid JSON number.');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('Prepared line write must contain JSON values only.');
  }
  if (ancestors.has(value)) {
    throw new Error('Prepared line write must not contain cyclic values.');
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.prototype.hasOwnProperty.call(Array.prototype, 'toJSON') ||
      Object.prototype.hasOwnProperty.call(Object.prototype, 'toJSON')
    ) {
      throw new Error('Prepared line write must contain plain JSON arrays only.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number'
    ) {
      throw new Error('Prepared line write must contain plain JSON arrays only.');
    }
    for (const key of keys) {
      if (key === 'length') continue;
      if (
        typeof key !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw new Error('Prepared line write contains non-JSON array properties.');
      }
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('Prepared line write must use enumerable data properties only.');
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('Prepared line write must use data properties only.');
      }
      assertJsonValue(descriptor.value, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      (prototype === Object.prototype &&
        Object.prototype.hasOwnProperty.call(Object.prototype, 'toJSON'))
    ) {
      throw new Error('Prepared line write must contain plain JSON objects only.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new Error('Prepared line write contains non-JSON object properties.');
      }
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        throw new Error('Prepared line write must use enumerable data properties only.');
      }
      assertWellFormedUnicode(key);
      assertJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeContent(
  value: unknown,
  location: 'top' | 'line' | 'nested',
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeContent(item, 'nested'));
  }

  const record = value as Record<string, unknown>;
  const reference = typeof record.value === 'string';
  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (location === 'top' && GENERATED_TOP_LEVEL_FIELDS.has(key)) continue;
    if (location === 'line' && key === 'Id') continue;
    if (reference && key === 'name') continue;
    if (location === 'top' && key === 'Line' && Array.isArray(item)) {
      sanitized[key] = item.map((line) => sanitizeContent(line, 'line'));
    } else {
      sanitized[key] = sanitizeContent(item, 'nested');
    }
  }
  return sanitized;
}

export function hashLineWriteContent(body: unknown): string {
  assertJsonValue(body);
  if (!isRecord(body)) {
    throw new Error('Prepared line write body must be a JSON object.');
  }
  return sha256(sanitizeContent(body, 'top'));
}

export function serializeLineWriteRequest(body: unknown): string {
  assertJsonValue(body);
  if (!isRecord(body)) {
    throw new Error('Prepared line write body must be a JSON object.');
  }
  return canonicalJson(body);
}

export function hashLineWriteRequest(body: unknown): string {
  return createHash('sha256')
    .update(serializeLineWriteRequest(body))
    .digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isQboType(value: unknown): value is QboTxn['qboType'] {
  return value === 'Purchase' || value === 'Deposit' || value === 'JournalEntry';
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function assertSnapshotShape(
  value: unknown,
  requireSyncToken: boolean,
): asserts value is QboLineWriteSnapshot | Omit<QboLineWriteSnapshot, 'syncToken'> {
  assertJsonValue(value);
  if (
    !isRecord(value) ||
    !isQboType(value.qboType) ||
    !isNonEmptyString(value.qboId) ||
    !isHash(value.contentHash) ||
    (requireSyncToken && !isNonEmptyString(value.syncToken)) ||
    (!requireSyncToken && value.syncToken !== undefined)
  ) {
    throw new Error('Prepared line write contains an invalid snapshot.');
  }
}

export function validatePreparedLineWrite(
  value: unknown,
): QboPreparedLineWrite {
  assertJsonValue(value);
  if (
    !isRecord(value) ||
    value.operation !== 'transfer' ||
    !isQboType(value.qboType) ||
    !isNonEmptyString(value.qboId) ||
    !isNonEmptyString(value.requestId) ||
    !isHash(value.requestHash) ||
    !isRecord(value.body)
  ) {
    throw new Error('Invalid prepared line write.');
  }

  assertSnapshotShape(value.before, true);
  assertSnapshotShape(value.expected, false);
  const before = value.before as QboLineWriteSnapshot;
  const expected = value.expected as Omit<QboLineWriteSnapshot, 'syncToken'>;
  if (
    before.qboType !== value.qboType ||
    before.qboId !== value.qboId ||
    expected.qboType !== value.qboType ||
    expected.qboId !== value.qboId ||
    value.body.Id !== value.qboId ||
    value.body.SyncToken !== before.syncToken
  ) {
    throw new Error('Prepared line write identity binding is invalid.');
  }
  if (hashLineWriteRequest(value.body) !== value.requestHash) {
    throw new Error('Prepared line write request hash does not match its body.');
  }
  if (hashLineWriteContent(value.body) !== expected.contentHash) {
    throw new Error('Prepared line write expected hash does not match its body.');
  }
  if (before.contentHash === expected.contentHash) {
    throw new Error('Prepared line write does not change accounting content.');
  }
  return value as unknown as QboPreparedLineWrite;
}

export function rebuildPurchaseLines(
  raw: RawPurchase,
  replaceIds: ReadonlySet<string>,
  newLines: QboLineWriteSplit[],
): RawPurchaseLine[] {
  return rebuildPurchaseLinesWhere(raw, (line) => {
    const id = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
    return id !== undefined && replaceIds.has(id);
  }, newLines);
}

function rebuildPurchaseLinesWhere(
  raw: RawPurchase,
  isReplaced: (line: RawPurchaseLine) => boolean,
  newLines: QboLineWriteSplit[],
): RawPurchaseLine[] {
  const lines = raw.Line ?? [];
  const replaced = lines.filter(isReplaced);
  if (replaced.length === 1 && newLines.length === 1) {
    const split = newLines[0]!;
    return lines.map((line) => {
      if (!isReplaced(line)) return line;
      const updated = { ...line };
      delete updated.Description;
      return {
        ...updated,
        Amount: round2(Math.abs(split.amount)),
        DetailType: 'AccountBasedExpenseLineDetail',
        ...(split.memo === undefined ? {} : { Description: split.memo }),
        AccountBasedExpenseLineDetail: {
          ...line.AccountBasedExpenseLineDetail,
          AccountRef: { value: split.accountQboId },
        },
      };
    });
  }
  const keep = lines.filter((line) => !isReplaced(line));
  return [
    ...keep,
    ...newLines.map(
      (split): RawPurchaseLine => ({
        Amount: round2(Math.abs(split.amount)),
        DetailType: 'AccountBasedExpenseLineDetail',
        ...(split.memo === undefined ? {} : { Description: split.memo }),
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: split.accountQboId },
        },
      }),
    ),
  ];
}

export function rebuildDepositLines(
  raw: RawDeposit,
  replaceIds: ReadonlySet<string>,
  newLines: QboLineWriteSplit[],
): RawDepositLine[] {
  return rebuildDepositLinesWhere(raw, (line) => {
    const id = line.DepositLineDetail?.AccountRef?.value;
    return id !== undefined && replaceIds.has(id);
  }, newLines);
}

function rebuildDepositLinesWhere(
  raw: RawDeposit,
  isReplaced: (line: RawDepositLine) => boolean,
  newLines: QboLineWriteSplit[],
): RawDepositLine[] {
  const lines = raw.Line ?? [];
  const replaced = lines.filter(isReplaced);
  if (replaced.length === 1 && newLines.length === 1) {
    const split = newLines[0]!;
    return lines.map((line) => {
      if (!isReplaced(line)) return line;
      const updated = { ...line };
      delete updated.Description;
      return {
        ...updated,
        Amount: round2(Math.abs(split.amount)),
        DetailType: 'DepositLineDetail',
        ...(split.memo === undefined ? {} : { Description: split.memo }),
        DepositLineDetail: {
          ...line.DepositLineDetail,
          AccountRef: { value: split.accountQboId },
        },
      };
    });
  }
  const keep = lines.filter((line) => !isReplaced(line));
  const entity = replaced[0]?.DepositLineDetail?.Entity;
  return [
    ...keep,
    ...newLines.map(
      (split): RawDepositLine => ({
        Amount: round2(Math.abs(split.amount)),
        DetailType: 'DepositLineDetail',
        ...(split.memo === undefined ? {} : { Description: split.memo }),
        DepositLineDetail: {
          AccountRef: { value: split.accountQboId },
          ...(entity === undefined ? {} : { Entity: entity }),
        },
      }),
    ),
  ];
}

export function rebuildJournalEntryLines(
  raw: RawJournalEntry,
  replaceIds: ReadonlySet<string>,
  newLines: QboLineWriteSplit[],
): RawJournalEntryLine[] {
  return rebuildJournalEntryLinesWhere(raw, (line) => {
    const detail = line.JournalEntryLineDetail;
    const id = detail?.AccountRef?.value;
    return (
      detail?.PostingType === 'Debit'
      && id !== undefined
      && replaceIds.has(id)
    );
  }, newLines);
}

function rebuildJournalEntryLinesWhere(
  raw: RawJournalEntry,
  isReplaced: (line: RawJournalEntryLine) => boolean,
  newLines: QboLineWriteSplit[],
): RawJournalEntryLine[] {
  const lines = raw.Line ?? [];
  const replaced = lines.filter(isReplaced);
  if (replaced.length === 1 && newLines.length === 1) {
    const split = newLines[0]!;
    return lines.map((line) => {
      if (!isReplaced(line)) return line;
      const updated = { ...line };
      delete updated.Description;
      return {
        ...updated,
        Amount: round2(Math.abs(split.amount)),
        DetailType: 'JournalEntryLineDetail',
        ...(split.memo === undefined ? {} : { Description: split.memo }),
        JournalEntryLineDetail: {
          ...line.JournalEntryLineDetail,
          PostingType: 'Debit',
          AccountRef: { value: split.accountQboId },
        },
      };
    });
  }
  const keep = lines.filter((line) => !isReplaced(line));
  return [
    ...keep,
    ...newLines.map(
      (split): RawJournalEntryLine => ({
        Amount: round2(Math.abs(split.amount)),
        DetailType: 'JournalEntryLineDetail',
        ...(split.memo === undefined ? {} : { Description: split.memo }),
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: split.accountQboId },
        },
      }),
    ),
  ];
}

function holdingLineCount(
  txn: QboTxn,
  holdingIds: ReadonlySet<string>,
): number {
  if (txn.qboType === 'Purchase') {
    return ((txn.raw as RawPurchase).Line ?? []).filter((line) => {
      const id = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
      return id !== undefined && holdingIds.has(id);
    }).length;
  }
  if (txn.qboType === 'Deposit') {
    return ((txn.raw as RawDeposit).Line ?? []).filter((line) => {
      const id = line.DepositLineDetail?.AccountRef?.value;
      return id !== undefined && holdingIds.has(id);
    }).length;
  }
  return ((txn.raw as RawJournalEntry).Line ?? []).filter((line) => {
    const detail = line.JournalEntryLineDetail;
    const id = detail?.AccountRef?.value;
    return (
      detail?.PostingType === 'Debit'
      && id !== undefined
      && holdingIds.has(id)
    );
  }).length;
}

/**
 * Pure full-entity transformation used by both QBO clients and by durable
 * transfer preparation to independently reconstruct the only authorized body.
 */
export function buildPreparedLineWrite(args: {
  txn: QboTxn;
  splits: QboLineWriteSplit[];
  requestId: string;
  holdingAccountQboIds: readonly string[];
}): QboPreparedLineWrite {
  const { txn, splits, requestId } = args;
  if (!isRecord(txn.raw)) {
    throw new Error('QuickBooks transaction raw body is not a JSON object.');
  }
  if (
    txn.raw.Id !== txn.qboId
    || txn.raw.SyncToken !== txn.syncToken
    || !isNonEmptyString(requestId)
    || splits.length === 0
    || splits.some((split) =>
      !Number.isFinite(split.amount)
      || !isNonEmptyString(split.accountQboId)
      || (
        split.memo !== undefined
        && typeof split.memo !== 'string'
      )
    )
  ) {
    throw new Error('Line write transformation input is invalid.');
  }
  const holdingIds = new Set(
    args.holdingAccountQboIds.filter(isNonEmptyString),
  );
  if (
    holdingIds.size === 0
    || holdingLineCount(txn, holdingIds) === 0
  ) {
    throw new Error('Line write transformation found no holding-account lines.');
  }

  const body: Record<string, unknown> = {
    ...txn.raw,
    Id: txn.qboId,
    SyncToken: txn.syncToken,
    Line: txn.qboType === 'Purchase'
      ? rebuildPurchaseLines(
          txn.raw as unknown as RawPurchase,
          holdingIds,
          splits,
        )
      : txn.qboType === 'Deposit'
        ? rebuildDepositLines(
            txn.raw as unknown as RawDeposit,
            holdingIds,
            splits,
          )
        : rebuildJournalEntryLines(
            txn.raw as unknown as RawJournalEntry,
            holdingIds,
            splits,
          ),
  };
  return validatePreparedLineWrite({
    operation: 'transfer',
    qboType: txn.qboType,
    qboId: txn.qboId,
    requestId,
    requestHash: hashLineWriteRequest(body),
    body,
    before: {
      qboType: txn.qboType,
      qboId: txn.qboId,
      syncToken: txn.syncToken,
      contentHash: hashLineWriteContent(txn.raw),
    },
    expected: {
      qboType: txn.qboType,
      qboId: txn.qboId,
      contentHash: hashLineWriteContent(body),
    },
  });
}

export type LineRestoreErrorCode =
  | 'POSTED_LINES_CHANGED'
  | 'POSTED_LINES_AMBIGUOUS';

const LINE_RESTORE_MESSAGES: Readonly<Record<LineRestoreErrorCode, string>> = {
  POSTED_LINES_CHANGED:
    'The lines this post wrote are no longer on the transaction in QuickBooks. Undo it there instead.',
  POSTED_LINES_AMBIGUOUS:
    'This transaction has another line with the same category and amount, so it is not clear which line the post wrote. Undo it in QuickBooks instead.',
};

export class LineRestoreError extends Error {
  constructor(readonly code: LineRestoreErrorCode) {
    super(LINE_RESTORE_MESSAGES[code]);
    this.name = 'LineRestoreError';
  }
}

interface CategoryLine {
  id: string | undefined;
  accountQboId: string | undefined;
  amountCents: number;
}

function categoryLines(txn: QboTxn): CategoryLine[] {
  const cents = (amount: number | undefined): number =>
    Math.round(Math.abs(amount ?? 0) * 100);
  if (txn.qboType === 'Purchase') {
    return ((txn.raw as RawPurchase).Line ?? []).map((line) => ({
      id: line.Id,
      accountQboId: line.AccountBasedExpenseLineDetail?.AccountRef?.value,
      amountCents: cents(line.Amount),
    }));
  }
  if (txn.qboType === 'Deposit') {
    return ((txn.raw as RawDeposit).Line ?? []).map((line) => ({
      id: line.Id,
      accountQboId: line.DepositLineDetail?.AccountRef?.value,
      amountCents: cents(line.Amount),
    }));
  }
  return ((txn.raw as RawJournalEntry).Line ?? [])
    .filter((line) => line.JournalEntryLineDetail?.PostingType === 'Debit')
    .map((line) => ({
      id: line.Id,
      accountQboId: line.JournalEntryLineDetail?.AccountRef?.value,
      amountCents: cents(line.Amount),
    }));
}

/**
 * The QBO line ids a previous post wrote, matched by exact category and cents.
 * Lines the bookkeeper categorized themselves are never selected: if a posted
 * line cannot be found, or another line has the same category and amount,
 * the undo is refused rather than guessing.
 */
export function findPostedLineIds(
  txn: QboTxn,
  postedLines: readonly QboLineWriteSplit[],
): string[] {
  const needed = new Map<string, number>();
  for (const line of postedLines) {
    const key = `${line.accountQboId}|${Math.round(Math.abs(line.amount) * 100)}`;
    needed.set(key, (needed.get(key) ?? 0) + 1);
  }
  const available = new Map<string, string[]>();
  for (const line of categoryLines(txn)) {
    if (line.accountQboId === undefined) continue;
    const key = `${line.accountQboId}|${line.amountCents}`;
    if (!needed.has(key)) continue;
    if (!isNonEmptyString(line.id)) throw new LineRestoreError('POSTED_LINES_CHANGED');
    available.set(key, [...(available.get(key) ?? []), line.id]);
  }
  const ids: string[] = [];
  for (const [key, count] of needed) {
    const found = available.get(key) ?? [];
    if (found.length < count) throw new LineRestoreError('POSTED_LINES_CHANGED');
    if (found.length > count) throw new LineRestoreError('POSTED_LINES_AMBIGUOUS');
    ids.push(...found);
  }
  return ids;
}

/**
 * Undo of a legacy post: replace exactly the lines that post wrote with one
 * line back to the holding account, preserving every other line verbatim.
 */
export function buildPreparedLineRestore(args: {
  txn: QboTxn;
  postedLines: QboLineWriteSplit[];
  holdingAccountQboId: string;
  requestId: string;
}): QboPreparedLineWrite {
  const { txn, requestId, holdingAccountQboId } = args;
  if (!isRecord(txn.raw)) {
    throw new Error('QuickBooks transaction raw body is not a JSON object.');
  }
  if (
    txn.raw.Id !== txn.qboId
    || txn.raw.SyncToken !== txn.syncToken
    || !isNonEmptyString(requestId)
    || !isNonEmptyString(holdingAccountQboId)
    || args.postedLines.length === 0
  ) {
    throw new Error('Line restore input is invalid.');
  }
  const lineIds = new Set(findPostedLineIds(txn, args.postedLines));
  const restoredCents = args.postedLines.reduce(
    (sum, line) => sum + Math.round(Math.abs(line.amount) * 100),
    0,
  );
  const restore: QboLineWriteSplit[] = [{
    amount: restoredCents / 100,
    accountQboId: holdingAccountQboId,
  }];
  const body: Record<string, unknown> = {
    ...txn.raw,
    Id: txn.qboId,
    SyncToken: txn.syncToken,
    Line: txn.qboType === 'Purchase'
      ? rebuildPurchaseLinesWhere(
          txn.raw as unknown as RawPurchase,
          (line) => line.Id !== undefined && lineIds.has(line.Id),
          restore,
        )
      : txn.qboType === 'Deposit'
        ? rebuildDepositLinesWhere(
            txn.raw as unknown as RawDeposit,
            (line) => line.Id !== undefined && lineIds.has(line.Id),
            restore,
          )
        : rebuildJournalEntryLinesWhere(
            txn.raw as unknown as RawJournalEntry,
            (line) =>
              line.JournalEntryLineDetail?.PostingType === 'Debit'
              && line.Id !== undefined
              && lineIds.has(line.Id),
            restore,
          ),
  };
  return validatePreparedLineWrite({
    operation: 'transfer',
    qboType: txn.qboType,
    qboId: txn.qboId,
    requestId,
    requestHash: hashLineWriteRequest(body),
    body,
    before: {
      qboType: txn.qboType,
      qboId: txn.qboId,
      syncToken: txn.syncToken,
      contentHash: hashLineWriteContent(txn.raw),
    },
    expected: {
      qboType: txn.qboType,
      qboId: txn.qboId,
      contentHash: hashLineWriteContent(body),
    },
  });
}

export function validatePreparedLineTransformation(
  value: unknown,
  args: Parameters<typeof buildPreparedLineWrite>[0],
): QboPreparedLineWrite {
  if (args.splits.length !== 1) {
    throw new Error('Durable transfer preparation requires exactly one target line.');
  }
  const prepared = validatePreparedLineWrite(value);
  const expected = buildPreparedLineWrite(args);
  if (canonicalJson(prepared) !== canonicalJson(expected)) {
    throw new Error(
      'Prepared line write does not match the authorized full-entity transformation.',
    );
  }
  assertJsonValue(expected);
  const detached: unknown = JSON.parse(canonicalJson(expected));
  return validatePreparedLineWrite(detached);
}

export function isQboPreparedLineWrite(
  value: unknown,
): value is QboPreparedLineWrite {
  try {
    validatePreparedLineWrite(value);
    return true;
  } catch {
    return false;
  }
}

export function verifyLineWriteResult(
  preparedValue: unknown,
  snapshotValue: unknown,
): QboLineWriteResult {
  const prepared = validatePreparedLineWrite(preparedValue);
  assertSnapshotShape(snapshotValue, true);
  const snapshot = snapshotValue as QboLineWriteSnapshot;
  if (
    snapshot.qboType !== prepared.expected.qboType ||
    snapshot.qboId !== prepared.expected.qboId
  ) {
    throw new Error('QuickBooks line write response identity does not match the prepared write.');
  }
  if (snapshot.syncToken === prepared.before.syncToken) {
    throw new Error('QuickBooks line write response retained the old SyncToken.');
  }
  if (snapshot.contentHash !== prepared.expected.contentHash) {
    throw new Error('QuickBooks line write response content does not match the prepared write.');
  }
  return {
    ok: true,
    newSyncToken: snapshot.syncToken,
    snapshot,
  };
}
