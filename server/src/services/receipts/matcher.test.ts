import { describe, expect, it } from 'vitest';
import {
  candidateAmountRange,
  hasIdentityEvidence,
  rankReceiptCandidates,
  scoreReceiptCandidate,
  tokenJaccard,
  type MatchableReceipt,
  type MatchableTransaction,
} from './matcher.js';

const receipt = (
  overrides: Partial<MatchableReceipt> = {},
): MatchableReceipt => ({
  totalAmount: '11.20',
  currency: 'CAD',
  receiptDate: '2026-07-30',
  vendorName: 'Synthetic Office Supply',
  paymentIdentifier: '1234',
  documentType: 'expense_receipt',
  ...overrides,
});

const transaction = (
  overrides: Partial<MatchableTransaction> = {},
): MatchableTransaction => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  amount: '-11.20',
  currency: 'CAD',
  date: '2026-07-30',
  payee: 'SYNTHETIC OFFICE SUPPLY 1234',
  memo: 'Card ending 1234',
  rawData: null,
  status: 'PENDING',
  revision: 0,
  ...overrides,
});

describe('deterministic receipt matcher', () => {
  it('scores an exact same-day vendor and payment match at 100', () => {
    expect(scoreReceiptCandidate(receipt(), transaction())).toMatchObject({
      score: 100,
      evidence: {
        amountPoints: 55,
        currencyPoints: 10,
        datePoints: 20,
        vendorPoints: 10,
        paymentPoints: 5,
      },
    });
  });

  it.each([
    ['amount outside two percent', receipt({ totalAmount: '10.00' }),
      transaction({ amount: '-10.21' })],
    ['known currency mismatch', receipt({ currency: 'CAD' }),
      transaction({ currency: 'USD' })],
    ['known direction mismatch', receipt({ documentType: 'expense_receipt' }),
      transaction({ amount: '10.00' })],
    ['outside fourteen days', receipt({ receiptDate: '2026-07-30' }),
      transaction({ date: '2026-08-14' })],
  ])('excludes %s', (_label, receiptValue, transactionValue) => {
    expect(scoreReceiptCandidate(receiptValue, transactionValue)).toBeNull();
  });

  it.each([
    ['10.00', '-10.00', 55],
    ['10.00', '-10.01', 50],
    ['100.00', '-100.50', 40],
    ['100.00', '-102.00', 25],
  ])('scores amount boundary %s versus %s', (total, amount, points) => {
    expect(scoreReceiptCandidate(
      receipt({ totalAmount: total }),
      transaction({ amount }),
    )?.evidence.amountPoints).toBe(points);
  });

  it.each([
    [0, 20],
    [1, 16],
    [3, 10],
    [7, 4],
    [14, 0],
  ])('scores %i date days as %i', (days, points) => {
    const date = new Date(Date.UTC(2026, 6, 30 + days))
      .toISOString().slice(0, 10);
    expect(scoreReceiptCandidate(
      receipt(),
      transaction({ date }),
    )?.evidence.datePoints).toBe(points);
  });

  it('normalizes accents and applies exact token similarity boundaries', () => {
    expect(tokenJaccard('Café Alpha', 'CAFE ALPHA')).toBe(1);
    expect(tokenJaccard('one two', 'one three')).toBeCloseTo(1 / 3);
    expect(scoreReceiptCandidate(
      receipt({ vendorName: 'one two' }),
      transaction({ payee: 'one two three', memo: null }),
    )?.evidence.vendorPoints).toBe(6);
    expect(scoreReceiptCandidate(
      receipt({ vendorName: 'one two three four' }),
      transaction({ payee: 'one two three four five', memo: null }),
    )?.evidence.vendorPoints).toBe(10);
  });

  it('allows unknown direction/currency without inventing vendor/payment evidence', () => {
    const scored = scoreReceiptCandidate(
      receipt({
        currency: null,
        documentType: null,
        vendorName: null,
        paymentIdentifier: '12',
      }),
      transaction({ currency: null, amount: '11.20', payee: '', memo: null }),
    );
    expect(scored?.evidence).toMatchObject({
      currencyPoints: 10,
      vendorPoints: 0,
      paymentPoints: 0,
    });
  });

  it('uses transaction id as the final deterministic tie break', () => {
    const ranked = rankReceiptCandidates(receipt(), [
      transaction({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      transaction({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ]);
    expect(ranked.map((item) => item.transactionId)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('does not treat amount, date and currency alone as identity evidence', () => {
    const otherVendor = scoreReceiptCandidate(
      receipt({ paymentIdentifier: null }),
      transaction({ payee: 'Unrelated Fuel Stop', memo: null }),
    )!;
    // Same amount, same day, same currency already clears the default
    // auto-match threshold of 85...
    expect(otherVendor.score).toBe(85);
    // ...but nothing ties this charge to the receipt's vendor.
    expect(hasIdentityEvidence(otherVendor)).toBe(false);

    expect(hasIdentityEvidence(scoreReceiptCandidate(receipt(), transaction())!)).toBe(true);
    expect(hasIdentityEvidence(scoreReceiptCandidate(
      receipt({ vendorName: null }),
      transaction(),
    )!)).toBe(true); // payment identifier alone
  });
});

describe('candidateAmountRange', () => {
  it('covers every amount the scorer accepts and excludes the first it rejects', () => {
    for (const total of ['0.01', '0.49', '11.20', '100.00', '-100.00', '1234.56']) {
      const range = candidateAmountRange(total);
      expect(range).not.toBeNull();
      const min = Number(range!.min);
      const max = Number(range!.max);
      const totalCents = Math.round(Math.abs(Number(total)) * 100);
      for (let delta = -Math.ceil(totalCents * 0.03) - 2; delta <= Math.ceil(totalCents * 0.03) + 2; delta += 1) {
        const amountCents = totalCents + delta;
        if (amountCents <= 0) continue;
        const amount = (amountCents / 100).toFixed(2);
        const scored = scoreReceiptCandidate(
          receipt({ totalAmount: total, documentType: null }),
          transaction({ amount: `-${amount}` }),
        );
        const inRange = Number(amount) >= min && Number(amount) <= max;
        expect({ amount, inRange }).toEqual({ amount, inRange: scored !== null });
      }
    }
  });

  it('returns null when the receipt has no usable total', () => {
    expect(candidateAmountRange(null)).toBeNull();
    expect(candidateAmountRange('not-a-number')).toBeNull();
  });
});
