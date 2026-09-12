import { Prisma, type PrismaClient } from '@prisma/client';
import type { VendorAlias, VendorIdentity } from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { runCompanyMutationTransaction } from '../companyMutationScope.js';

const MAX_VENDOR_TEXT_CODE_POINTS = 500;
const MAX_QBO_REFERENCE_CODE_POINTS = 120;
const MAX_ALIASES_IN_RESULT = 20;
const MAX_MERGE_HOPS = 20;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type VendorAliasSource = 'qbo' | 'user' | 'import' | 'inferred';

export interface VendorIdentityDb {
  vendorIdentity: PrismaClient['vendorIdentity'];
  vendorAlias: PrismaClient['vendorAlias'];
  vendorIdentityMerge: PrismaClient['vendorIdentityMerge'];
  $transaction?: PrismaClient['$transaction'];
}

export interface CreateVendorIdentityInput {
  companyId: string;
  /** The raw, human-readable value; it is not used as a fuzzy search input. */
  displayName: string;
  qboVendorId?: string | null;
}

export interface CreateVendorAliasInput {
  companyId: string;
  vendorIdentityId: string;
  /** The raw alias value; its deterministic key is persisted separately. */
  value: string;
  source: VendorAliasSource;
}

export interface MergeVendorIdentitiesInput {
  companyId: string;
  sourceVendorIdentityId: string;
  targetVendorIdentityId: string;
  mergedBy: string;
  reason: string;
}

export interface VendorIdentityMergeRecord {
  id: string;
  companyId: string;
  sourceVendorIdentityId: string;
  targetVendorIdentityId: string;
  mergedBy: string;
  reason: string;
  createdAt: string;
}

export class VendorIdentityError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'NOT_FOUND'
      | 'IDENTITY_CONFLICT'
      | 'ALIAS_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'VendorIdentityError';
  }
}

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new VendorIdentityError('INVALID_INPUT', 'A company identifier is required.');
  }
}

function boundedRawValue(value: string, field: string): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new VendorIdentityError('INVALID_INPUT', `${field} is not valid text.`);
  }
  const length = Array.from(value).length;
  if (length === 0 || length > MAX_VENDOR_TEXT_CODE_POINTS) {
    throw new VendorIdentityError('INVALID_INPUT', `${field} must be 1–500 characters.`);
  }
  return value;
}

/**
 * Computes the persisted vendor v1 lookup key. Keep this legacy fold stable so
 * existing normalizedName/normalizedValue rows remain addressable. A rule-v2
 * compatible vendor key requires additive columns and a controlled backfill.
 */
export function normalizeVendorLookupKey(value: string): string {
  const raw = boundedRawValue(value, 'Vendor value');
  const normalized = raw
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
  if (normalized.length === 0) {
    throw new VendorIdentityError('INVALID_INPUT', 'Vendor value must contain visible text.');
  }
  return normalized;
}

export const vendorLookupKey = normalizeVendorLookupKey;
export const normalizeVendorKey = normalizeVendorLookupKey;

function normalizeQboVendorId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new VendorIdentityError('INVALID_INPUT', 'The QBO vendor identifier is not valid.');
  }
  const normalized = value.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (length === 0 || length > MAX_QBO_REFERENCE_CODE_POINTS) {
    throw new VendorIdentityError('INVALID_INPUT', 'The QBO vendor identifier is not valid.');
  }
  return normalized;
}

function boundedMergeText(value: string, field: string, maximum: number): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new VendorIdentityError('INVALID_INPUT', `${field} is not valid text.`);
  }
  const normalized = value.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (length === 0 || length > maximum) {
    throw new VendorIdentityError('INVALID_INPUT', `${field} is not valid text.`);
  }
  return normalized;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function vendorMutationTransaction<T>(
  db: VendorIdentityDb,
  companyId: string,
  callback: (tx: VendorIdentityDb) => Promise<T>,
): Promise<T> {
  if (typeof db.$transaction !== 'function') return callback(db);
  return runCompanyMutationTransaction(
    db as unknown as Parameters<typeof runCompanyMutationTransaction>[0],
    companyId,
    (tx) => callback(tx as VendorIdentityDb),
  );
}

function aliasRow(row: {
  id: string;
  companyId: string;
  vendorIdentityId: string;
  value: string;
  normalizedValue: string;
  source: string;
  createdAt: Date;
}): VendorAlias {
  if (
    row.source !== 'qbo'
    && row.source !== 'user'
    && row.source !== 'import'
    && row.source !== 'inferred'
  ) {
    throw new VendorIdentityError('INVALID_INPUT', 'Stored vendor alias source is invalid.');
  }
  return {
    id: row.id,
    companyId: row.companyId,
    vendorIdentityId: row.vendorIdentityId,
    value: row.value,
    normalizedValue: row.normalizedValue,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

type IdentityRow = {
  id: string;
  companyId: string;
  qboVendorId: string | null;
  displayName: string;
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
  aliases: Array<{
    id: string;
    companyId: string;
    vendorIdentityId: string;
    value: string;
    normalizedValue: string;
    source: string;
    createdAt: Date;
  }>;
};

type MergeRow = {
  id: string;
  companyId: string;
  sourceVendorIdentityId: string;
  targetVendorIdentityId: string;
  mergedBy: string;
  reason: string;
  createdAt: Date;
};

function identityRow(row: IdentityRow): VendorIdentity {
  return {
    id: row.id,
    companyId: row.companyId,
    qboVendorId: row.qboVendorId,
    displayName: row.displayName,
    normalizedName: row.normalizedName,
    aliases: row.aliases.slice(0, MAX_ALIASES_IN_RESULT).map(aliasRow),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mergeRow(row: MergeRow): VendorIdentityMergeRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceVendorIdentityId: row.sourceVendorIdentityId,
    targetVendorIdentityId: row.targetVendorIdentityId,
    mergedBy: row.mergedBy,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

const identityInclude = {
  aliases: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: MAX_ALIASES_IN_RESULT,
  },
};

async function findIdentityByKey(
  companyId: string,
  normalizedName: string,
  db: VendorIdentityDb,
): Promise<VendorIdentity | null> {
  const row = await db.vendorIdentity.findUnique({
    where: { companyId_normalizedName: { companyId, normalizedName } },
    include: identityInclude,
  });
  return row === null ? null : identityRow(row as IdentityRow);
}

async function loadVendorIdentity(
  companyId: string,
  id: string,
  db: VendorIdentityDb,
): Promise<VendorIdentity | null> {
  const row = await db.vendorIdentity.findUnique({
    where: { companyId_id: { companyId, id } },
    include: identityInclude,
  });
  return row === null ? null : identityRow(row as IdentityRow);
}

async function resolveMergedIdentity(
  identity: VendorIdentity,
  db: VendorIdentityDb,
): Promise<VendorIdentity> {
  let current = identity;
  const visited = new Set<string>();
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    if (visited.has(current.id)) {
      throw new VendorIdentityError('IDENTITY_CONFLICT', 'Stored vendor merge history contains a cycle.');
    }
    visited.add(current.id);
    const merge = await db.vendorIdentityMerge.findUnique({
      where: {
        companyId_sourceVendorIdentityId: {
          companyId: current.companyId,
          sourceVendorIdentityId: current.id,
        },
      },
    });
    if (merge === null) return current;
    const target = await loadVendorIdentity(current.companyId, merge.targetVendorIdentityId, db);
    if (target === null) {
      throw new VendorIdentityError('IDENTITY_CONFLICT', 'Stored vendor merge target is invalid.');
    }
    current = target;
  }
  throw new VendorIdentityError('IDENTITY_CONFLICT', 'Stored vendor merge history is too deep.');
}

export async function getVendorIdentity(
  companyId: string,
  id: string,
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentity | null> {
  assertCompanyId(companyId);
  if (typeof id !== 'string' || id.trim() === '') {
    throw new VendorIdentityError('INVALID_INPUT', 'A vendor identity identifier is required.');
  }
  const identity = await loadVendorIdentity(companyId, id, db);
  return identity === null ? null : resolveMergedIdentity(identity, db);
}

export async function findVendorIdentityByName(
  companyId: string,
  displayName: string,
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentity | null> {
  assertCompanyId(companyId);
  const identity = await findIdentityByKey(companyId, normalizeVendorLookupKey(displayName), db);
  return identity === null ? null : resolveMergedIdentity(identity, db);
}

/**
 * Creates a new identity. A normalized-name collision is a hard conflict;
 * this function never silently merges two caller-supplied identities.
 */
export async function createVendorIdentity(
  input: CreateVendorIdentityInput,
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentity> {
  assertCompanyId(input.companyId);
  const displayName = boundedRawValue(input.displayName, 'Vendor display name');
  const normalizedName = normalizeVendorLookupKey(displayName);
  const qboVendorId = normalizeQboVendorId(input.qboVendorId);
  const claimedAlias = await db.vendorAlias.findUnique({
    where: { companyId_normalizedValue: { companyId: input.companyId, normalizedValue: normalizedName } },
  });
  if (claimedAlias !== null) {
    throw new VendorIdentityError(
      'IDENTITY_CONFLICT',
      'This exact company-scoped key is already a vendor alias.',
    );
  }
  try {
    const row = await db.vendorIdentity.create({
      data: {
        companyId: input.companyId,
        displayName,
        normalizedName,
        qboVendorId,
      },
      include: identityInclude,
    });
    return identityRow(row as IdentityRow);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new VendorIdentityError(
      'IDENTITY_CONFLICT',
      'A vendor identity with this exact company-scoped key already exists.',
    );
  }
}

async function ensureQboBinding(
  identity: VendorIdentity,
  qboVendorId: string | null,
  db: VendorIdentityDb,
): Promise<VendorIdentity> {
  if (qboVendorId === null) return identity;
  if (identity.qboVendorId !== null) {
    if (identity.qboVendorId !== qboVendorId) {
      throw new VendorIdentityError(
        'IDENTITY_CONFLICT',
        'The exact vendor key is already bound to a different QBO vendor.',
      );
    }
    return identity;
  }
  try {
    const claimed = await db.vendorIdentity.updateMany({
      where: {
        companyId: identity.companyId,
        id: identity.id,
        qboVendorId: null,
      },
      data: { qboVendorId },
    });
    if (claimed.count === 1) {
      const updated = await loadVendorIdentity(identity.companyId, identity.id, db);
      if (updated === null) {
        throw new VendorIdentityError('NOT_FOUND', 'The vendor identity no longer exists.');
      }
      return updated;
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const raced = await loadVendorIdentity(identity.companyId, identity.id, db);
  if (raced?.qboVendorId === qboVendorId) return raced;
  throw new VendorIdentityError(
    'IDENTITY_CONFLICT',
    'The exact vendor key is already bound to a different QBO vendor.',
  );
}

/**
 * Idempotently ensures the exact normalized identity exists. An existing
 * identity keeps its first raw display value; a previously unbound identity
 * may acquire its QBO ID, but a different QBO ID is a conflict.
 */
export async function ensureVendorIdentity(
  input: CreateVendorIdentityInput,
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentity> {
  assertCompanyId(input.companyId);
  const displayName = boundedRawValue(input.displayName, 'Vendor display name');
  const normalizedName = normalizeVendorLookupKey(displayName);
  const qboVendorId = normalizeQboVendorId(input.qboVendorId);
  const matched = await findIdentityByKey(input.companyId, normalizedName, db);
  if (matched !== null) {
    const existing = await resolveMergedIdentity(matched, db);
    return ensureQboBinding(existing, qboVendorId, db);
  }
  try {
    return await createVendorIdentity({
      companyId: input.companyId,
      displayName,
      qboVendorId,
    }, db);
  } catch (error) {
    // A concurrent exact create is safe to replay. A collision on qboVendorId
    // remains a hard conflict and is not converted into a merge.
    if (error instanceof VendorIdentityError && error.code === 'IDENTITY_CONFLICT') {
      const raced = await findIdentityByKey(input.companyId, normalizedName, db);
      if (raced !== null) {
        return ensureQboBinding(await resolveMergedIdentity(raced, db), qboVendorId, db);
      }
    }
    throw error;
  }
}

export async function createVendorAlias(
  input: CreateVendorAliasInput,
  db: VendorIdentityDb = prisma,
): Promise<VendorAlias> {
  assertCompanyId(input.companyId);
  if (typeof input.vendorIdentityId !== 'string' || input.vendorIdentityId.trim() === '') {
    throw new VendorIdentityError('INVALID_INPUT', 'A vendor identity identifier is required.');
  }
  if (!['qbo', 'user', 'import', 'inferred'].includes(input.source)) {
    throw new VendorIdentityError('INVALID_INPUT', 'The vendor alias source is invalid.');
  }
  const identity = await getVendorIdentity(input.companyId, input.vendorIdentityId, db);
  if (identity === null) {
    throw new VendorIdentityError('NOT_FOUND', 'The vendor identity was not found in this company.');
  }
  const value = boundedRawValue(input.value, 'Vendor alias');
  const normalizedValue = normalizeVendorLookupKey(value);
  const canonicalMatch = await findIdentityByKey(input.companyId, normalizedValue, db);
  const canonicalOwner = canonicalMatch === null
    ? null
    : await resolveMergedIdentity(canonicalMatch, db);
  if (canonicalOwner !== null && canonicalOwner.id !== identity.id) {
    throw new VendorIdentityError(
      'ALIAS_CONFLICT',
      'This exact alias key is already the canonical key of another identity.',
    );
  }
  const existing = await db.vendorAlias.findUnique({
    where: { companyId_normalizedValue: { companyId: input.companyId, normalizedValue } },
  });
  if (existing !== null) {
    if (existing.vendorIdentityId === identity.id) return aliasRow(existing);
    throw new VendorIdentityError(
      'ALIAS_CONFLICT',
      'This exact alias key is already bound to another identity.',
    );
  }
  try {
    const row = await db.vendorAlias.create({
      data: {
        companyId: input.companyId,
        vendorIdentityId: identity.id,
        value,
        normalizedValue,
        source: input.source,
      },
    });
    return aliasRow(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await db.vendorAlias.findUnique({
      where: { companyId_normalizedValue: { companyId: input.companyId, normalizedValue } },
    });
    if (raced?.vendorIdentityId === identity.id) return aliasRow(raced);
    throw new VendorIdentityError(
      'ALIAS_CONFLICT',
      'This exact alias key is already bound to another identity.',
    );
  }
}

export const ensureVendorAlias = createVendorAlias;

/** Resolves canonical or alias keys only; it never performs fuzzy matching. */
export async function findVendorIdentityByValue(
  companyId: string,
  value: string,
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentity | null> {
  assertCompanyId(companyId);
  const normalized = normalizeVendorLookupKey(value);
  const [canonical, alias] = await Promise.all([
    findIdentityByKey(companyId, normalized, db),
    db.vendorAlias.findUnique({
      where: { companyId_normalizedValue: { companyId, normalizedValue: normalized } },
    }),
  ]);
  const canonicalOwner = canonical === null ? null : await resolveMergedIdentity(canonical, db);
  if (alias === null) return canonicalOwner;
  const aliasOwner = await getVendorIdentity(companyId, alias.vendorIdentityId, db);
  if (aliasOwner === null) {
    throw new VendorIdentityError('IDENTITY_CONFLICT', 'Stored vendor alias ownership is invalid.');
  }
  if (canonicalOwner !== null && canonicalOwner.id !== aliasOwner.id) {
    throw new VendorIdentityError(
      'IDENTITY_CONFLICT',
      'Stored canonical and alias keys disagree for this company.',
    );
  }
  return aliasOwner;
}

/**
 * Records the only operation that can join two exact vendor identities. The
 * source row and every raw alias remain intact; lookup follows the immutable
 * audit event to the reviewed canonical target.
 */
export async function mergeVendorIdentities(
  input: MergeVendorIdentitiesInput,
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentityMergeRecord> {
  assertCompanyId(input.companyId);
  const sourceVendorIdentityId = boundedMergeText(
    input.sourceVendorIdentityId,
    'Source vendor identity identifier',
    128,
  );
  const targetVendorIdentityId = boundedMergeText(
    input.targetVendorIdentityId,
    'Target vendor identity identifier',
    128,
  );
  if (sourceVendorIdentityId === targetVendorIdentityId) {
    throw new VendorIdentityError('INVALID_INPUT', 'A vendor identity cannot merge into itself.');
  }
  const mergedBy = boundedMergeText(input.mergedBy, 'Merge reviewer', 128);
  const reason = boundedMergeText(input.reason, 'Merge reason', 500);
  return vendorMutationTransaction(db, input.companyId, async (tx) => {
    const [source, target] = await Promise.all([
      loadVendorIdentity(input.companyId, sourceVendorIdentityId, tx),
      loadVendorIdentity(input.companyId, targetVendorIdentityId, tx),
    ]);
    if (source === null || target === null) {
      throw new VendorIdentityError('NOT_FOUND', 'Both vendor identities must belong to this company.');
    }
    const existing = await tx.vendorIdentityMerge.findUnique({
      where: {
        companyId_sourceVendorIdentityId: {
          companyId: input.companyId,
          sourceVendorIdentityId,
        },
      },
    });
    if (existing !== null) {
      if (
        existing.targetVendorIdentityId === targetVendorIdentityId
        && existing.mergedBy === mergedBy
        && existing.reason === reason
      ) {
        return mergeRow(existing as MergeRow);
      }
      throw new VendorIdentityError('IDENTITY_CONFLICT', 'The source identity was already merged.');
    }
    const canonicalTarget = await resolveMergedIdentity(target, tx);
    if (canonicalTarget.id === sourceVendorIdentityId) {
      throw new VendorIdentityError('IDENTITY_CONFLICT', 'The vendor merge would create a cycle.');
    }
    const row = await tx.vendorIdentityMerge.create({
      data: {
        companyId: input.companyId,
        sourceVendorIdentityId,
        targetVendorIdentityId: canonicalTarget.id,
        mergedBy,
        reason,
      },
    });
    return mergeRow(row as MergeRow);
  });
}

export async function listVendorIdentities(
  companyId: string,
  options: { limit?: number; offset?: number } = {},
  db: VendorIdentityDb = prisma,
): Promise<VendorIdentity[]> {
  assertCompanyId(companyId);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const rows = await db.vendorIdentity.findMany({
    where: { companyId },
    orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
    skip: offset,
    take: limit,
    include: identityInclude,
  });
  return rows.map((row) => identityRow(row as IdentityRow));
}
