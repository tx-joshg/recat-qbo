// Single bottom-center toast — port of Recat.dc.html line 943. Driven from AppContext.

import { useApp } from '../state/AppContext';

export default function Toast() {
  const { activeToast } = useApp();
  if (!activeToast) return null;
  return (
    <div
      key={activeToast.id}
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 88,
        transform: 'translateX(-50%)',
        zIndex: 60,
        background: 'var(--dark)',
        color: 'var(--darkInk)',
        borderRadius: 9,
        padding: '11px 18px',
        fontSize: 14,
        fontWeight: 500,
        boxShadow: '0 12px 32px rgba(20,18,12,.35)',
        animation: 'rrup .18s ease-out',
        pointerEvents: 'none',
        // Long messages stay on-screen at phone widths.
        maxWidth: 'calc(100vw - 24px)',
        width: 'max-content',
        textAlign: 'center',
        boxSizing: 'border-box',
      }}
    >
      {activeToast.msg}
    </div>
  );
}
