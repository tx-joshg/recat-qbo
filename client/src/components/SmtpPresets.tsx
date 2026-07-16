// Quick-fill chip row for common SMTP providers, shared by the Setup wizard
// email step and the Settings email card. Selection is derived from the
// current host value, so manually editing the host clears the highlight.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { SMTP_PROVIDERS } from '../lib/smtpProviders';
import type { SmtpProvider } from '../lib/smtpProviders';

const chipBase: CSSProperties = {
  border: '1px solid var(--bd2)',
  background: 'var(--hl)',
  color: 'var(--mut)',
  borderRadius: 99,
  padding: '4px 11px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export default function SmtpPresets({
  host,
  onPick,
}: {
  /** Current SMTP host value — a chip is highlighted only while the host matches it. */
  host: string;
  onPick: (provider: SmtpProvider) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = SMTP_PROVIDERS.find((p) => p.host === host.trim()) ?? null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--fnt)' }}>Quick fill:</span>
        {SMTP_PROVIDERS.map((p) => {
          const isSelected = selected?.id === p.id;
          const isHovered = hovered === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                ...chipBase,
                ...(isHovered && !isSelected
                  ? { color: 'var(--ink)', borderColor: 'var(--fnt)' }
                  : null),
                ...(isSelected
                  ? { border: '1px solid var(--acc)', background: 'var(--okB)', color: 'var(--ink)' }
                  : null),
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {selected && (
        <div style={{ fontSize: 12.5, color: 'var(--fnt)', lineHeight: 1.5, marginTop: 8 }}>
          {selected.hint}
          {selected.docsUrl && (
            <>
              {' '}
              <a
                href={selected.docsUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--acc)' }}
              >
                docs →
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
