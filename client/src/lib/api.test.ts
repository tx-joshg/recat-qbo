import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  companies,
  attachments,
  autopilot,
  createCategorizationRequestId,
  receipts,
  transactions,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCategorizationRequestId', () => {
  it('uses the platform randomUUID implementation when available', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000040');
    vi.stubGlobal('crypto', { randomUUID });

    expect(createCategorizationRequestId()).toBe('00000000-0000-4000-8000-000000000040');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('falls back to secure random bytes and sets RFC 4122 version and variant bits', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const requestId = createCategorizationRequestId();

    expect(requestId).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when no cryptographically secure UUID API exists', () => {
    vi.stubGlobal('crypto', {});

    expect(() => createCategorizationRequestId()).toThrow(
      'Secure random UUID generation is unavailable.',
    );
  });
});

describe('structured mutation failures', () => {
  it('preserves only the bounded mutation result on ApiError', async () => {
    const responseBody = {
      transactionId: '00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000040',
      ok: false,
      status: 'PENDING',
      outcome: 'RETRYABLE',
      error: {
        code: 'RETRYABLE',
        message: 'The prepared write was not sent.',
        internal: 'excluded',
      },
      requestPayload: { internal: 'excluded' },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    const promise = transactions.commitCategorization(
      '00000000-0000-4000-8000-000000000030',
      3,
      '00000000-0000-4000-8000-000000000040',
    );

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await promise.catch((error: unknown) => {
      expect(error).toMatchObject({
        status: 409,
        mutationResult: {
          transactionId: '00000000-0000-4000-8000-000000000030',
          requestId: '00000000-0000-4000-8000-000000000040',
          ok: false,
          status: 'PENDING',
          outcome: 'RETRYABLE',
          error: {
            code: 'RETRYABLE',
            message: 'The prepared write was not sent.',
          },
        },
      });
      expect(JSON.stringify((error as ApiError).mutationResult)).not.toMatch(
        /requestPayload|internal/i,
      );
    });
  });

  it.each([
    ['invalid transaction identity', {
      transactionId: 'not-a-uuid',
      error: { code: 'RETRYABLE', message: 'Known failure.' },
    }],
    ['oversized error message', {
      transactionId: '00000000-0000-4000-8000-000000000030',
      error: { code: 'RETRYABLE', message: 'x'.repeat(501) },
    }],
  ])('rejects a mutation result with %s', async (_case, overrides) => {
    const responseBody = Object.assign({
      transactionId: '00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000040',
      ok: false,
      status: 'PENDING',
      outcome: 'RETRYABLE',
    }, overrides);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await transactions.commitCategorization(
      '00000000-0000-4000-8000-000000000030',
      3,
      '00000000-0000-4000-8000-000000000040',
    ).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).mutationResult).toBeUndefined();
    });
  });
});

describe('strict live control requests', () => {
  it('sends an explicit empty object for pause and opaque reconciliation', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await autopilot.pauseLive('company-1');
    await autopilot.reconcileLive(
      'company-1',
      '00000000-0000-4000-8000-000000000040',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/companies/company-1/autopilot/pause-live',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/companies/company-1/autopilot/reconcile/00000000-0000-4000-8000-000000000040',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    );
  });
});

describe('attachment requests', () => {
  it('stages browser files with a one-use bearer grant and lets the browser set the boundary', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({
      uploads: [{ id: 'upload-1' }, { id: 'upload-2' }],
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = new File(['first'], 'first.txt', { type: 'text/plain' });
    const second = new File(['second'], 'second.txt', { type: 'text/plain' });

    await expect(attachments.stage({
      uploadUrl: '/api/attachment-uploads/grant-1',
      grant: 'one-use-secret',
      expiresAt: '2026-07-30T00:00:00.000Z',
      maxFileCount: 2,
      maxEncodedRequestBytes: 100_000_000,
    }, [first, second])).resolves.toEqual(['upload-1', 'upload-2']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: { Authorization: 'Bearer one-use-secret' },
    });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('uses fresh idempotency keys for attach and destructive requests', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({
      operationId: 'operation-1',
      status: 'PREPARED',
      files: [],
      actions: { canRetry: false, requiresReconciliation: false },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn()
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000041')
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000042'),
    });

    await attachments.attach('company-1', 'transaction-1', [
      { kind: 'upload', uploadId: 'upload-1' },
      { kind: 'https', url: 'https://example.test/receipt.pdf' },
    ]);
    await attachments.delete('company-1', 'transaction-1', 'attachment-1', 'everywhere');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/companies/company-1/transactions/transaction-1/attachments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: '00000000-0000-4000-8000-000000000041',
          sources: [
            { kind: 'upload', uploadId: 'upload-1' },
            { kind: 'https', url: 'https://example.test/receipt.pdf' },
          ],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/companies/company-1/transactions/transaction-1/attachments/attachment-1?scope=everywhere&idempotencyKey=00000000-0000-4000-8000-000000000042',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('receipt workspace requests', () => {
  it('stages files then consumes upload IDs as receipts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        uploadUrl: '/api/attachment-uploads/grant-1',
        grant: 'receipt-grant',
        expiresAt: '2026-07-30T00:00:00.000Z',
        maxFileCount: 1,
        maxEncodedRequestBytes: 100_000_000,
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        uploads: [{ id: 'upload-1' }],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        receipts: [{ id: 'receipt-1', status: 'QUEUED' }],
      }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000051'),
    });
    const file = new File(['x'], 'synthetic.png', { type: 'image/png' });

    const result = await receipts.upload('company-1', [file], 'WEB_UPLOAD');

    expect(result.receipts[0]?.id).toBe('receipt-1');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/companies/company-1/receipts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: '00000000-0000-4000-8000-000000000051',
          files: [{ uploadId: 'upload-1' }],
          sourceKind: 'WEB_UPLOAD',
        }),
      }),
    );
  });

  it('encodes bounded receipt filters', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      receipts: [],
      total: 0,
      page: 2,
      pageSize: 20,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await receipts.list('company-1', {
      statuses: ['READY', 'NEEDS_REVIEW'],
      page: 2,
      pageSize: 20,
      sortBy: 'receiptDate',
      sortOrder: 'desc',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'status=READY%2CNEEDS_REVIEW&page=2&pageSize=20'
        + '&sortBy=receiptDate&sortOrder=desc',
      ),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

it('keeps safe request reference but ignores provider fields', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: 'QuickBooks could not provide this report right now.',
    code: 'QBO_REPORT_UNAVAILABLE',
    requestId: '8c9ed2fd-f3e0-4f6c-8784-41464977d558',
    providerBody: 'RAW_QBO_BODY_SENTINEL',
  }), { status: 502 })));

  await expect(companies.dashboard('company-1')).rejects.toMatchObject({
    status: 502,
    code: 'QBO_REPORT_UNAVAILABLE',
    requestId: '8c9ed2fd-f3e0-4f6c-8784-41464977d558',
  });
});

it('omits malformed request references from API errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: 'Report unavailable.', requestId: 'UNTRUSTED_REFERENCE_SENTINEL',
  }), { status: 502 })));
  await expect(companies.dashboard('company-1')).rejects.toMatchObject({ requestId: undefined });
});
