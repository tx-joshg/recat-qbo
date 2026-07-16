// Settings — "Density" card. Per-user, per-browser row-density preference for
// the queue (persisted in localStorage via AppContext); shown to every role.

import type { Density } from '../../state/AppContext';
import { useApp } from '../../state/AppContext';

const OPTIONS: { value: Density; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

export default function DensityCard() {
  const { density, setDensity } = useApp();

  return (
    <div
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Density</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
          Row spacing in the queue. Compact fits more transactions on screen.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setDensity(o.value)}
            style={{
              border: `1.5px solid ${density === o.value ? 'var(--acc)' : 'var(--bd2)'}`,
              background: 'var(--card)',
              color: 'var(--ink)',
              borderRadius: 7,
              padding: '8px 14px',
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
