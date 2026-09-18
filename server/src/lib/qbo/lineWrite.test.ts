import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPreparedLineWrite,
  hashLineWriteContent,
  hashLineWriteRequest,
  isQboPreparedLineWrite,
  validatePreparedLineTransformation,
  validatePreparedLineWrite,
  verifyLineWriteResult,
} from './lineWrite.js';
import type { QboTxn } from './types.js';

function deterministicJsonFixture(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(deterministicJsonFixture).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${deterministicJsonFixture(record[key])}`)
    .join(',')}}`;
}

function exactBodyHash(body: Record<string, unknown>): string {
  return createHash('sha256')
    .update(deterministicJsonFixture(body))
    .digest('hex');
}

function jsonbStyleRoundTrip(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(jsonbStyleRoundTrip);
  const reordered = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  )) {
    Object.defineProperty(reordered, key, {
      value: jsonbStyleRoundTrip((value as Record<string, unknown>)[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return reordered;
}

const currentBody = {
  Id: 'ENTITY_GENERIC',
  SyncToken: '7',
  MetaData: { LastUpdatedTime: '2026-07-01T00:00:00Z' },
  domain: 'QBO',
  sparse: false,
  PrivateNote: 'generic private note',
  AccountRef: { value: 'ACCOUNT_PAYMENT_GENERIC', name: 'Generic payment' },
  ExplicitNull: null,
  UnknownAccountingField: { preserve: true },
  Line: [
    {
      Id: 'LINE_HOLDING_GENERIC',
      Amount: 10,
      Description: 'generic holding memo',
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: 'ACCOUNT_HOLDING_GENERIC', name: 'Generic holding' },
        TaxCodeRef: { value: 'TAX_GENERIC', name: 'Generic tax' },
        TaxAmount: 0.5,
      },
    },
    {
      Id: 'LINE_UNTOUCHED_GENERIC',
      Amount: 5,
      Description: 'generic untouched memo',
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: 'ACCOUNT_UNTOUCHED_GENERIC', name: 'Generic untouched' },
      },
      UnknownLineField: { preserve: true },
    },
  ],
} satisfies Record<string, unknown>;

function validPrepared() {
  const body = {
    ...structuredClone(currentBody),
    Line: [
      structuredClone(currentBody.Line[1]),
      {
        Amount: 10,
        Description: 'generic target memo',
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'ACCOUNT_TARGET_GENERIC' },
          TaxCodeRef: { value: 'TAX_GENERIC' },
          TaxAmount: 0.5,
        },
      },
    ],
  };
  const beforeContentHash = hashLineWriteContent(currentBody);
  return {
    operation: 'transfer',
    qboType: 'Purchase',
    qboId: 'ENTITY_GENERIC',
    requestId: 'REQUEST_GENERIC',
    requestHash: exactBodyHash(body),
    body,
    before: {
      qboType: 'Purchase',
      qboId: 'ENTITY_GENERIC',
      syncToken: '7',
      contentHash: beforeContentHash,
    },
    expected: {
      qboType: 'Purchase',
      qboId: 'ENTITY_GENERIC',
      contentHash: hashLineWriteContent(body),
    },
  };
}

describe('validatePreparedLineTransformation', () => {
  it('returns reconstructed plain data detached from the candidate and fresh raw entity', () => {
    const raw = structuredClone(currentBody);
    const txn: QboTxn = {
      qboId: 'ENTITY_GENERIC',
      qboType: 'Purchase',
      syncToken: '7',
      date: '2026-07-29',
      payee: 'Generic Payee',
      memo: 'generic transaction memo',
      amount: -10,
      bankAccount: 'Generic payment',
      lines: [{
        id: 'LINE_HOLDING_GENERIC',
        amount: 10,
        accountQboId: 'ACCOUNT_HOLDING_GENERIC',
        accountName: 'Generic holding',
      }],
      raw,
    };
    const args = {
      txn,
      splits: [{
        amount: -10,
        accountQboId: 'ACCOUNT_TARGET_GENERIC',
        memo: 'generic target memo',
      }],
      requestId: 'REQUEST_GENERIC',
      holdingAccountQboIds: ['ACCOUNT_HOLDING_GENERIC'],
    };
    const candidate = buildPreparedLineWrite(args);

    const validated = validatePreparedLineTransformation(candidate, args);

    expect(validated).not.toBe(candidate);
    expect(validated.body).not.toBe(candidate.body);
    expect(validated.body.Line).not.toBe(candidate.body.Line);
    expect((validated.body.Line as unknown[])[0]).not.toBe(
      (candidate.body.Line as unknown[])[0],
    );
    expect((validated.body.Line as unknown[])[0]).not.toBe(raw.Line[1]);

    candidate.body.PrivateNote = 'adapter mutation';
    raw.Line[1]!.Description = 'fresh raw mutation';
    expect(validated.body.PrivateNote).toBe('generic private note');
    expect(validated.body.Line).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Id: 'LINE_UNTOUCHED_GENERIC',
        Description: 'generic untouched memo',
      }),
    ]));
  });
});

describe('buildPreparedLineWrite', () => {
  it.each([
    {
      qboType: 'Purchase' as const,
      detailKey: 'AccountBasedExpenseLineDetail',
      detail: {
        AccountRef: {
          value: 'ACCOUNT_HOLDING_GENERIC',
          name: 'Generic holding',
        },
        BillableStatus: 'NotBillable',
        TaxCodeRef: { value: 'TAX_DEFAULT_GENERIC' },
      },
    },
    {
      qboType: 'Deposit' as const,
      detailKey: 'DepositLineDetail',
      detail: {
        AccountRef: {
          value: 'ACCOUNT_HOLDING_GENERIC',
          name: 'Generic holding',
        },
        Entity: { value: 'ENTITY_GENERIC', name: 'Generic entity' },
      },
    },
    {
      qboType: 'JournalEntry' as const,
      detailKey: 'JournalEntryLineDetail',
      detail: {
        PostingType: 'Debit',
        AccountRef: {
          value: 'ACCOUNT_HOLDING_GENERIC',
          name: 'Generic holding',
        },
        ClassRef: { value: 'CLASS_GENERIC', name: 'Generic class' },
      },
    },
  ])(
    'preserves the existing $qboType line identity and provider defaults for a one-to-one account move',
    ({ qboType, detailKey, detail }) => {
      const holdingLine = {
        Id: 'LINE_HOLDING_GENERIC',
        LineNum: 1,
        Amount: 10,
        Description: 'generic holding memo',
        DetailType: detailKey,
        CustomExtensions: [],
        [detailKey]: detail,
      };
      const untouchedLine = qboType === 'JournalEntry'
        ? {
            Id: 'LINE_UNTOUCHED_GENERIC',
            Amount: 10,
            DetailType: detailKey,
            [detailKey]: {
              PostingType: 'Credit',
              AccountRef: { value: 'ACCOUNT_PAYMENT_GENERIC' },
            },
          }
        : {
            Id: 'LINE_UNTOUCHED_GENERIC',
            Amount: 5,
            DetailType: detailKey,
            [detailKey]: {
              AccountRef: { value: 'ACCOUNT_UNTOUCHED_GENERIC' },
            },
          };
      const raw = {
        Id: `ENTITY_${qboType.toUpperCase()}_GENERIC`,
        SyncToken: '7',
        Line: [holdingLine, untouchedLine],
      };
      const txn: QboTxn = {
        qboType,
        qboId: raw.Id,
        syncToken: '7',
        date: '2026-07-29',
        payee: 'Generic Payee',
        amount: qboType === 'Deposit' ? 10 : -10,
        bankAccount: 'Generic payment',
        lines: [{
          id: 'LINE_HOLDING_GENERIC',
          amount: 10,
          accountQboId: 'ACCOUNT_HOLDING_GENERIC',
          accountName: 'Generic holding',
        }],
        raw,
      };

      const prepared = buildPreparedLineWrite({
        txn,
        splits: [{
          amount: txn.amount,
          accountQboId: 'ACCOUNT_TARGET_GENERIC',
          memo: 'generic target memo',
        }],
        requestId: 'REQUEST_GENERIC',
        holdingAccountQboIds: ['ACCOUNT_HOLDING_GENERIC'],
      });
      const lines = prepared.body.Line as Record<string, unknown>[];
      const moved = lines[0] as Record<string, unknown>;
      const movedDetail = moved[detailKey] as Record<string, unknown>;

      expect(lines).toHaveLength(2);
      expect(moved).toMatchObject({
        Id: 'LINE_HOLDING_GENERIC',
        LineNum: 1,
        Amount: 10,
        Description: 'generic target memo',
        CustomExtensions: [],
      });
      expect(movedDetail).toMatchObject({
        ...detail,
        AccountRef: { value: 'ACCOUNT_TARGET_GENERIC' },
      });
      expect(lines[1]).toEqual(untouchedLine);
    },
  );
});

describe('hashLineWriteContent', () => {
  it('ignores only provider-generated identity metadata', () => {
    const withDifferentGeneratedMetadata = {
      ...structuredClone(currentBody),
      Id: 'DIFFERENT_PROVIDER_ID',
      SyncToken: '99',
      MetaData: { LastUpdatedTime: '2026-07-29T00:00:00Z' },
      domain: 'DIFFERENT_DOMAIN',
      sparse: true,
      AccountRef: {
        value: 'ACCOUNT_PAYMENT_GENERIC',
        name: 'Provider-renamed payment account',
      },
      Line: currentBody.Line.map((line, index) => ({
        ...structuredClone(line),
        Id: `SERVER_ASSIGNED_${index}`,
        AccountBasedExpenseLineDetail: {
          ...structuredClone(line.AccountBasedExpenseLineDetail),
          AccountRef: {
            value: line.AccountBasedExpenseLineDetail.AccountRef.value,
            name: `Provider-renamed line account ${index}`,
          },
        },
      })),
    };
    const withChangedMemo = {
      ...structuredClone(currentBody),
      PrivateNote: 'changed user private note',
    };

    expect(hashLineWriteContent(currentBody)).toBe(
      hashLineWriteContent(withDifferentGeneratedMetadata),
    );
    expect(hashLineWriteContent(withChangedMemo)).not.toBe(
      hashLineWriteContent(currentBody),
    );
  });

  it.each([
    ['amount', (body: typeof currentBody) => { body.Line[0]!.Amount = 11; }],
    ['reference value', (body: typeof currentBody) => {
      body.Line[0]!.AccountBasedExpenseLineDetail.AccountRef.value =
        'ACCOUNT_CHANGED_GENERIC';
    }],
    ['description', (body: typeof currentBody) => {
      body.Line[0]!.Description = 'changed generic description';
    }],
    ['tax detail', (body: typeof currentBody) => {
      body.Line[0]!.AccountBasedExpenseLineDetail.TaxAmount = 0.75;
    }],
    ['unknown accounting field', (body: typeof currentBody) => {
      body.UnknownAccountingField.preserve = false;
    }],
    ['array order', (body: typeof currentBody) => { body.Line.reverse(); }],
    ['explicit null', (body: typeof currentBody) => { delete (body as { ExplicitNull?: unknown }).ExplicitNull; }],
  ])('retains %s in the content binding', (_name, mutate) => {
    const changed = structuredClone(currentBody);
    mutate(changed);
    expect(hashLineWriteContent(changed)).not.toBe(
      hashLineWriteContent(currentBody),
    );
  });

  it('retains non-provider Id and name fields', () => {
    const changedNestedId = structuredClone(currentBody);
    Object.assign(changedNestedId.UnknownAccountingField, { Id: 'USER_ID_GENERIC' });
    const changedOrdinaryName = structuredClone(currentBody);
    Object.assign(changedOrdinaryName.UnknownAccountingField, {
      name: 'ordinary user name',
    });
    const changedNonStringReferenceName = structuredClone(currentBody);
    Object.assign(changedNonStringReferenceName.UnknownAccountingField, {
      value: 1,
      name: 'not a provider reference name',
    });

    for (const changed of [
      changedNestedId,
      changedOrdinaryName,
      changedNonStringReferenceName,
    ]) {
      expect(hashLineWriteContent(changed)).not.toBe(
        hashLineWriteContent(currentBody),
      );
    }
  });

  it('retains posting types and nested metadata fields', () => {
    const original = structuredClone(currentBody);
    Object.assign(
      original.Line[0]!.AccountBasedExpenseLineDetail,
      { PostingType: 'Debit', MetaData: { userField: 'original' } },
    );
    const changedPostingType = structuredClone(original);
    Object.assign(
      changedPostingType.Line[0]!.AccountBasedExpenseLineDetail,
      { PostingType: 'Credit' },
    );
    const changedNestedMetadata = structuredClone(original);
    Object.assign(
      changedNestedMetadata.Line[0]!.AccountBasedExpenseLineDetail,
      { MetaData: { userField: 'changed' } },
    );

    expect(hashLineWriteContent(changedPostingType)).not.toBe(
      hashLineWriteContent(original),
    );
    expect(hashLineWriteContent(changedNestedMetadata)).not.toBe(
      hashLineWriteContent(original),
    );
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'hash-binds an own hostile %s key without treating it as metadata',
    (key) => {
      const withFirstValue = structuredClone(currentBody);
      Object.defineProperty(withFirstValue, key, {
        value: { accounting: 'first' },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const withSecondValue = structuredClone(currentBody);
      Object.defineProperty(withSecondValue, key, {
        value: { accounting: 'second' },
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(hashLineWriteContent(withFirstValue)).not.toBe(
        hashLineWriteContent(currentBody),
      );
      expect(hashLineWriteContent(withFirstValue)).not.toBe(
        hashLineWriteContent(withSecondValue),
      );
    },
  );

  it('rejects an enumerable getter before it can change between hash and wire serialization', () => {
    const body = structuredClone(currentBody);
    let getterCalls = 0;
    Object.defineProperty(body, 'PrivateNote', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? 'first read' : 'later read';
      },
    });

    expect(() => hashLineWriteRequest(body)).toThrow(/data propert/i);
    expect(getterCalls).toBe(0);
  });

  it('rejects a non-enumerable toJSON hook that changes the transmitted body', () => {
    const body = structuredClone(currentBody);
    Object.defineProperty(body, 'toJSON', {
      enumerable: false,
      configurable: true,
      value: () => ({
        ...body,
        PrivateNote: 'different wire content',
      }),
    });

    expect(JSON.parse(JSON.stringify(body))).toMatchObject({
      PrivateNote: 'different wire content',
    });
    expect(() => hashLineWriteRequest(body)).toThrow(/plain JSON|data propert/i);
  });

  it('rejects non-enumerable array indices that structuredClone would omit', () => {
    const body = structuredClone(currentBody);
    const lines = body.Line as Record<string, unknown>[];
    const firstLine = lines[0];
    Object.defineProperty(lines, '0', {
      value: firstLine,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(JSON.stringify(lines)).not.toBe(JSON.stringify(structuredClone(lines)));
    expect(() => hashLineWriteRequest(body)).toThrow(/enumerable data propert/i);
  });

  it('rejects inherited toJSON hooks that can change nested array serialization', () => {
    const body = Object.assign(Object.create(null), { values: ['original'] });
    Object.defineProperty(Object.prototype, 'toJSON', {
      value: () => 'different wire content',
      configurable: true,
    });
    try {
      expect(JSON.stringify(body)).toBe('{"values":"different wire content"}');
      expect(() => hashLineWriteRequest(body)).toThrow(/plain JSON array/i);
    } finally {
      delete (Object.prototype as { toJSON?: () => unknown }).toJSON;
    }
  });

  it('hashes the exact deterministic JSON text used on the wire', () => {
    expect(hashLineWriteRequest(currentBody)).toBe(
      createHash('sha256')
        .update(deterministicJsonFixture(currentBody))
        .digest('hex'),
    );
  });

  it('keeps prepared request identity valid after a recursive JSONB-style round trip', () => {
    const prepared = validPrepared();
    const reloaded = jsonbStyleRoundTrip(prepared) as ReturnType<
      typeof validPrepared
    >;

    expect(JSON.stringify(reloaded.body)).not.toBe(JSON.stringify(prepared.body));
    expect(hashLineWriteRequest(reloaded.body)).toBe(prepared.requestHash);
    expect(validatePreparedLineWrite(reloaded)).toBe(reloaded);
  });

  it('keeps hostile own keys in the stable request identity across key reordering', () => {
    const body = structuredClone(currentBody);
    Object.defineProperty(body, '__proto__', {
      value: { accounting: 'bound value' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const reordered = jsonbStyleRoundTrip(body) as Record<string, unknown>;
    const changed = jsonbStyleRoundTrip(body) as Record<string, unknown>;
    (changed.__proto__ as Record<string, unknown>).accounting = 'changed value';

    expect(Object.hasOwn(reordered, '__proto__')).toBe(true);
    expect(hashLineWriteRequest(reordered)).toBe(hashLineWriteRequest(body));
    expect(hashLineWriteRequest(changed)).not.toBe(hashLineWriteRequest(body));
  });

  it.each([
    ['undefined', { ...currentBody, PrivateNote: undefined }],
    ['non-finite number', { ...currentBody, TotalAmt: Number.NaN }],
    ['unsafe integer', { ...currentBody, TotalAmt: Number.MAX_SAFE_INTEGER + 1 }],
    ['malformed Unicode value', { ...currentBody, PrivateNote: '\ud800' }],
    ['malformed Unicode key', { ...currentBody, ['\udfff']: true }],
    ['BigInt', { ...currentBody, TotalAmt: 1n }],
  ])('rejects non-canonical JSON containing %s', (_name, value) => {
    expect(() => hashLineWriteContent(value)).toThrow();
  });

  it('rejects cyclic input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashLineWriteContent(cyclic)).toThrow();
  });

  it('rejects symbol-keyed object content and non-JSON array properties', () => {
    const symbolKeyed = structuredClone(currentBody) as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol('accounting')] = 'not JSON';
    const arrayProperty = structuredClone(currentBody);
    Object.assign(arrayProperty.Line, { accounting: 'not JSON' });

    expect(() => hashLineWriteContent(symbolKeyed)).toThrow();
    expect(() => hashLineWriteContent(arrayProperty)).toThrow();
  });
});

describe('prepared line-write validation', () => {
  it('accepts a complete hash-bound prepared transfer', () => {
    const prepared = validPrepared();
    expect(isQboPreparedLineWrite(prepared)).toBe(true);
    expect(validatePreparedLineWrite(prepared)).toBe(prepared);
  });

  it.each([
    ['empty QBO id', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.qboId = ' ';
    }],
    ['empty request id', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.requestId = '';
    }],
    ['body QBO id mismatch', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.body.Id = 'OTHER_ENTITY_GENERIC';
      prepared.requestHash = exactBodyHash(prepared.body);
    }],
    ['body SyncToken mismatch', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.body.SyncToken = '8';
      prepared.requestHash = exactBodyHash(prepared.body);
    }],
    ['request/body hash mismatch', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.body.PrivateNote = 'tampered generic note';
    }],
    ['expected/body hash mismatch', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.expected.contentHash = '0'.repeat(64);
    }],
    ['unchanged expected content', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.expected.contentHash = prepared.before.contentHash;
      prepared.body = structuredClone(currentBody);
      prepared.requestHash = exactBodyHash(prepared.body);
    }],
    ['unsafe integer', (prepared: ReturnType<typeof validPrepared>) => {
      (prepared.body as { TotalAmt?: number }).TotalAmt = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['malformed Unicode', (prepared: ReturnType<typeof validPrepared>) => {
      prepared.body.PrivateNote = '\ud800';
    }],
  ])('rejects %s', (_name, mutate) => {
    const prepared = validPrepared();
    mutate(prepared);
    expect(isQboPreparedLineWrite(prepared)).toBe(false);
    expect(() => validatePreparedLineWrite(prepared)).toThrow();
  });
});

describe('verifyLineWriteResult', () => {
  it('returns a result carrying the exact verified readback snapshot', () => {
    const prepared = validPrepared();
    const snapshot = {
      ...prepared.expected,
      syncToken: '8',
    };
    expect(verifyLineWriteResult(prepared, snapshot)).toEqual({
      ok: true,
      newSyncToken: '8',
      snapshot,
    });
  });

  it.each([
    ['old SyncToken', (prepared: ReturnType<typeof validPrepared>) => ({
      ...prepared.expected,
      syncToken: prepared.before.syncToken,
    })],
    ['changed accounting content', (prepared: ReturnType<typeof validPrepared>) => ({
      ...prepared.expected,
      syncToken: '8',
      contentHash: '0'.repeat(64),
    })],
    ['wrong QBO id', (prepared: ReturnType<typeof validPrepared>) => ({
      ...prepared.expected,
      qboId: 'OTHER_ENTITY_GENERIC',
      syncToken: '8',
    })],
  ])('rejects a readback with %s', (_name, snapshot) => {
    const prepared = validPrepared();
    expect(() => verifyLineWriteResult(prepared, snapshot(prepared))).toThrow();
  });
});
