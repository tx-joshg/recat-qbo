import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  userCount: vi.fn(),
  getInstanceSettings: vi.fn(),
  localAdminConfig: { enabled: false, email: '', password: '' },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { user: { count: mocks.userCount } },
}));

// Only localAdminConfig is swapped; the rest of env is real, because
// instance.ts transitively pulls in the QBO factory, which reads it.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return {
    ...actual,
    get localAdminConfig() {
      return mocks.localAdminConfig;
    },
  };
});

vi.mock('../services/instanceSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/instanceSettings.js')>();
  return { ...actual, getInstanceSettings: mocks.getInstanceSettings };
});

const { setupRouter } = await import('./instance.js');

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRouter);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localAdminConfig = { enabled: false, email: '', password: '' };
  mocks.getInstanceSettings.mockResolvedValue({
    intuitClientId: '',
    smtpHost: '',
    appUrl: 'http://umbrel.local:3009',
  });
});

// The wizard must create the address local sign-in authenticates, or the
// password the deployment displays belongs to no account — and an Umbrel
// install has no SMTP to deliver a magic link instead.
describe('GET /api/setup/status — localAdminEmail', () => {
  it('offers the address while the instance is un-set-up and local sign-in is on', async () => {
    mocks.userCount.mockResolvedValue(0);
    mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: 'x'.repeat(12) };

    const res = await request(testApp()).get('/api/setup/status').expect(200);

    expect(res.body.needsSetup).toBe(true);
    expect(res.body.localAdminEmail).toBe('admin@recat.local');
  });

  it('withholds it once an instance admin exists', async () => {
    mocks.userCount.mockResolvedValue(1);
    mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: 'x'.repeat(12) };

    const res = await request(testApp()).get('/api/setup/status').expect(200);

    expect(res.body.needsSetup).toBe(false);
    // This route is public. After setup the address identifies a real account,
    // and the wizard no longer needs it.
    expect(res.body).not.toHaveProperty('localAdminEmail');
  });

  it('omits it when local sign-in is off, even before setup', async () => {
    mocks.userCount.mockResolvedValue(0);

    const res = await request(testApp()).get('/api/setup/status').expect(200);

    expect(res.body.needsSetup).toBe(true);
    expect(res.body).not.toHaveProperty('localAdminEmail');
  });
});
