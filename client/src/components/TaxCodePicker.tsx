import { isUsableSalesTaxCodeDto, isUsableTaxCodeDto } from '@recat/shared';
import type { TaxReadinessDto } from '@recat/shared';
import { Combobox } from './SelectCombobox';

export type TaxDirection = 'purchase' | 'sales';

export function usableTaxCodesForDirection(
  readiness: TaxReadinessDto | null,
  direction: TaxDirection,
) {
  const isSales = direction === 'sales';
  const status = isSales ? readiness?.salesStatus : readiness?.status;
  const taxCodes = isSales ? readiness?.salesTaxCodes : readiness?.taxCodes;
  return status === 'ready'
    ? (taxCodes ?? []).filter(
        (code) =>
          code.taxable === true &&
          (isSales ? isUsableSalesTaxCodeDto(code) : isUsableTaxCodeDto(code)),
      )
    : [];
}

export function isUsableTaxCodeForDirection(
  readiness: TaxReadinessDto | null,
  direction: TaxDirection,
  qboId: string,
): boolean {
  return usableTaxCodesForDirection(readiness, direction).some((code) => code.qboId === qboId);
}

export default function TaxCodePicker({
  id,
  label,
  readiness,
  value,
  onChange,
  disabled = false,
  direction = 'purchase',
  unavailableValueLabel,
}: {
  id: string;
  label: string;
  readiness: TaxReadinessDto | null;
  value: string | null;
  onChange: (qboId: string | null) => void;
  disabled?: boolean;
  direction?: TaxDirection;
  /** Preserves an unavailable historical reference until the user selects a repair. */
  unavailableValueLabel?: string;
}) {
  const isSales = direction === 'sales';
  const status = isSales ? readiness?.salesStatus : readiness?.status;
  const reason = isSales ? readiness?.salesReason : readiness?.reason;
  const taxLabel = isSales ? 'Sales tax' : 'Purchase tax';
  const usableCodes = usableTaxCodesForDirection(readiness, direction);
  const unavailableOption = value !== null && !usableCodes.some((code) => code.qboId === value)
    ? [{ value, label: `${unavailableValueLabel ?? value} · unavailable`, disabled: true }]
    : [];
  const explanation = readiness === null
    ? 'Tax availability is unavailable. Continue with the no-tax workflow.'
    : status === 'unsupported' && readiness.usingSalesTax === false
      ? reason ?? `${taxLabel} is disabled. Continue with the no-tax workflow.`
      : status !== 'ready'
        ? reason ?? `${taxLabel} references are unavailable. Continue with the no-tax workflow.`
        : null;

  return (
    <span style={{ display: 'block' }}>
      <Combobox
        id={id}
        label={label}
        value={value ?? ''}
        disabled={disabled}
        searchPlaceholder="Search tax codes…"
        emptyText="No matching tax codes"
        options={[
          ...unavailableOption,
          { value: '', label: 'No tax', searchText: 'no tax none' },
          ...usableCodes.map((code) => {
            const rate = isSales ? code.combinedSalesRate : code.combinedPurchaseRate;
            return {
              value: code.qboId,
              label: `${code.name} · ${rate}%`,
              searchText: code.name,
            };
          }),
        ]}
        onValueChange={(next) => onChange(next || null)}
      />
      {explanation && (
        <span style={{ display: 'block', color: 'var(--mut)', fontSize: 12, marginTop: 4 }}>
          {explanation}
        </span>
      )}
    </span>
  );
}
