import type { CSSProperties } from 'react';
import type { QboTaxCodeDto } from '@recat/shared';

export default function TaxCodePicker({
  value,
  codes,
  disabled = false,
  onPick,
  style,
  label = 'Tax code',
}: {
  value: string | null;
  codes: QboTaxCodeDto[];
  disabled?: boolean;
  onPick: (code: QboTaxCodeDto | null) => void;
  style?: CSSProperties;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => {
        const code = codes.find((candidate) => candidate.qboId === event.target.value) ?? null;
        onPick(code);
      }}
      style={{
        border: '1px solid var(--bd)',
        borderRadius: 7,
        padding: '7px 9px',
        fontSize: 12.5,
        background: 'var(--card)',
        color: value ? 'var(--ink)' : 'var(--fnt)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        minWidth: 0,
        ...style,
      }}
    >
      <option value="">Tax code…</option>
      {codes
        .filter((code) => code.active && code.purchaseApplicable)
        .map((code) => (
          <option key={code.qboId} value={code.qboId}>
            {code.name}
          </option>
        ))}
    </select>
  );
}
