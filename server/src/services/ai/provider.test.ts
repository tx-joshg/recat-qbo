import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInstanceSettings: vi.fn(),
  fetch: vi.fn(),
  getCodexAccess: vi.fn(),
  markCodexReconnectRequired: vi.fn(),
  completeCodexText: vi.fn(),
}));

vi.mock('../instanceSettings.js', () => ({ getInstanceSettings: mocks.getInstanceSettings }));
vi.mock('./codexAuth.js', () => ({
  getCodexAccess: mocks.getCodexAccess,
  markCodexReconnectRequired: mocks.markCodexReconnectRequired,
}));
vi.mock('./codexResponses.js', () => ({ completeCodexText: mocks.completeCodexText }));

import { completeCategory, testCodexConnection } from './provider.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.getInstanceSettings.mockResolvedValue({
    suggestionProvider: 'custom',
    suggestionModel: 'local-model',
    aiEndpoint: 'https://models.example/v1/',
    aiApiKey: 'custom-key',
    openrouterApiKey: '',
    openrouterReferer: '',
    openrouterTitle: '',
    codexModel: 'gpt-5.6-luna',
  });
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '  Office supplies  ' } }] }),
  });
  mocks.getCodexAccess.mockResolvedValue({ accessToken: 'codex-access', accountId: 'acct_123' });
  mocks.completeCodexText.mockResolvedValue('  Office supplies  ');
  mocks.markCodexReconnectRequired.mockResolvedValue(undefined);
});

describe('completeCategory', () => {
  it('uses the configurable custom endpoint and optional custom Bearer key', async () => {
    await expect(completeCategory('choose one')).resolves.toBe('Office supplies');

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://models.example/v1/chat/completions',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer custom-key' },
        body: JSON.stringify({
          model: 'local-model',
          temperature: 0,
          messages: [{ role: 'user', content: 'choose one' }],
        }),
      }),
    );
  });

  it('pins OpenRouter and sends vendor-qualified models with optional attribution headers only when configured', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'openrouter',
      suggestionModel: 'openai/gpt-4o-mini',
      aiEndpoint: 'https://ignored.example/v1',
      aiApiKey: 'custom-key',
      openrouterApiKey: 'openrouter-key',
      openrouterReferer: 'https://recat.example',
      openrouterTitle: 'Recat QBO',
    });

    await expect(completeCategory('choose one')).resolves.toBe('Office supplies');

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer openrouter-key',
          'HTTP-Referer': 'https://recat.example',
          'X-Title': 'Recat QBO',
        },
        body: expect.stringContaining('openai/gpt-4o-mini'),
      }),
    );
  });

  it('omits OpenRouter attribution headers when they are not configured', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'openrouter',
      suggestionModel: 'openai/gpt-4o-mini',
      aiEndpoint: '',
      aiApiKey: '',
      openrouterApiKey: 'openrouter-key',
      openrouterReferer: '',
      openrouterTitle: '',
    });

    await completeCategory('choose one');

    expect(mocks.fetch.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer openrouter-key',
    });
  });

  it.each([
    ['non-success response', () => ({ ok: false, json: async () => ({}) })],
    ['malformed response', () => ({ ok: true, json: async () => ({ choices: [] }) })],
    ['thrown transport error', () => new Error('network unavailable')],
  ])('returns null for every %s', async (_label, response) => {
    const value = response();
    if (value instanceof Error) mocks.fetch.mockRejectedValueOnce(value);
    else mocks.fetch.mockResolvedValueOnce(value);

    await expect(completeCategory('choose one')).resolves.toBeNull();
  });

  it('aborts a completion that exceeds the request deadline', async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockImplementationOnce(
        async (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );

      const pending = completeCategory('choose one');
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toBeNull();
      expect(mocks.fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the request deadline active while reading a stalled response body', async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => ({
        ok: true,
        json: async () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      }));

      const pending = completeCategory('choose one');
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches Codex with its separate model and subscription credentials', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'codex',
      suggestionModel: 'custom-model',
      codexModel: 'gpt-5.6-luna',
      aiEndpoint: 'https://ignored.example/v1',
      aiApiKey: 'ignored-key',
      openrouterApiKey: 'ignored-router-key',
      openrouterReferer: '',
      openrouterTitle: '',
    });

    await expect(completeCategory('choose one')).resolves.toBe('Office supplies');

    expect(mocks.getCodexAccess).toHaveBeenCalledTimes(1);
    expect(mocks.completeCodexText).toHaveBeenCalledWith({
      accessToken: 'codex-access',
      accountId: 'acct_123',
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', content: 'choose one' }],
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('force-refreshes and retries Codex exactly once after an inference 401', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'codex',
      codexModel: 'gpt-5.6-luna',
    });
    const unauthorized = Object.assign(new Error('rejected token'), { status: 401 });
    mocks.getCodexAccess
      .mockResolvedValueOnce({ accessToken: 'stale', accountId: 'acct_123' })
      .mockResolvedValueOnce({ accessToken: 'fresh', accountId: 'acct_123' });
    mocks.completeCodexText.mockRejectedValueOnce(unauthorized).mockResolvedValueOnce('Meals');

    await expect(completeCategory('choose one')).resolves.toBe('Meals');

    expect(mocks.getCodexAccess).toHaveBeenNthCalledWith(1);
    expect(mocks.getCodexAccess).toHaveBeenNthCalledWith(2, {
      forceRefresh: { failedAccessToken: 'stale' },
    });
    expect(mocks.completeCodexText).toHaveBeenCalledTimes(2);
    expect(mocks.completeCodexText.mock.calls[1]?.[0]).toMatchObject({ accessToken: 'fresh' });
    expect(mocks.markCodexReconnectRequired).not.toHaveBeenCalled();
  });

  it('marks reconnect required and returns null after a second Codex 401', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'codex',
      codexModel: 'gpt-5.6-luna',
    });
    const unauthorized = Object.assign(new Error('rejected token'), { status: 401 });
    mocks.completeCodexText.mockRejectedValue(unauthorized);

    await expect(completeCategory('choose one')).resolves.toBeNull();

    expect(mocks.completeCodexText).toHaveBeenCalledTimes(2);
    expect(mocks.markCodexReconnectRequired).toHaveBeenCalledWith({
      failedAccessToken: 'codex-access',
      failureCode: 'inference_unauthorized',
    });
  });

  it.each([
    ['credential failure', () => mocks.getCodexAccess.mockRejectedValueOnce(new Error('not connected'))],
    ['transport failure', () => mocks.completeCodexText.mockRejectedValueOnce(new Error('network'))],
    ['empty result', () => mocks.completeCodexText.mockResolvedValueOnce('')],
  ])('returns null without falling back when Codex has a %s', async (_label, arrange) => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'codex',
      codexModel: 'gpt-5.6-luna',
    });
    arrange();

    await expect(completeCategory('choose one')).resolves.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('tests Codex with a fixed non-financial prompt through the same credential path', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionProvider: 'codex',
      codexModel: 'gpt-5.6-luna',
    });
    mocks.completeCodexText.mockResolvedValueOnce('ok');

    await expect(testCodexConnection()).resolves.toEqual({ ok: true });
    expect(mocks.completeCodexText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: 'Reply with only the word "ok".' }],
      }),
    );
  });
});
