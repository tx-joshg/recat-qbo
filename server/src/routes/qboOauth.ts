// QuickBooks OAuth routes (mounted at the app root):
//   GET /auth/qbo/callback      — Intuit (or the fake consent page) redirects
//                                 here with code+state+realmId
//   GET /auth/qbo/mock-consent  — a clearly-labelled fake consent page for the
//                                 demo realms; always available (the demo is a
//                                 per-connection choice, not an env mode), but
//                                 only reachable with a valid state token from
//                                 a mode=demo connect flow.
// State tokens are held in-memory with a 10-minute TTL (single-process app)
// and carry the connect flow's user choices (mode + env) so the callback
// honors exactly what the user picked — never a boot-time default.

import { Router } from 'express';
import type { Company } from '@prisma/client';
import { env } from '../env.js';
import { encrypt, randomToken } from '../lib/crypto.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import {
  classifyIntuitOAuthBody,
  classifyQboFailure,
  qboFailureRedirect,
} from '../lib/qbo/diagnostics.js';
import {
  inspectAuthorizedConnection,
  isMockRealmId,
  qboFactory,
} from '../lib/qbo/factory.js';
import { MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR, resolveMockRealmId } from '../lib/qbo/mock.js';
import { requireInstanceAdmin, requireUser } from '../middleware/auth.js';
import { installDemoFinancials } from '../services/demoFinancials.js';

// ---------------------------------------------------------------------------
// OAuth state (CSRF) tokens — each carries the connect flow's choices.
// ---------------------------------------------------------------------------

export interface ConnectChoice {
  mode: 'real' | 'demo';
  /** sandbox/production for the REAL flow; null = fall back to the instance
   * default (AppConfig 'qboEnvDefault', then env.QBO_ENVIRONMENT). */
  env: 'sandbox' | 'production' | null;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, { expiresAt: number; choice: ConnectChoice }>();

function pruneStates(): void {
  const now = Date.now();
  for (const [state, entry] of states) {
    if (entry.expiresAt <= now) states.delete(state);
  }
}

/** Issue a state token for a new connect flow (used by /api/companies/connect-url). */
export function createOauthState(choice: ConnectChoice): string {
  pruneStates();
  const state = randomToken(16);
  states.set(state, { expiresAt: Date.now() + STATE_TTL_MS, choice });
  return state;
}

/** Single-use: returns the flow's choices (and forgets the state) when valid
 * and unexpired; null otherwise. */
export function consumeOauthState(state: string): ConnectChoice | null {
  pruneStates();
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state);
  return entry.choice;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "Harbor & Main Coffee Co." → "Harbor & Main Coffee"; "Bluebird Salon LLC" → "Bluebird Salon". */
export function defaultNickname(legalName: string): string {
  const suffix = /[,\s]+(co\.?|company|llc|l\.l\.c\.|inc\.?|incorporated|ltd\.?|corp\.?|corporation|plc|pllc|llp)$/i;
  let name = legalName.trim();
  while (suffix.test(name)) name = name.replace(suffix, '').trim();
  name = name.replace(/[,\s]+$/, '').trim();
  return name !== '' ? name : legalName.trim();
}

/** Instance default env for real connections when the flow didn't pick one:
 * AppConfig 'qboEnvDefault' (wizard Credentials step), then the env var. */
async function defaultQboEnv(): Promise<'sandbox' | 'production'> {
  const row = await prisma.appConfig.findUnique({ where: { key: 'qboEnvDefault' } });
  if (row && (row.value === 'sandbox' || row.value === 'production')) return row.value;
  return env.QBO_ENVIRONMENT;
}

function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const qboOauthRouter = Router();

qboOauthRouter.get(
  '/auth/qbo/callback',
  requireUser,
  requireInstanceAdmin,
  asyncHandler(async (req, res) => {
    const code = queryString(req.query.code);
    const state = queryString(req.query.state);
    const intuitError = queryString(req.query.error);
    const intuitErrorDescription = queryString(req.query.error_description);
    let realmId = queryString(req.query.realmId);

    const choice = state !== '' ? consumeOauthState(state) : null;
    if (!choice) {
      res.redirect(qboFailureRedirect(env.APP_URL, 'STATE_EXPIRED'));
      return;
    }
    if (intuitError !== '') {
      const publicCode = classifyIntuitOAuthBody(
        400,
        JSON.stringify({
          error: intuitError,
          error_description: intuitErrorDescription,
        }),
      );
      res.redirect(qboFailureRedirect(env.APP_URL, publicCode));
      return;
    }

    try {
      if (code === '') throw new HttpError(400, 'Missing authorization code', 'BAD_REQUEST');
      if (realmId === '' && choice.mode === 'demo') {
        const connected = await prisma.company.findMany({
          where: { disconnectedAt: null },
          select: { realmId: true },
        });
        realmId = resolveMockRealmId(code, connected.map((c) => c.realmId));
      }
      if (realmId === '') throw new HttpError(400, 'Missing realmId', 'BAD_REQUEST');
      // A real Intuit code can never belong to a mock realm; refuse the cross.
      if (choice.mode === 'real' && isMockRealmId(realmId)) {
        throw new HttpError(400, 'Demo realm on a real connect flow — restart the connect flow.', 'BAD_REQUEST');
      }

      const exchangedTokens = await qboFactory.exchangeCode(code, realmId, choice.mode);

      // Resolve reconnect state before validation, but do not publish the new
      // credentials yet. A failed CompanyInfo probe must leave an existing
      // healthy connection untouched and must not create a schedulable row.
      const existing = await prisma.company.findUnique({ where: { realmId } });
      const companyEnv =
        choice.mode === 'demo'
          ? 'sandbox'
          : existing?.env ?? choice.env ?? (await defaultQboEnv());
      const inspected = await inspectAuthorizedConnection({
        realmId,
        environment: companyEnv,
        mode: choice.mode,
        tokens: exchangedTokens,
      }).catch((err: unknown) => {
        console.error('[qbo-oauth] CompanyInfo validation failed:', err);
        res.redirect(
          qboFailureRedirect(env.APP_URL, classifyQboFailure(err, 'company_info')),
        );
        return null;
      });
      if (!inspected) return;
      const tokenData = {
        accessToken: encrypt(inspected.tokens.accessToken),
        refreshToken: encrypt(inspected.tokens.refreshToken),
        tokenExpiresAt: new Date(inspected.tokens.expiresAt),
      };

      // No Membership row is created for the connecting user: only instance
      // admins can reach this route, and instance admins are implicitly
      // 'admin' in every company — an explicit membership would be redundant.
      let company: Company;
      if (!existing && choice.mode === 'demo') {
        // Demo financial installation needs a company id. Keep this new row
        // explicitly disconnected and credential-free until all demo setup
        // succeeds so background jobs cannot schedule it prematurely.
        const pending = await prisma.company.create({
          data: {
            realmId,
            legalName: inspected.info.legalName,
            nickname: defaultNickname(inspected.info.legalName),
            env: 'sandbox',
            dryRun: true,
            disconnectedAt: new Date(),
          },
        });
        await installDemoFinancials(pending.id, realmId);
        company = await prisma.company.update({
          where: { id: pending.id },
          data: {
            ...tokenData,
            disconnectedAt: null,
            connectedAt: new Date(),
          },
        });
      } else if (existing) {
        // Existing demo setup is idempotent. Complete it before swapping any
        // credentials or connection state so a failed reconnect preserves the
        // current healthy connection.
        if (choice.mode === 'demo') {
          await installDemoFinancials(existing.id, realmId);
        }
        company = await prisma.company.update({
          where: { id: existing.id },
          data: {
            ...tokenData,
            disconnectedAt: null,
            legalName: inspected.info.legalName,
            ...(choice.mode === 'demo' && existing.disconnectedAt !== null
              ? { connectedAt: new Date() }
              : {}),
          },
        });
      } else {
        // New real connections become visible only after CompanyInfo succeeds.
        company = await prisma.company.create({
          data: {
            realmId,
            legalName: inspected.info.legalName,
            nickname: defaultNickname(inspected.info.legalName),
            env: companyEnv,
            dryRun: true,
            disconnectedAt: null,
            ...tokenData,
          },
        });
      }

      res.redirect(`${env.APP_URL}/setup?connected=${company.id}`);
    } catch (err) {
      console.error('[qbo-oauth] connect failed:', err);
      res.redirect(qboFailureRedirect(env.APP_URL, classifyQboFailure(err, 'oauth')));
    }
  }),
);

// A self-contained fake consent page for demo connections. This impersonates
// nothing real — it is clearly labelled as the Recat demo. Always mounted
// (demo is every deployment's evaluation path); reaching the callback still
// requires the single-use state token minted by a mode=demo connect flow.
qboOauthRouter.get(
  '/auth/qbo/mock-consent',
  requireUser,
  requireInstanceAdmin,
  asyncHandler(async (req, res) => {
    const state = queryString(req.query.state);
    const link = (code: string, realmId: string): string =>
      `/auth/qbo/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&realmId=${encodeURIComponent(realmId)}`;

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recat demo — fake Intuit consent</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #f6f5f1; color: #1f2421; display: flex; min-height: 100vh;
         align-items: center; justify-content: center; }
  .card { background: #fff; border: 1px solid #ddd8cc; border-radius: 12px;
          padding: 32px 36px; max-width: 420px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
  .badge { display: inline-block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
           background: #fdf3d7; color: #8a6d1f; border: 1px solid #e8d9a8;
           border-radius: 999px; padding: 3px 10px; margin-bottom: 14px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { font-size: 14px; color: #5c635c; margin: 0 0 20px; line-height: 1.5; }
  a.company { display: block; text-decoration: none; color: #1f2421; border: 1px solid #ccc7ba;
              border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; font-size: 15px; }
  a.company:hover { background: #f2f0e9; border-color: #9aa39a; }
  a.company small { display: block; color: #8a8f88; font-size: 12px; margin-top: 2px; }
</style>
</head>
<body>
  <div class="card">
    <span class="badge">Recat demo — fake Intuit consent</span>
    <h1>Choose a demo company to connect</h1>
    <p>This is a mock consent screen for Recat's built-in demo. No real Intuit
       account is involved; both companies are built-in sample data.</p>
    <a class="company" href="${link('mock-harbor', MOCK_REALM_HARBOR)}">Harbor &amp; Main Coffee Co.<small>Coffee shop · realm ${MOCK_REALM_HARBOR}</small></a>
    <a class="company" href="${link('mock-bluebird', MOCK_REALM_BLUEBIRD)}">Bluebird Salon LLC<small>Salon · realm ${MOCK_REALM_BLUEBIRD}</small></a>
  </div>
</body>
</html>`);
  }),
);
