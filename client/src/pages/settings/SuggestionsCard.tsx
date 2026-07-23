// Settings — "Category suggestions" card (Recat.dc.html lines 830–852).
// Source/provider selection plus the restart-safe ChatGPT device-auth panel.

import { useEffect, useRef, useState } from 'react';
import type {
  CodexStatusDto,
  InstanceSettingsDto,
  SuggestionProvider,
  SuggestionSetting,
} from '@recat/shared';
import { codex, instanceSettings } from '../../lib/api';
import { InfoDot } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';
import {
  createCodexDevicePoller,
  providerPersistenceForCodexTransition,
  providerSelectionDecision,
  type CodexDeviceUiState,
} from './codexPanel';

export default function SuggestionsCard({
  settings,
  onSettings,
}: {
  settings: InstanceSettingsDto;
  onSettings: (next: InstanceSettingsDto) => void;
}) {
  const { toast } = useApp();

  const [aiUrl, setAiUrl] = useState(settings.aiEndpoint ?? '');
  const [aiKey, setAiKey] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [openrouterReferer, setOpenrouterReferer] = useState(settings.openrouterReferer);
  const [openrouterTitle, setOpenrouterTitle] = useState(settings.openrouterTitle);
  const [aiModel, setAiModel] = useState(settings.suggestionModel);
  const [codexModel, setCodexModel] = useState(settings.codexModel);
  const [providerChoice, setProviderChoice] = useState(settings.suggestionProvider);
  const [codexStatus, setCodexStatus] = useState<CodexStatusDto>({
    connected: false,
    state: 'disconnected',
    reconnectRequired: false,
  });
  const [codexStatusLoaded, setCodexStatusLoaded] = useState(false);
  const [deviceState, setDeviceState] = useState<CodexDeviceUiState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollerRef = useRef<ReturnType<typeof createCodexDevicePoller> | null>(null);
  const onSettingsRef = useRef(onSettings);
  const toastRef = useRef(toast);
  onSettingsRef.current = onSettings;
  toastRef.current = toast;

  useEffect(() => {
    setProviderChoice(settings.suggestionProvider);
  }, [settings.suggestionProvider]);

  useEffect(() => {
    let active = true;
    const refreshStatus = async () => {
      const status = await codex.status();
      if (!active) return;
      setCodexStatus(status);
      setCodexStatusLoaded(true);
      if (status.state === 'pending' && status.device) {
        await pollerRef.current?.start(status.device);
      }
    };

    pollerRef.current = createCodexDevicePoller({
      startDevice: codex.start,
      pollDevice: codex.poll,
      cancelDevice: codex.cancel,
      onState: (state) => {
        if (!active) return;
        setDeviceState(state);
        setCopied(false);
        if (state.phase === 'pending') setProviderChoice('codex');
        const providerToPersist = providerPersistenceForCodexTransition(state.phase);
        if (providerToPersist) {
          setProviderChoice(providerToPersist);
          setCodexStatus({ connected: true, state: 'connected' });
          instanceSettings
            .patch({ suggestionProvider: providerToPersist })
            .then((updated) => {
              if (!active) return;
              onSettingsRef.current(updated);
              toastRef.current('ChatGPT connected');
            })
            .catch((error) => {
              if (active) toastRef.current(errMsg(error));
            });
          refreshStatus().catch(() => undefined);
        } else if (state.phase === 'failed') {
          setCodexStatus({
            connected: false,
            state: 'reconnect_required',
            reconnectRequired: true,
            reason: state.reason,
          });
        } else if (state.phase === 'cancelled' || state.phase === 'expired') {
          setCodexStatus({
            connected: false,
            state: 'disconnected',
            reconnectRequired: false,
          });
        }
      },
    });

    refreshStatus().catch((error) => {
      if (active) toastRef.current(errMsg(error));
    });
    return () => {
      active = false;
      pollerRef.current?.dispose();
      pollerRef.current = null;
    };
  }, []);

  const setSource = (source: SuggestionSetting) => {
    instanceSettings
      .patch({ suggestionSource: source })
      .then(onSettings)
      .catch((err) => toast(errMsg(err)));
  };

  const setProvider = (provider: SuggestionProvider) => {
    const decision = providerSelectionDecision(
      provider,
      providerChoice,
      codexStatusLoaded,
      connected,
    );
    setProviderChoice(decision.displayedProvider);
    if (!decision.providerToPersist) return;
    instanceSettings
      .patch({ suggestionProvider: decision.providerToPersist })
      .then(onSettings)
      .catch((err) => {
        setProviderChoice(settings.suggestionProvider);
        toast(errMsg(err));
      });
  };

  const saveEndpoint = () => {
    const value = aiUrl.trim();
    if (value === (settings.aiEndpoint ?? '')) return;
    instanceSettings
      .patch({ aiEndpoint: value === '' ? null : value })
      .then(onSettings)
      .catch((err) => toast(errMsg(err)));
  };

  const saveKey = () => {
    if (aiKey === '') return;
    instanceSettings
      .patch({ aiKey })
      .then((updated) => {
        onSettings(updated);
        setAiKey('');
      })
      .catch((err) => toast(errMsg(err)));
  };

  const saveModel = () => {
    const value = aiModel.trim();
    if (value === '' || value === settings.suggestionModel) return;
    instanceSettings
      .patch({ suggestionModel: value })
      .then((updated) => {
        onSettings(updated);
        setAiModel(updated.suggestionModel);
      })
      .catch((err) => toast(errMsg(err)));
  };

  const saveCodexModel = () => {
    const value = codexModel.trim();
    if (value === '' || value === settings.codexModel) return;
    instanceSettings
      .patch({ codexModel: value })
      .then((updated) => {
        onSettings(updated);
        setCodexModel(updated.codexModel);
      })
      .catch((err) => toast(errMsg(err)));
  };

  const saveOpenrouterKey = () => {
    if (openrouterKey === '') return;
    instanceSettings
      .patch({ openrouterApiKey: openrouterKey })
      .then((updated) => {
        onSettings(updated);
        setOpenrouterKey('');
      })
      .catch((err) => toast(errMsg(err)));
  };

  const saveOpenrouterMetadata = (field: 'openrouterReferer' | 'openrouterTitle', value: string) => {
    const trimmed = value.trim();
    if (trimmed === settings[field]) return;
    instanceSettings
      .patch({ [field]: trimmed })
      .then(onSettings)
      .catch((err) => toast(errMsg(err)));
  };

  const connectCodex = async () => {
    setConnecting(true);
    setDeviceState(null);
    setCopied(false);
    try {
      await pollerRef.current?.start();
      setCodexStatus({ connected: false, state: 'pending', reconnectRequired: false });
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setConnecting(false);
    }
  };

  const cancelCodex = async () => {
    setCancelling(true);
    try {
      await pollerRef.current?.cancel();
      setCodexStatus({ connected: false, state: 'disconnected', reconnectRequired: false });
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setCancelling(false);
    }
  };

  const disconnectCodex = async () => {
    setDisconnecting(true);
    try {
      await codex.disconnect();
      setDeviceState(null);
      setCodexStatus({ connected: false, state: 'disconnected', reconnectRequired: false });
      toast('ChatGPT disconnected');
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setDisconnecting(false);
    }
  };

  const testCodex = async () => {
    setTesting(true);
    try {
      await codex.test();
      toast('ChatGPT connection test passed');
    } catch (error) {
      toast(`ChatGPT connection test failed: ${errMsg(error)}`);
    } finally {
      setTesting(false);
    }
  };

  const copyCodexCode = async () => {
    if (deviceState?.phase !== 'pending') return;
    try {
      await navigator.clipboard.writeText(deviceState.userCode);
      setCopied(true);
    } catch {
      toast('Could not copy the authorization code');
    }
  };

  const connected = codexStatus.connected || deviceState?.phase === 'connected';
  const reconnectRequired =
    codexStatus.reconnectRequired === true ||
    codexStatus.state === 'reconnect_required' ||
    deviceState?.phase === 'failed';
  const pendingDevice = deviceState?.phase === 'pending' ? deviceState : null;
  const connectionLabel = connected
    ? 'Connected'
    : pendingDevice
      ? 'Waiting for authorization…'
      : reconnectRequired
        ? 'Reconnect required'
        : deviceState?.phase === 'expired'
          ? 'Authorization code expired'
          : deviceState?.phase === 'cancelled'
            ? 'Authorization cancelled'
            : 'Not connected';

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
        Category suggestions
        <InfoDot tip="How Recat pre-fills categories in the queue. Rules always win; the source chosen here fills in when no rule matches. Built-in uses your rules plus each payee's history — free, private, works offline." />
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--fnt)',
          }}
        >
          Source
          <select
            value={settings.suggestionSource}
            onChange={(e) => setSource(e.target.value as SuggestionSetting)}
            style={{
              border: '1px solid var(--bd)',
              borderRadius: 7,
              padding: '8px 10px',
              fontSize: 14,
              fontWeight: 500,
              background: 'var(--card)',
              color: 'var(--ink)',
              cursor: 'pointer',
            }}
          >
            <option value="builtin">Built-in — rules + payee history</option>
            <option value="ai">AI — choose a provider</option>
            <option value="off">Off — rules only</option>
          </select>
        </label>
      </div>
      {settings.suggestionSource === 'ai' && (
        <>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--fnt)' }}>
              Provider
              <select
                value={providerChoice}
                onChange={(e) => setProvider(e.target.value as SuggestionProvider)}
                style={{ border: '1px solid var(--bd)', borderRadius: 7, padding: '8px 10px', fontSize: 14, fontWeight: 500, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer' }}
              >
                <option value="custom">Custom</option>
                <option value="openrouter">OpenRouter</option>
                <option value="codex" disabled={!codexStatusLoaded}>
                  {codexStatusLoaded
                    ? 'ChatGPT subscription (Codex)'
                    : 'ChatGPT subscription (checking connection…)'}
                </option>
              </select>
            </label>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
              gap: 14,
              marginTop: 14,
            }}
          >
            {providerChoice === 'custom' && <div>
              <label
                style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}
              >
                Endpoint — OpenAI-compatible
              </label>
              <input
                className="input"
                value={aiUrl}
                onChange={(e) => setAiUrl(e.target.value)}
                onBlur={saveEndpoint}
                placeholder="https://api.openai.com/v1 · http://localhost:11434/v1 (Ollama)"
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
              />
            </div>}
            {providerChoice === 'custom' && <div>
              <label
                style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}
              >
                API key
              </label>
              <input
                className="input"
                type="password"
                value={aiKey}
                onChange={(e) => setAiKey(e.target.value)}
                onBlur={saveKey}
                placeholder={settings.aiKeySet ? '••••••••' : 'sk-…'}
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
              />
            </div>}
            {providerChoice === 'openrouter' && <>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}>
                  OpenRouter API key
                </label>
                <input
                  className="input"
                  type="password"
                  value={openrouterKey}
                  onChange={(e) => setOpenrouterKey(e.target.value)}
                  onBlur={saveOpenrouterKey}
                  placeholder={settings.openrouterKeySet ? '••••••••' : 'sk-or-…'}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}>
                  Referer (optional)
                </label>
                <input
                  className="input"
                  value={openrouterReferer}
                  onChange={(e) => setOpenrouterReferer(e.target.value)}
                  onBlur={() => saveOpenrouterMetadata('openrouterReferer', openrouterReferer)}
                  placeholder="https://your-instance.example"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}>
                  Title (optional)
                </label>
                <input
                  className="input"
                  value={openrouterTitle}
                  onChange={(e) => setOpenrouterTitle(e.target.value)}
                  onBlur={() => saveOpenrouterMetadata('openrouterTitle', openrouterTitle)}
                  placeholder="Recat QBO"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5 }}
                />
              </div>
            </>}
            {providerChoice !== 'codex' && <div>
              <label
                style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}
              >
                Model
              </label>
              <input
                className="input"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                onBlur={saveModel}
                placeholder={providerChoice === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'}
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
              />
            </div>}
            {providerChoice === 'codex' && <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--mut)' }}>
                  Codex model
                </label>
                <a
                  href="https://developers.openai.com/api/docs/models"
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11.5, color: 'var(--acc)' }}
                >
                  Available models
                </a>
              </div>
              <input
                className="input"
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                onBlur={saveCodexModel}
                placeholder="gpt-5.6-luna"
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
              />
            </div>}
          </div>
          {providerChoice === 'codex' && (
            <div
              style={{
                marginTop: 14,
                padding: '14px 16px',
                border: '1px solid var(--bd)',
                borderRadius: 8,
                background: 'var(--bg)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--mut)' }}>
                    ChatGPT connection
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      marginTop: 3,
                      color: connected ? 'var(--okT)' : reconnectRequired ? 'var(--erT)' : 'var(--ink)',
                    }}
                  >
                    {connectionLabel}
                  </div>
                  {connected && codexStatus.accountLabel && (
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Connected as {codexStatus.accountLabel}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {connected && (
                    <button
                      type="button"
                      onClick={testCodex}
                      disabled={testing}
                      style={{ border: '1px solid var(--bd)', background: 'var(--card)', borderRadius: 7, padding: '7px 11px', color: 'var(--ink)', font: 'inherit', fontSize: 12.5, cursor: testing ? 'default' : 'pointer', opacity: testing ? 0.6 : 1 }}
                    >
                      {testing ? 'Testing…' : 'Test'}
                    </button>
                  )}
                  {connected ? (
                    <button
                      type="button"
                      onClick={disconnectCodex}
                      disabled={disconnecting}
                      style={{ border: '1px solid var(--erD)', background: 'var(--erB)', borderRadius: 7, padding: '7px 11px', color: 'var(--erT)', font: 'inherit', fontSize: 12.5, cursor: disconnecting ? 'default' : 'pointer', opacity: disconnecting ? 0.6 : 1 }}
                    >
                      {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  ) : !pendingDevice ? (
                    <button
                      type="button"
                      onClick={connectCodex}
                      disabled={connecting}
                      style={{ border: 'none', background: 'var(--acc)', borderRadius: 7, padding: '8px 13px', color: '#fff', font: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: connecting ? 'default' : 'pointer', opacity: connecting ? 0.6 : 1 }}
                    >
                      {connecting
                        ? 'Starting…'
                        : reconnectRequired
                          ? 'Reconnect with ChatGPT'
                          : 'Sign in with ChatGPT'}
                    </button>
                  ) : null}
                </div>
              </div>

              {pendingDevice && (
                <div style={{ borderTop: '1px solid var(--bd)', marginTop: 13, paddingTop: 13 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginBottom: 9 }}>
                    Open the ChatGPT authorization page and enter this one-time code:
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <code style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', fontSize: 18, letterSpacing: 1.5, fontWeight: 700 }}>
                      {pendingDevice.userCode}
                    </code>
                    <button
                      type="button"
                      onClick={copyCodexCode}
                      style={{ border: '1px solid var(--bd)', background: 'var(--card)', borderRadius: 7, padding: '7px 10px', color: 'var(--ink)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}
                    >
                      {copied ? 'Copied' : 'Copy code'}
                    </button>
                    <a
                      href={pendingDevice.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ border: '1px solid var(--bd)', background: 'var(--card)', borderRadius: 7, padding: '7px 10px', color: 'var(--acc)', fontSize: 12.5, textDecoration: 'none' }}
                    >
                      Open authorization
                    </a>
                    <button
                      type="button"
                      onClick={cancelCodex}
                      disabled={cancelling}
                      style={{ border: '1px solid var(--bd)', background: 'transparent', borderRadius: 7, padding: '7px 10px', color: 'var(--mut)', font: 'inherit', fontSize: 12.5, cursor: cancelling ? 'default' : 'pointer' }}
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--mut)', marginTop: 8 }}>
                    Expires at {new Date(pendingDevice.expiresAt).toLocaleTimeString()}
                  </div>
                </div>
              )}

              {deviceState?.phase === 'error' && (
                <div style={{ fontSize: 12.5, color: 'var(--erT)', marginTop: 10 }}>
                  {deviceState.message}
                </div>
              )}
            </div>
          )}
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 10 }}>
            {providerChoice === 'openrouter'
              ? 'OpenRouter model IDs are vendor-qualified, for example openai/gpt-4o-mini. Referer and Title are optional attribution headers.'
              : providerChoice === 'codex'
                ? 'Uses your opt-in ChatGPT Plus/Pro Codex subscription. Recat keeps credentials encrypted and reduces the provider stream to one final category.'
                : 'Use an OpenAI-compatible /v1 endpoint, such as OpenAI, Ollama, LM Studio, or a compatible gateway.'}
            Only the payee, memo, amount, and your category list are sent — never full books.
          </div>
        </>
      )}
    </div>
  );
}
