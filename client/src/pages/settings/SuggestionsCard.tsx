// Settings — "Category suggestions" card (Recat.dc.html lines 830–852).
// Source select (built-in / AI / off); when AI, endpoint + key saved on blur.

import { useState } from 'react';
import type { InstanceSettingsDto, SuggestionProvider, SuggestionSetting } from '@recat/shared';
import { instanceSettings } from '../../lib/api';
import { InfoDot } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';

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

  const setSource = (source: SuggestionSetting) => {
    instanceSettings
      .patch({ suggestionSource: source })
      .then(onSettings)
      .catch((err) => toast(errMsg(err)));
  };

  const setProvider = (provider: SuggestionProvider) => {
    instanceSettings
      .patch({ suggestionProvider: provider })
      .then(onSettings)
      .catch((err) => toast(errMsg(err)));
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
            <option value="ai">AI — your own endpoint</option>
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
                value={settings.suggestionProvider}
                onChange={(e) => setProvider(e.target.value as SuggestionProvider)}
                style={{ border: '1px solid var(--bd)', borderRadius: 7, padding: '8px 10px', fontSize: 14, fontWeight: 500, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer' }}
              >
                <option value="custom">Custom</option>
                <option value="openrouter">OpenRouter</option>
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
            {settings.suggestionProvider === 'custom' && <div>
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
            {settings.suggestionProvider === 'custom' && <div>
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
            {settings.suggestionProvider === 'openrouter' && <>
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
            <div>
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
                placeholder={settings.suggestionProvider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'}
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13.5, fontFamily: 'monospace' }}
              />
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 10 }}>
            {settings.suggestionProvider === 'openrouter'
              ? 'OpenRouter model IDs are vendor-qualified, for example openai/gpt-4o-mini. Referer and Title are optional attribution headers.'
              : 'Use an OpenAI-compatible /v1 endpoint, such as OpenAI, Ollama, LM Studio, or a compatible gateway.'}
            Only the payee, memo, amount, and your category list are sent — never full books.
          </div>
        </>
      )}
    </div>
  );
}
