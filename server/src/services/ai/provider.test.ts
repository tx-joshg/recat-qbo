import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInstanceSettings: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../instanceSettings.js', () => ({ getInstanceSettings: mocks.getInstanceSettings }));

import { completeCategory } from './provider.js';

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
  });
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '  Office supplies  ' } }] }),
  });
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
});

describe('category completion deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['custom', 'headers'],
    ['custom', 'body'],
    ['openrouter', 'headers'],
    ['openrouter', 'body'],
  ])('bounds a stalled %s response at %s', async (provider, stage) => {
    const settings = await mocks.getInstanceSettings();
    mocks.getInstanceSettings.mockResolvedValue({ ...settings, suggestionProvider: provider });
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => {
      const stalled = () => new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return stage === 'headers' ? stalled() : Promise.resolve({ ok: true, json: stalled });
    });
    let result: string | null | undefined;
    const completion = completeCategory('choose one').then((value) => { result = value; });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    await completion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'http error', 'body error'])('cleans up the deadline after %s', async (outcome) => {
    let signal: AbortSignal | null | undefined;
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal;
      return {
        ok: outcome !== 'http error',
        json: async () => {
          if (outcome === 'body error') throw new Error('invalid JSON');
          return { choices: [{ message: { content: 'Office supplies' } }] };
        },
      };
    });

    expect(await completeCategory('choose one')).toBe(outcome === 'success' ? 'Office supplies' : null);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).not.toBe(true);
  });
});
