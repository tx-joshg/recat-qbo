import { describe, expect, it } from 'vitest';
import * as vendorIdentityService from './vendorIdentity.js';
import {
  createVendorAlias,
  createVendorIdentity,
  ensureVendorIdentity,
  findVendorIdentityByValue,
  normalizeVendorLookupKey,
  VendorIdentityError,
  type VendorIdentityDb,
} from './vendorIdentity.js';
import { normalizeRuleMatchText } from '../ruleMatching.js';

const COMPANY = 'company-a';
const OTHER_COMPANY = 'company-b';
const at = new Date('2026-08-30T00:00:00.000Z');

function fakeDb(): VendorIdentityDb {
  const identities: Array<{
    id: string;
    companyId: string;
    qboVendorId: string | null;
    displayName: string;
    normalizedName: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const aliases: Array<{
    id: string;
    companyId: string;
    vendorIdentityId: string;
    value: string;
    normalizedValue: string;
    source: string;
    createdAt: Date;
  }> = [];
  const merges: Array<{
    id: string;
    companyId: string;
    sourceVendorIdentityId: string;
    targetVendorIdentityId: string;
    mergedBy: string;
    reason: string;
    createdAt: Date;
  }> = [];
  let sequence = 0;
  const withAliases = (identity: (typeof identities)[number]) => ({
    ...identity,
    aliases: aliases
      .filter((alias) => alias.companyId === identity.companyId && alias.vendorIdentityId === identity.id)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
  });
  return {
    vendorIdentity: {
      findUnique: async (args: any) => {
        const identity = args.where.companyId_normalizedName
          ? identities.find((row) => row.companyId === args.where.companyId_normalizedName.companyId
            && row.normalizedName === args.where.companyId_normalizedName.normalizedName)
          : identities.find((row) => row.companyId === args.where.companyId_id.companyId
            && row.id === args.where.companyId_id.id);
        return identity === undefined ? null : withAliases(identity);
      },
      create: async (args: any) => {
        const row = {
          id: `vendor-${++sequence}`,
          companyId: args.data.companyId,
          qboVendorId: args.data.qboVendorId,
          displayName: args.data.displayName,
          normalizedName: args.data.normalizedName,
          createdAt: at,
          updatedAt: at,
        };
        identities.push(row);
        return withAliases(row);
      },
      update: async (args: any) => {
        const row = identities.find((candidate) => candidate.id === args.where.companyId_id.id
          && candidate.companyId === args.where.companyId_id.companyId)!;
        row.qboVendorId = args.data.qboVendorId;
        row.updatedAt = at;
        return withAliases(row);
      },
      findMany: async (args: any) => identities
        .filter((row) => row.companyId === args.where.companyId)
        .slice(args.skip, args.skip + args.take)
        .map(withAliases),
    } as VendorIdentityDb['vendorIdentity'],
    vendorAlias: {
      findUnique: async (args: any) => aliases.find((row) => row.companyId === args.where.companyId_normalizedValue.companyId
        && row.normalizedValue === args.where.companyId_normalizedValue.normalizedValue) ?? null,
      create: async (args: any) => {
        const row = {
          id: `alias-${++sequence}`,
          companyId: args.data.companyId,
          vendorIdentityId: args.data.vendorIdentityId,
          value: args.data.value,
          normalizedValue: args.data.normalizedValue,
          source: args.data.source,
          createdAt: at,
        };
        aliases.push(row);
        return row;
      },
    } as VendorIdentityDb['vendorAlias'],
    vendorIdentityMerge: {
      findUnique: async (args: any) => merges.find((row) =>
        row.companyId === args.where.companyId_sourceVendorIdentityId.companyId
        && row.sourceVendorIdentityId
          === args.where.companyId_sourceVendorIdentityId.sourceVendorIdentityId) ?? null,
      create: async (args: any) => {
        const row = {
          id: `merge-${++sequence}`,
          companyId: args.data.companyId,
          sourceVendorIdentityId: args.data.sourceVendorIdentityId,
          targetVendorIdentityId: args.data.targetVendorIdentityId,
          mergedBy: args.data.mergedBy,
          reason: args.data.reason,
          createdAt: at,
        };
        merges.push(row);
        return row;
      },
    },
  } as unknown as VendorIdentityDb;
}

describe('company-scoped vendor identities', () => {
  it('derives a deterministic NFC/collapsed-whitespace/lowercase key without fuzzy punctuation folding', () => {
    expect(normalizeVendorLookupKey('  Cafe\u0301   NORTH  ')).toBe('café north');
    expect(normalizeVendorLookupKey('Acme, Inc.')).not.toBe(normalizeVendorLookupKey('Acme Inc.'));
  });

  it.each([
    'Cafe\u0301',
    '  Café   NORTH  ',
    'MiXeD CaSe',
    'Acme, Inc.',
  ])('keeps the persisted vendor v1 key aligned with rule v2 for safe input %j', (value) => {
    expect(normalizeVendorLookupKey(value)).toBe(normalizeRuleMatchText(value));
  });

  it('keeps fold-changing persisted vendor keys on v1 until the dual-key migration', () => {
    expect(normalizeVendorLookupKey('Straße')).toBe('straße');
    expect(normalizeVendorLookupKey('ẞ')).toBe('ß');
    expect(normalizeRuleMatchText('Straße')).toBe('strasse');
    expect(normalizeRuleMatchText('ẞ')).toBe('ss');
  });

  it('preserves decomposed Unicode and surrounding whitespace in raw names and aliases', async () => {
    const db = fakeDb();
    const rawDisplayName = '  Cafe\u0301   North  ';
    const first = await createVendorIdentity({
      companyId: COMPANY,
      displayName: rawDisplayName,
      qboVendorId: 'qbo-1',
    }, db);
    const second = await ensureVendorIdentity({
      companyId: COMPANY,
      displayName: 'Café North',
      qboVendorId: 'qbo-1',
    }, db);
    const rawAlias = '  Cafe\u0301 North POS  ';
    const alias = await createVendorAlias({
      companyId: COMPANY,
      vendorIdentityId: first.id,
      value: rawAlias,
      source: 'user',
    }, db);
    expect(first).toMatchObject({
      displayName: rawDisplayName,
      normalizedName: 'café north',
      qboVendorId: 'qbo-1',
    });
    expect(alias).toMatchObject({
      value: rawAlias,
      normalizedValue: 'café north pos',
    });
    expect(second.id).toBe(first.id);
  });

  it('does not merge an exact alias collision into another company identity', async () => {
    const db = fakeDb();
    const first = await createVendorIdentity({ companyId: COMPANY, displayName: 'North Vendor' }, db);
    const other = await createVendorIdentity({ companyId: OTHER_COMPANY, displayName: 'Other Vendor' }, db);
    await createVendorAlias({
      companyId: COMPANY,
      vendorIdentityId: first.id,
      value: 'NORTH VENDOR POS',
      source: 'user',
    }, db);
    await expect(createVendorAlias({
      companyId: COMPANY,
      vendorIdentityId: other.id,
      value: 'north   vendor pos',
      source: 'inferred',
    }, db)).rejects.toMatchObject<Partial<VendorIdentityError>>({ code: 'NOT_FOUND' });
    await expect(findVendorIdentityByValue(OTHER_COMPANY, 'NORTH VENDOR POS', db)).resolves.toBeNull();
  });

  it('rejects a different QBO binding for the same exact company key', async () => {
    const db = fakeDb();
    await createVendorIdentity({ companyId: COMPANY, displayName: 'Bound Vendor', qboVendorId: 'qbo-a' }, db);
    await expect(ensureVendorIdentity({
      companyId: COMPANY,
      displayName: 'bound vendor',
      qboVendorId: 'qbo-b',
    }, db)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });

  it('keeps similar exact keys separate until an explicit audited merge', async () => {
    const mergeVendorIdentities = (vendorIdentityService as Record<string, unknown>)
      .mergeVendorIdentities as undefined | ((input: Record<string, string>, db: VendorIdentityDb) => Promise<{
        sourceVendorIdentityId: string;
        targetVendorIdentityId: string;
        mergedBy: string;
        reason: string;
      }>);
    expect(typeof mergeVendorIdentities).toBe('function');

    const db = fakeDb();
    const punctuated = await createVendorIdentity({
      companyId: COMPANY,
      displayName: 'Acme, Inc.',
    }, db);
    const plain = await createVendorIdentity({
      companyId: COMPANY,
      displayName: 'Acme Inc.',
    }, db);
    expect(punctuated.id).not.toBe(plain.id);
    await expect(findVendorIdentityByValue(COMPANY, 'Acme, Inc.', db))
      .resolves.toMatchObject({ id: punctuated.id });

    const merge = await mergeVendorIdentities!({
      companyId: COMPANY,
      sourceVendorIdentityId: punctuated.id,
      targetVendorIdentityId: plain.id,
      mergedBy: 'reviewer-synthetic',
      reason: 'Reviewed duplicate vendor records.',
    }, db);

    expect(merge).toMatchObject({
      sourceVendorIdentityId: punctuated.id,
      targetVendorIdentityId: plain.id,
      mergedBy: 'reviewer-synthetic',
      reason: 'Reviewed duplicate vendor records.',
    });
    await expect(findVendorIdentityByValue(COMPANY, 'Acme, Inc.', db))
      .resolves.toMatchObject({ id: plain.id });
  });
});
