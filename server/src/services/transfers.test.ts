import { describe, expect, it } from 'vitest';
import {
  isTransferPair,
  pairTransfers,
  pickCounterpartAccount,
  type CounterpartAccountLike,
  type PairableTxn,
} from './transfers.js';

function t(id: string, amount: number, bankAccount: string, date: string): PairableTxn {
  return { id, amount, bankAccount, date: new Date(date) };
}

describe('isTransferPair', () => {
  const out = t('a', -750, 'Checking ·4821', '2026-07-13');

  it('matches equal |amount|, opposite sign, different account, same day', () => {
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-13'))).toBe(true);
  });

  it('rejects same sign', () => {
    expect(isTransferPair(out, t('b', -750, 'Visa ·0392', '2026-07-13'))).toBe(false);
  });

  it('rejects same bank account', () => {
    expect(isTransferPair(out, t('b', 750, 'Checking ·4821', '2026-07-13'))).toBe(false);
  });

  it('rejects different amounts', () => {
    expect(isTransferPair(out, t('b', 750.5, 'Visa ·0392', '2026-07-13'))).toBe(false);
  });

  it('honors the 3-day window', () => {
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-16'))).toBe(true);
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-17'))).toBe(false);
  });
});

describe('pairTransfers', () => {
  it('pairs the prototype T17/T18 transfer and maps both directions', () => {
    const pairs = pairTransfers([
      t('t17', -750, 'Checking ·4821', '2026-07-13'),
      t('t18', 750, 'Visa ·0392', '2026-07-13'),
      t('t3', -52.4, 'Visa ·0392', '2026-07-01'),
    ]);
    expect(pairs.get('t17')).toBe('t18');
    expect(pairs.get('t18')).toBe('t17');
    expect(pairs.has('t3')).toBe(false);
  });

  it('pairs each txn at most once (greedy by date)', () => {
    const pairs = pairTransfers([
      t('out1', -100, 'Checking', '2026-07-01'),
      t('in1', 100, 'Visa', '2026-07-02'),
      t('in2', 100, 'Savings', '2026-07-03'),
    ]);
    expect(pairs.get('out1')).toBe('in1');
    expect(pairs.has('in2')).toBe(false);
    expect(pairs.size).toBe(2);
  });

  it('returns an empty map for unmatched txns', () => {
    const pairs = pairTransfers([
      t('a', -10, 'Checking', '2026-07-01'),
      t('b', 20, 'Visa', '2026-07-01'),
    ]);
    expect(pairs.size).toBe(0);
  });
});

describe('pickCounterpartAccount', () => {
  const acct = (qboId: string, name: string, active = true): CounterpartAccountLike => ({ qboId, name, active });

  it('picks the single active account matching the name', () => {
    const picked = pickCounterpartAccount([acct('1', 'Checking ·4821'), acct('2', 'Visa ·0392')], 'Visa ·0392');
    expect(picked.qboId).toBe('2');
  });

  it('ignores inactive accounts with the same name', () => {
    const picked = pickCounterpartAccount(
      [acct('1', 'Visa ·0392', false), acct('2', 'Visa ·0392')],
      'Visa ·0392',
    );
    expect(picked.qboId).toBe('2');
  });

  it('fails loudly when no active account matches', () => {
    expect(() => pickCounterpartAccount([acct('1', 'Visa ·0392', false)], 'Visa ·0392')).toThrow(/not found/);
    expect(() => pickCounterpartAccount([], 'Visa ·0392')).toThrow(/not found/);
  });

  it('fails loudly on an ambiguous name instead of guessing', () => {
    expect(() =>
      pickCounterpartAccount([acct('1', 'Checking'), acct('2', 'Checking')], 'Checking'),
    ).toThrow(/ambiguous/);
  });
});
