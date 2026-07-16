// Settings — "QuickBooks API access" card (Recat.dc.html lines 787–819).
// Instance-wide Intuit credentials, redirect URI, and (webhook mode only) the
// webhook endpoint + verifier token. Only changed fields are PATCHed.

import { useState } from 'react';
import type { InstanceSettingsDto, SyncMode } from '@recat/shared';
import { instanceSettings } from '../../lib/api';
import { InfoDot } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { errMsg, fmtWhen } from './format';
import HoverButton from './HoverButton';

const rowLabel = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--mut)',
  flex: 'none',
  width: 110,
} as const;

const codeChip = {
  fontSize: 12.5,
  color: 'var(--ink)',
  background: 'var(--hl)',
  border: '1px solid var(--bd2)',
  borderRadius: 6,
  padding: '7px 10px',
  flex: 1,
  minWidth: 0,
  overflowWrap: 'anywhere',
} as const;

const fieldLabel = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--mut)',
  marginBottom: 6,
} as const;

const copyBtn = {
  flex: 'none',
  border: '1px solid var(--bd)',
  background: 'var(--card)',
  color: 'var(--ink)',
  borderRadius: 6,
  padding: '7px 12px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit',
} as const;

export default function ApiAccessCard({
  settings,
  onSettings,
  syncMode,
  lastWebhookEventAt,
}: {
  settings: InstanceSettingsDto;
  onSettings: (next: InstanceSettingsDto) => void;
  syncMode: SyncMode;
  lastWebhookEventAt: string | null;
}) {
  const { toast } = useApp();

  const [clientId, setClientId] = useState(settings.intuitClientId);
  const [clientSecret, setClientSecret] = useState('');
  const [whToken, setWhToken] = useState('');

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast('Copied to clipboard'))
      .catch(() => toast('Copy failed'));
  };

  const save = () => {
    const body: Parameters<typeof instanceSettings.patch>[0] = {};
    if (clientId.trim() !== settings.intuitClientId && clientId.trim() !== '') {
      body.intuitClientId = clientId.trim();
    }
    if (clientSecret !== '') body.intuitClientSecret = clientSecret;
    if (whToken !== '') body.webhookVerifierToken = whToken;
    // Nothing changed — silent no-op; only a real, successful PATCH toasts.
    if (Object.keys(body).length === 0) return;
    instanceSettings
      .patch(body)
      .then((updated) => {
        onSettings(updated);
        setClientId(updated.intuitClientId);
        setClientSecret('');
        setWhToken('');
        toast('API credentials saved');
      })
      .catch((err) => toast(errMsg(err)));
  };

  const webhookEndpoint = `${window.location.origin}/webhooks/qbo`;

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
        QuickBooks API access
        <InfoDot tip="The Intuit app credentials from first-run setup, shared by every company on this Recat instance. If you rotate the secret on the Intuit Developer Portal, paste the new one here." />
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
          <label style={fieldLabel}>Client ID</label>
          <input
            className="input"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
          />
        </div>
        <div>
          <label style={fieldLabel}>Client secret</label>
          <input
            className="input"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={settings.intuitClientSecretSet ? '••••••••' : ''}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, minWidth: 0 }}>
        <span style={rowLabel}>Redirect URI</span>
        <code style={codeChip}>{settings.redirectUri}</code>
        <HoverButton
          onClick={() => copy(settings.redirectUri)}
          style={copyBtn}
          hoverStyle={{ background: 'var(--hl)' }}
        >
          Copy
        </HoverButton>
      </div>

      {syncMode === 'webhook' ? (
        <div style={{ borderTop: '1px solid var(--bd2)', marginTop: 18, paddingTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600 }}>
            Webhooks
            {lastWebhookEventAt !== null && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--okT)',
                  background: 'var(--okB)',
                  border: '1px solid var(--okD)',
                  borderRadius: 99,
                  padding: '2px 9px',
                }}
              >
                receiving · last event {fmtWhen(lastWebhookEventAt)}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, minWidth: 0 }}>
            <span style={rowLabel}>Endpoint</span>
            <code style={codeChip}>{webhookEndpoint}</code>
            <HoverButton
              onClick={() => copy(webhookEndpoint)}
              style={copyBtn}
              hoverStyle={{ background: 'var(--hl)' }}
            >
              Copy
            </HoverButton>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <span style={rowLabel}>Verifier token</span>
            <input
              className="input"
              type="password"
              value={whToken}
              onChange={(e) => setWhToken(e.target.value)}
              placeholder={
                settings.webhookVerifierTokenSet
                  ? '••••••••'
                  : 'Paste the verifier token from your Intuit app…'
              }
              style={{ flex: 1, minWidth: 0, padding: '8px 12px', fontSize: 13, fontFamily: 'monospace' }}
            />
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 14 }}>
          Sync is set to polling — switch it to Webhooks above to configure the endpoint and verifier
          token.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <HoverButton
          onClick={save}
          style={{
            border: '1px solid var(--bd)',
            background: 'var(--card)',
            color: 'var(--ink)',
            borderRadius: 7,
            padding: '8px 16px',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
            font: 'inherit',
          }}
          hoverStyle={{ background: 'var(--hl)' }}
        >
          Save changes
        </HoverButton>
      </div>
    </div>
  );
}
