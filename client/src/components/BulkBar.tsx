// Fixed dark bulk-action bar shown while rows are selected — port of
// Recat.dc.html lines 386–407. The bulk CategoryPicker is passed in as a node
// so the Queue page keeps ownership of picker state.

import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

const stop = (e: MouseEvent) => e.stopPropagation();

export default function BulkBar({
  count,
  label,
  btnOpacity,
  onOpenPicker,
  onPost,
  onClear,
  picker,
}: {
  count: number;
  /** 'Assign one category…' or the chosen full category path. */
  label: string;
  /** 1 when at least one selected row is ready, otherwise .45 (prototype). */
  btnOpacity: number;
  onOpenPicker: (e: MouseEvent) => void;
  onPost: () => void;
  onClear: () => void;
  /** The open bulk CategoryPicker (positioned above), or null. */
  picker: ReactNode;
}) {
  // ≤640px the row layout can't fit (230px picker + post button + esc), so the
  // bar stacks into a column. Same matchMedia pattern as Nav/Queue/Dashboard.
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const fn = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const escBtn = (
    <button
      onClick={onClear}
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
      esc
    </button>
  );

  return (
    <div
      onClick={stop}
      onMouseDown={stop}
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 26,
        transform: 'translateX(-50%)',
        zIndex: 25,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: 'var(--dark)',
        color: 'var(--darkInk)',
        borderRadius: 11,
        padding: '12px 18px',
        boxShadow: '0 12px 32px rgba(20,18,12,.35)',
        animation: 'rrup .18s ease-out',
        ...(isMobile
          ? {
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 10,
              width: 'calc(100vw - 24px)',
              maxWidth: 560,
              boxSizing: 'border-box',
            }
          : {}),
      }}
    >
      {isMobile ? (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {count} selected
          </span>
          {escBtn}
        </span>
      ) : (
        <>
          <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{count} selected</span>
          <span style={{ width: 1, height: 22, background: 'rgba(128,128,128,.35)' }} />
        </>
      )}
      <span style={{ position: 'relative', ...(isMobile ? { display: 'block' } : {}) }}>
        <button
          onClick={onOpenPicker}
          style={{
            border: '1px solid rgba(128,128,128,.45)',
            background: 'none',
            borderRadius: 7,
            padding: '8px 12px',
            fontSize: 14,
            color: 'var(--darkInk)',
            minWidth: 230,
            textAlign: 'left',
            cursor: 'pointer',
            font: 'inherit',
            ...(isMobile ? { width: '100%', minWidth: 0, boxSizing: 'border-box' } : {}),
          }}
        >
          {label}
        </button>
        {picker}
      </span>
      <button
        onClick={onPost}
        style={{
          background: 'var(--acc)',
          color: '#fff',
          border: 'none',
          borderRadius: 7,
          padding: '9px 16px',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          font: 'inherit',
          whiteSpace: 'nowrap',
          opacity: btnOpacity,
          ...(isMobile ? { width: '100%' } : {}),
        }}
      >
        Post {count} transactions
      </button>
      {!isMobile && escBtn}
    </div>
  );
}
