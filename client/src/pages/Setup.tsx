// First-run setup wizard — 6 steps (Admin → Credentials → Email → Connect →
// Accounts → Sync) plus the first-sync spinner. All styles are ported verbatim
// from design_handoff_recat/Recat.dc.html lines 68–177; step/nav/env/connect
// logic mirrors the prototype's renderVals() wizard section (lines 1374–1408).
//
// Flow notes:
//  - Progress persists in sessionStorage so the wizard survives the two
//    full-page departures (magic-link sign-in, Intuit OAuth consent).
//  - GET /auth/qbo/callback returns to /setup?connected=<companyId>.
//  - /connect (connect another company) re-enters at step 4 via /setup?step=4.

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { QboEnv, SyncMode } from '@recat/shared';
import {
  api,
  ApiError,
  auth,
  companies as companiesApi,
  instanceSettings,
  setup,
  transactions,
} from '../lib/api';
import type { InstanceSettingsPatchBody } from '../lib/api';
import type { SetupStatus } from '../lib/api';
import { useApp } from '../state/AppContext';
import { Spinner } from '../components/ui';

const STEP_NAMES = ['Admin', 'Credentials', 'Email', 'Connect', 'Accounts', 'Sync'] as const;
// v2: the Email step shifted Connect/Accounts/Sync from 3/4/5 to 4/5/6 — the
// key bump keeps stale v1 step numbers from resuming on the wrong step.
const PROGRESS_KEY = 'recat.setupWizard.v2';

// ---------------------------------------------------------------------------
// Server shapes not yet pinned down in lib/api.ts (typed locally; see the
// TODO(server) notes in lib/api.ts — routes are being built to match).
// ---------------------------------------------------------------------------

/** POST /api/setup/admin — mirrors /auth/magic-link's dev-mode devLink. */
interface AdminResponse {
  ok: boolean;
  /** false when this instance has no SMTP configured — no email was sent. */
  delivered?: boolean;
  devLink?: string;
}

/** GET /api/setup/status with the optional fields the wizard can use. */
interface SetupStatusX extends SetupStatus {
  /** true when the server runs against the in-memory mock QuickBooks (QBO_MOCK). */
  mock?: boolean;
  /** `${APP_URL}/auth/qbo/callback` — falls back to window.location.origin. */
  redirectUri?: string;
}

/** GET /api/companies/:id/holding-account-options — accounts + txn counts. */
interface HoldingAccountOption {
  id: string;
  name: string;
  /** null when the server can't provide counts (fallback path). */
  txnCount: number | null;
}

interface WizardProgress {
  step: number;
  env: QboEnv;
  syncMode: SyncMode;
  adminEmail: string;
  adminSent: boolean;
  companyId: string | null;
}

const DEFAULT_PROGRESS: WizardProgress = {
  step: 1,
  env: 'sandbox',
  syncMode: 'polling',
  adminEmail: '',
  adminSent: false,
  companyId: null,
};

function readSavedProgress(): WizardProgress | null {
  try {
    const raw = sessionStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<WizardProgress>;
    return {
      step: typeof p.step === 'number' && p.step >= 1 && p.step <= 6 ? p.step : 1,
      env: p.env === 'production' ? 'production' : 'sandbox',
      syncMode: p.syncMode === 'webhook' ? 'webhook' : 'polling',
      adminEmail: typeof p.adminEmail === 'string' ? p.adminEmail : '',
      adminSent: p.adminSent === true,
      companyId: typeof p.companyId === 'string' ? p.companyId : null,
    };
  } catch {
    return null;
  }
}

/** Saved progress, overridden by ?connected=<companyId> / ?error / ?step=<n>. */
function initialProgress(): WizardProgress {
  const params = new URLSearchParams(window.location.search);
  const base = readSavedProgress() ?? DEFAULT_PROGRESS;
  const connected = params.get('connected');
  if (connected) return { ...base, step: 4, companyId: connected, adminSent: false };
  // OAuth callback failure — stay on the Connect step so the user can retry.
  if (params.get('error') === 'connect_failed') return { ...base, step: 4, adminSent: false };
  const stepParam = Number(params.get('step'));
  if (Number.isInteger(stepParam) && stepParam >= 1 && stepParam <= 6) {
    // Explicit step re-entry (e.g. /connect → step 4) starts a fresh connection.
    return { ...base, step: stepParam, adminSent: false, companyId: stepParam <= 4 ? null : base.companyId };
  }
  return base;
}

async function fetchHoldingOptions(companyId: string): Promise<HoldingAccountOption[]> {
  try {
    const raw = await api.get<{ qboId: string; name: string; count: number }[]>(
      `/api/companies/${companyId}/holding-account-options`,
    );
    return raw.map((o) => ({ id: o.qboId, name: o.name, txnCount: o.count }));
  } catch (err) {
    // Fallback: plain chart of accounts (no txn counts) via the pinned contract.
    if (err instanceof ApiError && err.status === 404) {
      const accts = await companiesApi.accounts(companyId);
      return accts.map((a) => ({ id: a.id, name: a.name, txnCount: null }));
    }
    throw err;
  }
}

function countLabel(n: number | null): string {
  if (n === null) return '';
  if (n === 0) return 'empty';
  if (n === 1) return '1 transaction';
  return `${n} transactions`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Shared verbatim style fragments (prototype lines 88–101).
const stepTitle = { fontFamily: "'Spectral',serif", fontSize: 22, fontWeight: 500 } as const;
const stepCopy = {
  fontSize: 14,
  color: 'var(--mut)',
  margin: '6px 0 22px',
  lineHeight: 1.55,
} as const;
const fieldLabel = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--mut)',
  marginBottom: 6,
} as const;

export default function Setup() {
  const {
    session,
    sessionLoading,
    setSession,
    companies,
    refreshCompanies,
    setActiveCompany,
    toast,
  } = useApp();
  const navigate = useNavigate();

  const [initial] = useState(initialProgress);
  // Captured before the query-consuming effect below strips the search string.
  const [connectFailed, setConnectFailed] = useState(
    () => new URLSearchParams(window.location.search).get('error') === 'connect_failed',
  );
  const [step, setStep] = useState(initial.step);
  const [env, setEnv] = useState<QboEnv>(initial.env);
  const [syncMode, setSyncMode] = useState<SyncMode>(initial.syncMode);
  const [adminEmail, setAdminEmail] = useState(initial.adminEmail);
  const [adminSent, setAdminSent] = useState(initial.adminSent);
  const [companyId, setCompanyId] = useState<string | null>(initial.companyId);

  const [status, setStatus] = useState<SetupStatusX | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [linkDelivered, setLinkDelivered] = useState(true);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  // true → SMTP comes from env vars (from GET /api/instance/settings, admin-only).
  const [smtpEnvManaged, setSmtpEnvManaged] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [options, setOptions] = useState<HoldingAccountOption[] | null>(null);
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const connectedCompany = companyId ? companies.find((c) => c.id === companyId) ?? null : null;

  // Consume the query string once (its values are already in initial state).
  useEffect(() => {
    if (window.location.search) navigate('/setup', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface the OAuth-callback failure once, on arrival.
  useEffect(() => {
    if (connectFailed) toast('QuickBooks connection failed — try again.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist progress so magic-link / OAuth departures resume where they left off.
  useEffect(() => {
    const p: WizardProgress = { step, env, syncMode, adminEmail, adminSent, companyId };
    sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  }, [step, env, syncMode, adminEmail, adminSent, companyId]);

  // Setup status (needsSetup / credentialsSet / mock / redirectUri).
  useEffect(() => {
    let cancelled = false;
    api
      .get<SetupStatusX>('/api/setup/status')
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // status unavailable — the wizard still works with defaults
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 1 is done already when a session exists and setup isn't needed.
  useEffect(() => {
    if (step !== 1 || adminSent || sessionLoading) return;
    if (session && status && !status.needsSetup) setStep(2);
  }, [step, adminSent, session, sessionLoading, status]);

  // Returning from OAuth: make sure the connected company is in the list.
  useEffect(() => {
    if (!companyId || !session) return;
    if (companies.some((c) => c.id === companyId)) return;
    refreshCompanies().catch(() => {
      // list refresh failed — the connected card falls back to the id
    });
  }, [companyId, session, companies, refreshCompanies]);

  // Step 3 (Email): load current SMTP settings once — prefills the fields and
  // tells us whether the server environment already manages email.
  const [smtpLoaded, setSmtpLoaded] = useState(false);
  useEffect(() => {
    if (step !== 3 || !session || smtpLoaded) return;
    let cancelled = false;
    instanceSettings
      .get()
      .then((dto) => {
        if (cancelled) return;
        setSmtpLoaded(true);
        setSmtpEnvManaged(dto.smtpFromEnv);
        if (dto.smtpFromEnv) return;
        if (dto.smtpHost !== '') setSmtpHost(dto.smtpHost);
        setSmtpPort(String(dto.smtpPort));
        if (dto.smtpUser !== '') setSmtpUser(dto.smtpUser);
        if (dto.smtpHost !== '') setSmtpFrom(dto.smtpFrom);
      })
      .catch(() => {
        // settings unavailable — the step still works with blank fields
      });
    return () => {
      cancelled = true;
    };
  }, [step, session, smtpLoaded]);

  // Step 5: load holding-account options (once per connected company).
  useEffect(() => {
    if (step !== 5 || !companyId || optionsFor === companyId) return;
    let cancelled = false;
    fetchHoldingOptions(companyId)
      .then((opts) => {
        if (cancelled) return;
        setOptions(opts);
        setOptionsFor(companyId);
        const preset = companies.find((c) => c.id === companyId)?.holdingAccountIds ?? [];
        const sel: Record<string, boolean> = {};
        for (const o of opts) {
          sel[o.id] =
            preset.length > 0
              ? preset.includes(o.id)
              : /ask my accountant|uncategorized expense/i.test(o.name);
        }
        setSelected(sel);
      })
      .catch(() => {
        if (!cancelled) toast('Could not load accounts — try again');
      });
    return () => {
      cancelled = true;
    };
  }, [step, companyId, optionsFor, companies, toast]);

  const redirectUri = status?.redirectUri ?? `${window.location.origin}/auth/qbo/callback`;
  const isMock = status?.mock === true;
  const selectedIds = options?.filter((o) => selected[o.id]).map((o) => o.id) ?? [];

  // ---- step actions --------------------------------------------------------

  const submitAdmin = async () => {
    const email = adminEmail.trim();
    if (!email) {
      toast('Enter your email first');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<AdminResponse>('/api/setup/admin', { email });
      setDevLink(res.devLink ?? null);
      setLinkDelivered(res.delivered ?? true);
      setAdminSent(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the link — try again');
    } finally {
      setBusy(false);
    }
  };

  // Dev shortcut: consume the magic link in place (the callback sets the
  // session cookie), then resume at step 2 without leaving /setup.
  const openSignInLink = async () => {
    if (!devLink || busy) return;
    setBusy(true);
    let fetched = false;
    try {
      await fetch(devLink, { credentials: 'include' });
      fetched = true;
      const s = await auth.session();
      setSession(s.user);
      setAdminSent(false);
      setStep(2);
    } catch {
      if (fetched) {
        toast('Sign-in failed — request a new link');
        setAdminSent(false);
      } else {
        // Network hiccup on the in-place fetch — fall back to a full
        // navigation; persist step 2 so a later /setup visit resumes there.
        const p: WizardProgress = { step: 2, env, syncMode, adminEmail, adminSent: false, companyId };
        sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
        window.location.href = devLink;
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = async () => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret) {
      if (isMock || status?.credentialsSet) {
        setStep(3);
        return;
      }
      toast('Enter your Intuit app client ID and secret');
      return;
    }
    setBusy(true);
    try {
      await setup.credentials({ clientId: id, clientSecret: secret, env });
      setStatus((s) => (s ? { ...s, credentialsSet: true } : s));
      setStep(3);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the credentials');
    } finally {
      setBusy(false);
    }
  };

  const smtpPatchBody = (): InstanceSettingsPatchBody => {
    const port = Number(smtpPort.trim());
    return {
      smtpHost: smtpHost.trim(),
      smtpPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 587,
      smtpUser: smtpUser.trim(),
      ...(smtpPass !== '' ? { smtpPass } : {}),
      smtpFrom: smtpFrom.trim(),
    };
  };

  const saveEmail = async (): Promise<void> => {
    await instanceSettings.patch(smtpPatchBody());
  };

  // 'Send test email' saves the fields first so the test uses what's on screen.
  const sendTestEmail = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!smtpEnvManaged) {
        if (smtpHost.trim() === '') {
          toast('Enter the SMTP host first');
          return;
        }
        await saveEmail();
      }
      const res = await instanceSettings.testEmail();
      toast(
        res.delivered
          ? `Test email sent to ${res.to} — check the inbox`
          : 'SMTP not configured — the email was printed to the server log',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test email failed');
    } finally {
      setBusy(false);
    }
  };

  // Continue on the Email step: env-managed or all-blank → just advance;
  // otherwise save the SMTP settings, then advance.
  const submitEmail = async () => {
    const allBlank =
      smtpHost.trim() === '' && smtpUser.trim() === '' && smtpPass === '' && smtpFrom.trim() === '';
    if (smtpEnvManaged || allBlank) {
      setStep(4);
      return;
    }
    if (smtpHost.trim() === '') {
      toast('Enter the SMTP host — or skip for now');
      return;
    }
    setBusy(true);
    try {
      await saveEmail();
      setStatus((s) => (s ? { ...s, smtpConfigured: true } : s));
      setStep(4);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the email settings');
    } finally {
      setBusy(false);
    }
  };

  const connectQbo = async () => {
    if (connecting) return;
    setConnectFailed(false);
    setConnecting(true);
    try {
      // Flush progress before leaving for the Intuit consent screen.
      const p: WizardProgress = { step, env, syncMode, adminEmail, adminSent: false, companyId };
      sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
      const { url } = await companiesApi.connectUrl();
      window.location.href = url;
    } catch (err) {
      setConnecting(false);
      toast(err instanceof Error ? err.message : 'Could not start the Intuit connection');
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast('Copied to clipboard'))
      .catch(() => toast('Copy failed — select the text manually'));
  };

  const copyUri = () => copyText(redirectUri);

  const finish = async () => {
    if (!companyId || syncing) return;
    setSyncing(true);
    setSyncMsg('Fetching chart of accounts…');
    const started = Date.now();
    // Cycle the two progress messages while the real work runs (prototype: 700ms).
    const timer = window.setInterval(() => {
      setSyncMsg((m) =>
        m === 'Fetching chart of accounts…' ? 'Reading holding accounts…' : 'Fetching chart of accounts…',
      );
    }, 700);
    try {
      await companiesApi.setSyncMode(companyId, syncMode);
      // Saving the holding accounts kicks off the initial sync server-side.
      await companiesApi.setHoldingAccounts(companyId, selectedIds);
      let found: number | null = null;
      try {
        const res = await transactions.list(companyId, { status: 'PENDING', countOnly: true });
        found = res.pendingCount;
      } catch {
        // count is cosmetic — finish without it
      }
      window.clearInterval(timer);
      await sleep(Math.max(0, started + 1400 - Date.now()));
      setSyncMsg(
        found !== null
          ? `Found ${found} transaction${found === 1 ? '' : 's'} to categorize`
          : 'Wrapping up…',
      );
      await sleep(700);
      sessionStorage.removeItem(PROGRESS_KEY);
      await refreshCompanies();
      setActiveCompany(companyId);
      navigate('/', { replace: true });
      toast(
        found !== null
          ? `Initial sync complete — ${found} transaction${found === 1 ? '' : 's'} found`
          : 'Initial sync complete',
      );
    } catch (err) {
      window.clearInterval(timer);
      setSyncing(false);
      toast(err instanceof Error ? err.message : 'First sync failed — try again');
    }
  };

  const wBack = () => setStep((s) => Math.max(1, s - 1));

  const wNext = () => {
    if (busy || syncing) return;
    if (step === 1) {
      if (session && status && !status.needsSetup) {
        setStep(2);
        return;
      }
      if (adminSent) {
        toast('Open the sign-in link we emailed you first');
        return;
      }
      void submitAdmin();
      return;
    }
    if (step === 2) {
      void submitCredentials();
      return;
    }
    if (step === 3) {
      void submitEmail();
      return;
    }
    if (step === 4) {
      if (!companyId) {
        toast('Connect QuickBooks first');
        return;
      }
      setStep(5);
      return;
    }
    if (step === 5) {
      if (selectedIds.length === 0) {
        toast('Pick at least one account to watch');
        return;
      }
      setStep(6);
      return;
    }
    void finish();
  };

  const showSkip = companies.length > 0 || isMock;
  const companyName = connectedCompany?.legalName ?? 'QuickBooks company';
  const companyInitial = (companyName.trim().charAt(0) || 'Q').toUpperCase();

  // ---- render --------------------------------------------------------------

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '56px 40px',
      }}
    >
      <style>{`
        .rr .sw-primary:hover { background: var(--accH); }
        .rr .sw-back:hover { color: var(--ink); }
        .rr .sw-copy:hover { background: var(--hl); }
        .rr .sw-dashed:hover { color: var(--ink); border-color: var(--fnt); }
        @media (max-width: 640px) { .rr .sw-step-label { display: none; } }
      `}</style>
      <div style={{ width: '100%', maxWidth: 660, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, fontFamily: "'Spectral',serif" }}>
          <span style={{ fontSize: 26, fontWeight: 600 }}>Recat</span>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--acc)',
              display: 'inline-block',
            }}
          />
          <span style={{ fontFamily: "'IBM Plex Sans'", fontSize: 14, color: 'var(--fnt)', marginLeft: 12 }}>
            First-run setup
          </span>
        </div>

        {/* step rail */}
        <div style={{ display: 'flex', gap: 8 }}>
          {STEP_NAMES.map((label, i) => (
            <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  background: i < step ? 'var(--acc)' : 'var(--bd)',
                }}
              />
              <div
                className="sw-step-label"
                style={{ fontSize: 12, fontWeight: 600, color: i < step ? 'var(--ink)' : 'var(--fnt)' }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            background: 'var(--sur)',
            border: '1px solid var(--bd)',
            borderRadius: 12,
            padding: 32,
            boxShadow: '0 2px 12px rgba(60,55,45,.06)',
          }}
        >
          {/* ---- step 1 · Admin ---- */}
          {step === 1 && !syncing && (
            !adminSent ? (
              <div>
                <div style={stepTitle}>Create the admin account</div>
                <div style={stepCopy}>
                  This account manages connections, team invites, and settings for this Recat
                  instance.
                </div>
                <label style={fieldLabel}>Your email</label>
                <input
                  className="input-lg"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="you@company.com"
                  type="email"
                />
                <div style={{ fontSize: 13, color: 'var(--fnt)', marginTop: 10 }}>
                  We'll verify it with a magic link — no password to create.
                </div>
              </div>
            ) : (
              <div>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'var(--okB)',
                    border: '1px solid var(--okD)',
                    color: 'var(--okT)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 20,
                    marginBottom: 16,
                  }}
                >
                  ✉
                </div>
                {linkDelivered ? (
                  <>
                    <div style={stepTitle}>Check your inbox</div>
                    <div style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}>
                      We sent a sign-in link to{' '}
                      <b style={{ color: 'var(--ink)' }}>{adminEmail.trim()}</b>. It expires in 15
                      minutes.
                    </div>
                  </>
                ) : devLink !== null ? (
                  <>
                    <div style={stepTitle}>You're one click away</div>
                    <div style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}>
                      Email isn't set up yet (that's the next step), so nothing was mailed to{' '}
                      <b style={{ color: 'var(--ink)' }}>{adminEmail.trim()}</b> — verify with your
                      one-time sign-in link instead.
                    </div>
                  </>
                ) : (
                  <>
                    <div style={stepTitle}>Almost there</div>
                    <div style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}>
                      Email isn't set up yet, so nothing was mailed. Your one-time sign-in link was
                      printed to the server logs — open your deployment's logs and look for the{' '}
                      <code style={{ fontSize: 12.5 }}>[mailer:dev]</code> line.
                    </div>
                  </>
                )}
                {devLink !== null && (
                  <button
                    onClick={() => void openSignInLink()}
                    className={linkDelivered ? 'sw-dashed' : 'sw-primary'}
                    style={
                      linkDelivered
                        ? {
                            width: '100%',
                            border: '1px dashed var(--bd)',
                            background: 'var(--hl)',
                            color: 'var(--mut)',
                            borderRadius: 8,
                            padding: 11,
                            fontSize: 13.5,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }
                        : {
                            width: '100%',
                            background: 'var(--acc)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 8,
                            padding: 12,
                            fontSize: 15,
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }
                    }
                  >
                    {linkDelivered ? 'Open the sign-in link →' : 'Verify & continue →'}
                  </button>
                )}
              </div>
            )
          )}

          {/* ---- step 2 · Credentials ---- */}
          {step === 2 && !syncing && (
            <div>
              <div style={stepTitle}>Intuit app credentials</div>
              <div style={stepCopy}>
                Paste the keys from your app on the{' '}
                <a href="https://developer.intuit.com" target="_blank" rel="noreferrer">
                  Intuit Developer Portal
                </a>
                . Never made one?{' '}
                <a
                  href="https://github.com/tx-joshg/recat-qbo/blob/main/docs/intuit-setup.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  the setup walkthrough
                </a>{' '}
                walks you through it in ~10 minutes.
              </div>
              {isMock && (
                <div style={{ fontSize: 13, color: 'var(--fnt)', margin: '-12px 0 18px' }}>
                  Demo mode — mock QuickBooks, keys optional.
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={fieldLabel}>Client ID</label>
                  <input
                    className="input-lg"
                    style={{ fontSize: 14, fontFamily: 'monospace' }}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </div>
                <div>
                  <label style={fieldLabel}>Client secret</label>
                  <input
                    className="input-lg"
                    style={{ fontSize: 14, fontFamily: 'monospace' }}
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              </div>
              <div
                style={{
                  marginTop: 18,
                  background: 'var(--hl)',
                  border: '1px solid var(--bd2)',
                  borderRadius: 8,
                  padding: '14px 16px',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mut)' }}>
                  Redirect URI — paste this into your Intuit app
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, minWidth: 0 }}>
                  <code
                    style={{
                      fontSize: 13,
                      color: 'var(--ink)',
                      background: 'var(--card)',
                      border: '1px solid var(--bd2)',
                      borderRadius: 6,
                      padding: '7px 10px',
                      flex: 1,
                      minWidth: 0,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {redirectUri}
                  </code>
                  <button
                    onClick={copyUri}
                    className="sw-copy"
                    style={{
                      flex: 'none',
                      border: '1px solid var(--bd)',
                      background: 'var(--card)',
                      color: 'var(--ink)',
                      borderRadius: 6,
                      padding: '7px 12px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Copy
                  </button>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginTop: 16 }}>
                  Intuit also asks for EULA, Privacy Policy, Launch, and Disconnect URLs —
                  this deployment serves them all, in that order
                </div>
                {[
                  `${window.location.origin}/eula`,
                  `${window.location.origin}/privacy`,
                  `${window.location.origin}/`,
                  `${window.location.origin}/disconnected`,
                ].map((u) => (
                  <div
                    key={u}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, minWidth: 0 }}
                  >
                    <code
                      style={{
                        fontSize: 13,
                        color: 'var(--ink)',
                        background: 'var(--card)',
                        border: '1px solid var(--bd2)',
                        borderRadius: 6,
                        padding: '7px 10px',
                        flex: 1,
                        minWidth: 0,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {u}
                    </code>
                    <button
                      onClick={() => copyText(u)}
                      className="sw-copy"
                      style={{
                        flex: 'none',
                        border: '1px solid var(--bd)',
                        background: 'var(--card)',
                        color: 'var(--ink)',
                        borderRadius: 6,
                        padding: '7px 12px',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---- step 3 · Email ---- */}
          {step === 3 && !syncing && (
            <div>
              <div style={stepTitle}>Email for sign-in links</div>
              <div style={stepCopy}>
                Recat signs everyone in with magic links, so it needs a way to send email. Any SMTP
                provider works — Resend, Postmark, SES, or your own.
              </div>
              {isMock && (
                <div style={{ fontSize: 13, color: 'var(--fnt)', margin: '-12px 0 18px' }}>
                  Demo mode — sign-in links print to the server log, SMTP optional.
                </div>
              )}
              {smtpEnvManaged ? (
                <div
                  style={{
                    border: '1px solid var(--okD)',
                    background: 'var(--okB)',
                    borderRadius: 10,
                    padding: '14px 18px',
                    fontSize: 14,
                    color: 'var(--okT)',
                    fontWeight: 600,
                  }}
                >
                  ✓ Email is configured by the server environment — nothing to do here. Continue to
                  the next step.
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', gap: 14 }}>
                      <div style={{ flex: 3 }}>
                        <label style={fieldLabel}>SMTP host</label>
                        <input
                          className="input-lg"
                          style={{ fontSize: 14, fontFamily: 'monospace' }}
                          value={smtpHost}
                          onChange={(e) => setSmtpHost(e.target.value)}
                          placeholder="smtp.example.com"
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={fieldLabel}>Port</label>
                        <input
                          className="input-lg"
                          style={{ fontSize: 14, fontFamily: 'monospace' }}
                          type="number"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(e.target.value)}
                        />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 14 }}>
                      <div style={{ flex: 1 }}>
                        <label style={fieldLabel}>Username</label>
                        <input
                          className="input-lg"
                          style={{ fontSize: 14, fontFamily: 'monospace' }}
                          value={smtpUser}
                          onChange={(e) => setSmtpUser(e.target.value)}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={fieldLabel}>Password</label>
                        <input
                          className="input-lg"
                          style={{ fontSize: 14, fontFamily: 'monospace' }}
                          type="password"
                          value={smtpPass}
                          onChange={(e) => setSmtpPass(e.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <label style={fieldLabel}>From address</label>
                      <input
                        className="input-lg"
                        style={{ fontSize: 14 }}
                        value={smtpFrom}
                        onChange={(e) => setSmtpFrom(e.target.value)}
                        placeholder="Recat <noreply@yourdomain.com>"
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                    <button
                      onClick={() => void sendTestEmail()}
                      className="sw-copy"
                      style={{
                        border: '1px solid var(--bd)',
                        background: 'var(--card)',
                        color: 'var(--ink)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        fontSize: 13.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Send test email
                    </button>
                    <button
                      onClick={() => setStep(4)}
                      className="sw-dashed"
                      style={{
                        flex: 1,
                        border: '1px dashed var(--bd)',
                        background: 'var(--hl)',
                        color: 'var(--mut)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        fontSize: 13.5,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Skip for now — links print to the server log →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- step 4 · Connect ---- */}
          {step === 4 && !syncing && (
            <div>
              <div style={stepTitle}>Connect QuickBooks</div>
              <div style={stepCopy}>
                Choose the environment, then authorize Recat with Intuit. You can connect more
                companies later in Settings.
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 22 }}>
                <label
                  onClick={() => setEnv('sandbox')}
                  style={{
                    flex: 1,
                    border: `1.5px solid ${env === 'sandbox' ? 'var(--acc)' : 'var(--bd2)'}`,
                    background: 'var(--card)',
                    borderRadius: 10,
                    padding: '14px 16px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>Sandbox</div>
                  <div style={{ fontSize: 13, color: 'var(--fnt)', marginTop: 2 }}>
                    Test company, instant keys
                  </div>
                </label>
                <label
                  onClick={() => setEnv('production')}
                  style={{
                    flex: 1,
                    border: `1.5px solid ${env === 'production' ? 'var(--acc)' : 'var(--bd2)'}`,
                    background: 'var(--card)',
                    borderRadius: 10,
                    padding: '14px 16px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>Production</div>
                  <div style={{ fontSize: 13, color: 'var(--fnt)', marginTop: 2 }}>
                    Real books — needs Intuit approval
                  </div>
                </label>
              </div>
              {connectFailed && !companyId && (
                <div style={{ fontSize: 13.5, color: 'var(--erT)', margin: '-10px 0 14px' }}>
                  QuickBooks connection failed — try again.
                </div>
              )}
              {!companyId ? (
                <button
                  onClick={() => void connectQbo()}
                  className="sw-primary"
                  style={{
                    width: '100%',
                    background: 'var(--acc)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: 13,
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {connecting ? 'Redirecting to Intuit…' : 'Connect QuickBooks →'}
                </button>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    border: '1px solid var(--okD)',
                    background: 'var(--okB)',
                    borderRadius: 10,
                    padding: '14px 18px',
                  }}
                >
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      background: 'var(--acc)',
                      color: '#fff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 600,
                    }}
                  >
                    {companyInitial}
                  </span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{companyName}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                      realm {connectedCompany?.realmId ?? '—'} · connected just now
                    </div>
                  </div>
                  <span style={{ marginLeft: 'auto', color: 'var(--okT)', fontWeight: 600, fontSize: 14 }}>
                    ✓ Connected
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ---- step 5 · Accounts ---- */}
          {step === 5 && !syncing && (
            <div>
              <div style={stepTitle}>Which accounts should Recat watch?</div>
              <div style={stepCopy}>
                Transactions sitting in these <b>holding accounts</b> become your categorization
                queue. Tip: add a QuickBooks bank rule that auto-adds feed items to one of them.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {options === null ? (
                  <div style={{ fontSize: 13, color: 'var(--fnt)' }}>Loading accounts…</div>
                ) : (
                  options.map((a) => {
                    const on = selected[a.id] === true;
                    return (
                      <label
                        key={a.id}
                        onClick={() => setSelected((sel) => ({ ...sel, [a.id]: !on }))}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          border: `1.5px solid ${on ? 'var(--acc)' : 'var(--bd2)'}`,
                          background: 'var(--card)',
                          borderRadius: 10,
                          padding: '13px 16px',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          readOnly
                          style={{ width: 16, height: 16, accentColor: 'var(--acc)', pointerEvents: 'none' }}
                        />
                        <span style={{ fontSize: 14.5, fontWeight: 500 }}>{a.name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--fnt)' }}>
                          {countLabel(a.txnCount)}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* ---- step 6 · Sync mode ---- */}
          {step === 6 && !syncing && (
            <div>
              <div style={stepTitle}>How should Recat stay in sync?</div>
              <div style={stepCopy}>
                Polling needs no public URL and is right for most self-hosters. Either way, a full
                reconcile runs nightly.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label
                  onClick={() => setSyncMode('polling')}
                  style={{
                    border: `1.5px solid ${syncMode === 'polling' ? 'var(--acc)' : 'var(--bd2)'}`,
                    background: 'var(--card)',
                    borderRadius: 10,
                    padding: '15px 18px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600 }}>Polling</span>
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: 'var(--okT)',
                        background: 'var(--okB)',
                        border: '1px solid var(--okD)',
                        borderRadius: 99,
                        padding: '2px 8px',
                      }}
                    >
                      recommended
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>
                    Checks QuickBooks for changes every <b>10 minutes</b>. No public URL required.
                  </div>
                </label>
                <label
                  onClick={() => setSyncMode('webhook')}
                  style={{
                    border: `1.5px solid ${syncMode === 'webhook' ? 'var(--acc)' : 'var(--bd2)'}`,
                    background: 'var(--card)',
                    borderRadius: 10,
                    padding: '15px 18px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>Webhooks</div>
                  <div style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>
                    Near-instant updates. Requires a public HTTPS endpoint and a verifier token from
                    Intuit.
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* ---- first-sync spinner ---- */}
          {syncing && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '24px 0',
                gap: 16,
              }}
            >
              <Spinner />
              <div style={{ fontFamily: "'Spectral',serif", fontSize: 20, fontWeight: 500 }}>
                Running the first sync…
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--mut)' }}>{syncMsg}</div>
            </div>
          )}

          {/* ---- nav ---- */}
          {!syncing && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 28 }}>
              <button
                onClick={wBack}
                className="sw-back"
                style={{
                  border: '1px solid var(--bd)',
                  background: 'var(--card)',
                  color: 'var(--mut)',
                  borderRadius: 8,
                  padding: '10px 18px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  visibility: step > 1 ? 'visible' : 'hidden',
                }}
              >
                ← Back
              </button>
              <button
                onClick={wNext}
                className="sw-primary"
                style={{
                  background: 'var(--acc)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '10px 22px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {step === 6 ? 'Finish — run first sync' : 'Continue →'}
              </button>
            </div>
          )}
        </div>

        {showSkip && (
          <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--fnt)' }}>
            <Link to="/">{isMock ? 'Skip setup — jump to the demo queue →' : 'Skip setup →'}</Link>
          </div>
        )}
      </div>
    </div>
  );
}
