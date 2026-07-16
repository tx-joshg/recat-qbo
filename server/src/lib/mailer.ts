// Thin nodemailer wrapper. SMTP config is the merged instance settings (env
// vars win over DB values — see services/instanceSettings.ts), read lazily per
// send with a short cache so in-app changes take effect without a restart.
// When SMTP is not configured (the common local-dev case) every message is
// logged to the console instead — magic links must always be discoverable,
// even without an email provider.

import nodemailer, { type Transporter } from 'nodemailer';
import { getInstanceSettings } from '../services/instanceSettings.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface CachedMailer {
  /** null → SMTP not configured; fall back to console logging. */
  transporter: Transporter | null;
  from: string;
  at: number;
}

const CACHE_TTL_MS = 60_000;

let cached: CachedMailer | null = null;

/** Drop the cached transport so the next send re-reads instance settings. */
export function invalidateMailerCache(): void {
  cached = null;
}

async function getMailer(): Promise<CachedMailer> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const s = await getInstanceSettings();
  const transporter: Transporter | null =
    s.smtpHost !== ''
      ? nodemailer.createTransport({
          host: s.smtpHost,
          port: s.smtpPort,
          secure: s.smtpPort === 465,
          auth: s.smtpUser !== '' ? { user: s.smtpUser, pass: s.smtpPass } : undefined,
        })
      : null;
  cached = { transporter, from: s.smtpFrom, at: Date.now() };
  return cached;
}

/** Whether an SMTP host is present from either source (env var or DB). */
export async function isSmtpConfigured(): Promise<boolean> {
  const mailer = await getMailer();
  return mailer.transporter !== null;
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const mailer = await getMailer();
  if (mailer.transporter === null) {
    const body = msg.text
      .split('\n')
      .map((line) => `[mailer:dev]   ${line}`)
      .join('\n');
    console.log(
      [
        '[mailer:dev] SMTP not configured — printing email instead of sending.',
        `[mailer:dev] To:      ${msg.to}`,
        `[mailer:dev] Subject: ${msg.subject}`,
        body,
      ].join('\n'),
    );
    return;
  }
  await mailer.transporter.sendMail({
    from: mailer.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
