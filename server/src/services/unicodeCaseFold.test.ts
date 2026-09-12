import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  foldUnicodeDefaultCase,
  UNICODE_CASE_FOLD_ENTRIES,
  UNICODE_CASE_FOLD_ENTRY_COUNT,
  UNICODE_CASE_FOLD_SHA256,
  UNICODE_CASE_FOLD_VERSION,
} from './unicodeCaseFold.js';

function scalarHex(value: string): string {
  return [...value]
    .map((scalar) => scalar.codePointAt(0)!.toString(16).toUpperCase().padStart(6, '0'))
    .join(' ');
}

describe('pinned Unicode default case-fold mapping', () => {
  it('pins Unicode 16.0 mapping count and checksum', () => {
    const canonicalMapping = UNICODE_CASE_FOLD_ENTRIES
      .map(([codePoint, folded]) => (
        `${codePoint.toString(16).toUpperCase().padStart(6, '0')};${scalarHex(folded)}\n`
      ))
      .join('');

    expect(UNICODE_CASE_FOLD_VERSION).toBe('16.0.0');
    expect(UNICODE_CASE_FOLD_ENTRIES).toHaveLength(UNICODE_CASE_FOLD_ENTRY_COUNT);
    expect(UNICODE_CASE_FOLD_ENTRY_COUNT).toBe(1_557);
    expect(createHash('sha256').update(canonicalMapping).digest('hex'))
      .toBe(UNICODE_CASE_FOLD_SHA256);
    expect(UNICODE_CASE_FOLD_SHA256)
      .toBe('3665d2456dc5fa6295527b8fe486e5a100cd898ab02585ec09b6db4b4244ab50');
  });

  it('exhaustively applies every mapping and leaves every mapped result idempotent', () => {
    for (const [codePoint, folded] of UNICODE_CASE_FOLD_ENTRIES) {
      expect(foldUnicodeDefaultCase(String.fromCodePoint(codePoint))).toBe(folded);
      expect(foldUnicodeDefaultCase(folded)).toBe(folded);
    }
  });
});
