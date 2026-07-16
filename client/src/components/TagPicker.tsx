// Tag checkbox popup for a queue row — port of Recat.dc.html lines 268–278
// (desktop, with 'Manage tags →' footer) and 337–343 (mobile, no footer).

import type { MouseEvent } from 'react';
import type { TagDto } from '@recat/shared';

const stop = (e: MouseEvent) => e.stopPropagation();

export default function TagPicker({
  tags,
  selectedIds,
  onToggle,
  onManage,
  width,
}: {
  tags: TagDto[];
  selectedIds: string[];
  onToggle: (tagId: string) => void;
  /** 'Manage tags →' footer (desktop only in the prototype). */
  onManage?: () => void;
  /** 230 on desktop, 'min(230px,86vw)' on mobile. */
  width: string | number;
}) {
  return (
    <span
      onClick={stop}
      onMouseDown={stop}
      style={{
        position: 'absolute',
        zIndex: 16,
        top: 'calc(100% + 6px)',
        left: 0,
        width,
        background: 'var(--card)',
        border: '1px solid var(--bd)',
        borderRadius: 9,
        boxShadow: 'var(--sh)',
        display: 'block',
        overflow: 'hidden',
      }}
    >
      {tags.map((tag) => (
        <button
          key={tag.id}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(tag.id);
          }}
          className="hov-hl"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            width: '100%',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            padding: '9px 13px',
            font: 'inherit',
            fontSize: 13.5,
            color: 'var(--ink)',
            textAlign: 'left',
          }}
        >
          <input
            type="checkbox"
            checked={selectedIds.includes(tag.id)}
            readOnly
            style={{ width: 14, height: 14, accentColor: 'var(--acc)', pointerEvents: 'none' }}
          />
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: tag.color,
              display: 'inline-block',
            }}
          />
          {tag.name}
        </button>
      ))}
      {onManage && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onManage();
          }}
          className="hov-hl"
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 'none',
            borderTop: '1px solid var(--bd2)',
            background: 'none',
            padding: '9px 13px',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--acc)',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Manage tags →
        </button>
      )}
    </span>
  );
}
