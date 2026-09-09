// Split-transaction modal — port of Recat.dc.html lines 895–930 (markup) and
// 1553–1582 (logic). The draft lives here (the component mounts fresh each time
// the editor opens); amounts are edited as absolute values like the prototype.

import { useState } from 'react';
import type { MouseEvent } from 'react';
import type {
  TagDto,
  TaxCalculation,
  TaxReadinessDto,
  TransactionDto,
} from '@recat/shared';
import { useApp } from '../state/AppContext';
import { fmtMoney } from '../lib/format';
import TaxCodePicker, { usableTaxCodesForDirection } from './TaxCodePicker';
import type { TaxDirection } from './TaxCodePicker';

export interface SplitLineDraft {
  amt: string;
  cat: string;
  tags: string[];
  memo: string;
  taxCodeQboId: string | null;
}

export interface SplitCatOpt {
  group: string;
  name: string;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export default function SplitEditor({
  txn,
  tags,
  catOpts,
  taxReadiness = null,
  onClose,
  onSave,
}: {
  txn: TransactionDto;
  tags: TagDto[];
  catOpts: SplitCatOpt[];
  taxReadiness?: TaxReadinessDto | null;
  onClose: () => void;
  onSave: (lines: SplitLineDraft[], taxCalculation?: TaxCalculation) => void;
}) {
  const { toast } = useApp();
  const sourceAmount = txn.sourceGrossCents === undefined ? txn.amount : txn.sourceGrossCents / 100;
  const total = Math.abs(sourceAmount);
  const taxDirection: TaxDirection | null = txn.qboType === 'Purchase'
    ? 'purchase'
    : txn.qboType === 'Deposit'
      ? 'sales'
      : null;
  const taxEnabled = taxDirection !== null && (
    taxDirection === 'purchase'
      ? taxReadiness?.status === 'ready'
      : taxReadiness?.salesStatus === 'ready'
  );
  const taxLabel = taxDirection === 'sales' ? 'Sales tax' : 'Purchase tax';
  const [taxCalculation, setTaxCalculation] = useState<TaxCalculation>(
    txn.taxCalculation === 'TaxExcluded'
      ? 'TaxExcluded'
      : txn.taxCalculation === 'TaxInclusive'
        ? 'TaxInclusive'
        : 'NotApplicable',
  );

  // Prototype openSplit(): existing splits load as-is; a categorized (or blank)
  // row seeds line 1 = full amount with current cat/tags + line 2 = 0.00.
  const [draft, setDraft] = useState<SplitLineDraft[]>(() =>
    txn.splits && txn.splits.length
      ? txn.splits.map((sp) => ({
          amt: Math.abs(sp.amount).toFixed(2),
          cat: sp.category,
          tags: [...sp.tagIds],
          memo: sp.memo ?? '',
          taxCodeQboId: sp.taxCodeQboId ?? null,
        }))
      : [
          {
            amt: total.toFixed(2),
            cat: txn.category ?? '',
            tags: [...txn.tagIds],
            memo: txn.memo ?? '',
            taxCodeQboId: txn.taxCodeQboId ?? null,
          },
          { amt: '0.00', cat: '', tags: [], memo: '', taxCodeQboId: null },
        ],
  );

  const sum = draft.reduce((a, l) => a + (parseFloat(l.amt) || 0), 0);
  const remain = total - sum;
  const selectedTaxCount = draft.filter((line) => line.taxCodeQboId !== null).length;
  const usableTaxCodeIds = new Set(
    taxDirection === null
      ? []
      : usableTaxCodesForDirection(taxReadiness, taxDirection).map((code) => code.qboId),
  );
  const hasInvalidTaxCode = taxEnabled && draft.some(
    (line) => line.taxCodeQboId !== null && !usableTaxCodeIds.has(line.taxCodeQboId),
  );
  const validTax =
    !taxEnabled ||
    selectedTaxCount === 0 ||
    (
      selectedTaxCount === draft.length &&
      taxCalculation !== 'NotApplicable' &&
      !hasInvalidTaxCode
    );
  const valid =
    Math.abs(remain) < 0.005 &&
    draft.every((l) => l.cat && (parseFloat(l.amt) || 0) > 0) &&
    validTax;

  const upd = (i: number, patch: Partial<SplitLineDraft>) =>
    setDraft((d) => d.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const remainLabel =
    Math.abs(remain) < 0.005
      ? '✓ fully assigned'
      : '$' + Math.abs(remain).toFixed(2) + (remain > 0 ? ' left to assign' : ' over the total');
  const remainColor =
    Math.abs(remain) < 0.005 ? 'var(--okT)' : remain < 0 ? 'var(--erT)' : 'var(--amT)';

  return (
    <div
      onClick={onClose}
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
      <div
        onClick={stop}
        onMouseDown={stop}
        style={{
          width: 560,
          maxWidth: '100%',
          maxHeight: '86vh',
          overflow: 'auto',
          background: 'var(--card)',
          border: '1px solid var(--bd)',
          borderRadius: 12,
          boxShadow: 'var(--sh)',
          padding: '22px 24px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontFamily: "'Spectral',serif", fontSize: 20, fontWeight: 500 }}>
          Split transaction
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', margin: '4px 0 16px' }}>
          {txn.payee} · {fmtMoney(sourceAmount)} — assign every dollar to a category.
        </div>
        {taxEnabled && (
          <span style={{ display: 'block', marginBottom: 12 }}>
            <label
              htmlFor={`split-tax-calculation-${txn.id}`}
              style={{ display: 'block', fontSize: 12, color: 'var(--mut)', marginBottom: 4 }}
            >
              Tax calculation for split
            </label>
            <select
              id={`split-tax-calculation-${txn.id}`}
              className="select"
              value={taxCalculation === 'TaxExcluded' ? 'TaxExcluded' : 'TaxInclusive'}
              onChange={(event) => setTaxCalculation(event.target.value as TaxCalculation)}
            >
              <option value="TaxInclusive">Tax inclusive</option>
              <option value="TaxExcluded">Tax exclusive</option>
            </select>
          </span>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.map((l, i) => (
            <div key={i} style={{ border: '1px solid var(--bd2)', borderRadius: 9, padding: '12px 14px' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  aria-label={`Amount for split line ${i + 1}`}
                  value={l.amt}
                  onChange={(e) => upd(i, { amt: e.target.value })}
                  className="foc-acc"
                  style={{
                    width: 92,
                    boxSizing: 'border-box',
                    textAlign: 'right',
                    border: '1px solid var(--bd)',
                    borderRadius: 7,
                    padding: '8px 10px',
                    fontSize: 14,
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    outline: 'none',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                />
                <select
                  aria-label={`Category for split line ${i + 1}`}
                  value={l.cat}
                  onChange={(e) => upd(i, { cat: e.target.value })}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: '1px solid var(--bd)',
                    borderRadius: 7,
                    padding: '8px 10px',
                    fontSize: 13.5,
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    cursor: 'pointer',
                  }}
                >
                  <option value="">Category…</option>
                  {catOpts.map((c) => (
                    <option key={`${c.group}·${c.name}`} value={c.name}>
                      {c.group} · {c.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    setDraft((d) => (d.length > 1 ? d.filter((_, j) => j !== i) : d))
                  }
                  data-tip="Remove line"
                  className="hov-del"
                  style={{
                    border: 'none',
                    background: 'none',
                    color: 'var(--fnt)',
                    fontSize: 16,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  ×
                </button>
              </div>
              {taxEnabled && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                    gap: 10,
                    marginTop: 9,
                  }}
                >
                  <span style={{ display: 'block' }}>
                    <label
                      htmlFor={`split-memo-${txn.id}-${i}`}
                      style={{ display: 'block', fontSize: 12, color: 'var(--mut)', marginBottom: 4 }}
                    >
                      Memo for split line {i + 1}
                    </label>
                    <input
                      id={`split-memo-${txn.id}-${i}`}
                      className="input"
                      value={l.memo}
                      maxLength={500}
                      onChange={(event) => upd(i, { memo: event.target.value })}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                  </span>
                  <TaxCodePicker
                    id={`split-tax-code-${txn.id}-${i}`}
                    label={`${taxLabel} for split line ${i + 1}`}
                    readiness={taxReadiness}
                    direction={taxDirection ?? 'purchase'}
                    value={l.taxCodeQboId}
                    onChange={(taxCodeQboId) => {
                      upd(i, { taxCodeQboId });
                      if (taxCodeQboId !== null && taxCalculation === 'NotApplicable') {
                        setTaxCalculation('TaxInclusive');
                      }
                    }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 }}>
                {tags.map((tag) => {
                  const on = l.tags.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      onClick={() =>
                        upd(i, {
                          tags: on ? l.tags.filter((x) => x !== tag.id) : [...l.tags, tag.id],
                        })
                      }
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 11.5,
                        fontWeight: 600,
                        border: `1.5px solid ${on ? 'var(--acc)' : 'var(--bd2)'}`,
                        background: on ? 'var(--okB)' : 'transparent',
                        color: 'var(--ink)',
                        borderRadius: 99,
                        padding: '2px 9px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: tag.color,
                          display: 'inline-block',
                        }}
                      />
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
          <button
            onClick={() =>
              setDraft((d) => [
                ...d,
                {
                  amt: remain > 0 ? remain.toFixed(2) : '0.00',
                  cat: '',
                  tags: [],
                  memo: '',
                  taxCodeQboId: null,
                },
              ])
            }
            className="hov-dash"
            style={{
              border: '1px dashed var(--bd)',
              background: 'none',
              color: 'var(--mut)',
              borderRadius: 7,
              padding: '7px 13px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            ＋ Add line
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: remainColor }}>
            {remainLabel}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button
            onClick={onClose}
            className="hov-ink"
            style={{
              border: '1px solid var(--bd)',
              background: 'var(--card)',
              color: 'var(--mut)',
              borderRadius: 7,
              padding: '9px 16px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (!valid) {
                toast(
                  hasInvalidTaxCode
                    ? `Select a usable ${taxLabel.toLowerCase()} code for every taxed split line.`
                    : validTax
                    ? 'Assign the full amount and pick a category on every line'
                    : 'Use a supported taxable code on every split line, or choose No tax on every split line.',
                );
                return;
              }
              if (taxEnabled) {
                onSave(
                  draft,
                  selectedTaxCount === 0 ? 'NotApplicable' : taxCalculation,
                );
              } else {
                onSave(draft);
              }
            }}
            className="hov-acc"
            style={{
              background: 'var(--acc)',
              color: '#fff',
              border: 'none',
              borderRadius: 7,
              padding: '9px 18px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
              opacity: valid ? 1 : 0.5,
            }}
          >
            Save split
          </button>
        </div>
      </div>
    </div>
  );
}
