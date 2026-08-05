import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  suggestionModel: '',
  suggestionProvider: '',
  openrouterApiKey: '',
  openrouterReferer: '',
  openrouterTitle: '',
  appConfig: { findMany: vi.fn(), upsert: vi.fn() },
  agentCompanyConfig: { updateMany: vi.fn() },
  transaction: vi.fn(),
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
    APP_URL: 'http://localhost:5173',
  },
  appUrlEnvManaged: false,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    appConfig: mocks.appConfig,
    agentCompanyConfig: mocks.agentCompanyConfig,
    user: mocks.user,
    $transaction: mocks.transaction,
  },
}));
vi.mock('../middleware/auth.js', () => {
  const allow: RequestHandler = (_req, _res, next) => next();
  return { requireUser: allow, requireInstanceAdmin: allow };
});
vi.mock('../lib/mailer.js', () => ({
  invalidateMailerCache: vi.fn(),
  isSmtpConfigured: vi.fn(async () => false),
  sendMail: vi.fn(),
}));
vi.mock('../lib/qbo/factory.js', () => ({ getIntuitCredentialPreflight: vi.fn() }));
vi.mock('./devLogin.js', () => ({ devLoginAllowed: vi.fn(async () => false) }));
vi.mock('./magicLink.js', () => ({ issueMagicLink: vi.fn() }));

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
  mocks.agentCompanyConfig.updateMany.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(async (callback) => callback({
    appConfig: mocks.appConfig,
    agentCompanyConfig: mocks.agentCompanyConfig,
  }));
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

describe('agent model settings', () => {
  it.each([
    ['agentDecisionModel', 'decision-model-v2'],
    ['agentVerifierModel', 'verifier-model-v2'],
    ['aiEndpoint', 'https://models.example/v2'],
    ['aiApiKey', 'custom-key-v2'],
    ['openrouterApiKey', 'router-key-v2'],
  ] as const)('atomically pauses every requested live company when %s changes', async (key, value) => {
    await updateInstanceSettings({ [key]: value });

    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(mocks.agentCompanyConfig.updateMany).toHaveBeenCalledWith({
      where: { liveRequested: true },
      data: expect.objectContaining({
        liveAcceptedPolicyVersion: null,
        liveAcceptedConfigVersion: null,
        liveAcceptedProviderBinding: null,
        livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
      }),
    });
  });

  it('defaults both agent models dynamically to the effective environment suggestion model', async () => {
    mocks.suggestionModel = 'environment-suggestion-model';
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionModel', value: 'stored-suggestion-model', encrypted: false },
    ]);

    await expect(getInstanceSettings()).resolves.toMatchObject({
      suggestionModel: 'environment-suggestion-model',
      agentDecisionModel: 'environment-suggestion-model',
      agentVerifierModel: 'environment-suggestion-model',
    });
  });

  it('lets each explicitly stored agent model win independently', async () => {
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionModel', value: 'stored-suggestion-model', encrypted: false },
      { key: 'agentDecisionModel', value: 'stored-decision-model', encrypted: false },
    ]);

    await expect(getInstanceSettings()).resolves.toMatchObject({
      suggestionModel: 'stored-suggestion-model',
      agentDecisionModel: 'stored-decision-model',
      agentVerifierModel: 'stored-suggestion-model',
    });

    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionModel', value: 'stored-suggestion-model', encrypted: false },
      { key: 'agentVerifierModel', value: 'stored-verifier-model', encrypted: false },
    ]);
    await expect(getInstanceSettings()).resolves.toMatchObject({
      suggestionModel: 'stored-suggestion-model',
      agentDecisionModel: 'stored-suggestion-model',
      agentVerifierModel: 'stored-verifier-model',
    });
  });

  it('treats blank stored agent model names as unset', async () => {
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'suggestionModel', value: 'stored-suggestion-model', encrypted: false },
      { key: 'agentDecisionModel', value: '', encrypted: false },
      { key: 'agentVerifierModel', value: '', encrypted: false },
    ]);

    await expect(getInstanceSettings()).resolves.toMatchObject({
      agentDecisionModel: 'stored-suggestion-model',
      agentVerifierModel: 'stored-suggestion-model',
    });
  });

  it('persists both model names independently as non-secret values', async () => {
    await updateInstanceSettings({
      agentDecisionModel: 'decision-model',
      agentVerifierModel: 'verifier-model',
    });

    expect(mocks.appConfig.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.appConfig.upsert).toHaveBeenCalledWith({
      where: { key: 'agentDecisionModel' },
      update: { value: 'decision-model', encrypted: false },
      create: { key: 'agentDecisionModel', value: 'decision-model', encrypted: false },
    });
    expect(mocks.appConfig.upsert).toHaveBeenCalledWith({
      where: { key: 'agentVerifierModel' },
      update: { value: 'verifier-model', encrypted: false },
      create: { key: 'agentVerifierModel', value: 'verifier-model', encrypted: false },
    });
  });

  it('includes both non-secret effective names in the admin DTO', async () => {
    mocks.appConfig.findMany.mockResolvedValue([
      { key: 'agentDecisionModel', value: 'decision-model', encrypted: false },
      { key: 'agentVerifierModel', value: 'verifier-model', encrypted: false },
    ]);

    const dto = await getInstanceSettingsDto();

    expect(dto).toMatchObject({
      agentDecisionModel: 'decision-model',
      agentVerifierModel: 'verifier-model',
    });
  });

  it('passes both model overrides through the admin PATCH API and allows independent clearing', async () => {
    const { instanceRouter } = await import('../routes/instance.js');
    const app = express();
    app.use(express.json());
    app.use('/api/instance', instanceRouter);

    const response = await request(app)
      .patch('/api/instance/settings')
      .send({
        agentDecisionModel: ' decision-model ',
        agentVerifierModel: '',
      });

    expect(response.status).toBe(200);
    expect(mocks.appConfig.upsert).toHaveBeenCalledWith({
      where: { key: 'agentDecisionModel' },
      update: { value: 'decision-model', encrypted: false },
      create: { key: 'agentDecisionModel', value: 'decision-model', encrypted: false },
    });
    expect(mocks.appConfig.upsert).toHaveBeenCalledWith({
      where: { key: 'agentVerifierModel' },
      update: { value: '', encrypted: false },
      create: { key: 'agentVerifierModel', value: '', encrypted: false },
    });
  });
});
