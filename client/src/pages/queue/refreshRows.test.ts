import type { TransactionDto } from '@recat/shared';
import { describe, expect, it } from 'vitest';
import { mergeRefreshedRows } from './refreshRows';

const row = (id: string, status: TransactionDto['status']) =>
  ({ id, status }) as TransactionDto;

describe('mergeRefreshedRows', () => {
  it('replaces refreshed rows in place and leaves the rest untouched', () => {
    const prev = [row('a', 'PENDING'), row('b', 'POSTING'), row('c', 'PENDING')];
    const untouched = prev[2];

    const next = mergeRefreshedRows(prev, [row('b', 'POSTED')], ['b']);

    expect(next.map((r) => [r.id, r.status])).toEqual([
      ['a', 'PENDING'],
      ['b', 'POSTED'],
      ['c', 'PENDING'],
    ]);
    expect(next[2]).toBe(untouched);
  });

  it('drops a requested row the server no longer returns', () => {
    const next = mergeRefreshedRows([row('a', 'PENDING'), row('b', 'PENDING')], [], ['b']);

    expect(next.map((r) => r.id)).toEqual(['a']);
  });

  it('ignores unrequested rows in the response', () => {
    const next = mergeRefreshedRows(
      [row('a', 'PENDING'), row('b', 'PENDING')],
      [row('a', 'POSTED'), row('b', 'POSTED')],
      ['b'],
    );

    expect(next.map((r) => r.status)).toEqual(['PENDING', 'POSTED']);
  });
});
