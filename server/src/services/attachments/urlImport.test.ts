import { describe, expect, it, vi } from 'vitest';
import { createAttachmentBatchBudget } from './blobStore.js';
import type {
  StageAttachmentInput,
  StagedAttachmentDto,
} from './types.js';
import {
  importHttpsAttachment,
  isPublicAttachmentAddress,
  type PinnedHttpsResponse,
  type UrlImportDependencies,
} from './urlImport.js';

const encoder = new TextEncoder();
const PUBLIC_ADDRESS = '93.184.216.34';

function body(...chunks: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield encoder.encode(chunk);
    },
  };
}

function response(
  overrides: Partial<PinnedHttpsResponse> = {},
): PinnedHttpsResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': '14',
      'content-disposition': 'attachment; filename="receipt.pdf"',
    },
    body: body('%PDF-1.7\n', 'done\n'),
    ...overrides,
  };
}

function input(url = 'https://public.test/receipt.pdf') {
  return {
    companyId: 'company-1',
    actorKey: 'user:user-1',
    retainLocally: true,
    url,
    batchBudget: createAttachmentBatchBudget(100_000_000),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  };
}

function successfulStage(): {
  stage: UrlImportDependencies['stage'];
  inputs: StageAttachmentInput[];
} {
  const inputs: StageAttachmentInput[] = [];
  const stage = vi.fn(async (stageInput: StageAttachmentInput) => {
    inputs.push(stageInput);
    let sizeBytes = 0;
    for await (const chunk of stageInput.content) sizeBytes += chunk.byteLength;
    return {
      id: 'staged-1',
      companyId: stageInput.companyId,
      filename: stageInput.filename,
      contentType: 'application/pdf',
      sizeBytes,
      sha256: 'a'.repeat(64),
      sourceKind: 'HTTPS_IMPORT',
      retainLocally: stageInput.retainLocally,
      expiresAt: stageInput.expiresAt.toISOString(),
    } satisfies StagedAttachmentDto;
  });
  return { stage, inputs };
}

describe('public HTTPS attachment imports', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '192.88.99.1',
    '::',
    '::1',
    'fc00::1',
    'fec0::1',
    'fd7a:115c:a1e0::1',
    'fe80::1',
    '2001:db8::1',
    '2002:c000:0201::1',
    '3fff::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAttachmentAddress(address)).toBe(false);
  });

  it.each([
    PUBLIC_ADDRESS,
    '8.8.8.8',
    '2606:4700:4700::1111',
  ])('accepts public address %s', (address) => {
    expect(isPublicAttachmentAddress(address)).toBe(true);
  });

  it.each([
    'http://public.test/receipt.pdf',
    'https://user:password@public.test/receipt.pdf',
  ])('rejects unsafe URL form without resolving it', async (url) => {
    const resolve = vi.fn(async () => [PUBLIC_ADDRESS]);
    const staged = successfulStage();

    await expect(importHttpsAttachment(input(url), {
      resolve,
      request: async () => response(),
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_INPUT' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects any DNS set containing a private or changed answer', async () => {
    const staged = successfulStage();
    await expect(importHttpsAttachment(input(), {
      resolve: async () => [PUBLIC_ADDRESS, '127.0.0.1'],
      request: async () => response(),
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_INPUT' });
    expect(staged.stage).not.toHaveBeenCalled();
  });

  it('re-resolves redirects and rejects a public-to-private hop', async () => {
    const staged = successfulStage();
    const resolve = vi.fn(async (hostname: string) =>
      hostname === 'public.test' ? [PUBLIC_ADDRESS] : ['127.0.0.1']);
    const request = vi.fn(async () => response({
      status: 302,
      headers: { location: 'https://private.test/secret.pdf' },
      body: body(),
    }));

    await expect(importHttpsAttachment(input(), {
      resolve,
      request,
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_INPUT' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(staged.stage).not.toHaveBeenCalled();
  });

  it('rejects a fourth redirect', async () => {
    const staged = successfulStage();
    let redirects = 0;
    await expect(importHttpsAttachment(input(), {
      resolve: async () => [PUBLIC_ADDRESS],
      request: async () => {
        redirects += 1;
        return response({
          status: 302,
          headers: { location: `/redirect-${redirects}.pdf` },
          body: body(),
        });
      },
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_INPUT' });
    expect(redirects).toBe(4);
  });

  it.each(['gzip', 'br'])('rejects compressed response encoding %s', async (encoding) => {
    const staged = successfulStage();
    await expect(importHttpsAttachment(input(), {
      resolve: async () => [PUBLIC_ADDRESS],
      request: async () => response({
        headers: {
          'content-type': 'application/pdf',
          'content-encoding': encoding,
        },
      }),
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_INPUT' });
  });

  it('rejects misleading Content-Length and streaming overflow', async () => {
    const staged = successfulStage();
    await expect(importHttpsAttachment(input(), {
      resolve: async () => [PUBLIC_ADDRESS],
      request: async () => response({
        headers: {
          'content-type': 'application/pdf',
          'content-length': '1',
        },
      }),
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_INPUT' });

    const overflow = input();
    overflow.batchBudget = createAttachmentBatchBudget(8);
    await expect(importHttpsAttachment(overflow, {
      resolve: async () => [PUBLIC_ADDRESS],
      request: async () => response({
        headers: { 'content-type': 'application/pdf' },
      }),
      stage: staged.stage,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('maps request timeouts to one safe retryable error', async () => {
    const staged = successfulStage();
    const timeout = new Error('socket details must not escape');
    timeout.name = 'AbortError';

    await expect(importHttpsAttachment(input(), {
      resolve: async () => [PUBLIC_ADDRESS],
      request: async () => {
        throw timeout;
      },
      stage: staged.stage,
    })).rejects.toMatchObject({
      code: 'ATTACHMENT_BUSY',
      retryable: true,
      message: 'HTTPS attachment import timed out.',
    });
  });

  it('pins the public address, preserves the hostname, and streams into staging', async () => {
    const staged = successfulStage();
    const request = vi.fn(async () => response());

    const result = await importHttpsAttachment(input(), {
      resolve: async () => [PUBLIC_ADDRESS],
      request,
      stage: staged.stage,
    });

    expect(result).toMatchObject({
      filename: 'receipt.pdf',
      sizeBytes: 14,
      sourceKind: 'HTTPS_IMPORT',
    });
    expect((request.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      hostname: 'public.test',
      address: PUBLIC_ADDRESS,
      port: 443,
    });
    expect(staged.inputs[0]).toMatchObject({
      companyId: 'company-1',
      actorKey: 'user:user-1',
      sourceKind: 'HTTPS_IMPORT',
      filename: 'receipt.pdf',
      declaredContentType: 'application/pdf',
    });
  });
});
