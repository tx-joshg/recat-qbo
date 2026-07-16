// Category picker popup — port of Recat.dc.html lines 288–299 (row, desktop),
// 349–359 (row, mobile) and 393–402 (bulk bar). Every inline style value is
// copied verbatim from the prototype. The parent owns the query / active index
// state so the Queue keyboard handler can drive ↑↓/Enter.

import { useEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent } from 'react';

export interface CategoryOption {
  group: string;
  name: string;
  /** true → right-aligned green "suggested" badge (desktop rows only). */
  sug: boolean;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export default function CategoryPicker({
  query,
  onQueryChange,
  options,
  empty,
  activeIdx,
  onPick,
  onSplitFooter,
  showBadges,
  containerStyle,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  /** Already limited to 40 by the caller, like the prototype's opts.slice(0, 40). */
  options: CategoryOption[];
  /** true when the unsliced filtered list is empty → 'No matching categories'. */
  empty: boolean;
  activeIdx: number;
  onPick: (name: string) => void;
  /** 'Split into multiple categories →' footer; omitted for the bulk picker. */
  onSplitFooter?: () => void;
  /** Desktop row picker shows the suggested badge; mobile/bulk render plain rows. */
  showBadges: boolean;
  /** Positioning overrides (top/bottom, z-index, width, color). */
  containerStyle: CSSProperties;
}) {
  const listRef = useRef<HTMLSpanElement>(null);

  // Keep the keyboard-active option in view (prototype's listRef scroll behavior).
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  return (
    <span
      onClick={stop}
      onMouseDown={stop}
      style={{
        position: 'absolute',
        left: 0,
        background: 'var(--card)',
        border: '1px solid var(--bd)',
        borderRadius: 9,
        boxShadow: 'var(--sh)',
        overflow: 'hidden',
        display: 'block',
        ...containerStyle,
      }}
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search categories…"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          border: 'none',
          borderBottom: '1px solid var(--bd2)',
          padding: '11px 14px',
          fontSize: 14,
          background: 'var(--card)',
          color: 'var(--ink)',
          outline: 'none',
        }}
      />
      <span ref={listRef} style={{ display: 'block', maxHeight: 246, overflow: 'auto' }}>
        {options.map((o, i) =>
          showBadges ? (
            <button
              key={`${o.group}·${o.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onPick(o.name);
              }}
              className="hov-hl"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                cursor: 'pointer',
                padding: '9px 14px',
                fontSize: 14,
                font: 'inherit',
                background: i === activeIdx ? 'var(--hl)' : 'transparent',
                color: 'var(--ink)',
              }}
            >
              <span>
                <span style={{ color: 'var(--fnt)' }}>{o.group} · </span>
                {o.name}
              </span>
              {o.sug && (
                <span style={{ fontSize: 11.5, color: 'var(--okT)', fontWeight: 600 }}>
                  suggested
                </span>
              )}
            </button>
          ) : (
            <button
              key={`${o.group}·${o.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onPick(o.name);
              }}
              className="hov-hl"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                cursor: 'pointer',
                padding: '9px 14px',
                fontSize: 14,
                font: 'inherit',
                background: i === activeIdx ? 'var(--hl)' : 'transparent',
                color: 'var(--ink)',
              }}
            >
              <span style={{ color: 'var(--fnt)' }}>{o.group} · </span>
              {o.name}
            </button>
          ),
        )}
        {empty && (
          <span style={{ display: 'block', padding: '12px 14px', fontSize: 13.5, color: 'var(--fnt)' }}>
            No matching categories
          </span>
        )}
      </span>
      {onSplitFooter && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSplitFooter();
          }}
          className="hov-hl"
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 'none',
            borderTop: '1px solid var(--bd2)',
            background: 'none',
            padding: '9px 14px',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--acc)',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Split into multiple categories →
        </button>
      )}
    </span>
  );
}
