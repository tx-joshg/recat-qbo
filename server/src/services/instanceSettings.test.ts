import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  suggestionModel: '',
  suggestionProvider: '',
  openrouterApiKey: '',
  openrouterReferer: '',
  openrouterTitle: '',
  appConfig: { findMany: vi.fn(), upsert: vi.fn() },
  user: { count: vi.fn() },
}));

vi.mock('../env.js', () => ({
  env: {
    get SUGGESTION_MODEL() {
      return mocks.suggestionModel;
    },
    get SUGGESTION_PROVIDER() {
      return mocks.suggestionProvider;
    },
    get OPENROUTER_API_KEY() {
      return mocks.openrouterApiKey;
    },
    get OPENROUTER_REFERER() {
      return mocks.openrouterReferer;
    },
    get OPENROUTER_TITLE() {
      return mocks.openrouterTitle;
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

vi.mock('../lib/prisma.js', () => ({ prisma: { appConfig: mocks.appConfig, user: mocks.user } }));

import { getInstanceSettings, getInstanceSettingsDto, updateInstanceSettings } from './instanceSettings.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.suggestionModel = '';
  mocks.suggestionProvider = '';
  mocks.openrouterApiKey = '';
  mocks.openrouterReferer = '';
  mocks.openrouterTitle = '';
  mocks.appConfig.findMany.mockResolvedValue([]);
  mocks.appConfig.upsert.mockResolvedValue({});
  mocks.user.count.mockResolvedValue(1);
});

describe('OpenRouter provider settings', () => {
  it('uses the OpenRouter environment overrides and normalizes an invalid provider to custom', async () => {
    mocks.suggestionProvider = 'not-a-provider';
    mocks.openrouterApiKey = 'environment-router-key';
    mocks.openrouterReferer = 'https://recat.example';
    mocks.openrouterTitle = 'Recat QBO';

    await expect(getInstanceSettings()).resolves.toMatchObject({
      suggestionProvider: 'custom',
      openrouterApiKey: 'environment-router-key',
      openrouterReferer: 'https://recat.example',
      openrouterTitle: 'Recat QBO',
    });
  });

  it('stores OpenRouter secrets encrypted, masks them in the DTO, and leaves custom keys untouched on provider switches', async () => {
    await updateInstanceSettings({
      aiApiKey: 'custom-secret',
      openrouterApiKey: 'openrouter-secret',
    });

    const keyWrites = mocks.appConfig.upsert.mock.calls.map(([args]) => args);
    expect(keyWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: { key: 'aiApiKey' }, create: expect.objectContaining({ encrypted: true }) }),
        expect.objectContaining({
          where: { key: 'openrouterApiKey' },
          create: expect.objectContaining({ encrypted: true, value: expect.not.stringContaining('openrouter-secret') }),
        }),
      ]),
    );

    mocks.appConfig.upsert.mockClear();
    await updateInstanceSettings({ suggestionProvider: 'openrouter' });
    expect(mocks.appConfig.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.appConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'suggestionProvider' } }));

    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'openrouterApiKey', value: 'plain-test-secret', encrypted: false },
    ]);
    await expect(getInstanceSettingsDto()).resolves.toMatchObject({ openrouterKeySet: true });
    const dto = await getInstanceSettingsDto();
    expect(dto).not.toHaveProperty('openrouterApiKey');
  });
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

describe('Codex provider settings', () => {
  it('accepts Codex as a provider and defaults its separate model exactly', async () => {
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionProvider', value: 'codex', encrypted: false },
      { key: 'suggestionModel', value: 'custom-model', encrypted: false },
    ]);

    await expect(getInstanceSettings()).resolves.toMatchObject({
      suggestionProvider: 'codex',
      suggestionModel: 'custom-model',
      codexModel: 'gpt-5.6-luna',
    });
  });

  it('stores Codex model plaintext and returns it in the masked settings DTO', async () => {
    await updateInstanceSettings({ codexModel: 'gpt-5.6-test' });

    expect(mocks.appConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'codexModel' },
        create: expect.objectContaining({ value: 'gpt-5.6-test', encrypted: false }),
      }),
    );

    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'codexModel', value: 'gpt-5.6-test', encrypted: false },
    ]);
    await expect(getInstanceSettingsDto()).resolves.toMatchObject({ codexModel: 'gpt-5.6-test' });
  });
});
