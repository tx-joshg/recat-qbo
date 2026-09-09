import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeRuleMatchText } from './ruleMatching.js';
import {
  UNICODE_CASE_FOLD_ENTRIES,
  UNICODE_CASE_FOLD_ENTRY_COUNT,
  UNICODE_CASE_FOLD_SHA256,
  UNICODE_CASE_FOLD_VERSION,
} from './unicodeCaseFold.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

const ECMASCRIPT_WHITESPACE = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
].map((codePoint) => String.fromCodePoint(codePoint));

describePostgres('PostgreSQL canonical rule match keys', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function sqlMatchKey(value: string | null): Promise<string | null> {
    const rows = await db.$queryRaw<Array<{ value: string | null }>>`
      SELECT rule_match_key(${value}) AS value
    `;
    return rows[0]?.value ?? null;
  }

  it.each([
    ['NFC composition', 'Cafe\u0301', normalizeRuleMatchText('Cafe\u0301')],
    ['punctuation stays literal', '  Acme, Inc.  ', normalizeRuleMatchText('  Acme, Inc.  ')],
    ['Greek final sigma', 'ΟΣ ος', normalizeRuleMatchText('ΟΣ ος')],
    ['sharp-S and capital sharp-S', 'Straße ẞ', normalizeRuleMatchText('Straße ẞ')],
    ['dotless-I stays separate', 'I ı İ', normalizeRuleMatchText('I ı İ')],
    ['multi-scalar ligature fold', 'ﬃ', normalizeRuleMatchText('ﬃ')],
    ['empty input', '', ''],
    ['blank input', '\t \n', ''],
  ])('matches TypeScript for %s', async (_label, input, expected) => {
    expect(await sqlMatchKey(input)).toBe(expected);
  });

  it.each(ECMASCRIPT_WHITESPACE.map((whitespace, index) => [index, whitespace] as const))(
    'trims and collapses ECMAScript whitespace scalar %i',
    async (_index, whitespace) => {
      const input = `${whitespace}North${whitespace}${whitespace}Shore${whitespace}`;
      expect(await sqlMatchKey(input)).toBe(normalizeRuleMatchText(input));
    },
  );

  it('is strict, immutable, parallel-safe, idempotent, and self-describing', async () => {
    const functions = await db.$queryRaw<Array<{
      proname: string;
      volatility: string;
      strict: boolean;
      parallel: string;
      config: string;
    }>>`
      SELECT proname, provolatile AS volatility, proisstrict AS strict,
             proparallel AS parallel,
             COALESCE(array_to_string(proconfig, ','), '') AS config
        FROM pg_proc
       WHERE oid IN (
         'rule_match_key(text)'::regprocedure,
         'rule_unicode_case_fold_16_0(text)'::regprocedure
       )
       ORDER BY proname
    `;
    const contracts = await db.$queryRaw<Array<{ contract: unknown }>>`
      SELECT rule_match_key_contract() AS contract
    `;
    const first = await sqlMatchKey('\u00a0Straße\ufeffΟΣ\u3000');

    expect(await sqlMatchKey(null)).toBeNull();
    expect(functions).toEqual([
      {
        proname: 'rule_match_key', volatility: 'i', strict: true, parallel: 's',
        config: 'search_path=pg_catalog, public',
      },
      {
        proname: 'rule_unicode_case_fold_16_0', volatility: 'i', strict: true, parallel: 's',
        config: 'search_path=pg_catalog, public',
      },
    ]);
    expect(contracts).toEqual([{ contract: {
      unicodeVersion: UNICODE_CASE_FOLD_VERSION,
      mappingEntryCount: UNICODE_CASE_FOLD_ENTRY_COUNT,
      mappingSha256: UNICODE_CASE_FOLD_SHA256,
      statuses: 'C+F',
      turkic: false,
      normalization: 'NFC -> ECMAScript whitespace trim/collapse -> default case fold -> NFC',
    } }]);
    expect(await sqlMatchKey(first)).toBe(first);
  });

  it('matches all 1,557 pinned Unicode folds in one set-based parity query', async () => {
    const expected = UNICODE_CASE_FOLD_ENTRIES.map(([codePoint]) => {
      const input = String.fromCodePoint(codePoint);
      return { input, expected: normalizeRuleMatchText(input) };
    });
    const rows = await db.$queryRawUnsafe<Array<{
      total: number;
      matching: number;
      idempotent: number;
    }>>(`
      WITH expected AS (
        SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS value(input text, expected text)
      ), actual AS (
        SELECT input, expected, rule_match_key(input) AS actual
          FROM expected
      )
      SELECT count(*)::integer AS total,
             count(*) FILTER (WHERE actual = expected)::integer AS matching,
             count(*) FILTER (WHERE rule_match_key(actual) = actual)::integer AS idempotent
        FROM actual
    `, JSON.stringify(expected));

    expect(rows).toEqual([{
      total: UNICODE_CASE_FOLD_ENTRY_COUNT,
      matching: UNICODE_CASE_FOLD_ENTRY_COUNT,
      idempotent: UNICODE_CASE_FOLD_ENTRY_COUNT,
    }]);
    // Exhaustive parity is a correctness check, not a five-second CI benchmark.
  }, 30_000);
});
