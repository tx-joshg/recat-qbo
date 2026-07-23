import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codex } from './api.js';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ status: 'pending', retryAfterMs: 5000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

describe('Codex admin API', () => {
  it('uses the exact device/status/disconnect/test routes and sends no raw secrets', async () => {
    await codex.start();
    await codex.poll(FLOW_ID);
    await codex.cancel(FLOW_ID);
    await codex.status();
    await codex.disconnect();
    await codex.test();

    const calls = vi.mocked(fetch).mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: init?.body,
    }));
    expect(calls).toEqual([
      { url: '/api/instance/ai/codex/device', method: 'POST', body: undefined },
      {
        url: '/api/instance/ai/codex/device/poll',
        method: 'POST',
        body: JSON.stringify({ flowId: FLOW_ID }),
      },
      {
        url: '/api/instance/ai/codex/device',
        method: 'DELETE',
        body: JSON.stringify({ flowId: FLOW_ID }),
      },
      { url: '/api/instance/ai/codex/status', method: 'GET', body: undefined },
      { url: '/api/instance/ai/codex', method: 'DELETE', body: undefined },
      { url: '/api/instance/ai/codex/test', method: 'POST', body: undefined },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/accessToken|refreshToken|device_auth|code_verifier/i);
  });
});
