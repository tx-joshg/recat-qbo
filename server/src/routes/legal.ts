// Legal pages served by every deployment: /eula and /privacy.
//
// Intuit's developer portal requires an End User License Agreement URL and a
// Privacy Policy URL hosted on the app's own domain. Rather than making every
// deployer write and host these, the instance serves sensible defaults —
// scoped to what THIS software actually does — at stable URLs the setup
// wizard hands out ready to paste.
//
// These are TEMPLATES provided for convenience (each page says so): operators
// with specific legal requirements should adapt them.

import { Router } from 'express';
import { env } from '../env.js';

export const legalRouter = Router();

function origin(): string {
  try {
    return new URL(env.APP_URL).host;
  } catch {
    return env.APP_URL;
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Recat</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body { margin: 0; background: #f1efe8; color: #22211d; font-family: 'IBM Plex Sans', sans-serif; font-size: 15px; line-height: 1.65; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
  .logo { font-family: 'Spectral', serif; font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
  .logo .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2f5d50; margin-left: 3px; }
  h1 { font-family: 'Spectral', serif; font-size: 27px; font-weight: 500; margin: 28px 0 4px; }
  .sub { color: #9b968a; font-size: 13.5px; margin-bottom: 28px; }
  h2 { font-size: 16px; font-weight: 600; margin: 28px 0 8px; }
  p, li { color: #6d685c; }
  b, strong { color: #22211d; }
  .card { background: #ffffff; border: 1px solid #e9e5db; border-radius: 10px; padding: 28px 32px; box-shadow: 0 1px 6px rgba(60,55,45,.05); }
  .note { border: 1px solid #e8d9a8; background: #f6edd4; color: #8a6d1f; border-radius: 8px; padding: 12px 16px; font-size: 13.5px; margin-top: 28px; }
  a { color: #2f5d50; }
</style>
</head>
<body>
  <div class="wrap">
    <span class="logo">Recat<span class="dot"></span></span>
    ${body}
    <div class="note">This page is a template that ships with the open-source
    Recat QBO software so every self-hosted deployment has a working document
    at a stable URL. The operator of this deployment may replace or extend it
    to meet the requirements of their jurisdiction.</div>
  </div>
</body>
</html>`;
}

legalRouter.get('/eula', (_req, res) => {
  const host = origin();
  res.type('html').send(
    page(
      'End User License Agreement',
      `
<h1>End User License Agreement</h1>
<div class="sub">For the Recat QBO deployment at ${host}</div>
<div class="card">
<p>This deployment of Recat QBO (the “Service”) is operated by the person or
organization that installed it (the “Operator”). By signing in, you agree to
the following terms.</p>

<h2>1. What the Service is</h2>
<p>The Service lets authorized team members review and categorize QuickBooks
Online transactions for the companies the Operator has connected. It reads
and writes accounting data on the Operator's behalf via Intuit's QuickBooks
Online API.</p>

<h2>2. Authorized use</h2>
<p>Access is by invitation of the Operator. You agree to use the Service only
for the Operator's legitimate bookkeeping purposes, to keep your sign-in links
private, and not to attempt to access companies or data you have not been
granted a role for.</p>

<h2>3. Software license</h2>
<p>The underlying software is open source, licensed under the
<a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL-3.0</a>; its
source code is available at
<a href="https://github.com/tx-joshg/recat-qbo">github.com/tx-joshg/recat-qbo</a>.
This agreement covers your use of this deployment, not the software's source
code.</p>

<h2>4. Accounting responsibility</h2>
<p>The Service assists with categorization but does not provide accounting,
tax, or legal advice. Categorizations posted to QuickBooks are made by, and
remain the responsibility of, the people the Operator authorized. The audit
log records every write.</p>

<h2>5. No warranty; limitation of liability</h2>
<p>The Service is provided “as is”, without warranty of any kind, to the
maximum extent permitted by law. The Operator and the software's authors are
not liable for indirect or consequential damages arising from use of the
Service.</p>

<h2>6. Termination</h2>
<p>The Operator may suspend or remove access at any time. Sections 4–5
survive termination.</p>
</div>`,
    ),
  );
});

legalRouter.get('/privacy', (_req, res) => {
  const host = origin();
  res.type('html').send(
    page(
      'Privacy Policy',
      `
<h1>Privacy Policy</h1>
<div class="sub">For the Recat QBO deployment at ${host}</div>
<div class="card">
<p>This deployment of Recat QBO is <b>self-hosted</b>: all data described
below is stored on infrastructure chosen and controlled by the person or
organization operating it (the “Operator”). The software sends <b>no
telemetry or analytics</b> to its authors or any third party.</p>

<h2>What is stored</h2>
<ul>
  <li><b>Account data</b> — your email address, display name, and per-company
  role, so you can sign in and be authorized.</li>
  <li><b>QuickBooks data</b> — for each connected company: the chart of
  accounts, company information, and the transactions in the watched holding
  accounts (date, payee, memo, amount, account), synced so the team can
  categorize them.</li>
  <li><b>OAuth tokens</b> — the QuickBooks access and refresh tokens for
  connected companies, encrypted at rest (AES-256-GCM).</li>
  <li><b>Audit log</b> — an append-only record of every write to QuickBooks:
  who, what, when, and the exact change.</li>
</ul>

<h2>Who data is shared with</h2>
<ul>
  <li><b>Intuit</b> — the Service reads and writes QuickBooks data through
  Intuit's official API on the Operator's behalf, subject to
  <a href="https://www.intuit.com/privacy/statement/">Intuit's privacy
  statement</a>.</li>
  <li><b>The Operator's email provider</b> — sign-in links and optional digest
  emails are sent through the SMTP service the Operator configured.</li>
  <li><b>Optional AI endpoint</b> — only if the Operator enables AI category
  suggestions: the payee, memo, amount, and the company's category list (never
  full books) are sent to the endpoint the Operator chose.</li>
  <li>No one else. There is no advertising, tracking, or resale of data.</li>
</ul>

<h2>Cookies</h2>
<p>One cookie: an httpOnly session cookie that keeps you signed in for up to
30 days. No tracking cookies.</p>

<h2>Retention &amp; deletion</h2>
<p>Data remains until the Operator deletes it. Disconnecting a company stops
syncing and revokes its tokens while retaining local history and the audit
log. To exercise access or deletion rights, contact the Operator of this
deployment.</p>
</div>`,
    ),
  );
});
