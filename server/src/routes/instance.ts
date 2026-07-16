// Instance settings (admin) and first-run setup endpoints.
//   instanceRouter → /api/instance  (GET/PATCH /settings)
//   setupRouter    → /api/setup     (GET /status, POST /admin, POST /credentials)

import { Router } from 'express';
import { z } from 'zod';
import { devLoginAllowed, env } from '../env.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { invalidateMailerCache, isSmtpConfigured, sendMail } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { requireInstanceAdmin, requireUser } from '../middleware/auth.js';
import {
  getInstanceSettings,
  getInstanceSettingsDto,
  updateInstanceSettings,
} from '../services/instanceSettings.js';
import { issueMagicLink } from '../services/magicLink.js';

// ---------------------------------------------------------------------------
// /api/instance/settings
// ---------------------------------------------------------------------------

const settingsPatchBody = z.object({
  intuitClientId: z.string().optional(),
  intuitClientSecret: z.string().optional(),
  webhookVerifierToken: z.string().optional(),
  suggestionSource: z.enum(['builtin', 'ai', 'off']).optional(),
  aiEndpoint: z.string().nullable().optional(),
  // The client contract (api.ts) sends `aiKey`; `aiApiKey` accepted too.
  aiKey: z.string().optional(),
  aiApiKey: z.string().optional(),
  smtpHost: z.string().trim().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().trim().optional(),
});

export const instanceRouter = Router();
instanceRouter.use(requireUser, requireInstanceAdmin);

instanceRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(await getInstanceSettingsDto());
  }),
);

instanceRouter.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const body = validate(settingsPatchBody)(req.body);
    const aiApiKey = body.aiApiKey ?? body.aiKey;
    await updateInstanceSettings({
      ...(body.intuitClientId !== undefined ? { intuitClientId: body.intuitClientId } : {}),
      ...(body.intuitClientSecret !== undefined ? { intuitClientSecret: body.intuitClientSecret } : {}),
      ...(body.webhookVerifierToken !== undefined ? { webhookVerifierToken: body.webhookVerifierToken } : {}),
      ...(body.suggestionSource !== undefined ? { suggestionSource: body.suggestionSource } : {}),
      ...(body.aiEndpoint !== undefined ? { aiEndpoint: body.aiEndpoint ?? '' } : {}),
      ...(aiApiKey !== undefined ? { aiApiKey } : {}),
      ...(body.smtpHost !== undefined ? { smtpHost: body.smtpHost } : {}),
      ...(body.smtpPort !== undefined ? { smtpPort: body.smtpPort } : {}),
      ...(body.smtpUser !== undefined ? { smtpUser: body.smtpUser } : {}),
      ...(body.smtpPass !== undefined ? { smtpPass: body.smtpPass } : {}),
      ...(body.smtpFrom !== undefined ? { smtpFrom: body.smtpFrom } : {}),
    });
    // The mailer caches its transport briefly — new SMTP values apply at once.
    invalidateMailerCache();
    res.json(await getInstanceSettingsDto());
  }),
);

// Send a test email through the current SMTP config (env or DB). Without SMTP
// the mailer prints to the server log — that's reported as delivered:false so
// the UI can say so instead of pretending a real email went out.
const testEmailBody = z.object({ to: z.string().trim().toLowerCase().email().optional() });

instanceRouter.post(
  '/settings/test-email',
  asyncHandler(async (req, res) => {
    const { to } = validate(testEmailBody)(req.body ?? {});
    const recipient = to ?? req.user?.email;
    if (recipient === undefined) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const delivered = await isSmtpConfigured();
    try {
      await sendMail({
        to: recipient,
        subject: 'Recat test email',
        text: 'This is a test email from your Recat instance. If you can read this, SMTP is working.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `SMTP send failed: ${message}`, 'SMTP_ERROR');
    }
    res.json({ ok: true, delivered, to: recipient });
  }),
);

// ---------------------------------------------------------------------------
// /api/setup — the first-run wizard (pre-auth where it must be)
// ---------------------------------------------------------------------------

const adminBody = z.object({ email: z.string().trim().toLowerCase().email() });

const credentialsBody = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  env: z.enum(['sandbox', 'production']),
});

export const setupRouter = Router();

// Public: the login/setup screens route on this before any session exists.
setupRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const adminCount = await prisma.user.count({ where: { isInstanceAdmin: true } });
    const settings = await getInstanceSettings();
    res.json({
      needsSetup: adminCount === 0,
      credentialsSet: env.QBO_MOCK || settings.intuitClientId !== '',
      smtpConfigured: settings.smtpHost !== '',
      mock: env.QBO_MOCK,
    });
  }),
);

// Wizard step 1: create the first instance admin (only while none exists)
// and send the magic link that verifies the address.
setupRouter.post(
  '/admin',
  asyncHandler(async (req, res) => {
    const { email } = validate(adminBody)(req.body);
    const adminCount = await prisma.user.count({ where: { isInstanceAdmin: true } });
    if (adminCount > 0) {
      throw new HttpError(409, 'Setup is already complete — an admin account exists.', 'ALREADY_SETUP');
    }
    const user = await prisma.user.upsert({
      where: { email },
      create: { email, isInstanceAdmin: true, invitePending: false },
      update: { isInstanceAdmin: true, invitePending: false },
    });
    const { link } = await issueMagicLink(user);
    const devLink = devLoginAllowed && !(await isSmtpConfigured()) ? link : undefined;
    res.json(devLink !== undefined ? { ok: true, devLink } : { ok: true });
  }),
);

// Wizard step 2: Intuit app credentials (stored encrypted; env vars win).
// The env choice applies to the NEXT connection: it is stored as AppConfig
// 'qboEnvDefault' and read by the OAuth callback when it creates the Company
// row. NOTE: env var QBO_ENVIRONMENT remains the fallback default when this
// key is unset; the stored value wins when present (see routes/qboOauth.ts).
setupRouter.post(
  '/credentials',
  requireUser,
  requireInstanceAdmin,
  asyncHandler(async (req, res) => {
    const body = validate(credentialsBody)(req.body);
    await updateInstanceSettings({
      intuitClientId: body.clientId,
      intuitClientSecret: body.clientSecret,
    });
    await prisma.appConfig.upsert({
      where: { key: 'qboEnvDefault' },
      update: { value: body.env, encrypted: false },
      create: { key: 'qboEnvDefault', value: body.env, encrypted: false },
    });
    res.json({ ok: true });
  }),
);
