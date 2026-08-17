// Multi-line entity safety (C1): mapping exposes ONLY holding-account lines
// with amount = the holding-line sum, and the write-side rebuild replaces only
// those lines — everything else on the entity survives verbatim.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QboAttachmentNotFoundError,
  QboAuthError,
  QboRequestTimeout,
  QboSyncTokenConflict,
  type QboDepositPreparedWrite,
  type QboDepositSnapshot,
  type QboPreparedLineWrite,
  type QboPreparedWrite,
} from './types.js';
import { QboAttachmentAdapterError } from './attachments.js';
import {
  RealQboClient,
  exchangeAuthCode,
  mapDeposit,
  mapDepositSnapshot,
  mapJournalEntry,
  mapPurchase,
  mapPurchaseSnapshot,
  mapTaxCode,
  mapTaxProfile,
  mapTaxRate,
  parseStatementReport,
  parseTransactionListReport,
  rebuildDepositLines,
  rebuildJournalEntryLines,
  rebuildPurchaseLines,
  revokeIntuitToken,
  sumLinesPostingTo,
  type RawDeposit,
  type RawJournalEntry,
  type RawPurchase,
  type RawReport,
} from './real.js';
import { hashLineWriteContent } from './lineWrite.js';
import { QboWriteSafetyError } from './writeSafety.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OAuth token errors', () => {
  it('uses a typed reason and omits the upstream body from token endpoint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'bad secret SECRET_SENTINEL',
          }),
          { status: 401 },
        ),
      ),
    );

    const error = await exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QboAuthError);
    expect(error).toMatchObject({ reason: 'INVALID_CLIENT_CREDENTIALS' });
    expect((error as Error).message).not.toContain('SECRET_SENTINEL');
  });

  it('maps fetch failures to Intuit unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const error = await exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QboAuthError);
    expect(error).toMatchObject({ reason: 'INTUIT_UNAVAILABLE' });
  });

  it('aborts a stalled token request at its explicit deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const exchanging = exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    });
    const assertion = expect(exchanging).rejects.toMatchObject({
      reason: 'INTUIT_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await assertion;
  });
});

describe('OAuth token revocation', () => {
  it('aborts a delayed best-effort revoke at the explicit timeout without logging its capability', async () => {
    vi.useFakeTimers();
    let settleFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        settleFetch = resolve;
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const revoking = revokeIntuitToken({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      token: 'REFRESH_TOKEN_SENTINEL',
    });

    try {
      const request = fetchMock.mock.calls[0]?.[1];
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(request?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(request?.signal?.aborted).toBe(true);
      await expect(revoking).resolves.toBeUndefined();
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    } finally {
      settleFetch?.(new Response('', { status: 200 }));
      await revoking;
    }
  });
});

function realClient(
  onTokensRefreshed = vi.fn(async () => undefined),
  holdingAccountQboIds: string[] = [],
) {
  return {
    client: new RealQboClient({
      realmId: 'realm/1',
      environment: 'sandbox',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      holdingAccountQboIds,
      onTokensRefreshed,
    }),
    onTokensRefreshed,
  };
}

function rawAttachable(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'A1',
    SyncToken: '2',
    FileName: 'receipt.pdf',
    ContentType: 'application/pdf',
    Size: 4,
    Note: 'Recat reference: marker-1',
    AttachableRef: [{
      EntityRef: { type: 'Purchase', value: 'P1' },
    }],
    ...overrides,
  };
}

function attachmentUploadFile(content = '%PDF') {
  const bytes = Buffer.from(content);
  return {
    ordinal: 7,
    filename: 'receipt.pdf',
    contentType: 'application/pdf',
    sizeBytes: bytes.byteLength,
    marker: 'marker-1',
    async openContent() {
      return {
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        async *chunks() {
          yield bytes;
        },
      };
    },
  };
}

async function consumeRequestBody(init: RequestInit | undefined): Promise<Buffer> {
  const body = init?.body as unknown as AsyncIterable<Uint8Array> | undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('RealQboClient attachment HTTP seam', () => {
  it('streams an exact multipart request and parses per-file upload outcomes', async () => {
    let encodedBody = Buffer.alloc(0);
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      encodedBody = await consumeRequestBody(init);
      return new Response(JSON.stringify([
        { Attachable: rawAttachable() },
      ]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await expect(client.uploadAttachments(
      { qboType: 'Purchase', qboId: 'P1' },
      [attachmentUploadFile()],
      'request/attachment',
    )).resolves.toMatchObject([
      {
        ordinal: 7,
        outcome: 'ATTACHED',
        attachable: { id: 'A1', filename: 'receipt.pdf' },
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      '/upload?requestid=request%2Fattachment&minorversion=75',
    );
    expect(init?.headers).toMatchObject({
      'Content-Length': String(encodedBody.byteLength),
    });
    expect(encodedBody.toString()).toContain('name="file_metadata_01"');
    expect(encodedBody.toString()).toContain('name="file_content_01"');
    expect(encodedBody.subarray(-4).toString()).toBe('--\r\n');
  });

  it('treats a network loss after body consumption as an ambiguous timeout', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      await consumeRequestBody(init);
      throw new TypeError('connection closed');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.uploadAttachments(
      { qboType: 'Purchase', qboId: 'P1' },
      [attachmentUploadFile()],
      'request-timeout',
    )).rejects.toBeInstanceOf(QboRequestTimeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a whole-request server error after upload as ambiguous', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      await consumeRequestBody(init);
      return new Response('upstream unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.uploadAttachments(
      { qboType: 'Purchase', qboId: 'P1' },
      [attachmentUploadFile()],
      'request-server-error',
    )).rejects.toBeInstanceOf(QboRequestTimeout);
  });

  it('keeps an authoritative client rejection definite', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      await consumeRequestBody(init);
      return new Response(JSON.stringify({
        Fault: {
          Error: [{ Message: 'Invalid attachment request', code: '2010' }],
        },
      }), { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const error = await realClient().client.uploadAttachments(
      { qboType: 'Purchase', qboId: 'P1' },
      [attachmentUploadFile()],
      'request-client-error',
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(QboRequestTimeout);
  });

  it.each([
    'not-json',
    JSON.stringify([]),
  ])('treats an unverified successful upload response as ambiguous', async (body) => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      await consumeRequestBody(init);
      return new Response(body);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.uploadAttachments(
      { qboType: 'Purchase', qboId: 'P1' },
      [attachmentUploadFile()],
      'request-unverified',
    )).rejects.toBeInstanceOf(QboRequestTimeout);
  });

  it('refreshes and reopens the body only when a 401 arrives before consumption', async () => {
    const onTokensRefreshed = vi.fn(async () => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      })))
      .mockImplementationOnce(async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        await consumeRequestBody(init);
        return new Response(JSON.stringify([
          { Attachable: rawAttachable() },
        ]));
      });
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient(onTokensRefreshed);

    await expect(client.uploadAttachments(
      { qboType: 'Purchase', qboId: 'P1' },
      [attachmentUploadFile()],
      'request-refresh',
    )).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onTokensRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'fresh-refresh' }),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fresh-access',
    });
  });

  it('lists exact transaction references without exposing temporary URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      QueryResponse: {
        Attachable: [
          rawAttachable({ TempDownloadUri: 'https://download.example/secret' }),
          rawAttachable({
            Id: 'A2',
            AttachableRef: [{
              EntityRef: { type: 'Deposit', value: 'D1' },
            }],
          }),
        ],
      },
    }))));

    const attachments = await realClient().client.listAttachments({
      qboType: 'Purchase',
      qboId: 'P1',
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ id: 'A1' });
    expect(attachments[0]).not.toHaveProperty('TempDownloadUri');
    expect(JSON.stringify(attachments)).not.toContain('download.example');
  });

  it('ignores valid attachments for unsupported entity types and unattached documents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      QueryResponse: {
        Attachable: [
          rawAttachable({
            Id: 'BILL-ATTACHMENT',
            AttachableRef: [{
              EntityRef: { type: 'Bill', value: 'B1' },
            }],
          }),
          rawAttachable({
            Id: 'UNATTACHED',
            AttachableRef: [],
          }),
          rawAttachable({
            Id: 'UNATTACHED-OMITTED-REFS',
            AttachableRef: undefined,
          }),
          rawAttachable({
            Id: 'MIXED',
            AttachableRef: [
              { EntityRef: { type: 'Bill', value: 'B2' } },
              { EntityRef: { type: 'Purchase', value: 'P1' } },
            ],
          }),
        ],
      },
    }))));

    await expect(realClient().client.listAttachments({
      qboType: 'Purchase',
      qboId: 'P1',
    })).resolves.toMatchObject([{ id: 'MIXED' }]);
  });

  it('still rejects structurally malformed attachment references while listing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      QueryResponse: {
        Attachable: [
          rawAttachable({
            AttachableRef: [{ EntityRef: { type: 'Bill' } }],
          }),
        ],
      },
    }))));

    await expect(realClient().client.listAttachments({
      qboType: 'Purchase',
      qboId: 'P1',
    })).rejects.toBeInstanceOf(QboAttachmentAdapterError);
  });

  it('treats QBO code 610 object-not-found attachment reads as absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Fault: {
        Error: [{
          code: '610',
          Message: 'Object Not Found',
          Detail: 'Something referenced by this object has been made inactive.',
        }],
      },
    }), { status: 400 })));

    await expect(realClient().client.getAttachment('A1')).resolves.toBeNull();
  });

  it('fetches a temporary download internally and returns only the byte stream', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable({
          TempDownloadUri: 'https://download.example/capability',
        }),
      })))
      .mockResolvedValueOnce(new Response('%PDF', {
        headers: {
          'content-type': 'application/pdf',
          'content-length': '4',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const download = await realClient().client.openAttachmentDownload('A1');
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.body) chunks.push(chunk);

    expect(download).toMatchObject({
      contentType: 'application/pdf',
      sizeBytes: 4,
    });
    expect(download).not.toHaveProperty('TempDownloadUri');
    expect(Buffer.concat(chunks).toString()).toBe('%PDF');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://download.example/capability',
    );
  });

  it('uses a typed error when an attachment disappears before download', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable({
          TempDownloadUri: 'https://download.example/capability',
        }),
      })))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      realClient().client.openAttachmentDownload('A1'),
    ).rejects.toBeInstanceOf(QboAttachmentNotFoundError);
  });

  it('bounds a stalled temporary attachment download', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable({
          TempDownloadUri: 'https://download.example/capability',
        }),
      })))
      .mockImplementationOnce((
        _input: string | URL | Request,
        init?: RequestInit,
      ) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);

    const downloading = realClient().client.openAttachmentDownload('A1');
    const assertion = expect(downloading).rejects.toBeInstanceOf(QboRequestTimeout);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('preflights deletion and refuses a stale SyncToken before mutating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Attachable: rawAttachable(),
    })));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await expect(client.deleteAttachment({
      id: 'A1',
      syncToken: '1',
      requestId: 'delete-stale',
    })).rejects.toBeInstanceOf(QboSyncTokenConflict);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes with the verified SyncToken and caller request ID', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable(),
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable({ status: 'Deleted' }),
      })));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await client.deleteAttachment({
      id: 'A1',
      syncToken: '2',
      requestId: 'delete/1',
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/attachable?operation=delete&requestid=delete%2F1&minorversion=75',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ Id: 'A1', SyncToken: '2' }),
    );
  });

  it('treats an unconfirmed deletion write as ambiguous', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable(),
      })))
      .mockRejectedValueOnce(new TypeError('connection closed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.deleteAttachment({
      id: 'A1',
      syncToken: '2',
      requestId: 'delete-ambiguous',
    })).rejects.toBeInstanceOf(QboRequestTimeout);
  });

  it('treats a deletion server error after send as ambiguous', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Attachable: rawAttachable(),
      })))
      .mockResolvedValueOnce(new Response('upstream unavailable', {
        status: 503,
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.deleteAttachment({
      id: 'A1',
      syncToken: '2',
      requestId: 'delete-server-error',
    })).rejects.toBeInstanceOf(QboRequestTimeout);
  });
});

describe('RealQboClient purchase-tax HTTP seam', () => {
  it('reads the close date and exact cleared/reconciled transaction identity', async () => {
    const report = (id: string, type: string): RawReport => ({
      Columns: { Column: [{ ColType: 'tx_date' }, { ColType: 'txn_type' }] },
      Rows: { Row: [{ ColData: [{ value: '2026-08-01', id }, { value: type }] }] },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ AccountingInfoPrefs: { BookCloseDate: '2026-07-31' } }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(report('deposit-1', 'Deposit'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(report('other-id', 'Deposit'))));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.fetchWriteSafety({
      qboType: 'Deposit',
      qboId: 'deposit-1',
      txnDate: '2026-08-01',
      bankAccountQboId: 'bank-1',
    })).resolves.toEqual({
      bookCloseDate: '2026-07-31',
      cleared: true,
      reconciled: false,
    });
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0])))
      .toContain('cleared=Cleared');
    expect(decodeURIComponent(String(fetchMock.mock.calls[2]?.[0])))
      .toContain('cleared=Reconciled');
  });

  it('canonicalizes the TransactionList Expense label to a Purchase entity', async () => {
    const report = (type: string): RawReport => ({
      Columns: { Column: [{ ColType: 'tx_date' }, { ColType: 'txn_type' }] },
      Rows: {
        Row: [{
          ColData: [{ value: '2026-08-01', id: 'purchase-1' }, { value: type }],
        }],
      },
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ AccountingInfoPrefs: {} }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(report('Expense'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(report('Purchase')))));

    await expect(realClient().client.fetchWriteSafety({
      qboType: 'Purchase',
      qboId: 'purchase-1',
      txnDate: '2026-08-01',
      bankAccountQboId: 'bank-1',
    })).resolves.toMatchObject({ cleared: true, reconciled: true });
  });

  it('fails closed when the exact provider identity has an unknown report type', async () => {
    const unknownType: RawReport = {
      Columns: { Column: [{ ColType: 'tx_date' }, { ColType: 'txn_type' }] },
      Rows: {
        Row: [{
          ColData: [{ value: '2026-08-01', id: 'purchase-1' }, { value: 'Localized expense' }],
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ AccountingInfoPrefs: {} }] },
      })))
      .mockImplementation(async () => new Response(JSON.stringify(unknownType))));

    await expect(realClient().client.fetchWriteSafety({
      qboType: 'Purchase',
      qboId: 'purchase-1',
      txnDate: '2026-08-01',
      bankAccountQboId: 'bank-1',
    })).rejects.toMatchObject({ code: 'QBO_WRITE_SAFETY_UNAVAILABLE' });
  });

  it.each([
    {},
    { QueryResponse: { Preferences: [] } },
    { QueryResponse: { Preferences: [{ AccountingInfoPrefs: { BookCloseDate: 'not-a-date' } }] } },
  ])('fails closed when closing-date preferences are unavailable', async (preferencesBody) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(preferencesBody)),
    ));

    await expect(realClient().client.fetchWriteSafety({
      qboType: 'Purchase',
      qboId: 'purchase-1',
      txnDate: '2026-08-01',
      bankAccountQboId: 'bank-1',
    })).rejects.toBeInstanceOf(QboWriteSafetyError);
  });

  it('treats an explicit absent close date and empty filtered reports as safe evidence', async () => {
    const emptyReport: RawReport = {
      Columns: { Column: [{ ColType: 'tx_date' }, { ColType: 'txn_type' }] },
      Rows: { Row: [] },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ AccountingInfoPrefs: {} }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyReport)))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyReport))));

    await expect(realClient().client.fetchWriteSafety({
      qboType: 'Purchase',
      qboId: 'purchase-1',
      txnDate: '2026-08-01',
      bankAccountQboId: 'bank-1',
    })).resolves.toEqual({
      bookCloseDate: null,
      cleared: false,
      reconciled: false,
    });
  });

  it('fails closed when a matching filtered report row has no provider identity', async () => {
    const ambiguousReport: RawReport = {
      Columns: { Column: [{ ColType: 'tx_date' }, { ColType: 'txn_type' }] },
      Rows: { Row: [{ ColData: [{ value: '2026-08-01' }, { value: 'Purchase' }] }] },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ AccountingInfoPrefs: {} }] },
      })))
      .mockResolvedValue(new Response(JSON.stringify(ambiguousReport))));

    await expect(realClient().client.fetchWriteSafety({
      qboType: 'Purchase',
      qboId: 'purchase-1',
      txnDate: '2026-08-01',
      bankAccountQboId: 'bank-1',
    })).rejects.toMatchObject({ code: 'QBO_WRITE_SAFETY_UNAVAILABLE' });
  });

  it('requests and normalizes valid and malformed tax profiles', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: false } }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: 'yes' } }] },
      })));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await expect(client.getTaxProfile()).resolves.toEqual({ usingSalesTax: true, partnerTaxEnabled: false });
    await expect(client.getTaxProfile()).resolves.toEqual({ usingSalesTax: null, partnerTaxEnabled: null });
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain(
      'select * from Preferences startposition 1 maxresults 1000',
    );
  });

  it.each([
    ['TaxCode', 'listTaxCodes', (index: number) => ({ Id: `C${index}`, Name: `Code ${index}`, Taxable: true })],
    ['TaxRate', 'listTaxRates', (index: number) => ({ Id: `R${index}`, Name: `Rate ${index}`, RateValue: 5 })],
  ] as const)('paginates %s queries and normalizes every page', async (entity, method, row) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { [entity]: Array.from({ length: 1_000 }, (_, index) => row(index)) },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { [entity]: [row(1_000)] },
      })));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    const result = await client[method]();

    expect(result).toHaveLength(1_001);
    expect(result[0]?.qboId).toBe(entity === 'TaxCode' ? 'C0' : 'R0');
    expect(result.at(-1)?.sourceUpdatedAt).toBeNull();
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))).toContain(
      `select * from ${entity} startposition 1001 maxresults 1000`,
    );
  });

  it('propagates a later tax-reference page failure', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: {
          TaxCode: Array.from({ length: 1_000 }, (_, index) => ({ Id: `C${index}`, Name: `Code ${index}` })),
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Fault: { Error: [{ Detail: 'later page sentinel' }] },
      }), { status: 500 })));

    await expect(realClient().client.listTaxCodes()).rejects.toThrow('later page sentinel');
  });

  it('reads a signed Purchase snapshot and returns null for a QBO not-found response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Purchase: {
          Id: 'P/1',
          SyncToken: '2',
          TotalAmt: 10,
          Line: [{ Amount: 10, AccountBasedExpenseLineDetail: { TaxAmount: 1 } }],
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Fault: { Error: [{ Detail: 'Object Not Found' }] },
      }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await expect(client.fetchPurchaseSnapshot('P/1')).resolves.toMatchObject({
      qboId: 'P/1',
      direction: 'purchase',
      totalCents: -1_000,
      lines: [{ amountCents: -1_000, taxAmountCents: -100 }],
    });
    await expect(client.fetchPurchaseSnapshot('missing')).resolves.toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/purchase/P%2F1?minorversion=75');
  });

  it('treats a live-shaped QBO code 610 transaction read as absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Fault: {
        Error: [{
          code: '610',
          Message: 'Object Not Found',
          Detail: 'Something referenced by this object has been made inactive.',
        }],
      },
    }), { status: 400 })));

    await expect(
      realClient().client.fetchTxn('Purchase', 'missing'),
    ).resolves.toBeNull();
  });

  it('propagates reconciliation cancellation to the actual Purchase GET', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const reading = realClient().client.fetchPurchaseSnapshot(
      'purchase-generic',
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const fetchSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    const assertion = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();

    expect(fetchSignal).toBeInstanceOf(AbortSignal);
    expect(fetchSignal?.aborted).toBe(true);
    await assertion;
    rejectFetch?.(new Error('settled'));
  });

  it('cancels while token refresh is pending and never starts a late Purchase GET', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async () =>
      new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onTokensRefreshed = vi.fn(async () => undefined);
    const client = new RealQboClient({
      realmId: 'realm-generic',
      environment: 'sandbox',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokens: {
        accessToken: 'expired-access',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1,
      },
      holdingAccountQboIds: [],
      onTokensRefreshed,
    });
    const controller = new AbortController();

    const reading = client.fetchPurchaseSnapshot(
      'purchase-generic',
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const assertion = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;

    resolveRefresh?.(new Response(JSON.stringify({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      expires_in: 3600,
    })));
    await vi.waitFor(() => expect(onTokensRefreshed).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads a prepared Deposit snapshot from the Deposit endpoint', async () => {
    const rawDeposit: RawDeposit = {
      Id: 'D/1',
      SyncToken: '2',
      TxnDate: '2026-07-28',
      TotalAmt: 10.5,
      DepositToAccountRef: { value: 'BANK_GENERIC' },
      GlobalTaxCalculation: 'TaxExcluded',
      TxnTaxDetail: { TotalTax: 0.5 },
      Line: [{
        Id: 'LINE_GENERIC',
        Amount: 10,
        Description: 'Generic sale',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'INCOME_GENERIC' },
          TaxCodeRef: { value: 'TAX_GENERIC' },
          TaxApplicableOn: 'Sales',
        },
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Deposit: rawDeposit,
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      realClient().client.fetchPreparedSnapshot('Deposit', 'D/1'),
    ).resolves.toEqual(mapDepositSnapshot(rawDeposit));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/deposit/D%2F1?minorversion=75',
    );
  });

  it('dispatches prepared recategorization and restore to the Deposit pure functions', async () => {
    const raw: RawDeposit = {
      Id: 'DEPOSIT_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-28',
      TotalAmt: 10.5,
      DepositToAccountRef: { value: 'BANK_GENERIC' },
      Line: [{
        Id: 'LINE_HOLDING',
        Amount: 10.5,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: 'HOLDING_GENERIC' } },
      }],
    };
    const before: QboDepositSnapshot = mapDepositSnapshot(raw);
    const staged = {
      transactionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      taxCalculation: 'TaxExcluded',
      totals: { subtotalCents: 1000, taxCents: 50, totalCents: 1050 },
      lines: [{
        idx: 0,
        subtotalCents: 1000,
        taxCents: 50,
        totalCents: 1050,
        categoryQboId: 'INCOME_GENERIC',
        taxCodeQboId: 'TAX_GENERIC',
        memo: 'Generic sale',
      }],
      tagIds: [],
    } as const;
    const client = realClient(undefined, ['HOLDING_GENERIC']).client;
    const txn = mapDeposit(raw, new Set(['HOLDING_GENERIC']));

    const prepared = await client.prepareRecategorization(
      txn,
      staged,
      before,
      'REQUEST_DEPOSIT',
    );
    expect(prepared).toMatchObject({
      qboType: 'Deposit',
      operation: 'recategorize',
      body: {
        Id: raw.Id,
        Line: [{
          Id: 'LINE_HOLDING',
          Amount: 10,
          DepositLineDetail: {
            AccountRef: { value: 'INCOME_GENERIC' },
            TaxCodeRef: { value: 'TAX_GENERIC' },
            TaxApplicableOn: 'Sales',
          },
        }],
      },
    });

    const postedRaw: RawDeposit = {
      ...prepared.body,
      SyncToken: '8',
      TxnTaxDetail: { TotalTax: 0.5 },
      Line: structuredClone(prepared.body.Line),
    };
    await expect(client.preparePurchaseRestore(
      mapDeposit(postedRaw, new Set(['HOLDING_GENERIC'])),
      prepared,
      'REQUEST_WRONG_COMPATIBILITY_RESTORE',
    )).rejects.toThrow(/Purchase compatibility restore/i);
    const restore = await client.prepareRestore(
      mapDeposit(postedRaw, new Set(['HOLDING_GENERIC'])),
      prepared,
      'REQUEST_DEPOSIT_RESTORE',
    );
    expect(restore).toMatchObject({
      qboType: 'Deposit',
      operation: 'restore',
      requestId: 'REQUEST_DEPOSIT_RESTORE',
      body: {
        Id: raw.Id,
        SyncToken: '8',
        Line: [{ Id: 'LINE_HOLDING', Amount: 10.5 }],
      },
    });
  });

  it('refreshes once after a 401 and retries a tax-profile request', async () => {
    const onTokensRefreshed = vi.fn(async () => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'retry-access',
        refresh_token: 'retry-refresh',
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: true } }] },
      })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient(onTokensRefreshed).client.getTaxProfile()).resolves.toMatchObject({ usingSalesTax: true });
    expect(onTokensRefreshed).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'retry-access' }));
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer retry-access' });
  });

  it('posts a complete non-tax Purchase recategorization payload without adding tax fields', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: unknown, init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as RawPurchase;
        return new Response(JSON.stringify({
          Purchase: { ...body, SyncToken: '4' },
        }));
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const raw = twoLinePurchase();
    const txn = mapPurchase(raw, new Set(['4']));

    await expect(
      realClient(undefined, ['4']).client.recategorize(txn, [
        { amount: -100, accountQboId: '17', memo: 'client dinner' },
      ]),
    ).resolves.toEqual({ ok: true, newSyncToken: '4' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /\/purchase\?requestid=[^&]+&minorversion=75$/,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as RawPurchase;
    expect(body).toMatchObject({
      Id: raw.Id,
      AccountRef: raw.AccountRef,
      EntityRef: raw.EntityRef,
      SyncToken: txn.syncToken,
    });
    expect(body.Line?.[0]).toMatchObject({
      Id: raw.Line?.[0]?.Id,
      Amount: 100,
      Description: 'client dinner',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '17' } },
    });
    expect(body.Line?.[1]).toEqual(raw.Line?.[1]);
    expect(JSON.stringify(body)).not.toMatch(/TaxCodeRef|TaxAmount|TaxInclusiveAmt/);
  });

  it('sends the exact prepared Purchase JSON once with QBO request metadata', async () => {
    const body: RawPurchase = {
      Id: 'PURCHASE_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 10,
      PrivateNote: 'generic private note',
      AccountRef: { value: 'ACCOUNT_PAYMENT' },
      CurrencyRef: { value: 'CUR' },
      ExchangeRate: 1.25,
      GlobalTaxCalculation: 'TaxInclusive',
      TxnTaxDetail: { TotalTax: 0.48 },
      Line: [{
        Amount: 9.52,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'ACCOUNT_CATEGORY' },
          TaxCodeRef: { value: 'TAX_CODE_STANDARD' },
          TaxAmount: 0.48,
          TaxInclusiveAmt: 10,
        },
      }],
    };
    const prepared = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: body.Id,
      requestId: 'REQUEST/GENERIC',
      requestHash: 'hash-generic',
      body,
      before: {} as QboPreparedWrite['before'],
      expected: {} as QboPreparedWrite['expected'],
    } satisfies QboPreparedWrite;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Purchase: { ...body, SyncToken: '8' },
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.sendPreparedWrite(prepared)).resolves.toEqual({
      ok: true,
      newSyncToken: '8',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/purchase?requestid=REQUEST%2FGENERIC&minorversion=75',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends exact prepared Deposit JSON to the Deposit endpoint and requires its response token', async () => {
    const body: RawDeposit = {
      Id: 'DEPOSIT_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 10,
      DepositToAccountRef: { value: 'BANK_GENERIC' },
      Line: [],
    };
    const prepared = {
      operation: 'recategorize',
      qboType: 'Deposit',
      qboId: body.Id,
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body,
      before: {} as QboDepositPreparedWrite['before'],
      expected: {} as QboDepositPreparedWrite['expected'],
    } satisfies QboDepositPreparedWrite;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Deposit: { ...body, SyncToken: '8' },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Purchase: { SyncToken: '9' },
      })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().client.sendPreparedWrite(prepared)).resolves.toEqual({
      ok: true,
      newSyncToken: '8',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/deposit?requestid=REQUEST_GENERIC&minorversion=75',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(body),
    });

    await expect(realClient().client.sendPreparedWrite(prepared)).rejects.toThrow(
      /Deposit SyncToken/,
    );
  });

  it.each([
    [
      'conflict',
      new Response(JSON.stringify({
        Fault: { Error: [{ code: '5010', Message: 'stale generic object' }] },
      }), { status: 400 }),
      QboSyncTokenConflict,
    ],
    [
      'auth',
      new Response(JSON.stringify({
        Fault: { Error: [{ Message: 'generic auth failure' }] },
      }), { status: 401 }),
      QboAuthError,
    ],
  ] as const)('maps prepared-write %s outcomes without retrying', async (_case, response, errorType) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const prepared = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body: { Id: 'PURCHASE_GENERIC', SyncToken: '7', Line: [] },
      before: {} as QboPreparedWrite['before'],
      expected: {} as QboPreparedWrite['expected'],
    } satisfies QboPreparedWrite;

    await expect(realClient().client.sendPreparedWrite(prepared)).rejects.toBeInstanceOf(errorType);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a prepared-write transport timeout without retrying', async () => {
    const timeout = new DOMException('generic timeout', 'TimeoutError');
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchMock);
    const prepared = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body: { Id: 'PURCHASE_GENERIC', SyncToken: '7', Line: [] },
      before: {} as QboPreparedWrite['before'],
      expected: {} as QboPreparedWrite['expected'],
    } satisfies QboPreparedWrite;

    await expect(realClient().client.sendPreparedWrite(prepared)).rejects.toBeInstanceOf(QboRequestTimeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['AbortError', 'TimeoutError'] as const)(
    'maps a prepared-write response-body %s without retrying',
    async (name) => {
      const response = {
        ok: true,
        status: 200,
        text: vi.fn().mockRejectedValue(new DOMException('generic body timeout', name)),
      } as unknown as Response;
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      const prepared = {
        operation: 'recategorize',
        qboType: 'Purchase',
        qboId: 'PURCHASE_GENERIC',
        requestId: 'REQUEST_GENERIC',
        requestHash: 'hash-generic',
        body: { Id: 'PURCHASE_GENERIC', SyncToken: '7', Line: [] },
        before: {} as QboPreparedWrite['before'],
        expected: {} as QboPreparedWrite['expected'],
      } satisfies QboPreparedWrite;

      await expect(realClient().client.sendPreparedWrite(prepared)).rejects.toBeInstanceOf(
        QboRequestTimeout,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.text).toHaveBeenCalledTimes(1);
    },
  );

  it('maps an undici connect timeout without retrying', async () => {
    const timeout = new TypeError('generic transport failure', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchMock);
    const prepared = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body: { Id: 'PURCHASE_GENERIC', SyncToken: '7', Line: [] },
      before: {} as QboPreparedWrite['before'],
      expected: {} as QboPreparedWrite['expected'],
    } satisfies QboPreparedWrite;

    await expect(realClient().client.sendPreparedWrite(prepared)).rejects.toBeInstanceOf(QboRequestTimeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed successful prepared-write response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal('fetch', fetchMock);
    const prepared = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body: { Id: 'PURCHASE_GENERIC', SyncToken: '7', Line: [] },
      before: {} as QboPreparedWrite['before'],
      expected: {} as QboPreparedWrite['expected'],
    } satisfies QboPreparedWrite;

    await expect(realClient().client.sendPreparedWrite(prepared)).rejects.toThrow(
      /prepared write response/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

const LINE_WRITE_HOLDING = 'ACCOUNT_HOLDING_GENERIC';
const LINE_WRITE_TARGET = 'ACCOUNT_TARGET_GENERIC';

function lineWriteFixture(qboType: 'Purchase' | 'Deposit' | 'JournalEntry') {
  if (qboType === 'Purchase') {
    const raw: RawPurchase = {
      Id: 'PURCHASE_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 15,
      PrivateNote: 'generic private note',
      AccountRef: { value: 'ACCOUNT_PAYMENT_GENERIC', name: 'Generic payment' },
      UnknownDocumentField: { preserve: true },
      Line: [
        {
          Id: 'LINE_HOLDING_GENERIC',
          Amount: 10,
          Description: 'generic holding memo',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: LINE_WRITE_HOLDING, name: 'Generic holding' },
          },
        },
        {
          Id: 'LINE_UNTOUCHED_GENERIC',
          Amount: 5,
          Description: 'generic untouched memo',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: {
              value: 'ACCOUNT_UNTOUCHED_GENERIC',
              name: 'Generic untouched',
            },
          },
          UnknownLineField: { preserve: true },
        },
      ],
    };
    return {
      raw,
      txn: mapPurchase(raw, new Set([LINE_WRITE_HOLDING])),
      responseKey: 'Purchase' as const,
      path: 'purchase',
      untouched: raw.Line![1],
    };
  }
  if (qboType === 'Deposit') {
    const raw: RawDeposit = {
      Id: 'DEPOSIT_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 15,
      PrivateNote: 'generic private note',
      DepositToAccountRef: {
        value: 'ACCOUNT_PAYMENT_GENERIC',
        name: 'Generic payment',
      },
      Line: [
        {
          Id: 'LINE_HOLDING_GENERIC',
          Amount: 10,
          Description: 'generic holding memo',
          DetailType: 'DepositLineDetail',
          DepositLineDetail: {
            AccountRef: { value: LINE_WRITE_HOLDING, name: 'Generic holding' },
            Entity: { value: 'ENTITY_GENERIC', name: 'Generic entity' },
          },
        },
        {
          Id: 'LINE_UNTOUCHED_GENERIC',
          Amount: 5,
          Description: 'generic untouched memo',
          DetailType: 'DepositLineDetail',
          DepositLineDetail: {
            AccountRef: {
              value: 'ACCOUNT_UNTOUCHED_GENERIC',
              name: 'Generic untouched',
            },
          },
        },
      ],
    };
    return {
      raw,
      txn: mapDeposit(raw, new Set([LINE_WRITE_HOLDING])),
      responseKey: 'Deposit' as const,
      path: 'deposit',
      untouched: raw.Line![1],
    };
  }
  const raw: RawJournalEntry = {
    Id: 'JOURNAL_GENERIC',
    SyncToken: '7',
    TxnDate: '2026-07-01',
    PrivateNote: 'generic private note',
    Line: [
      {
        Id: 'LINE_HOLDING_GENERIC',
        Amount: 10,
        Description: 'generic holding memo',
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: LINE_WRITE_HOLDING, name: 'Generic holding' },
        },
      },
      {
        Id: 'LINE_UNTOUCHED_GENERIC',
        Amount: 10,
        Description: 'generic funding memo',
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: {
            value: 'ACCOUNT_PAYMENT_GENERIC',
            name: 'Generic payment',
          },
        },
      },
    ],
  };
  return {
    raw,
    txn: mapJournalEntry(raw, new Set([LINE_WRITE_HOLDING])),
    responseKey: 'JournalEntry' as const,
    path: 'journalentry',
    untouched: raw.Line![1],
  };
}

function providerResponseBody(
  prepared: QboPreparedLineWrite,
  syncToken = '8',
): Record<string, unknown> {
  const body = structuredClone(prepared.body);
  body.SyncToken = syncToken;
  body.MetaData = { LastUpdatedTime: '2026-07-29T00:00:00Z' };
  body.domain = 'QBO';
  body.sparse = false;
  body.Line = (body.Line as Record<string, unknown>[]).map((line, index) => ({
    ...line,
    Id: `SERVER_ASSIGNED_${index}`,
  }));
  return body;
}

function jsonbStyleRoundTrip<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(jsonbStyleRoundTrip) as T;
  }
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
  return reordered as T;
}

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

describe('RealQboClient prepared transfer line writes', () => {
  it.each(['Purchase', 'Deposit', 'JournalEntry'] as const)(
    'fetches a hash-bound %s line-write snapshot',
    async (qboType) => {
      const fixture = lineWriteFixture(qboType);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        [fixture.responseKey]: fixture.raw,
      }))));

      await expect(
        realClient(undefined, [LINE_WRITE_HOLDING])
          .client.fetchLineWriteSnapshot(qboType, fixture.txn.qboId),
      ).resolves.toEqual({
        qboType,
        qboId: fixture.txn.qboId,
        syncToken: '7',
        contentHash: hashLineWriteContent(fixture.raw),
      });
    },
  );

  it.each(['Purchase', 'Deposit', 'JournalEntry'] as const)(
    'prepares a complete %s write without sending',
    async (qboType) => {
      const sentRequests: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn((...args: unknown[]) => {
        sentRequests.push(args);
        throw new Error('preparation must not send');
      }));
      const fixture = lineWriteFixture(qboType);

      const prepared = await realClient(undefined, [LINE_WRITE_HOLDING])
        .client.prepareLineRecategorization(
          fixture.txn,
          [{
            amount: fixture.txn.amount,
            accountQboId: LINE_WRITE_TARGET,
            memo: 'generic target memo',
          }],
          'request-1',
        );

      expect(prepared.before).toMatchObject({
        qboType,
        qboId: fixture.txn.qboId,
        syncToken: '7',
      });
      expect(prepared.before.contentHash).not.toBe(prepared.expected.contentHash);
      expect(prepared.body).toMatchObject({
        Id: fixture.txn.qboId,
        SyncToken: '7',
        PrivateNote: 'generic private note',
      });
      expect((prepared.body.Line as unknown[])[1]).toEqual(fixture.untouched);
      expect((prepared.body.Line as Record<string, unknown>[])[0]).toMatchObject({
        Id: 'LINE_HOLDING_GENERIC',
        Description: 'generic target memo',
      });
      expect(prepared.body).toEqual(
        JSON.parse(JSON.stringify(prepared.body)) as Record<string, unknown>,
      );
      expect(sentRequests).toHaveLength(0);
    },
  );

  it.each(['Purchase', 'Deposit', 'JournalEntry'] as const)(
    'sends and verifies the exact prepared %s response with Intuit requestid',
    async (qboType) => {
      const fixture = lineWriteFixture(qboType);
      const client = realClient(undefined, [LINE_WRITE_HOLDING]).client;
      const prepared = await client.prepareLineRecategorization(
        fixture.txn,
        [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
        'request-1',
      );
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        [fixture.responseKey]: providerResponseBody(prepared),
      })));
      vi.stubGlobal('fetch', fetchMock);

      await expect(client.sendPreparedLineWrite(prepared)).resolves.toEqual({
        ok: true,
        newSyncToken: '8',
        snapshot: {
          ...prepared.expected,
          syncToken: '8',
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        `/${fixture.path}?requestid=request-1&minorversion=75`,
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        body: deterministicJsonFixture(prepared.body),
      });
    },
  );

  it('runs the transfer authority guard after token refresh and before provider POST', async () => {
    const fixture = lineWriteFixture('Purchase');
    const events: string[] = [];
    const client = new RealQboClient({
      realmId: 'realm/1',
      environment: 'sandbox',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokens: {
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token',
        expiresAt: 0,
      },
      holdingAccountQboIds: [LINE_WRITE_HOLDING],
      onTokensRefreshed: async () => {
        events.push('tokens-persisted');
      },
    });
    const prepared = await client.prepareLineRecategorization(
      fixture.txn,
      [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
      'request-1',
    );
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        events.push('token-refresh');
        return new Response(JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        }));
      })
      .mockImplementationOnce(async () => {
        events.push('provider-post');
        return new Response(JSON.stringify({
          Purchase: providerResponseBody(prepared),
        }));
      });
    vi.stubGlobal('fetch', fetchMock);
    const guard = vi.fn(async () => {
      events.push('authority-guard');
      throw new Error('AUTHORITY_LOST_SENTINEL');
    });

    await expect(
      client.sendPreparedLineWrite(prepared, guard),
    ).rejects.toThrow('AUTHORITY_LOST_SENTINEL');
    expect(events).toEqual([
      'token-refresh',
      'tokens-persisted',
      'authority-guard',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('captures the hash-bound body before the first asynchronous send boundary', async () => {
    const fixture = lineWriteFixture('Purchase');
    const client = realClient(undefined, [LINE_WRITE_HOLDING]).client;
    const prepared = await client.prepareLineRecategorization(
      fixture.txn,
      [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
      'request-1',
    );
    const originalBodyText = deterministicJsonFixture(prepared.body);
    const fetchMock = vi.fn().mockImplementation(
      async (_url: unknown, init: RequestInit | undefined) => {
        const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          Purchase: {
            ...sentBody,
            SyncToken: '8',
            Line: (sentBody.Line as Record<string, unknown>[]).map(
              (line, index) => ({ ...line, Id: `SERVER_ASSIGNED_${index}` }),
            ),
          },
        }));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = client.sendPreparedLineWrite(prepared);
    prepared.body.PrivateNote = 'mutation after send call';

    await expect(result).resolves.toMatchObject({ newSyncToken: '8' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(originalBodyText);
  });

  it('sends identical deterministic bytes before and after a JSONB-style prepared-payload round trip', async () => {
    const fixture = lineWriteFixture('Purchase');
    const client = realClient(undefined, [LINE_WRITE_HOLDING]).client;
    const prepared = await client.prepareLineRecategorization(
      fixture.txn,
      [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
      'request-1',
    );
    const reloaded = jsonbStyleRoundTrip(prepared);
    const sentBodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: unknown, init: RequestInit | undefined) => {
        const bodyText = String(init?.body);
        sentBodies.push(bodyText);
        const sentBody = JSON.parse(bodyText) as Record<string, unknown>;
        return new Response(JSON.stringify({
          Purchase: {
            ...sentBody,
            SyncToken: '8',
            Line: (sentBody.Line as Record<string, unknown>[]).map(
              (line, index) => ({ ...line, Id: `SERVER_ASSIGNED_${index}` }),
            ),
          },
        }));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(JSON.stringify(reloaded.body)).not.toBe(JSON.stringify(prepared.body));
    expect(reloaded.requestHash).toBe(prepared.requestHash);
    await expect(client.sendPreparedLineWrite(prepared)).resolves.toMatchObject({
      newSyncToken: '8',
    });
    await expect(client.sendPreparedLineWrite(reloaded)).resolves.toMatchObject({
      newSyncToken: '8',
    });
    expect(sentBodies).toEqual([
      deterministicJsonFixture(prepared.body),
      deterministicJsonFixture(prepared.body),
    ]);
  });

  it.each([
    ['changed untouched line', (response: Record<string, unknown>) => {
      const lines = response.Line as Record<string, unknown>[];
      lines[0] = { ...lines[0], Description: 'provider changed untouched memo' };
    }],
    ['wrong target amount', (response: Record<string, unknown>) => {
      const lines = response.Line as Record<string, unknown>[];
      lines[1] = { ...lines[1], Amount: 9 };
    }],
    ['wrong target account', (response: Record<string, unknown>) => {
      const lines = response.Line as Record<string, unknown>[];
      const line = lines[1]!;
      lines[1] = {
        ...line,
        AccountBasedExpenseLineDetail: {
          ...(line.AccountBasedExpenseLineDetail as Record<string, unknown>),
          AccountRef: { value: 'ACCOUNT_WRONG_GENERIC' },
        },
      };
    }],
  ])('rejects a Purchase response with %s', async (_name, mutate) => {
    const fixture = lineWriteFixture('Purchase');
    const client = realClient(undefined, [LINE_WRITE_HOLDING]).client;
    const prepared = await client.prepareLineRecategorization(
      fixture.txn,
      [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
      'request-1',
    );
    const response = providerResponseBody(prepared);
    mutate(response);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Purchase: response,
    }))));

    await expect(client.sendPreparedLineWrite(prepared)).rejects.toThrow(
      /content/i,
    );
  });

  it('rejects an unchanged response SyncToken', async () => {
    const fixture = lineWriteFixture('Deposit');
    const client = realClient(undefined, [LINE_WRITE_HOLDING]).client;
    const prepared = await client.prepareLineRecategorization(
      fixture.txn,
      [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
      'request-1',
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Deposit: providerResponseBody(prepared, prepared.before.syncToken),
    }))));

    await expect(client.sendPreparedLineWrite(prepared)).rejects.toThrow(
      /old SyncToken/i,
    );
  });

  it.each([{}, null])(
    'rejects an omitted prepared JournalEntry response',
    async (responseBody) => {
    const fixture = lineWriteFixture('JournalEntry');
    const client = realClient(undefined, [LINE_WRITE_HOLDING]).client;
    const prepared = await client.prepareLineRecategorization(
      fixture.txn,
      [{ amount: fixture.txn.amount, accountQboId: LINE_WRITE_TARGET }],
      'request-1',
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody)),
    ));

    await expect(client.sendPreparedLineWrite(prepared)).rejects.toThrow(
      /response omitted/i,
    );
    },
  );
});

const HOLDING = new Set(['4']);

describe('tax read normalization', () => {
  it('normalizes distinct purchase and sales rate components without retaining the raw response', () => {
    expect(
      mapTaxCode({
        Id: 'GST5',
        Name: 'GST 5%',
        Active: true,
        Taxable: true,
        PurchaseTaxRateList: {
          TaxRateDetail: [{ TaxRateRef: { value: 'RATE5' }, TaxTypeApplicable: 'TaxOnAmount' }],
        },
        SalesTaxRateList: {
          TaxRateDetail: [{ TaxRateRef: { value: 'RATE7' }, TaxTypeApplicable: 'TaxOnAmount' }],
        },
      }),
    ).toMatchObject({
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
      salesRates: [{ taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' }],
    });
  });

  it('rejects a malformed purchase component before it reaches the cache', () => {
    expect(() =>
      mapTaxCode({
        Id: 'GST-PST',
        Name: 'GST + PST',
        PurchaseTaxRateList: {
          TaxRateDetail: [
            { TaxRateRef: { value: 'GST5' }, TaxTypeApplicable: 'TaxOnAmount' },
            { TaxTypeApplicable: 'TaxOnTax' },
          ],
        },
      }),
    ).toThrow(/rate reference/i);
  });

  it('rejects a malformed sales component before it reaches the cache', () => {
    expect(() =>
      mapTaxCode({
        Id: 'CODE',
        Name: 'Code',
        SalesTaxRateList: {
          TaxRateDetail: [{ TaxTypeApplicable: 'TaxOnAmount' }],
        },
      }),
    ).toThrow(/rate reference/i);
  });

  it('normalizes profile, rate, and purchase snapshot fields into safe values', () => {
    expect(mapTaxProfile({ TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: false } })).toEqual({
      usingSalesTax: true,
      partnerTaxEnabled: false,
    });
    expect(
      mapTaxRate({ Id: 'RATE5', Name: 'GST', Description: 'Goods and services tax', Active: true, RateValue: 5 }),
    ).toEqual({
      qboId: 'RATE5',
      name: 'GST',
      description: 'Goods and services tax',
      active: true,
      rateValue: 5,
      sourceUpdatedAt: null,
    });
    expect(
      mapPurchaseSnapshot({
        Id: 'P-1',
        SyncToken: '7',
        TxnDate: '2026-07-27',
        TotalAmt: 105,
        Credit: true,
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive',
        TxnTaxDetail: { TotalTax: 5 },
        Line: [
          {
            Id: '1',
            Amount: 105,
            Description: 'Lunch',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '17' },
              CustomerRef: { value: 'customer-1' },
              ClassRef: { value: 'class-1' },
              TaxCodeRef: { value: 'UNKNOWN-CODE' },
              TaxAmount: 5,
              TaxInclusiveAmt: 105,
            },
          },
        ],
      }),
    ).toEqual({
      qboId: 'P-1',
      syncToken: '7',
      totalCents: 10500,
      accountQboId: 'bank-1',
      date: '2026-07-27',
      direction: 'refund',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: 500,
      lines: [
        {
          id: '1',
          amountCents: 10500,
          description: 'Lunch',
          accountQboId: '17',
          customerQboId: 'customer-1',
          classQboId: 'class-1',
          taxCodeQboId: 'UNKNOWN-CODE',
          taxAmountCents: 500,
          taxInclusiveCents: 10500,
        },
      ],
    });
  });

  it('normalizes all purchase monetary fields as negative without double-inverting negative raw values', () => {
    expect(
      mapPurchaseSnapshot({
        Id: 'P-2',
        SyncToken: '1',
        TotalAmt: -105,
        Credit: false,
        TxnTaxDetail: { TotalTax: -5 },
        Line: [
          {
            Amount: -105,
            AccountBasedExpenseLineDetail: {
              TaxAmount: -5,
              TaxInclusiveAmt: -105,
            },
          },
        ],
      }),
    ).toMatchObject({
      totalCents: -10_500,
      direction: 'purchase',
      totalTaxCents: -500,
      lines: [
        {
          amountCents: -10_500,
          taxAmountCents: -500,
          taxInclusiveCents: -10_500,
        },
      ],
    });
  });

  it('derives omitted inclusive tax fields exactly from normalized QBO amounts', () => {
    expect(
      mapPurchaseSnapshot({
        Id: 'P-DERIVED',
        SyncToken: '1',
        TxnDate: '2026-07-27',
        TotalAmt: 10.5,
        Credit: false,
        GlobalTaxCalculation: 'TaxInclusive',
        Line: [{
          Amount: 10,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'CATEGORY_GENERIC' },
            TaxCodeRef: { value: 'TAX_GENERIC' },
            TaxInclusiveAmt: 10.5,
          },
        }],
      }),
    ).toMatchObject({
      totalTaxCents: -50,
      lines: [{
        amountCents: -1_000,
        taxAmountCents: -50,
        taxInclusiveCents: -1_050,
      }],
    });
  });

  it.each([
    ['TaxExcluded', { TaxCodeRef: { value: 'TAX_GENERIC' }, TaxAmount: 0.5 }, -50],
    ['NotApplicable', {}, 0],
  ] as const)(
    'derives an omitted %s aggregate from fully provable normalized lines',
    (taxCalculation, detail, totalTaxCents) => {
      expect(
        mapPurchaseSnapshot({
          Id: 'P-AGGREGATE',
          SyncToken: '1',
          TxnDate: '2026-07-27',
          TotalAmt: 10,
          Credit: false,
          GlobalTaxCalculation: taxCalculation,
          Line: [{
            Amount: 10,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: 'CATEGORY_GENERIC' },
              ...detail,
            },
          }],
        }).totalTaxCents,
      ).toBe(totalTaxCents);
    },
  );

  it('preserves malformed tax preferences and rates as unavailable metadata', () => {
    expect(mapTaxProfile({ TaxPrefs: {} })).toEqual({
      usingSalesTax: null,
      partnerTaxEnabled: null,
    });
    expect(mapTaxProfile({ TaxPrefs: { UsingSalesTax: 'yes' } } as never).usingSalesTax).toBeNull();
    expect(mapTaxRate({ Id: 'MISSING', Name: 'Missing' }).rateValue).toBeNull();
    expect(mapTaxRate({ Id: 'NEGATIVE', Name: 'Negative', RateValue: -1 }).rateValue).toBeNull();
    expect(mapTaxRate({ Id: 'TOO_HIGH', Name: 'Too high', RateValue: 1_000 }).rateValue).toBeNull();
  });

  it('normalizes optional source timestamps and rejects malformed timestamps', () => {
    expect(
      mapTaxCode({
        Id: 'GST5',
        Name: 'GST 5%',
        MetaData: { LastUpdatedTime: '2026-07-27T09:10:11-07:00' },
      }).sourceUpdatedAt,
    ).toBe('2026-07-27T16:10:11.000Z');
    expect(mapTaxRate({ Id: 'RATE5', Name: 'GST' }).sourceUpdatedAt).toBeNull();
    expect(() =>
      mapTaxRate({
        Id: 'BROKEN',
        Name: 'Broken',
        MetaData: { LastUpdatedTime: 'not-a-timestamp' },
      }),
    ).toThrow(/source timestamp/i);
  });

  it.each(['false', 0, null])('rejects a present non-boolean Active value %j', (active) => {
    expect(() =>
      mapTaxCode({ Id: 'CODE', Name: 'Code', Active: active } as never),
    ).toThrow(/Active/i);
    expect(() =>
      mapTaxRate({ Id: 'RATE', Name: 'Rate', Active: active, RateValue: 5 } as never),
    ).toThrow(/Active/i);
  });

  it('defaults absent Active to true but rejects empty tax identities', () => {
    expect(mapTaxCode({ Id: 'CODE', Name: 'Code' }).active).toBe(true);
    expect(mapTaxRate({ Id: 'RATE', Name: 'Rate', RateValue: 5 }).active).toBe(true);
    expect(() => mapTaxCode({ Id: ' ', Name: 'Code' })).toThrow(/Id/i);
    expect(() => mapTaxRate({ Id: '', Name: 'Rate', RateValue: 5 })).toThrow(/Id/i);
    expect(() =>
      mapTaxCode({
        Id: 'CODE',
        Name: 'Code',
        PurchaseTaxRateList: {
          TaxRateDetail: [{ TaxRateRef: { value: '' }, TaxTypeApplicable: 'TaxOnAmount' }],
        },
      }),
    ).toThrow(/rate reference/i);
  });

  it.each([123, {}, '', 'not-a-timestamp'])(
    'rejects malformed source timestamp %j',
    (lastUpdatedTime) => {
      expect(() =>
        mapTaxRate({
          Id: 'RATE',
          Name: 'Rate',
          RateValue: 5,
          MetaData: { LastUpdatedTime: lastUpdatedTime },
        } as never),
      ).toThrow(/source timestamp/i);
    },
  );
});

/** Two-line purchase: $100 parked in holding + $50 already categorized. */
function twoLinePurchase(): RawPurchase {
  return {
    Id: '42',
    SyncToken: '3',
    TxnDate: '2026-07-01',
    TotalAmt: 150,
    EntityRef: { value: 'v1', name: 'COSTCO WHSE #1123' },
    AccountRef: { value: '1', name: 'Checking ·4821' },
    Line: [
      {
        Id: '1',
        Amount: 100,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '4', name: 'Ask My Accountant' } },
      },
      {
        Id: '2',
        Amount: 50,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'Shelf brackets',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '19', name: 'Office supplies' } },
      },
    ],
  };
}

describe('mapPurchase (multi-line)', () => {
  it('amount is the holding-line sum, not TotalAmt', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(txn.amount).toBe(-100); // NOT -150
  });

  it('lines contain only the holding-account lines', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(txn.lines).toHaveLength(1);
    expect(txn.lines[0]).toMatchObject({ accountQboId: '4', amount: 100 });
  });

  it('keeps the natural sign for credits', () => {
    const txn = mapPurchase({ ...twoLinePurchase(), Credit: true }, HOLDING);
    expect(txn.amount).toBe(100);
  });

  it('maps an entity with no holding lines to zero amount and no lines', () => {
    const txn = mapPurchase(twoLinePurchase(), new Set(['999']));
    expect(txn.amount).toBe(-0);
    expect(txn.lines).toHaveLength(0);
  });
});

describe('rebuildPurchaseLines (multi-line write safety)', () => {
  it('replaces only holding lines; the categorized line survives verbatim and the total is unchanged', () => {
    const raw = twoLinePurchase();
    const rebuilt = rebuildPurchaseLines(raw, HOLDING, [
      { amount: -60, accountQboId: '17', memo: 'client dinner' },
      { amount: -40, accountQboId: '14' },
    ]);

    // The already-categorized $50 Office supplies line is untouched.
    const kept = rebuilt.find((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === '19');
    expect(kept).toEqual(raw.Line?.[1]);

    // No holding line remains; the new category lines are present.
    expect(rebuilt.some((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === '4')).toBe(false);
    expect(rebuilt.filter((l) => ['17', '14'].includes(l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? ''))).toHaveLength(2);

    // Entity total unchanged: 50 + 60 + 40 = 150.
    const total = rebuilt.reduce((a, l) => a + (l.Amount ?? 0), 0);
    expect(total).toBeCloseTo(150, 2);
  });

  it('does not add tax fields to existing categorization payload lines', () => {
    const rebuilt = rebuildPurchaseLines(twoLinePurchase(), HOLDING, [
      { amount: -100, accountQboId: '17', memo: 'client dinner' },
    ]);
    const detail = rebuilt.find(
      (line) => line.AccountBasedExpenseLineDetail?.AccountRef?.value === '17',
    )?.AccountBasedExpenseLineDetail;

    expect(detail).toEqual({ AccountRef: { value: '17' } });
    expect(detail).not.toHaveProperty('TaxCodeRef');
    expect(detail).not.toHaveProperty('TaxAmount');
    expect(detail).not.toHaveProperty('TaxInclusiveAmt');
  });
});

describe('rebuildDepositLines', () => {
  const deposit: RawDeposit = {
    Id: '7',
    SyncToken: '0',
    TotalAmt: 300,
    DepositToAccountRef: { value: '1', name: 'Checking ·4821' },
    Line: [
      {
        Id: '1',
        Amount: 200,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '4', name: 'Ask My Accountant' }, Entity: { value: 'c9', name: 'Square' } },
      },
      {
        Id: '2',
        Amount: 100,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '7', name: 'Sales — food' } },
      },
    ],
  };

  it('keeps non-holding lines, preserves the payer Entity, and keeps the total', () => {
    const rebuilt = rebuildDepositLines(deposit, HOLDING, [{ amount: 200, accountQboId: '8' }]);
    expect(rebuilt.find((l) => l.DepositLineDetail?.AccountRef?.value === '7')).toEqual(deposit.Line?.[1]);
    const newLine = rebuilt.find((l) => l.DepositLineDetail?.AccountRef?.value === '8');
    expect(newLine?.DepositLineDetail?.Entity).toEqual({ value: 'c9', name: 'Square' });
    expect(rebuilt.reduce((a, l) => a + (l.Amount ?? 0), 0)).toBeCloseTo(300, 2);
  });

  it('mapDeposit amount is the holding-line sum', () => {
    expect(mapDeposit(deposit, HOLDING).amount).toBe(200);
  });
});

describe('rebuildJournalEntryLines', () => {
  const je: RawJournalEntry = {
    Id: '11',
    SyncToken: '0',
    Line: [
      {
        Id: '1',
        Amount: 80,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '4', name: 'Ask My Accountant' } },
      },
      {
        Id: '2',
        Amount: 20,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '23', name: 'Rent' } },
      },
      {
        Id: '3',
        Amount: 100,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '1', name: 'Checking ·4821' } },
      },
    ],
  };

  it('replaces only the holding Debit line; other Debits and all Credits survive', () => {
    const rebuilt = rebuildJournalEntryLines(je, HOLDING, [{ amount: -80, accountQboId: '17' }]);
    expect(rebuilt.find((l) => l.JournalEntryLineDetail?.AccountRef?.value === '23')).toEqual(je.Line?.[1]);
    expect(rebuilt.find((l) => l.JournalEntryLineDetail?.PostingType === 'Credit')).toEqual(je.Line?.[2]);
    expect(rebuilt.some((l) => l.JournalEntryLineDetail?.AccountRef?.value === '4')).toBe(false);
    // Debits still balance the credit: 20 + 80 = 100.
    const debits = rebuilt
      .filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit')
      .reduce((a, l) => a + (l.Amount ?? 0), 0);
    expect(debits).toBeCloseTo(100, 2);
  });

  it('mapJournalEntry amount is minus the holding-debit sum', () => {
    expect(mapJournalEntry(je, HOLDING).amount).toBe(-80);
  });
});

describe('sumLinesPostingTo', () => {
  it('sums only the raw lines posting to the given accounts', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(sumLinesPostingTo(txn, new Set(['19']))).toBe(50);
    expect(sumLinesPostingTo(txn, new Set(['4']))).toBe(100);
    expect(sumLinesPostingTo(txn, new Set(['999']))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reports API parsing — Intuit report JSON → normalized QboStatement /
// account-transaction rows. Fixtures follow the documented Rows/Columns shape
// (Section rows with Header/Summary, nested Rows.Row, ColData value+id).
// ---------------------------------------------------------------------------

const plReport: RawReport = {
  Columns: {
    Column: [
      { ColTitle: '', ColType: 'Account' },
      { ColTitle: 'Total', ColType: 'Money' },
    ],
  },
  Rows: {
    Row: [
      {
        type: 'Section',
        group: 'Income',
        Header: { ColData: [{ value: 'Income' }, { value: '' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Sales — food', id: '7' }, { value: '4200.00' }] },
            { type: 'Data', ColData: [{ value: 'Sales — beverage', id: '8' }, { value: '1,150.50' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Income' }, { value: '5350.50' }] },
      },
      {
        type: 'Section',
        group: 'COGS',
        Header: { ColData: [{ value: 'Cost of Goods Sold' }, { value: '' }] },
        Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Food purchases', id: '10' }, { value: '900.00' }] }] },
        Summary: { ColData: [{ value: 'Total Cost of Goods Sold' }, { value: '900.00' }] },
      },
      { type: 'Section', group: 'GrossProfit', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '4450.50' }] } },
      {
        type: 'Section',
        group: 'Expenses',
        Header: { ColData: [{ value: 'Expenses' }, { value: '' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Rent', id: '23' }, { value: '1800.00' }] },
            {
              // nested sub-account section — QBO nests Rows.Row arbitrarily deep
              type: 'Section',
              Header: { ColData: [{ value: 'Payroll' }, { value: '' }] },
              Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Payroll wages', id: '20' }, { value: '2100.00' }] }] },
              Summary: { ColData: [{ value: 'Total Payroll' }, { value: '2100.00' }] },
            },
          ],
        },
        Summary: { ColData: [{ value: 'Total Expenses' }, { value: '3900.00' }] },
      },
      { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '550.50' }] } },
    ],
  },
};

describe('parseStatementReport', () => {
  it('maps a realistic P&L body to the normalized statement tree', () => {
    const stmt = parseStatementReport(plReport);
    expect(stmt.columns).toEqual([{ label: 'Total' }]);
    expect(
      stmt.rows.map((r) => ({ label: r.label, kind: r.kind, indent: r.indent, id: r.accountQboId, v: r.values })),
    ).toEqual([
      { label: 'Income', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Sales — food', kind: 'line', indent: true, id: '7', v: [4200] },
      { label: 'Sales — beverage', kind: 'line', indent: true, id: '8', v: [1150.5] },
      { label: 'Total Income', kind: 'total', indent: false, id: undefined, v: [5350.5] },
      { label: 'Cost of Goods Sold', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Food purchases', kind: 'line', indent: true, id: '10', v: [900] },
      { label: 'Total Cost of Goods Sold', kind: 'total', indent: false, id: undefined, v: [900] },
      { label: 'Gross Profit', kind: 'grand', indent: false, id: undefined, v: [4450.5] },
      { label: 'Expenses', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Rent', kind: 'line', indent: true, id: '23', v: [1800] },
      { label: 'Payroll', kind: 'head', indent: true, id: undefined, v: [] },
      { label: 'Payroll wages', kind: 'line', indent: true, id: '20', v: [2100] },
      { label: 'Total Payroll', kind: 'total', indent: false, id: undefined, v: [2100] },
      { label: 'Total Expenses', kind: 'total', indent: false, id: undefined, v: [3900] },
      { label: 'Net Income', kind: 'grand', indent: false, id: undefined, v: [550.5] },
    ]);
  });

  it('marks top-level balance-sheet section summaries as grand rows', () => {
    const bs: RawReport = {
      Columns: {
        Column: [
          { ColTitle: '', ColType: 'Account' },
          { ColTitle: 'Total', ColType: 'Money' },
        ],
      },
      Rows: {
        Row: [
          {
            type: 'Section',
            group: 'TotalAssets',
            Header: { ColData: [{ value: 'ASSETS' }, { value: '' }] },
            Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Checking', id: '1' }, { value: '12400.00' }] }] },
            Summary: { ColData: [{ value: 'Total ASSETS' }, { value: '12400.00' }] },
          },
        ],
      },
    };
    const stmt = parseStatementReport(bs);
    expect(stmt.rows[2]).toEqual({ label: 'Total ASSETS', kind: 'grand', indent: false, values: [12400] });
  });

  it('tolerates empty / missing pieces (defensive parsing)', () => {
    expect(parseStatementReport({})).toEqual({ columns: [], rows: [] });
    const weird: RawReport = {
      Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
      Rows: { Row: [{ type: 'Data', ColData: [{ value: 'No id row' }, { value: 'n/a' }] }] },
    };
    expect(parseStatementReport(weird).rows).toEqual([
      { label: 'No id row', kind: 'line', indent: true, values: [0] },
    ]);
  });
});

describe('parseTransactionListReport', () => {
  const txnList: RawReport = {
    Columns: {
      Column: [
        { ColTitle: 'Date', ColType: 'tx_date' },
        { ColTitle: 'Transaction Type', ColType: 'txn_type' },
        { ColTitle: 'Name', ColType: 'name' },
        { ColTitle: 'Memo/Description', ColType: 'memo' },
        { ColTitle: 'Amount', ColType: 'subt_nat_amount' },
      ],
    },
    Rows: {
      Row: [
        {
          type: 'Data',
          ColData: [
            { value: '2026-07-05', id: '6' },
            { value: 'Expense' },
            { value: 'WEBFLOW.COM' },
            { value: '' },
            { value: '-29.00' },
          ],
        },
        {
          type: 'Data',
          ColData: [
            { value: '2026-07-11', id: '11' },
            { value: 'Expense' },
            { value: 'ULINE SHIP SUPPLIES' },
            { value: 'Boxes' },
            { value: '-212.06' },
          ],
        },
        {
          type: 'Section',
          group: 'GrandTotal',
          Summary: {
            ColData: [{ value: 'Grand Total' }, { value: '' }, { value: '' }, { value: '' }, { value: '-241.06' }],
          },
        },
      ],
    },
  };

  it('maps data rows via the report column metadata and skips summary rows', () => {
    expect(parseTransactionListReport(txnList)).toEqual([
      { date: '2026-07-05', payee: 'WEBFLOW.COM', amount: -29, txnType: 'Expense', qboId: '6' },
      { date: '2026-07-11', payee: 'ULINE SHIP SUPPLIES', memo: 'Boxes', amount: -212.06, txnType: 'Expense', qboId: '11' },
    ]);
  });

  it('flattens grouped sections and returns [] for an empty report', () => {
    const grouped: RawReport = { Columns: txnList.Columns, Rows: { Row: [{ type: 'Section', Rows: txnList.Rows }] } };
    expect(parseTransactionListReport(grouped)).toHaveLength(2);
    expect(parseTransactionListReport({})).toEqual([]);
  });
});

// The country decides whether a company can express tax-inclusive entry at all,
// so the probe reads it through the client rather than fetching it itself —
// fetching it itself is what dropped Intuit's rotated refresh token (#44, #48).
describe('getCompanyInfo — country', () => {
  function clientWithCompanyInfo(companyInfo: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ CompanyInfo: companyInfo }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    return new RealQboClient({
      realmId: 'realm-1',
      environment: 'sandbox',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 600_000 },
      holdingAccountQboIds: [],
      onTokensRefreshed: async () => undefined,
    });
  }

  it('reports the country QuickBooks returns', async () => {
    const info = await clientWithCompanyInfo({ LegalName: 'Acme UK', Country: 'GB' }).getCompanyInfo();

    expect(info.country).toBe('GB');
    expect(info.legalName).toBe('Acme UK');
  });

  it('reports null rather than guessing when QBO omits it', async () => {
    const info = await clientWithCompanyInfo({ LegalName: 'Acme' }).getCompanyInfo();

    expect(info.country).toBeNull();
  });
});
