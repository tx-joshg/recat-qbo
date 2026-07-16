// Tags screen — Recat-only labels with palette/custom colors, inline rename,
// usage counts, delete, and an add-tag footer row.
// Layout/styles copied verbatim from design_handoff_recat/Recat.dc.html lines
// 548–586; interaction logic mirrors renderVals() lines 1505–1525.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { TagDto } from '@recat/shared';
import { tags as tagsApi } from '../lib/api';
import { useApp } from '../state/AppContext';
import { InfoDot } from '../components/ui';

const TAGS_TIP =
  "Tags live only in Recat — they're never written back to QuickBooks, so you don't need Intuit's class-tracking plan. A transaction can carry as many tags as you want. Deleting a tag removes it from every transaction; the transactions themselves are untouched.";

// 8-color palette + free color picker — README §Design Tokens / prototype this.palette.
const PALETTE = ['#2f5d50', '#8a6d1f', '#a13b2e', '#3e5c76', '#7d5ba6', '#b05a7a', '#5a7d2a', '#6d685c'];

const DEFAULT_NEW_COLOR = '#3e5c76';

// Grid columns per prototype: header/rows `240px 1fr 140px 40px`, add-row
// `240px 1fr 130px`; both collapse to 1fr ≤640px (tagsGridCols / tagsAddCols).
const TAGS_CSS = `
.rr .tags-head{display:grid;grid-template-columns:240px 1fr 140px 40px;gap:0 16px;padding:10px 20px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--fnt);border-bottom:1px solid var(--bd2);}
.rr .tags-row{display:grid;grid-template-columns:240px 1fr 140px 40px;gap:8px 16px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--rowbd);}
.rr .tags-add{display:grid;grid-template-columns:240px 1fr 130px;gap:8px 16px;align-items:center;padding:14px 20px;background:var(--hl);border-radius:0 0 10px 10px;}
.rr .tags-inline-input{font-size:14.5px;font-weight:500;border:1px solid transparent;border-radius:6px;padding:5px 8px;margin-left:-9px;background:transparent;color:var(--ink);outline:none;font-family:inherit;width:100%;box-sizing:border-box;}
.rr .tags-inline-input:hover{border-color:var(--bd);}
.rr .tags-inline-input:focus{border-color:var(--acc);background:var(--card);}
.rr .tags-add-input{font-size:14.5px;border:1px solid var(--bd);border-radius:7px;padding:8px 12px;background:var(--card);color:var(--ink);outline:none;font-family:inherit;width:100%;box-sizing:border-box;}
.rr .tags-add-input:focus{border-color:var(--acc);}
.rr .tags-add-btn{background:var(--acc);color:#fff;border:none;border-radius:7px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;font:inherit;justify-self:end;}
.rr .tags-add-btn:hover{background:var(--accH);}
.rr .tags-del:hover{color:var(--erT);}
.rr .tags-meta{display:contents;}
@media (max-width:640px){
.rr .tags-head{display:none;}
.rr .tags-row,.rr .tags-add{grid-template-columns:1fr;}
.rr .tags-meta{display:flex;align-items:center;justify-content:space-between;}
}
`;

// Delete × — same style as the rules screen (prototype line 571).
const delStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--fnt)',
  fontSize: 16,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const RAINBOW = 'conic-gradient(#e5484d,#e2a336,#5bb98b,#3e63dd,#8e4ec6,#e5484d)';

function ring(color: string): string {
  return `inset 0 0 0 2px var(--card), 0 0 0 2px ${color}`;
}

/** Palette dots + rainbow custom-picker dot (prototype lines 563–568 / 575–580). */
function ColorDots({
  current,
  onPick,
  onCustom,
}: {
  current: string;
  onPick: (color: string) => void;
  onCustom: (color: string) => void;
}) {
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {PALETTE.map((cl) => (
        <button
          key={cl}
          onClick={() => onPick(cl)}
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            background: cl,
            boxShadow: cl === current ? ring(cl) : 'none',
          }}
        />
      ))}
      <span
        data-tip="Any color — click to open the color picker"
        style={{
          position: 'relative',
          width: 16,
          height: 16,
          flex: 'none',
          display: 'inline-block',
          borderRadius: '50%',
          background: RAINBOW,
          boxShadow: PALETTE.includes(current) ? 'none' : ring(current),
        }}
      >
        <input
          type="color"
          value={current}
          onChange={(e) => onCustom(e.target.value)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: 'pointer',
          }}
        />
      </span>
    </span>
  );
}

const NAME_DEBOUNCE_MS = 500;
const COLOR_DEBOUNCE_MS = 300;

export default function Tags() {
  const { activeCompanyId, tags, refreshTags, toast } = useApp();

  // Optimistic color overrides so the selected ring moves instantly; the
  // context list catches up after refreshTags().
  const [colorOverride, setColorOverride] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_NEW_COLOR);

  const nameTimers = useRef(new Map<string, number>());
  const pendingName = useRef(new Map<string, string>());
  const colorTimers = useRef(new Map<string, number>());

  useEffect(() => {
    setColorOverride({});
  }, [activeCompanyId]);

  // Clear pending debounce timers on unmount.
  useEffect(() => {
    const nt = nameTimers.current;
    const ct = colorTimers.current;
    return () => {
      for (const t of nt.values()) window.clearTimeout(t);
      for (const t of ct.values()) window.clearTimeout(t);
    };
  }, []);

  // `revert` undoes the caller's optimistic update when the PATCH fails.
  const patchTag = useCallback(
    (tagId: string, body: { name?: string; color?: string }, revert?: () => void) => {
      if (!activeCompanyId) return;
      tagsApi
        .patch(activeCompanyId, tagId, body)
        .then(() => refreshTags())
        .catch((err: Error) => {
          revert?.();
          toast(err.message);
        });
    },
    [activeCompanyId, refreshTags, toast],
  );

  const commitName = useCallback(
    (tag: TagDto) => {
      const timer = nameTimers.current.get(tag.id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        nameTimers.current.delete(tag.id);
      }
      const value = pendingName.current.get(tag.id);
      pendingName.current.delete(tag.id);
      if (value === undefined || value === tag.name) return;
      patchTag(tag.id, { name: value });
    },
    [patchTag],
  );

  const onNameChange = useCallback(
    (tag: TagDto, value: string) => {
      pendingName.current.set(tag.id, value);
      const existing = nameTimers.current.get(tag.id);
      if (existing !== undefined) window.clearTimeout(existing);
      nameTimers.current.set(
        tag.id,
        window.setTimeout(() => commitName(tag), NAME_DEBOUNCE_MS),
      );
    },
    [commitName],
  );

  // On PATCH failure, drop the optimistic override so the true server color shows.
  const clearOverride = useCallback((tagId: string) => {
    setColorOverride((prev) => {
      const { [tagId]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  // Palette dot click — instant PATCH.
  const pickColor = useCallback(
    (tag: TagDto, color: string) => {
      setColorOverride((prev) => ({ ...prev, [tag.id]: color }));
      patchTag(tag.id, { color }, () => clearOverride(tag.id));
    },
    [patchTag, clearOverride],
  );

  // Custom picker — the input fires continuously while dragging, so the PATCH
  // is debounced; the swatch ring updates instantly from the override.
  const pickCustomColor = useCallback(
    (tag: TagDto, color: string) => {
      setColorOverride((prev) => ({ ...prev, [tag.id]: color }));
      const existing = colorTimers.current.get(tag.id);
      if (existing !== undefined) window.clearTimeout(existing);
      colorTimers.current.set(
        tag.id,
        window.setTimeout(() => patchTag(tag.id, { color }, () => clearOverride(tag.id)), COLOR_DEBOUNCE_MS),
      );
    },
    [patchTag, clearOverride],
  );

  const deleteTag = useCallback(
    (tag: TagDto) => {
      if (!activeCompanyId) return;
      tagsApi
        .del(activeCompanyId, tag.id)
        .then(() => {
          toast(`Deleted tag "${tag.name}"`);
          return refreshTags();
        })
        .catch((err: Error) => toast(err.message));
    },
    [activeCompanyId, refreshTags, toast],
  );

  const addTag = useCallback(() => {
    if (!activeCompanyId) return;
    if (!newName.trim()) {
      toast('Name the tag first');
      return;
    }
    tagsApi
      .create(activeCompanyId, { name: newName.trim(), color: newColor })
      .then(() => {
        setNewName('');
        return refreshTags();
      })
      .catch((err: Error) => toast(err.message));
  }, [activeCompanyId, newName, newColor, refreshTags, toast]);

  const rows = useMemo(
    () => tags.map((t) => ({ tag: t, color: colorOverride[t.id] ?? t.color })),
    [tags, colorOverride],
  );

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      <style>{TAGS_CSS}</style>
      <div style={{ marginBottom: 18 }}>
        <div className="page-title">Tags</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 14,
            color: 'var(--fnt)',
            marginTop: 4,
          }}
        >
          Private labels for locations, projects, owners — anything.
          <InfoDot tip={TAGS_TIP} />
        </div>
      </div>
      <div className="card">
        <div className="tags-head">
          <span>Color</span>
          <span>Tag</span>
          <span style={{ textAlign: 'right' }}>Used on</span>
          <span></span>
        </div>
        {rows.map(({ tag, color }) => (
          <div key={tag.id} className="tags-row">
            <ColorDots
              current={color}
              onPick={(cl) => pickColor(tag, cl)}
              onCustom={(cl) => pickCustomColor(tag, cl)}
            />
            <input
              defaultValue={tag.name}
              onChange={(e) => onNameChange(tag, e.target.value)}
              onBlur={() => commitName(tag)}
              className="tags-inline-input"
            />
            <span className="tags-meta">
              <span style={{ textAlign: 'right', fontSize: 13, color: 'var(--fnt)' }}>
                {tag.usageCount ?? 0} transactions
              </span>
              <button
                className="tags-del"
                onClick={() => deleteTag(tag)}
                data-tip="Delete tag (removes it from all transactions)"
                style={delStyle}
              >
                ×
              </button>
            </span>
          </div>
        ))}
        <div className="tags-add">
          <ColorDots current={newColor} onPick={setNewColor} onCustom={setNewColor} />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New tag name…"
            className="tags-add-input"
          />
          <button className="tags-add-btn" onClick={addTag}>
            Add tag
          </button>
        </div>
      </div>
    </div>
  );
}
