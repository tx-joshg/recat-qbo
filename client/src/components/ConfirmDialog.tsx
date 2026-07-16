// In-app confirmation dialog — the app never uses browser-native popups.
// Overlay + card styled like the split editor's modal (Recat.dc.html §split
// editor): rgba scrim, 12px-radius card, Spectral title, ghost cancel +
// danger/primary confirm.

import { useEffect } from 'react';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — strings or rich content. */
  children: ReactNode;
  confirmLabel: string;
  /** 'danger' = red outline action (destructive), 'primary' = green solid. */
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(20,18,12,.45)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <style>{`
        .rr .cfm-cancel:hover { color: var(--ink); }
        .rr .cfm-danger:hover { background: var(--erB); }
        .rr .cfm-primary:hover { background: var(--accH); }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '100%',
          background: 'var(--card)',
          border: '1px solid var(--bd)',
          borderRadius: 12,
          boxShadow: 'var(--sh)',
          padding: '22px 24px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontFamily: "'Spectral',serif", fontSize: 20, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', margin: '8px 0 0', lineHeight: 1.55 }}>
          {children}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button
            onClick={onCancel}
            className="cfm-cancel"
            style={{
              border: '1px solid var(--bd)',
              background: 'var(--card)',
              color: 'var(--mut)',
              borderRadius: 7,
              padding: '9px 16px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={tone === 'danger' ? 'cfm-danger' : 'cfm-primary'}
            style={
              tone === 'danger'
                ? {
                    border: '1px solid var(--erD)',
                    background: 'none',
                    color: 'var(--erT)',
                    borderRadius: 7,
                    padding: '9px 16px',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    opacity: busy ? 0.6 : 1,
                  }
                : {
                    border: 'none',
                    background: 'var(--acc)',
                    color: '#fff',
                    borderRadius: 7,
                    padding: '9px 18px',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    opacity: busy ? 0.6 : 1,
                  }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
