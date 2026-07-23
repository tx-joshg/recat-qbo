// Settings — "Email (SMTP)" card (admin only), modeled on ApiAccessCard.
// Instance-wide SMTP config for magic links and the daily digest. Env vars
// (SMTP_HOST etc.) take precedence over anything saved here.

import { useState } from 'react';
import type { InstanceSettingsDto } from '@recat/shared';
import { instanceSettings } from '../../lib/api';
import type { SmtpProvider } from '../../lib/smtpProviders';
import SmtpPresets from '../../components/SmtpPresets';
import { InfoDot } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';
import HoverButton from './HoverButton';

const fieldLabel = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--mut)',
  marginBottom: 6,
} as const;

const ghostBtn = {
  border: '1px solid var(--bd)',
  background: 'var(--card)',
  color: 'var(--ink)',
  borderRadius: 7,
  padding: '8px 16px',
  fontSize: 13.5,
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit',
} as const;

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 12px',
  fontSize: 13.5,
  fontFamily: 'monospace',
} as const;

export default function EmailCard({
  settings,
  onSettings,
}: {
  settings: InstanceSettingsDto;
  onSettings: (next: InstanceSettingsDto) => void;
}) {
  const { toast } = useApp();
  const envManaged = settings.smtpFromEnv;

  const [host, setHost] = useState(settings.smtpHost);
  const [port, setPort] = useState(String(settings.smtpPort));
  const [user, setUser] = useState(settings.smtpUser);
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState(settings.smtpHost !== '' ? settings.smtpFrom : '');
  const [busy, setBusy] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionState, setConnectionState] = useState<
    'connected' | 'untested' | 'failed' | 'not-configured'
  >(settings.smtpHost !== '' || envManaged ? 'untested' : 'not-configured');

  const markUntested = (nextHost = host) => {
    setConnectionState(nextHost.trim() === '' && !envManaged ? 'not-configured' : 'untested');
  };

  // Fill host/port (and username only when the provider fixes it); never touch
  // the password or from address.
  const pickProvider = (p: SmtpProvider) => {
    setHost(p.host);
    setPort(String(p.port));
    if (p.username !== null) setUser(p.username);
    markUntested(p.host);
  };

  const patchBody = (): Parameters<typeof instanceSettings.patch>[0] => {
    const body: Parameters<typeof instanceSettings.patch>[0] = {};
    if (host.trim() !== settings.smtpHost) body.smtpHost = host.trim();
    const portNum = Number(port.trim());
    if (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 && portNum !== settings.smtpPort) {
      body.smtpPort = portNum;
    }
    if (user.trim() !== settings.smtpUser) body.smtpUser = user.trim();
    if (pass !== '') body.smtpPass = pass;
    if (from.trim() !== '' && from.trim() !== settings.smtpFrom) body.smtpFrom = from.trim();
    return body;
  };

  const save = () => {
    const body = patchBody();
    // Nothing changed — silent no-op; only a real, successful PATCH toasts.
    if (Object.keys(body).length === 0) return;
    setBusy(true);
    instanceSettings
      .patch(body)
      .then((updated) => {
        onSettings(updated);
        setHost(updated.smtpHost);
        setPort(String(updated.smtpPort));
        setUser(updated.smtpUser);
        setPass('');
        setFrom(updated.smtpHost !== '' ? updated.smtpFrom : '');
        setConnectionState(updated.smtpHost !== '' || updated.smtpFromEnv ? 'untested' : 'not-configured');
        toast('Email settings saved');
      })
      .catch((err) => toast(errMsg(err)))
      .finally(() => setBusy(false));
  };

  // Saves any pending edits first so the test uses what's on screen.
  const sendTest = () => {
    if (busy) return;
    setBusy(true);
    setTestingConnection(true);
    const body = patchBody();
    const saved =
      envManaged || Object.keys(body).length === 0
        ? Promise.resolve(null)
        : instanceSettings.patch(body).then((updated) => {
            onSettings(updated);
            setPass('');
            return updated;
          });
    saved
      .then(() => instanceSettings.testEmail())
      .then((res) => {
        setConnectionState(res.delivered ? 'connected' : 'not-configured');
        toast(
          res.delivered
            ? `Test email sent to ${res.to} — check the inbox`
            : 'SMTP not configured — the email was printed to the server log',
        );
      })
      .catch((err) => {
        setConnectionState('failed');
        toast(errMsg(err));
      })
      .finally(() => {
        setTestingConnection(false);
        setBusy(false);
      });
  };

  const connectionStatus =
    connectionState === 'connected'
      ? { text: '✓ Connected', color: 'var(--okT)' }
      : connectionState === 'failed'
        ? { text: 'Connection failed', color: 'var(--erT)' }
        : connectionState === 'untested'
          ? { text: 'Not tested', color: 'var(--amT)' }
          : { text: 'Not configured', color: 'var(--fnt)' };

  return (
    <div
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: 24,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
        Email (SMTP)
        <InfoDot tip="Recat sends magic sign-in links and the daily digest over SMTP. Any provider works — Resend, Postmark, SES, or your own server. Without SMTP, links print to the server log." />
      </div>

      {envManaged ? (
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 14, lineHeight: 1.5 }}>
          Email is configured by the server environment (<code>SMTP_HOST</code> et al.) — env vars
          take precedence, so values saved here would be ignored.
        </div>
      ) : (
        <>
          <div style={{ marginTop: 16 }}>
            <SmtpPresets host={host} onPick={pickProvider} />
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
              gap: 14,
              marginTop: 16,
            }}
          >
          <div>
            <label htmlFor="smtp-host" style={fieldLabel}>SMTP host</label>
            <input
              id="smtp-host"
              className="input"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                markUntested(e.target.value);
              }}
              placeholder="smtp.example.com"
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="smtp-port" style={fieldLabel}>Port</label>
            <input
              id="smtp-port"
              className="input"
              type="number"
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                markUntested();
              }}
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="smtp-user" style={fieldLabel}>Username</label>
            <input
              id="smtp-user"
              className="input"
              value={user}
              onChange={(e) => {
                setUser(e.target.value);
                markUntested();
              }}
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="smtp-password" style={fieldLabel}>Password</label>
            <input
              id="smtp-password"
              className="input"
              type="password"
              value={pass}
              onChange={(e) => {
                setPass(e.target.value);
                markUntested();
              }}
              placeholder={settings.smtpPassSet ? '••••••••' : ''}
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="smtp-from" style={fieldLabel}>From address</label>
            <input
              id="smtp-from"
              className="input"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                markUntested();
              }}
              placeholder="Recat <noreply@yourdomain.com>"
              style={{ ...inputStyle, fontFamily: 'inherit' }}
            />
          </div>
          </div>
        </>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 16,
        }}
      >
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 13.5, fontWeight: 600, color: connectionStatus.color }}
        >
          {testingConnection ? 'Testing connection…' : connectionStatus.text}
        </span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <HoverButton
            onClick={sendTest}
            disabled={busy}
            style={{ ...ghostBtn, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1 }}
            hoverStyle={{ background: 'var(--hl)' }}
          >
            {testingConnection ? 'Sending…' : 'Send test email'}
          </HoverButton>
          {!envManaged && (
            <HoverButton
              onClick={save}
              disabled={busy}
              style={{ ...ghostBtn, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1 }}
              hoverStyle={{ background: 'var(--hl)' }}
            >
              Save changes
            </HoverButton>
          )}
        </div>
      </div>
    </div>
  );
}
