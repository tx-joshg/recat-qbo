import { describe, expect, it } from 'vitest';
import { parseActionTagIds } from './actionTagIds.js';

const tags = (count: number) => Array.from({ length: count }, (_unused, index) =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`);

describe('exact action tag IDs', () => {
  it('preserves exactly fifty and rejects the entire invalid value', () => {
    expect(parseActionTagIds(tags(50))).toEqual(tags(50));
    expect(parseActionTagIds(tags(51))).toBeNull();
    expect(parseActionTagIds([...tags(2), tags(1)[0]!])).toBeNull();
    expect(parseActionTagIds(['not-a-uuid'])).toBeNull();
    expect(parseActionTagIds('not-an-array')).toBeNull();
  });
});
