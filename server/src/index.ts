// Recat server entrypoint — wires middleware, routers, static client serving
// (production), the error middleware, and the background job scheduler.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { env, isProd } from './env.js';
import { errorMiddleware } from './lib/http.js';
import { originCheck } from './middleware/auth.js';
import { startJobs } from './jobs/scheduler.js';
import { compileTrustedProxy } from './services/trustedProxy.js';
import { authRouter } from './routes/auth.js';
import { localAuthRouter } from './routes/localAuth.js';
import { legalRouter } from './routes/legal.js';
import { auditRouter } from './routes/audit.js';
import { companiesRouter } from './routes/companies.js';
import { dashboardRouter, meRouter } from './routes/dashboard.js';
import { instanceRouter, setupRouter } from './routes/instance.js';
import { qboOauthRouter } from './routes/qboOauth.js';
import { reportsRouter } from './routes/reports.js';
import { rulesRouter } from './routes/rules.js';
import { tagsRouter } from './routes/tags.js';
import {
  companyTransactionsRouter,
  transactionActionsRouter,
  transferCandidatesRouter,
} from './routes/transactions.js';
import { usersRouter } from './routes/users.js';
import { webhooksRouter } from './routes/webhooks.js';

const app = express();
app.set('trust proxy', compileTrustedProxy(env.TRUSTED_PROXY_IPS));
app.disable('x-powered-by');

app.use(cookieParser());

// Webhooks need the raw body for HMAC verification — mounted before
// express.json (the router applies express.raw itself).
app.use('/webhooks/qbo', webhooksRouter);

app.use(express.json({ limit: '1mb' }));
app.use(originCheck);

// Root-mounted routers (absolute paths inside).
app.use(legalRouter); // /eula, /privacy — public pages for Intuit's app requirements
app.use(localAuthRouter); // /auth/methods, /auth/local
app.use(authRouter); // /auth/magic-link, /auth/callback, /auth/logout, /api/session
app.use(qboOauthRouter); // /auth/qbo/callback, /auth/qbo/mock-consent

// /api — company-scoped data routers first (specific paths), then the
// company resource router.
app.use('/api/users', usersRouter);
app.use('/api/companies/:companyId/transactions', companyTransactionsRouter);
app.use('/api/companies/:companyId/transfer-candidates', transferCandidatesRouter);
app.use('/api/companies/:companyId/tags', tagsRouter);
app.use('/api/companies/:companyId/rules', rulesRouter);
app.use('/api/companies/:companyId/reports', reportsRouter);
app.use('/api/companies/:companyId/dashboard', dashboardRouter);
app.use('/api/companies/:companyId/audit', auditRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/transactions', transactionActionsRouter);
app.use('/api/instance', instanceRouter);
app.use('/api/setup', setupRouter);
app.use('/api/me', meRouter);

// Unknown API/auth routes get a JSON 404 rather than the SPA fallback.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Production: serve the built client and fall back to index.html for SPA
// routes (never for /api, /auth, or /webhooks paths).
if (isProd) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(here, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/auth') ||
      req.path.startsWith('/webhooks')
    ) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(errorMiddleware);

// Demo and real companies coexist: demo vs real is a per-connection choice
// made in the UI, dispatched per company by realmId (lib/qbo/factory.ts).
// Users disconnect demo companies from Settings when they're done with them.

app.listen(env.PORT, () => {
  const dryRun = env.DRY_RUN ? ' · DRY RUN (no QBO writes)' : '';
  console.log(`[recat] listening on http://localhost:${env.PORT}${dryRun}`);
  console.log(`[recat] app URL: ${env.APP_URL}`);
  startJobs();
});
