import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  suggestionModel: '',
  appConfig: { findMany: vi.fn() },
}));

vi.mock('../env.js', () => ({
  env: {
    get SUGGESTION_MODEL() {
      return mocks.suggestionModel;
    },
    QBO_CLIENT_ID: '',
    QBO_CLIENT_SECRET: '',
    QBO_WEBHOOK_VERIFIER_TOKEN: '',
    SMTP_HOST: '',
    SMTP_PORT: 587,
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: 'Recat <noreply@example.com>',
    ENCRYPTION_KEY: '0'.repeat(64),
  },
  redirectUri: 'http://localhost:5173/auth/qbo/callback',
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { appConfig: mocks.appConfig } }));

import { getInstanceSettings } from './instanceSettings.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.suggestionModel = '';
  mocks.appConfig.findMany.mockResolvedValue([]);
});

describe('suggestion model setting precedence', () => {
  it('uses the stored model when SUGGESTION_MODEL is unset', async () => {
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionModel', value: 'stored-model', encrypted: false },
    ]);

    await expect(getInstanceSettings()).resolves.toMatchObject({ suggestionModel: 'stored-model' });
  });

  it('uses a non-empty SUGGESTION_MODEL over the stored model', async () => {
    mocks.suggestionModel = 'environment-model';
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionModel', value: 'stored-model', encrypted: false },
    ]);

    await expect(getInstanceSettings()).resolves.toMatchObject({ suggestionModel: 'environment-model' });
  });

  it('defaults to gpt-4o-mini when neither environment nor storage supplies a model', async () => {
    await expect(getInstanceSettings()).resolves.toMatchObject({ suggestionModel: 'gpt-4o-mini' });
  });
});
