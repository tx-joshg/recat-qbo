import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  AgentSnapshotError,
  buildAgentSnapshot,
  serializeAgentSnapshot,
  type AgentSnapshotSource,
} from './snapshot.js';

const IDS = {
  transaction: '11111111-1111-4111-8111-111111111111',
  tag: '55555555-5555-4555-8555-555555555555',
  rule: '66666666-6666-4666-8666-666666666666',
  similar: '77777777-7777-4777-8777-777777777777',
} as const;

function itemUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function validSource(overrides: Partial<AgentSnapshotSource> = {}): AgentSnapshotSource {
  return {
    transaction: { id: IDS.transaction, revision: 7 },
    date: '2026-07-09',
    signedAmountCents: -12345,
    currency: 'cad',
    sourceAccount: { displayName: '  Operating\tAccount  ', type: 'BANK' },
    payee: '  Caf\u00e9\n  Supplies ',
    memo: '  July\tcoffee ',
    candidateCategories: [
      { qboId: '300', name: '  Zeta expense ' },
      { qboId: '100', name: 'Alpha expense' },
    ],
    tax: {
      status: 'ready',
      supportedCalculationModes: ['TaxExcluded'],
      eligibleReferences: [{ qboId: '200', label: ' Standard tax ' }],
    },
    tags: [{ id: IDS.tag, name: ' Travel ' }],
    rules: [
      {
        id: IDS.rule,
        priority: 10,
        matchField: 'payee',
        matchText: '  Cafe ',
        categoryQboId: '100',
        taxCalculation: 'TaxExcluded',
        taxCodeQboId: '200',
        tagIds: [IDS.tag],
      },
    ],
    similarVerifiedTransactions: [
      {
        transactionId: IDS.similar,
        date: '2026-06-09',
        signedAmountCents: -12000,
        currency: 'CAD',
        payee: 'Cafe Supplies',
        memo: 'Lunch meeting',
        taxCalculation: 'TaxExcluded',
        lines: [
          {
            signedGrossCents: -12000,
            categoryQboId: '100',
            taxCodeQboId: '200',
            memo: '  Lunch\tmeeting ',
            tagIds: [IDS.tag],
          },
        ],
        tagIds: [IDS.tag],
        verifiedAt: '2026-06-10T12:00:00.000Z',
      },
    ],
    featureVersion: 'shadow-core.1',
    configurationVersion: 'config-2026.07',
    ...overrides,
  };
}

function expectSnapshotError(action: () => unknown, code: AgentSnapshotError['code']): void {
  try {
    action();
    throw new Error('Expected AgentSnapshotError');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSnapshotError);
    expect((error as AgentSnapshotError).code).toBe(code);
  }
}

describe('buildAgentSnapshot', () => {
  it('retains exactly the provider-safe field allowlist and normalizes text', () => {
    const snapshot = buildAgentSnapshot(validSource());

    expect(snapshot).toEqual({
      schemaVersion: 1,
      transaction: { id: IDS.transaction, revision: 7 },
      date: '2026-07-09',
      signedAmountCents: -12345,
      currency: 'CAD',
      sourceAccount: { displayName: 'Operating Account', type: 'BANK' },
      payee: 'Caf\u00e9 Supplies',
      memo: 'July coffee',
      candidateCategories: [
        { qboId: '100', name: 'Alpha expense' },
        { qboId: '300', name: 'Zeta expense' },
      ],
      tax: {
        status: 'ready',
        supportedCalculationModes: ['TaxExcluded'],
        eligibleReferences: [{ qboId: '200', label: 'Standard tax' }],
      },
      tags: [{ id: IDS.tag, name: 'Travel' }],
      rules: [
        {
          id: IDS.rule,
          priority: 10,
          matchField: 'payee',
          matchText: 'Cafe',
          categoryQboId: '100',
          taxCalculation: 'TaxExcluded',
          taxCodeQboId: '200',
          tagIds: [IDS.tag],
        },
      ],
      similarVerifiedTransactions: [
        {
          transactionId: IDS.similar,
          date: '2026-06-09',
          signedAmountCents: -12000,
          currency: 'CAD',
          payee: 'Cafe Supplies',
          memo: 'Lunch meeting',
          taxCalculation: 'TaxExcluded',
          lines: [
            {
              signedGrossCents: -12000,
              categoryQboId: '100',
              taxCodeQboId: '200',
              memo: 'Lunch meeting',
              tagIds: [IDS.tag],
            },
        ],
        tagIds: [IDS.tag],
        verifiedAt: '2026-06-10T12:00:00.000Z',
        },
      ],
      featureVersion: 'shadow-core.1',
      configurationVersion: 'config-2026.07',
    });

    const serialized = serializeAgentSnapshot(snapshot, 64 * 1024);
    expect(serialized).not.toContain('companyId');
    expect(serialized).not.toMatch(/accountNumber|accessToken|apiKey|rawQbo|unrelated/i);
  });

  it('sorts every bounded collection deterministically and caps it at twenty entries', () => {
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      qboId: String(index + 1),
      name: `Category ${String(21 - index).padStart(2, '0')}`,
    }));
    const snapshot = buildAgentSnapshot(
      validSource({
        candidateCategories: candidates,
        tax: {
          status: 'ready',
          supportedCalculationModes: ['TaxExcluded'],
          eligibleReferences: candidates.map(({ qboId, name }) => ({ qboId, label: name })),
        },
        tags: candidates.map(({ name }, index) => ({ id: itemUuid(index + 1), name })),
        rules: candidates.map(({ qboId, name }, index) => ({
          id: itemUuid(index + 1),
          priority: 21 - index,
          matchField: 'payee' as const,
          matchText: name,
          categoryQboId: qboId,
          taxCalculation: 'NotApplicable' as const,
          taxCodeQboId: null,
          tagIds: [],
        })),
        similarVerifiedTransactions: candidates.map(({ qboId }, index) => ({
          transactionId: itemUuid(index + 1),
          date: `2026-06-${String(index + 1).padStart(2, '0')}`,
          signedAmountCents: -(index + 1),
          currency: 'CAD',
          payee: `Payee ${index}`,
          taxCalculation: 'NotApplicable' as const,
          lines: [{ signedGrossCents: -(index + 1), categoryQboId: qboId, taxCodeQboId: null, tagIds: [] }],
          tagIds: [],
          verifiedAt: `2026-06-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
        })),
      }),
    );

    expect(snapshot.candidateCategories).toHaveLength(20);
    expect(snapshot.tax.eligibleReferences).toHaveLength(20);
    expect(snapshot.tags).toHaveLength(20);
    expect(snapshot.rules).toHaveLength(20);
    expect(snapshot.similarVerifiedTransactions).toHaveLength(20);
    expect(snapshot.candidateCategories.map((item) => item.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Category ${String(index + 1).padStart(2, '0')}`),
    );
    expect(snapshot.rules.map((item) => item.priority)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('accepts bounded numeric QBO references but rejects unknown fields, duplicates, and invalid values safely', () => {
    const secret = 'sensitive-example-token';
    const cases: Array<() => unknown> = [
      () => buildAgentSnapshot({ ...validSource(), companyId: IDS.transaction } as unknown as AgentSnapshotSource),
      () => buildAgentSnapshot({ ...validSource(), sourceAccount: { ...validSource().sourceAccount, accountNumber: '123456789' } } as unknown as AgentSnapshotSource),
      () => buildAgentSnapshot(validSource({ candidateCategories: [{ qboId: '100', name: 'A' }, { qboId: '100', name: 'B' }] })),
      () => buildAgentSnapshot(validSource({ date: '2026-15-99' })),
      () => buildAgentSnapshot(validSource({ signedAmountCents: 12.5 })),
      () => buildAgentSnapshot(validSource({ rules: [{ ...validSource().rules[0]!, priority: Number.POSITIVE_INFINITY }] })),
      () => buildAgentSnapshot({ ...validSource(), rawPayload: secret } as unknown as AgentSnapshotSource),
    ];

    expect(buildAgentSnapshot(validSource({
      candidateCategories: [{ qboId: '42', name: 'Numeric reference' }],
      rules: [{ ...validSource().rules[0]!, categoryQboId: '42' }],
      similarVerifiedTransactions: [{ ...validSource().similarVerifiedTransactions[0]!, lines: [{ ...validSource().similarVerifiedTransactions[0]!.lines[0]!, categoryQboId: '42' }] }],
    })).candidateCategories[0]!.qboId).toBe('42');
    expect(buildAgentSnapshot(validSource({ transaction: { id: '018f8c70-0000-7000-8000-000000000000', revision: 7 } })).transaction.id).toBe('018f8c70-0000-7000-8000-000000000000');
    for (const action of cases.slice(0, -1)) expectSnapshotError(action, 'AGENT_SNAPSHOT_INVALID');
    try {
      cases[cases.length - 1]!();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSnapshotError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('returns a detached recursively frozen snapshot', () => {
    const source = validSource();
    const snapshot = buildAgentSnapshot(source);
    source.candidateCategories[0]!.name = 'Changed after build';
    source.similarVerifiedTransactions[0]!.lines[0]!.memo = 'Changed after build';

    expect(snapshot.candidateCategories[1]!.name).toBe('Zeta expense');
    expect(snapshot.similarVerifiedTransactions[0]!.lines[0]!.memo).toBe('Lunch meeting');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.candidateCategories)).toBe(true);
    expect(Object.isFrozen(snapshot.similarVerifiedTransactions[0]!.lines[0]!)).toBe(true);
    expect(() => (snapshot.candidateCategories as unknown as Array<unknown>).push('mutation')).toThrow(TypeError);
    expect(() => {
      (snapshot.similarVerifiedTransactions[0]!.lines[0] as { memo: string }).memo = 'mutation';
    }).toThrow(TypeError);
    expect(Object.isFrozen(snapshot.rules[0]!.tagIds)).toBe(true);
    expect(Object.isFrozen(snapshot.similarVerifiedTransactions[0]!.tagIds)).toBe(true);
    expect(Object.isFrozen(snapshot.similarVerifiedTransactions[0]!.lines[0]!.tagIds)).toBe(true);
  });

  it('rejects orphaned retained references and inconsistent verified tax history safely', () => {
    const base = validSource();
    const cases: Array<() => unknown> = [
      () => buildAgentSnapshot(validSource({ rules: [{ ...base.rules[0]!, categoryQboId: '999' }] })),
      () => buildAgentSnapshot(validSource({ rules: [{ ...base.rules[0]!, tagIds: [itemUuid(99)] }] })),
      () => buildAgentSnapshot(validSource({ rules: [{ ...base.rules[0]!, taxCodeQboId: '999' }] })),
      () => buildAgentSnapshot(validSource({ rules: [{ ...base.rules[0]!, taxCodeQboId: null }] })),
      () => buildAgentSnapshot(validSource({ rules: [{ ...base.rules[0]!, taxCalculation: 'NotApplicable', taxCodeQboId: '200' }] })),
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, tagIds: [itemUuid(99)] }] })),
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: [] }] })),
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: [{ ...base.similarVerifiedTransactions[0]!.lines[0]!, signedGrossCents: 12000 }] }] })),
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: [{ ...base.similarVerifiedTransactions[0]!.lines[0]!, signedGrossCents: -11999 }] }] })),
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: [{ ...base.similarVerifiedTransactions[0]!.lines[0]!, categoryQboId: '999' }] }] })),
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: [{ ...base.similarVerifiedTransactions[0]!.lines[0]!, taxCalculation: 'NotApplicable' } as never] }] })),
    ];

    for (const action of cases) expectSnapshotError(action, 'AGENT_SNAPSHOT_INVALID');
  });

  it('models readiness status and only exposes taxable capability when ready', () => {
    const base = validSource();
    const notApplicableRule = { ...base.rules[0]!, taxCalculation: 'NotApplicable' as const, taxCodeQboId: null };
    const notApplicableHistory = {
      ...base.similarVerifiedTransactions[0]!,
      taxCalculation: 'NotApplicable' as const,
      lines: [{ ...base.similarVerifiedTransactions[0]!.lines[0]!, taxCodeQboId: null }],
    };
    const nonReady = validSource({
      tax: { status: 'needs_setup', supportedCalculationModes: [], eligibleReferences: [] },
      rules: [notApplicableRule],
      similarVerifiedTransactions: [notApplicableHistory],
    });

    expect(buildAgentSnapshot(nonReady).tax.status).toBe('needs_setup');
    expectSnapshotError(
      () => buildAgentSnapshot({ ...nonReady, tax: { ...nonReady.tax, eligibleReferences: [{ qboId: '200', label: 'Standard tax' }] } }),
      'AGENT_SNAPSHOT_INVALID',
    );
    expectSnapshotError(
      () => buildAgentSnapshot({ ...nonReady, tax: { ...nonReady.tax, supportedCalculationModes: ['TaxExcluded'] } }),
      'AGENT_SNAPSHOT_INVALID',
    );
    expectSnapshotError(
      () => buildAgentSnapshot({ ...validSource(), tax: { status: 'ready', supportedCalculationModes: [], eligibleReferences: [] } }),
      'AGENT_SNAPSHOT_INVALID',
    );
    expectSnapshotError(
      () => buildAgentSnapshot({ ...validSource(), tax: { ...validSource().tax, supportedCalculationModes: ['TaxInclusive'] } }),
      'AGENT_SNAPSHOT_INVALID',
    );
  });

  it('rejects oversized source collections before normalizing and retaining twenty entries', () => {
    const base = validSource();
    expectSnapshotError(
      () => buildAgentSnapshot(validSource({ candidateCategories: Array.from({ length: 101 }, (_, index) => ({ qboId: String(index + 1), name: `Category ${index}` })) })),
      'AGENT_SNAPSHOT_INVALID',
    );
    expectSnapshotError(
      () => buildAgentSnapshot(validSource({ rules: Array.from({ length: 101 }, (_, index) => ({ ...base.rules[0]!, id: itemUuid(index + 1), priority: index })) })),
      'AGENT_SNAPSHOT_INVALID',
    );
    expectSnapshotError(
      () => buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: Array.from({ length: 21 }, () => base.similarVerifiedTransactions[0]!.lines[0]!) }] })),
      'AGENT_SNAPSHOT_INVALID',
    );
    expectSnapshotError(
      () => buildAgentSnapshot(validSource({ rules: [{ ...base.rules[0]!, tagIds: Array.from({ length: 21 }, (_, index) => itemUuid(index + 1)) }] })),
      'AGENT_SNAPSHOT_INVALID',
    );
  });

  it('rejects likely account numbers and strict-DTo descriptor bypasses without reflecting values', () => {
    const accountNumber = '1234 5678 9012';
    const hidden = validSource() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hidden, 'companyId', { value: IDS.transaction, enumerable: false });
    const accessor = validSource() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(accessor, 'payee', { get: () => 'ordinary payee', enumerable: true });
    const symbol = validSource() as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol('private')] = 'hidden';

    const cases = [
      () => buildAgentSnapshot(validSource({ payee: accountNumber })),
      () => buildAgentSnapshot(hidden as unknown as AgentSnapshotSource),
      () => buildAgentSnapshot(accessor as unknown as AgentSnapshotSource),
      () => buildAgentSnapshot(symbol as unknown as AgentSnapshotSource),
    ];
    for (const action of cases) {
      try {
        action();
        throw new Error('Expected AgentSnapshotError');
      } catch (error) {
        expect(error).toBeInstanceOf(AgentSnapshotError);
        expect((error as Error).message).not.toContain(accountNumber);
      }
    }
  });

  it('canonicalizes equivalent history line permutations with a total line ordering', () => {
    const base = validSource();
    const lines = [
      { signedGrossCents: -6000, categoryQboId: '100', taxCodeQboId: '200', memo: 'Z memo', tagIds: [IDS.tag] },
      { signedGrossCents: -6000, categoryQboId: '100', taxCodeQboId: '200', memo: 'A memo', tagIds: [] },
    ];
    const left = buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines }] }));
    const right = buildAgentSnapshot(validSource({ similarVerifiedTransactions: [{ ...base.similarVerifiedTransactions[0]!, lines: [...lines].reverse() }] }));

    expect(serializeAgentSnapshot(left, 64 * 1024)).toBe(serializeAgentSnapshot(right, 64 * 1024));
  });
});

describe('serializeAgentSnapshot', () => {
  it('uses deterministic canonical JSON and measures its UTF-8 byte length', () => {
    const snapshot = buildAgentSnapshot(validSource({ payee: 'Caf\u00e9 \u2615' }));
    const first = serializeAgentSnapshot(snapshot, 64 * 1024);
    const second = serializeAgentSnapshot(snapshot, 64 * 1024);

    expect(first).toBe(second);
    expect(Buffer.byteLength(first, 'utf8')).toBeGreaterThan(first.length - 1);
    expectSnapshotError(() => serializeAgentSnapshot(snapshot, Buffer.byteLength(first, 'utf8') - 1), 'AGENT_SNAPSHOT_TOO_LARGE');
  });

  it('validates supplied snapshots and does not reflect their data in serialization errors', () => {
    const snapshot = buildAgentSnapshot(validSource({ payee: 'private merchant name' }));
    const invalid = JSON.parse(serializeAgentSnapshot(snapshot, 64 * 1024)) as typeof snapshot;
    (invalid as { currency: string }).currency = 'BAD!';

    try {
      serializeAgentSnapshot(invalid, 64 * 1024);
      throw new Error('Expected AgentSnapshotError');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSnapshotError);
      expect((error as AgentSnapshotError).code).toBe('AGENT_SNAPSHOT_INVALID');
      expect((error as Error).message).not.toContain('private merchant name');
    }
  });
});
