// Settings — "Email (SMTP)" card (admin only), modeled on ApiAccessCard.
// Instance-wide SMTP config for magic links and the daily digest. Env vars
// (SMTP_HOST etc.) take precedence over anything saved here.

import { useState } from 'react';
import type { InstanceSettingsDto } from '@recat/shared';
import { instanceSettings } from '../../lib/api';
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
        toast('Email settings saved');
      })
      .catch((err) => toast(errMsg(err)))
      .finally(() => setBusy(false));
  };

  // Saves any pending edits first so the test uses what's on screen.
  const sendTest = () => {
    if (busy) return;
    setBusy(true);
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
      .then((res) =>
        toast(
          res.delivered
            ? `Test email sent to ${res.to} — check the inbox`
            : 'SMTP not configured — the email was printed to the server log',
        ),
      )
      .catch((err) => toast(errMsg(err)))
      .finally(() => setBusy(false));
  };

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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
            gap: 14,
            marginTop: 16,
          }}
        >
          <div>
            <label style={fieldLabel}>SMTP host</label>
            <input
              className="input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={fieldLabel}>Port</label>
            <input
              className="input"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={fieldLabel}>Username</label>
            <input
              className="input"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={fieldLabel}>Password</label>
            <input
              className="input"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder={settings.smtpPassSet ? '••••••••' : ''}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={fieldLabel}>From address</label>
            <input
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="Recat <noreply@yourdomain.com>"
              style={{ ...inputStyle, fontFamily: 'inherit' }}
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <HoverButton onClick={sendTest} style={ghostBtn} hoverStyle={{ background: 'var(--hl)' }}>
          Send test email
        </HoverButton>
        {!envManaged && (
          <HoverButton onClick={save} style={ghostBtn} hoverStyle={{ background: 'var(--hl)' }}>
            Save changes
          </HoverButton>
        )}
      </div>
    </div>
  );
}
