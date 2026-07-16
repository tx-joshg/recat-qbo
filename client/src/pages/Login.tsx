// Login — magic-link email flow (form → "check your inbox" state).
// All styles ported verbatim from design_handoff_recat/Recat.dc.html lines 40–66.
// Dev convenience: POST /auth/magic-link returns { devLink } when no SMTP is
// configured — surfaced as the dashed "Open the sign-in link →" button
// (prototype line 60's shortcut pattern).

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SetupStatus } from '../lib/api';
import { useApp } from '../state/AppContext';

/** Actual /auth/magic-link response (lib/api.ts types it void — see server routes/auth.ts). */
interface MagicLinkResponse {
  ok: boolean;
  devLink?: string;
}

export default function Login() {
  const { session, sessionLoading, toast } = useApp();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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
          {!sent ? (
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
              <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
                Check your inbox
              </div>
              <div style={{ fontSize: 14, color: 'var(--mut)', margin: '6px 0 20px', lineHeight: 1.5 }}>
                We sent a sign-in link to <b style={{ color: 'var(--ink)' }}>{email.trim()}</b>. It
                expires in 15 minutes.
              </div>
              {devLink !== null && (
                <button
                  onClick={() => {
                    // Full navigation: the callback sets the session cookie and redirects to /.
                    window.location.href = devLink;
                  }}
                  className="lg-dashed"
                  style={{
                    width: '100%',
                    border: '1px dashed var(--bd)',
                    background: 'var(--hl)',
                    color: 'var(--mut)',
                    borderRadius: 8,
                    padding: 11,
                    fontSize: 13.5,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Open the sign-in link →
                </button>
              )}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'center', fontSize: 13.5, color: 'var(--fnt)' }}>
          First run on this server?{' '}
          <Link to="/setup" style={{ fontWeight: 600 }}>
            Set up Recat
          </Link>
        </div>
      </div>
    </div>
  );
}
