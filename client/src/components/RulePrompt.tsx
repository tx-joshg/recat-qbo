// 'Always file X as Y?' bottom prompt after posting — port of Recat.dc.html
// lines 933–939.

export default function RulePrompt({
  payee,
  category,
  onCreate,
  onDismiss,
}: {
  payee: string;
  category: string;
  onCreate: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 26,
        transform: 'translateX(-50%)',
        zIndex: 24,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 14,
        background: 'var(--dark)',
        color: 'var(--darkInk)',
        borderRadius: 11,
        padding: '12px 18px',
        boxShadow: '0 12px 32px rgba(20,18,12,.35)',
        animation: 'rrup .18s ease-out',
        // Long payees stay on-screen at phone widths (wraps instead of nowrap).
        maxWidth: 'calc(100vw - 24px)',
        boxSizing: 'border-box',
      }}
    >
      <span style={{ fontSize: 14 }}>
        Always file <b>{payee}</b> as <b>{category}</b>?
      </span>
      <button
        onClick={onCreate}
        className="hov-acc"
        style={{
          background: 'var(--acc)',
          color: '#fff',
          border: 'none',
          borderRadius: 7,
          padding: '8px 14px',
          fontSize: 13.5,
          fontWeight: 600,
          cursor: 'pointer',
          font: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        Create rule
      </button>
      <button
        onClick={onDismiss}
        className="hov-full"
        style={{
          border: 'none',
          background: 'none',
          color: 'var(--darkInk)',
          opacity: 0.55,
          fontSize: 13,
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
