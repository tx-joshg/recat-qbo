# Security

Recat QBO is self-hosted software that reads and writes real accounting
ledgers, so its access model is deliberately closed.

## Access model

- **Invitation-only.** There is no self-signup. After the instance is claimed,
  submitting an email at the login screen creates nothing — only people
  invited by a company admin (Settings → Team) can sign in, and the login
  endpoint never reveals whether an email has an account.
- **Per-company roles.** viewer / categorizer / admin scope what each person
  can see and do in each company. An **instance admin** manages the
  deployment itself (Intuit keys, email, companies, people) and can review
  everyone with access in Settings → People with access.
- **Claim window.** The *first* email to sign in on a fresh deployment becomes
  the instance admin. Sign in immediately after deploying, before sharing the
  URL.
- **Magic links** are single-use, expire in 15 minutes, and are stored hashed.
  The one-click sign-in convenience (demo instances) locks itself the moment a
  real QuickBooks company is connected; from then on links travel only through
  your configured email — so protect that mailbox like a password.
- **Sessions** are httpOnly, SameSite, secure-in-production cookies (30 days),
  revocable server-side. Removing a person revokes their sessions.
- **Data at rest:** QuickBooks OAuth tokens and configured secrets are
  encrypted (AES-256-GCM) with your `ENCRYPTION_KEY`. Every write to
  QuickBooks is recorded in an append-only audit log.
- **Production boots refuse default secrets** — a deployment cannot start with
  the well-known development `SESSION_SECRET`/`ENCRYPTION_KEY`.

## Operator responsibilities

- Serve the app over HTTPS (Railway and similar platforms do this for you).
- Keep `SESSION_SECRET` and `ENCRYPTION_KEY` secret and backed up — rotating
  `ENCRYPTION_KEY` invalidates stored tokens (reconnect companies after).
- Leave `ALLOW_DEV_LOGIN` unset in production; it bypasses the email loop.

## Reporting a vulnerability

Please open a GitHub security advisory ("Report a vulnerability" on the
repository's Security tab) rather than a public issue. Include reproduction
steps; we'll respond as quickly as we can.
