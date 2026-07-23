// Login — magic-link email flow (form → "check your inbox" state).
// All styles ported verbatim from design_handoff_recat/Recat.dc.html lines 40–66.
// Dev convenience: POST /auth/magic-link returns { devLink } when no SMTP is
// configured — surfaced as the dashed "Open the sign-in link →" button
// (prototype line 60's shortcut pattern).

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth, api } from '../lib/api';
import type { SetupStatus } from '../lib/api';
import { useApp } from '../state/AppContext';
import LocalAdminLogin from './login/LocalAdminLogin';

/** Actual /auth/magic-link response (lib/api.ts types it void — see server routes/auth.ts). */
interface MagicLinkResponse {
  ok: boolean;
  /** false when this instance has no SMTP configured — no email was sent. */
  delivered?: boolean;
  devLink?: string;
}

export default function Login() {
  const { session, sessionLoading, setSession, toast } = useApp();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(true);
  const [sending, setSending] = useState(false);
  const [localAdminEnabled, setLocalAdminEnabled] = useState(false);
  const [loginMode, setLoginMode] = useState<'magic' | 'local'>('magic');

  useEffect(() => {
    let cancelled = false;
    auth
      .methods()
      .then((methods) => {
        if (!cancelled) setLocalAdminEnabled(methods.localAdmin);
      })
      .catch(() => {
        if (!cancelled) setLocalAdminEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Already signed in → the app. First boot (no admin user yet) → the wizard.
  useEffect(() => {
    if (sessionLoading) return;
    if (session) {
      navigate('/', { replace: true });
      return;
    }
    let cancelled = false;
    api
      .get<SetupStatus>('/api/setup/status')
      .then((s) => {
        if (!cancelled && s.needsSetup) navigate('/setup', { replace: true });
      })
      .catch(() => {
        // status unavailable — stay on the login form
      });
    return () => {
      cancelled = true;
    };
  }, [session, sessionLoading, navigate]);

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await api.post<MagicLinkResponse>('/auth/magic-link', { email: trimmed });
      setDevLink(res.devLink ?? null);
      setDelivered(res.delivered ?? true);
      setSent(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the link — try again');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <style>{`
        .rr .lg-primary:hover { background: var(--accH); }
        .rr .lg-dashed:hover { color: var(--ink); border-color: var(--fnt); }
      `}</style>
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 3,
            justifyContent: 'center',
            fontFamily: "'Spectral',serif",
          }}
        >
          <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-.01em' }}>Recat</span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--acc)',
              display: 'inline-block',
            }}
          />
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
          {loginMode === 'local' ? (
            <LocalAdminLogin
              email={email}
              setEmail={setEmail}
              onSuccess={(user) => {
                setSession(user);
                navigate('/', { replace: true });
              }}
              onError={toast}
              onBack={() => setLoginMode('magic')}
            />
          ) : !sent ? (
            <form onSubmit={sendLink}>
              <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
                Sign in
              </div>
              <div style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 22px', lineHeight: 1.5 }}>
                No passwords here — we'll email you a magic link.
              </div>
              <label
                style={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--mut)',
                  marginBottom: 6,
                }}
              >
                Email
              </label>
              <input
                className="input-lg"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                type="email"
                autoFocus
              />
              <button
                type="submit"
                className="lg-primary"
                style={{
                  width: '100%',
                  marginTop: 14,
                  background: 'var(--acc)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Email me a magic link
              </button>
              {localAdminEnabled && (
                <button
                  type="button"
                  className="lg-dashed"
                  onClick={() => setLoginMode('local')}
                  style={{
                    width: '100%',
                    marginTop: 10,
                    border: '1px dashed var(--bd)',
                    background: 'var(--hl)',
                    color: 'var(--mut)',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 13.5,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Local admin access
                </button>
              )}
            </form>
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
              {delivered ? (
                <>
                  <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
                    Check your inbox
                  </div>
                  <div
                    style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}
                  >
                    We sent a sign-in link to <b style={{ color: 'var(--ink)' }}>{email.trim()}</b>.
                    It expires in 15 minutes.
                  </div>
                </>
              ) : devLink !== null ? (
                <>
                  <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
                    You're one click away
                  </div>
                  <div
                    style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}
                  >
                    This server doesn't send email yet, so nothing was mailed to{' '}
                    <b style={{ color: 'var(--ink)' }}>{email.trim()}</b> — use your one-time
                    sign-in link instead. You can set up email later in Settings.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
                    Almost there
                  </div>
                  <div
                    style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}
                  >
                    This server doesn't send email yet, so nothing was mailed. Your one-time
                    sign-in link was printed to the server logs — open your deployment's logs
                    (on Railway: the app service → View Logs) and look for the{' '}
                    <code style={{ fontSize: 12.5 }}>[mailer:dev]</code> line.
                  </div>
                </>
              )}
              {devLink !== null && (
                <button
                  onClick={() => {
                    // Full navigation: the callback sets the session cookie and redirects to /.
                    window.location.href = devLink;
                  }}
                  className={delivered ? 'lg-dashed' : 'lg-primary'}
                  style={
                    delivered
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
                  Sign in →
                </button>
              )}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'center', fontSize: 13.5, color: 'var(--fnt)' }}>
          Access is by invitation — there's no self-signup.
          <br />
          First run on this server?{' '}
          <Link to="/setup" style={{ fontWeight: 600 }}>
            Set up Recat
          </Link>
        </div>
      </div>
    </div>
  );
}
