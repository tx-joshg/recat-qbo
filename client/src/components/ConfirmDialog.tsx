// In-app confirmation dialog — the app never uses browser-native popups.
// Overlay + card styled like the split editor's modal (Recat.dc.html §split
// editor): rgba scrim, 12px-radius card, Spectral title, ghost cancel +
// danger/primary confirm.

import { useEffect, useId, useRef } from 'react';
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
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const cancelHandlerRef = useRef(onCancel);
  busyRef.current = busy;
  cancelHandlerRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialFocus = cancelRef.current?.disabled ? dialogRef.current : cancelRef.current;
    initialFocus?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busyRef.current) cancelHandlerRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const focusIsOutsideTabOrder = !focusable.some((element) => element === document.activeElement);
      if (e.shiftKey && (document.activeElement === first || focusIsOutsideTabOrder)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || focusIsOutsideTabOrder)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-testid="confirm-dialog-backdrop"
      onClick={() => { if (!busy) onCancel(); }}
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
        .rr .cfm-cancel:not(:disabled):not([aria-disabled="true"]):hover { color: var(--ink); }
        .rr .cfm-danger:not(:disabled):not([aria-disabled="true"]):hover { background: var(--erB); }
        .rr .cfm-primary:not(:disabled):not([aria-disabled="true"]):hover { background: var(--accH); }
      `}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
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
        <div id={titleId} style={{ fontFamily: "'Spectral',serif", fontSize: 20, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', margin: '8px 0 0', lineHeight: 1.55 }}>
          {children}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
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
              opacity: busy ? 0.6 : 1,
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
