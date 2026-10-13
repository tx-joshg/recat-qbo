import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  consumeMagicLink: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

vi.mock('../services/magicLink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/magicLink.js')>();
  return { ...actual, consumeMagicLink: mocks.consumeMagicLink };
});

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>();
  return { ...actual, createSession: mocks.createSession };
});

vi.mock('../services/publicUrl.js', () => ({
  resolvePublicUrl: async () => 'http://recat.test',
}));

const { authRouter } = await import('./auth.js');

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeMagicLink.mockResolvedValue({ id: 'u1' });
  mocks.createSession.mockResolvedValue({ token: 'session-token', expiresAt: new Date() });
});

describe('magic-link callback', () => {
  it('does not consume the token or sign in on GET', async () => {
    const res = await request(testApp()).get('/auth/callback?token=abc').expect(200);

    expect(mocks.consumeMagicLink).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<form method="post" action="/auth/callback">');
    expect(res.text).toContain('name="token" value="abc"');
  });

  it('escapes the token it echoes into the page', async () => {
    const res = await request(testApp())
      .get(`/auth/callback?token=${encodeURIComponent('"><script>alert(1)</script>')}`)
      .expect(200);

    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('redirects a GET without a token to the invalid-link screen', async () => {
    const res = await request(testApp()).get('/auth/callback').expect(302);
    expect(res.headers.location).toBe('http://recat.test/?auth=invalid');
  });

  it('consumes the token and starts a session on the form POST', async () => {
    const res = await request(testApp())
      .post('/auth/callback')
      .type('form')
      .send({ token: 'abc' })
      .expect(302);

    expect(mocks.consumeMagicLink).toHaveBeenCalledWith('abc');
    expect(mocks.createSession).toHaveBeenCalledWith('u1');
    expect(res.headers.location).toBe('http://recat.test/');
    expect(String(res.headers['set-cookie'])).toContain('recat_session=session-token');
  });

  it('sends a spent or unknown token to the invalid-link screen', async () => {
    mocks.consumeMagicLink.mockResolvedValue(null);

    const res = await request(testApp())
      .post('/auth/callback')
      .type('form')
      .send({ token: 'used' })
      .expect(302);

    expect(res.headers.location).toBe('http://recat.test/?auth=invalid');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
