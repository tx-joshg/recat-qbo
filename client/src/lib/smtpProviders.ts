// One-click SMTP presets for common providers. Filling host/port/username is
// safe to automate; passwords and from-addresses are always the user's own.

export interface SmtpProvider {
  id: string;
  label: string;
  host: string;
  port: number;
  /** Fixed username (e.g. 'resend', 'apikey') or null = the user's own email address. */
  username: string | null;
  /** One-line hint shown after selection — what the password field wants + gotchas. */
  hint: string;
  /** Optional docs URL for the hint's trailing link. */
  docsUrl?: string;
}

export const SMTP_PROVIDERS: SmtpProvider[] = [
  {
    id: 'microsoft365',
    label: 'Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    username: null,
    hint: 'Password = an app password (Microsoft 365 admin must enable Authenticated SMTP for the mailbox; with MFA, create an app password). From must be the same mailbox.',
    docsUrl:
      'https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission',
  },
  {
    id: 'gmail',
    label: 'Google Workspace / Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    username: null,
    hint: "Password = an App Password (requires 2-Step Verification — regular passwords won't work). From must be the same address.",
    docsUrl: 'https://support.google.com/accounts/answer/185833',
  },
  {
    id: 'resend',
    label: 'Resend',
    host: 'smtp.resend.com',
    port: 587,
    username: 'resend',
    hint: "Password = your Resend API key (re_…). From must be on a domain you've verified in Resend.",
    docsUrl: 'https://resend.com/docs/send-with-smtp',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: 587,
    username: 'apikey',
    hint: 'Password = a SendGrid API key (SG.…). From must be a verified sender or authenticated domain.',
    docsUrl:
      'https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api',
  },
  {
    id: 'postmark',
    label: 'Postmark',
    host: 'smtp.postmarkapp.com',
    port: 587,
    username: null,
    hint: 'Username and password are both your Server API token. From must be a verified Sender Signature.',
    docsUrl: 'https://postmarkapp.com/developer/user-guide/send-email-with-smtp',
  },
];
