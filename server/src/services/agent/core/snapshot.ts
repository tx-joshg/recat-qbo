import { Buffer } from 'node:buffer';

const MAX_RETAINED_ITEMS = 20;
const MAX_SOURCE_COLLECTION_ITEMS = 100;
const MAX_NESTED_COLLECTION_ITEMS = 20;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ACCOUNT_NUMBER_PATTERN = /\d(?:[ -]*\d){7,}/u;

type AccountType = 'BANK' | 'CREDIT_CARD' | 'CASH' | 'OTHER';
type TaxCalculation = 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
type TaxableCalculation = Exclude<TaxCalculation, 'NotApplicable'>;
type TaxStatus = 'unsupported' | 'needs_setup' | 'ready';
type CategoryReference = { qboId: string; name: string };
type TaxReference = { qboId: string; label: string };
type TagReference = { id: string; name: string };

interface ApplicableRule {
  id: string;
  ruleRevision: number;
  priority: number;
  matchField: 'payee';
  matchText: string;
  action: {
    version: 2;
    direction: 'Purchase' | 'Deposit';
    category: string;
    categoryQboId: string;
    taxCalculation: TaxCalculation;
    taxCodeQboId: string | null;
    tagIds: string[];
  };
  autoPost: boolean;
}

interface SimilarLine {
  signedGrossCents: number;
  categoryQboId: string;
  taxCodeQboId: string | null;
  memo?: string;
  tagIds: string[];
}

interface SimilarVerifiedTransaction {
  transactionId: string;
  date: string;
  signedAmountCents: number;
  currency: string;
  payee: string;
  memo?: string;
  taxCalculation: TaxCalculation;
  lines: SimilarLine[];
  tagIds: string[];
  verifiedAt: string;
}

interface TaxReadiness {
  status: TaxStatus;
  supportedCalculationModes: TaxableCalculation[];
  eligibleReferences: TaxReference[];
}

type DeepReadonly<T> = T extends Array<infer Item>
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export interface AgentSnapshotSource {
  transaction: { id: string; revision: number };
  date: string;
  signedAmountCents: number;
  currency: string;
  sourceAccount: { displayName: string; type: AccountType };
  payee: string;
  memo?: string;
  candidateCategories: CategoryReference[];
  tax: TaxReadiness;
  tags: TagReference[];
  rules: ApplicableRule[];
  similarVerifiedTransactions: SimilarVerifiedTransaction[];
  featureVersion: string;
  configurationVersion: string;
}

export interface AgentTransactionSnapshot {
  readonly schemaVersion: 2;
  readonly transaction: DeepReadonly<{ id: string; revision: number }>;
  readonly date: string;
  readonly signedAmountCents: number;
  readonly currency: string;
  readonly sourceAccount: DeepReadonly<{ displayName: string; type: AccountType }>;
  readonly payee: string;
  readonly memo?: string;
  readonly candidateCategories: DeepReadonly<CategoryReference[]>;
  readonly tax: DeepReadonly<TaxReadiness>;
  readonly tags: DeepReadonly<TagReference[]>;
  readonly rules: DeepReadonly<ApplicableRule[]>;
  readonly similarVerifiedTransactions: DeepReadonly<SimilarVerifiedTransaction[]>;
  readonly featureVersion: string;
  readonly configurationVersion: string;
}

export class AgentSnapshotError extends Error {
  constructor(readonly code: 'AGENT_SNAPSHOT_INVALID' | 'AGENT_SNAPSHOT_TOO_LARGE') {
    super(code === 'AGENT_SNAPSHOT_TOO_LARGE' ? 'Agent snapshot exceeds the byte limit.' : 'Invalid agent snapshot.');
    this.name = 'AgentSnapshotError';
  }
}

export function buildAgentSnapshot(source: AgentSnapshotSource): AgentTransactionSnapshot {
  return deepFreeze({ schemaVersion: 2 as const, ...normalizeSource(source) });
}

export function serializeAgentSnapshot(snapshot: AgentTransactionSnapshot, maxBytes: number): string {
  const normalized = validateSnapshot(snapshot);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) invalid();
  const serialized = canonicalJson(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > Math.min(maxBytes, MAX_SERIALIZED_BYTES)) {
    throw new AgentSnapshotError('AGENT_SNAPSHOT_TOO_LARGE');
  }
  return serialized;
}

const snapshotKeys = ['schemaVersion', 'transaction', 'date', 'signedAmountCents', 'currency', 'sourceAccount', 'payee', 'memo', 'candidateCategories', 'tax', 'tags', 'rules', 'similarVerifiedTransactions', 'featureVersion', 'configurationVersion'];
const sourceKeys = snapshotKeys.filter((key) => key !== 'schemaVersion');

function validateSnapshot(snapshot: unknown): AgentTransactionSnapshot {
  const record = recordOf(snapshot);
  exactKeys(record, snapshotKeys);
  if (record.schemaVersion !== 2) invalid();
  const normalized = deepFreeze({ schemaVersion: 2 as const, ...normalizeSource(without(record, 'schemaVersion')) });
  if (canonicalJson(record) !== canonicalJson(normalized)) invalid();
  return normalized;
}

function normalizeSource(source: unknown): Omit<AgentTransactionSnapshot, 'schemaVersion'> {
  const record = recordOf(source);
  exactKeys(record, sourceKeys);
  const transaction = recordOf(record.transaction);
  exactKeys(transaction, ['id', 'revision']);
  const account = recordOf(record.sourceAccount);
  exactKeys(account, ['displayName', 'type']);
  const memo = optionalFreeText(record.memo, 500);
  const candidateCategories = boundedTop(record.candidateCategories, categoryReference, compareCategory);
  const tax = readiness(record.tax);
  const tags = boundedTop(record.tags, tagReference, compareTag);
  const rules = boundedPreserved(record.rules, rule);
  const similarVerifiedTransactions = boundedTop(record.similarVerifiedTransactions, similarTransaction, compareSimilar);
  const normalized = {
    transaction: { id: uuid(transaction.id), revision: nonnegativeInteger(transaction.revision) },
    date: date(record.date),
    signedAmountCents: integer(record.signedAmountCents),
    currency: currency(record.currency),
    sourceAccount: { displayName: freeText(account.displayName, 120), type: accountType(account.type) },
    payee: freeText(record.payee, 160),
    ...(memo === undefined ? {} : { memo }),
    candidateCategories,
    tax,
    tags,
    rules,
    similarVerifiedTransactions,
    featureVersion: version(record.featureVersion),
    configurationVersion: version(record.configurationVersion),
  };
  validateRetainedRelationships(normalized);
  return normalized;
}

function readiness(value: unknown): TaxReadiness {
  const record = recordOf(value);
  exactKeys(record, ['status', 'supportedCalculationModes', 'eligibleReferences']);
  const status = taxStatus(record.status);
  const supportedCalculationModes = boundedTaxableModes(record.supportedCalculationModes);
  const eligibleReferences = boundedTop(record.eligibleReferences, taxReference, compareTax);
  if (status === 'ready') {
    if (supportedCalculationModes.length === 0 || eligibleReferences.length === 0) invalid();
  } else if (supportedCalculationModes.length !== 0 || eligibleReferences.length !== 0) {
    invalid();
  }
  return { status, supportedCalculationModes, eligibleReferences };
}

function categoryReference(value: unknown): CategoryReference {
  const record = recordOf(value);
  exactKeys(record, ['qboId', 'name']);
  return { qboId: providerReference(record.qboId), name: freeText(record.name, 160) };
}

function taxReference(value: unknown): TaxReference {
  const record = recordOf(value);
  exactKeys(record, ['qboId', 'label']);
  return { qboId: providerReference(record.qboId), label: freeText(record.label, 160) };
}

function tagReference(value: unknown): TagReference {
  const record = recordOf(value);
  exactKeys(record, ['id', 'name']);
  return { id: uuid(record.id), name: freeText(record.name, 160) };
}

function rule(value: unknown): ApplicableRule {
  const record = recordOf(value);
  exactKeys(record, ['id', 'ruleRevision', 'priority', 'matchField', 'matchText', 'action', 'autoPost']);
  const action = recordOf(record.action);
  exactKeys(action, ['version', 'direction', 'category', 'categoryQboId', 'taxCalculation', 'taxCodeQboId', 'tagIds']);
  if (action.version !== 2 || (action.direction !== 'Purchase' && action.direction !== 'Deposit')) invalid();
  if (typeof record.autoPost !== 'boolean') invalid();
  return {
    id: uuid(record.id), ruleRevision: boundedInteger(record.ruleRevision, 1, 2_147_483_647),
    priority: boundedInteger(record.priority, 0, 1_000_000), matchField: matchField(record.matchField),
    matchText: freeText(record.matchText, 160),
    action: {
      version: 2,
      direction: action.direction,
      category: freeText(action.category, 160),
      categoryQboId: providerReference(action.categoryQboId),
      taxCalculation: taxCalculation(action.taxCalculation),
      taxCodeQboId: nullableProviderReference(action.taxCodeQboId),
      tagIds: boundedIds(action.tagIds),
    },
    autoPost: record.autoPost,
  };
}

function similarTransaction(value: unknown): SimilarVerifiedTransaction {
  const record = recordOf(value);
  exactKeys(record, ['transactionId', 'date', 'signedAmountCents', 'currency', 'payee', 'memo', 'taxCalculation', 'lines', 'tagIds', 'verifiedAt']);
  const memo = optionalFreeText(record.memo, 500);
  return {
    transactionId: uuid(record.transactionId), date: date(record.date), signedAmountCents: integer(record.signedAmountCents), currency: currency(record.currency), payee: freeText(record.payee, 160),
    ...(memo === undefined ? {} : { memo }), taxCalculation: taxCalculation(record.taxCalculation), lines: boundedLines(record.lines), tagIds: boundedIds(record.tagIds), verifiedAt: timestamp(record.verifiedAt),
  };
}

function similarLine(value: unknown): SimilarLine {
  const record = recordOf(value);
  exactKeys(record, ['signedGrossCents', 'categoryQboId', 'taxCodeQboId', 'memo', 'tagIds']);
  const memo = optionalFreeText(record.memo, 500);
  return {
    signedGrossCents: integer(record.signedGrossCents), categoryQboId: providerReference(record.categoryQboId), taxCodeQboId: nullableProviderReference(record.taxCodeQboId),
    ...(memo === undefined ? {} : { memo }), tagIds: boundedIds(record.tagIds),
  };
}

function validateRetainedRelationships(value: {
  candidateCategories: CategoryReference[]; tax: TaxReadiness; tags: TagReference[]; rules: ApplicableRule[]; similarVerifiedTransactions: SimilarVerifiedTransaction[];
}): void {
  const categories = new Set(value.candidateCategories.map((entry) => entry.qboId));
  const taxReferences = new Set(value.tax.eligibleReferences.map((entry) => entry.qboId));
  const tags = new Set(value.tags.map((entry) => entry.id));
  const validateTax = (calculation: TaxCalculation, taxCodeQboId: string | null): void => {
    if (calculation === 'NotApplicable') { if (taxCodeQboId !== null) invalid(); return; }
    if (value.tax.status !== 'ready' || !value.tax.supportedCalculationModes.includes(calculation) || taxCodeQboId === null || !taxReferences.has(taxCodeQboId)) invalid();
  };
  const validateTags = (ids: string[]): void => { if (ids.some((id) => !tags.has(id))) invalid(); };
  for (const entry of value.rules) {
    if (!categories.has(entry.action.categoryQboId)) invalid();
    validateTax(entry.action.taxCalculation, entry.action.taxCodeQboId);
    validateTags(entry.action.tagIds);
  }
  for (const transaction of value.similarVerifiedTransactions) {
    if (transaction.signedAmountCents === 0 || transaction.lines.length === 0) invalid();
    validateTags(transaction.tagIds);
    let total = 0;
    for (const line of transaction.lines) {
      if (line.signedGrossCents === 0 || Math.sign(line.signedGrossCents) !== Math.sign(transaction.signedAmountCents) || !categories.has(line.categoryQboId)) invalid();
      validateTax(transaction.taxCalculation, line.taxCodeQboId);
      validateTags(line.tagIds);
      total += line.signedGrossCents;
      if (!Number.isSafeInteger(total)) invalid();
    }
    if (total !== transaction.signedAmountCents) invalid();
  }
}

function boundedTop<T extends { id?: string; qboId?: string; transactionId?: string }>(value: unknown, normalize: (entry: unknown) => T, compare: (left: T, right: T) => number): T[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_COLLECTION_ITEMS) invalid();
  const entries = value.map(normalize);
  unique(entries.map((entry) => entry.id ?? entry.qboId ?? entry.transactionId));
  return entries.sort(compare).slice(0, MAX_RETAINED_ITEMS);
}

function boundedPreserved<T extends { id?: string; qboId?: string; transactionId?: string }>(value: unknown, normalize: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_COLLECTION_ITEMS) invalid();
  const entries = value.map(normalize);
  unique(entries.map((entry) => entry.id ?? entry.qboId ?? entry.transactionId));
  return entries.slice(0, MAX_RETAINED_ITEMS);
}

function boundedLines(value: unknown): SimilarLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NESTED_COLLECTION_ITEMS) invalid();
  return value.map(similarLine).sort(compareLine);
}

function boundedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_NESTED_COLLECTION_ITEMS) invalid();
  const ids = value.map(uuid);
  unique(ids);
  return ids.sort(compareText);
}

function boundedTaxableModes(value: unknown): TaxableCalculation[] {
  if (!Array.isArray(value) || value.length > MAX_NESTED_COLLECTION_ITEMS) invalid();
  const modes = value.map(taxableCalculation);
  unique(modes);
  return modes.sort(compareText);
}

function unique(values: Array<string | undefined>): void { if (values.some((value) => value === undefined) || new Set(values).size !== values.length) invalid(); }
function compareCategory(left: CategoryReference, right: CategoryReference): number { return compareText(left.name, right.name) || compareText(left.qboId, right.qboId); }
function compareTax(left: TaxReference, right: TaxReference): number { return compareText(left.label, right.label) || compareText(left.qboId, right.qboId); }
function compareTag(left: TagReference, right: TagReference): number { return compareText(left.name, right.name) || compareText(left.id, right.id); }
function compareLine(left: SimilarLine, right: SimilarLine): number { return compareText(left.categoryQboId, right.categoryQboId) || compareNumber(left.signedGrossCents, right.signedGrossCents) || compareText(left.taxCodeQboId ?? '', right.taxCodeQboId ?? '') || compareText(left.memo ?? '', right.memo ?? '') || compareText(left.tagIds.join(','), right.tagIds.join(',')); }
function compareSimilar(left: SimilarVerifiedTransaction, right: SimilarVerifiedTransaction): number { return compareText(right.verifiedAt, left.verifiedAt) || compareText(right.date, left.date) || compareText(left.transactionId, right.transactionId); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareNumber(left: number, right: number): number { return left < right ? -1 : left > right ? 1 : 0; }

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !('value' in descriptor)) invalid();
  }
  for (const key of allowed) if (key !== 'memo' && !Object.hasOwn(record, key)) invalid();
}

function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(); return value.toLowerCase(); }
function normalizeText(value: unknown, maximumLength: number): string { if (typeof value !== 'string') invalid(); const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' '); if (normalized.length === 0 || normalized.length > maximumLength) invalid(); return normalized; }
function freeText(value: unknown, maximumLength: number): string { const normalized = normalizeText(value, maximumLength); if (ACCOUNT_NUMBER_PATTERN.test(normalized)) invalid(); return normalized; }
function optionalFreeText(value: unknown, maximumLength: number): string | undefined { return value === undefined ? undefined : freeText(value, maximumLength); }
function providerReference(value: unknown): string { const normalized = normalizeText(value, 120); if (!REFERENCE_PATTERN.test(normalized)) invalid(); return normalized; }
function nullableProviderReference(value: unknown): string | null { return value === null ? null : providerReference(value); }
function version(value: unknown): string { const normalized = normalizeText(value, 80); if (!VERSION_PATTERN.test(normalized)) invalid(); return normalized; }
function date(value: unknown): string { if (typeof value !== 'string' || !DATE_PATTERN.test(value)) invalid(); const parsed = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) invalid(); return value; }
function timestamp(value: unknown): string { if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) invalid(); const parsed = new Date(value); if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid(); return value; }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(); return value; }
function nonnegativeInteger(value: unknown): number { const result = integer(value); if (result < 0) invalid(); return result; }
function boundedInteger(value: unknown, minimum: number, maximum: number): number { const result = integer(value); if (result < minimum || result > maximum) invalid(); return result; }
function currency(value: unknown): string { const normalized = normalizeText(value, 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(normalized)) invalid(); return normalized; }
function accountType(value: unknown): AccountType { if (value === 'BANK' || value === 'CREDIT_CARD' || value === 'CASH' || value === 'OTHER') return value; invalid(); }
function taxCalculation(value: unknown): TaxCalculation { if (value === 'TaxInclusive' || value === 'TaxExcluded' || value === 'NotApplicable') return value; invalid(); }
function taxableCalculation(value: unknown): TaxableCalculation { if (value === 'TaxInclusive' || value === 'TaxExcluded') return value; invalid(); }
function taxStatus(value: unknown): TaxStatus { if (value === 'unsupported' || value === 'needs_setup' || value === 'ready') return value; invalid(); }
function matchField(value: unknown): 'payee' { if (value !== 'payee') invalid(); return value; }
function without(record: Record<string, unknown>, key: string): Record<string, unknown> { const copy = { ...record }; delete copy[key]; return copy; }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function invalid(): never { throw new AgentSnapshotError('AGENT_SNAPSHOT_INVALID'); }
