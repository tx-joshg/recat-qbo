// Instance settings (admin) and first-run setup endpoints.
//   instanceRouter → /api/instance  (GET/PATCH /settings)
//   setupRouter    → /api/setup     (GET /status, POST /admin, POST /credentials)

import { Router } from 'express';
import { z } from 'zod';
import { appUrlEnvManaged, attachmentPolicyEnvManaged, localAdminConfig } from '../env.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { invalidateMailerCache, isSmtpConfigured, sendMail } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { getIntuitCredentialPreflight } from '../lib/qbo/factory.js';
import { requireInstanceAdmin, requireUser } from '../middleware/auth.js';
import { devLoginAllowed } from '../services/devLogin.js';
import {
  getInstanceSettings,
  getInstanceSettingsDto,
  updateInstanceSettings,
} from '../services/instanceSettings.js';
import { issueMagicLink } from '../services/magicLink.js';
import {
  ATTACHMENT_POLICY_BOUNDS,
  resolveAttachmentStoragePolicy,
} from '../services/attachments/policy.js';
import {
  ATTACHMENT_POLICY_CONFIG_KEYS,
  ATTACHMENT_STORAGE_INSTANCE_LOCK,
  getAttachmentInstanceStoragePolicyDto,
  getAttachmentStoragePolicyDefaults,
} from '../services/attachments/policyStore.js';
import { AttachmentError } from '../services/attachments/types.js';
import { invalidatePublicUrl } from '../services/publicUrl.js';

// ---------------------------------------------------------------------------
// /api/instance/settings
// ---------------------------------------------------------------------------

/**
 * Public address of this deployment. Rejects anything that cannot serve as an
 * OAuth redirect base: a path, query or fragment would silently corrupt the
 * callback URL, and plain http on a non-loopback host cannot be registered with
 * Intuit for a production app — accepting it would recreate the problem this
 * setting exists to solve.
 */
const appUrlValue = z.string().trim().min(1).max(2_048).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Enter a full URL, for example https://recat.example.com' });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'Use http:// or https://' });
    return;
  }
  if (url.search !== '' || url.hash !== '' || url.pathname.replace(/\/+$/, '') !== '') {
    ctx.addIssue({ code: 'custom', message: 'Use the origin only, with no path, query or fragment' });
    return;
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) {
    ctx.addIssue({
      code: 'custom',
      message: 'QuickBooks requires https for any address other than localhost',
    });
  }
});

const settingsPatchBody = z.object({
  appUrl: appUrlValue.optional(),
  intuitClientId: z.string().optional(),
  intuitClientSecret: z.string().optional(),
  webhookVerifierToken: z.string().optional(),
  suggestionSource: z.enum(['builtin', 'ai', 'off']).optional(),
  suggestionProvider: z.enum(['custom', 'openrouter']).optional(),
  suggestionModel: z.string().trim().min(1).optional(),
  // Empty clears the override so it follows the effective suggestion model.
  agentDecisionModel: z.string().trim().max(200).optional(),
  agentVerifierModel: z.string().trim().max(200).optional(),
  aiEndpoint: z.string().nullable().optional(),
  // The client contract (api.ts) sends `aiKey`; `aiApiKey` accepted too.
  aiKey: z.string().optional(),
  aiApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  openrouterReferer: z.string().optional(),
  openrouterTitle: z.string().optional(),
  smtpHost: z.string().trim().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().trim().optional(),
});

const storagePolicyPatchBody = z.object({
  companyQuotaBytes: z.string().regex(/^\d+$/).transform((value) => BigInt(value))
    .refine((value) => value >= ATTACHMENT_POLICY_BOUNDS.companyQuotaMinBytes
      && value <= ATTACHMENT_POLICY_BOUNDS.companyQuotaMaxBytes)
    .optional(),
  instanceQuotaBytes: z.string().regex(/^\d+$/).transform((value) => BigInt(value))
    .refine((value) => value >= ATTACHMENT_POLICY_BOUNDS.instanceQuotaMinBytes
      && value <= ATTACHMENT_POLICY_BOUNDS.instanceQuotaMaxBytes)
    .optional(),
  retentionDays: z.number().int()
    .min(ATTACHMENT_POLICY_BOUNDS.retentionMinDays)
    .max(ATTACHMENT_POLICY_BOUNDS.retentionMaxDays)
    .optional(),
});

export const instanceRouter = Router();
instanceRouter.use(requireUser, requireInstanceAdmin);

instanceRouter.post(
  '/qbo/preflight',
  asyncHandler(async (_req, res) => {
    res.json(await getIntuitCredentialPreflight());
  }),
);

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
    if (body.appUrl !== undefined && appUrlEnvManaged) {
      throw new HttpError(
        409,
        'The public URL is managed by the APP_URL environment variable.',
        'APP_URL_ENV_MANAGED',
      );
    }
    const aiApiKey = body.aiApiKey ?? body.aiKey;
    // Remember the address being replaced. originCheck keeps accepting it, so
    // an operator who saves a typo while browsing on the old address can still
    // send the request that corrects it.
    const previousAppUrl = body.appUrl === undefined
      ? undefined
      : (await getInstanceSettings()).appUrl;
    await updateInstanceSettings({
      ...(body.appUrl !== undefined ? { appUrl: body.appUrl.replace(/\/+$/, '') } : {}),
      ...(previousAppUrl !== undefined ? { previousAppUrl } : {}),
      ...(body.intuitClientId !== undefined ? { intuitClientId: body.intuitClientId } : {}),
      ...(body.intuitClientSecret !== undefined ? { intuitClientSecret: body.intuitClientSecret } : {}),
      ...(body.webhookVerifierToken !== undefined ? { webhookVerifierToken: body.webhookVerifierToken } : {}),
      ...(body.suggestionSource !== undefined ? { suggestionSource: body.suggestionSource } : {}),
      ...(body.suggestionProvider !== undefined ? { suggestionProvider: body.suggestionProvider } : {}),
      ...(body.suggestionModel !== undefined ? { suggestionModel: body.suggestionModel } : {}),
      ...(body.agentDecisionModel !== undefined ? { agentDecisionModel: body.agentDecisionModel } : {}),
      ...(body.agentVerifierModel !== undefined ? { agentVerifierModel: body.agentVerifierModel } : {}),
      ...(body.aiEndpoint !== undefined ? { aiEndpoint: body.aiEndpoint ?? '' } : {}),
      ...(aiApiKey !== undefined ? { aiApiKey } : {}),
      ...(body.openrouterApiKey !== undefined ? { openrouterApiKey: body.openrouterApiKey } : {}),
      ...(body.openrouterReferer !== undefined ? { openrouterReferer: body.openrouterReferer } : {}),
      ...(body.openrouterTitle !== undefined ? { openrouterTitle: body.openrouterTitle } : {}),
      ...(body.smtpHost !== undefined ? { smtpHost: body.smtpHost } : {}),
      ...(body.smtpPort !== undefined ? { smtpPort: body.smtpPort } : {}),
      ...(body.smtpUser !== undefined ? { smtpUser: body.smtpUser } : {}),
      ...(body.smtpPass !== undefined ? { smtpPass: body.smtpPass } : {}),
      ...(body.smtpFrom !== undefined ? { smtpFrom: body.smtpFrom } : {}),
    });
    // The mailer caches its transport briefly — new SMTP values apply at once.
    invalidateMailerCache();
    // Same for the public URL: origin checking and the OAuth redirect both
    // read it through a short cache.
    invalidatePublicUrl();
    res.json(await getInstanceSettingsDto());
  }),
);

instanceRouter.get(
  '/attachment-storage-policy',
  asyncHandler(async (_req, res) => {
    res.json(await getAttachmentInstanceStoragePolicyDto());
  }),
);

instanceRouter.patch(
  '/attachment-storage-policy',
  asyncHandler(async (req, res) => {
    const patch = validate(storagePolicyPatchBody)(req.body);
    if (
      (patch.companyQuotaBytes !== undefined && attachmentPolicyEnvManaged.companyQuotaBytes)
      || (patch.instanceQuotaBytes !== undefined && attachmentPolicyEnvManaged.instanceQuotaBytes)
      || (patch.retentionDays !== undefined && attachmentPolicyEnvManaged.retentionDays)
    ) {
      throw new HttpError(
        409,
        'This attachment storage setting is managed by the environment.',
        'ATTACHMENT_POLICY_ENV_MANAGED',
      );
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(${ATTACHMENT_STORAGE_INSTANCE_LOCK})::text`;
      const current = await getAttachmentStoragePolicyDefaults(transaction);
      const candidate = {
        companyQuotaBytes: patch.companyQuotaBytes ?? current.companyQuotaBytes,
        instanceQuotaBytes: patch.instanceQuotaBytes ?? current.instanceQuotaBytes,
        retentionDays: patch.retentionDays ?? current.retentionDays,
      };
      try {
        resolveAttachmentStoragePolicy({
          attachmentQuotaBytes: null,
          attachmentRetentionDays: null,
        }, candidate);
        const companyOverrides = await transaction.company.findMany({
          where: { attachmentQuotaBytes: { not: null } },
          select: { attachmentQuotaBytes: true, attachmentRetentionDays: true },
        });
        for (const company of companyOverrides) {
          resolveAttachmentStoragePolicy(company, candidate);
        }
      } catch (error) {
        if (error instanceof AttachmentError && error.code === 'ATTACHMENT_POLICY_INVALID') {
          throw new HttpError(400, error.message, error.code);
        }
        throw error;
      }
      for (const [field, value] of Object.entries(patch)) {
        const key = ATTACHMENT_POLICY_CONFIG_KEYS[
          field as keyof typeof ATTACHMENT_POLICY_CONFIG_KEYS
        ];
        await transaction.appConfig.upsert({
          where: { key },
          update: { value: value.toString(), encrypted: false },
          create: { key, value: value.toString(), encrypted: false },
        });
      }
    });
    res.json(await getAttachmentInstanceStoragePolicyDto());
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
  // Optional, and accepted here rather than only in Settings: this is the step
  // where an admin copies the callback to register with Intuit, and Settings is
  // not reachable until a company exists. Without it, a first-run install behind
  // a TLS front would register a redirect URI that can never work.
  appUrl: appUrlValue.optional(),
});

export const setupRouter = Router();

// Public: the login/setup screens route on this before any session exists.
setupRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const adminCount = await prisma.user.count({ where: { isInstanceAdmin: true } });
    const settings = await getInstanceSettings();
    const needsSetup = adminCount === 0;
    res.json({
      needsSetup,
      // Real Intuit credentials only — the demo needs none and is always
      // available (it's a per-connection choice in the wizard, not a mode).
      credentialsSet: settings.intuitClientId !== '',
      smtpConfigured: settings.smtpHost !== '',
      redirectUri: `${settings.appUrl}/auth/qbo/callback`,
      webhookUrl: `${settings.appUrl}/webhooks/qbo`,
      // Local sign-in authenticates an EXISTING instance admin at this exact
      // address — it never creates one. If the wizard creates a different
      // address, the password the deployment displays (Umbrel's ${APP_PASSWORD})
      // authenticates nobody, and with no SMTP there is no magic link either.
      // So the wizard defaults to it.
      //
      // Only while the instance is un-set-up, and only when local sign-in is
      // on. This route is public, and after setup the address is a real account
      // identifier worth not handing out; before setup there is no account yet.
      ...(needsSetup && localAdminConfig.enabled
        ? { localAdminEmail: localAdminConfig.email }
        : {}),
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
    const smtp = await isSmtpConfigured();
    const devLink = !smtp && (await devLoginAllowed()) ? link : undefined;
    res.json(devLink !== undefined ? { ok: true, delivered: smtp, devLink } : { ok: true, delivered: smtp });
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
    if (body.appUrl !== undefined && appUrlEnvManaged) {
      throw new HttpError(
        409,
        'The public URL is managed by the APP_URL environment variable.',
        'APP_URL_ENV_MANAGED',
      );
    }
    const previousAppUrl = body.appUrl === undefined
      ? undefined
      : (await getInstanceSettings()).appUrl;
    await updateInstanceSettings({
      intuitClientId: body.clientId,
      intuitClientSecret: body.clientSecret,
      ...(body.appUrl !== undefined ? { appUrl: body.appUrl.replace(/\/+$/, '') } : {}),
      ...(previousAppUrl !== undefined ? { previousAppUrl } : {}),
    });
    invalidatePublicUrl();
    await prisma.appConfig.upsert({
      where: { key: 'qboEnvDefault' },
      update: { value: body.env, encrypted: false },
      create: { key: 'qboEnvDefault', value: body.env, encrypted: false },
    });
    res.json({ ok: true });
  }),
);
