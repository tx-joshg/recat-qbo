import { Combobox, type ControlOption } from './SelectCombobox';
import { useId } from 'react';

export interface CategoryOption {
  value: string;
  group: string;
  name: string;
  sug: boolean;
}

type CategoryPickerProps = {
  label: string;
  value: string | null;
  onPick: (value: string) => void;
  options: readonly CategoryOption[];
  onSplitFooter?: () => void;
  showBadges: boolean;
  disabled?: boolean;
  triggerText?: string;
  triggerTone?: 'suggested';
  triggerBadge?: string;
  triggerBadgeTooltip?: string;
};
export default function CategoryPicker(props: CategoryPickerProps) {
  const {
    label,
    value,
    onPick,
    options,
    onSplitFooter,
    showBadges,
    disabled = false,
    triggerText,
    triggerTone,
    triggerBadge,
    triggerBadgeTooltip,
  } = props;
  const controlOptions: ControlOption[] = options.map(({ value: optionValue, group, name }) => ({
    value: optionValue,
    label: `${group} · ${name}`,
    group,
    searchText: `${group} ${name}`,
  }));
  const descriptionId = `category-picker-${useId()}-description`;
  const triggerDescription = value === null && triggerText && triggerBadge
    ? [
      `Suggested category: ${triggerText}.`,
      triggerBadge === 'rule' ? 'Suggested by rule.' : 'Suggested.',
      triggerBadgeTooltip,
    ].filter(Boolean).join(' ')
    : undefined;

  return (
    <span className="category-picker">
      <Combobox
        label={label}
        value={value}
        options={controlOptions}
        onValueChange={(next) => { if (next !== null) onPick(next); }}
        disabled={disabled}
        placeholder={triggerText}
        describedBy={triggerDescription ? descriptionId : undefined}
        className={triggerTone === 'suggested' ? 'category-picker-suggested' : undefined}
        searchPlaceholder="Search categories…"
        emptyText="No matching categories"
        renderOption={(option) => {
          const source = options.find((entry) => entry.value === option.value)!;
          return <><span><span className="control-option-group">{source.group} · </span>{source.name}</span>{showBadges && source.sug && <span className="category-option-suggestion"> suggested</span>}</>;
        }}
        footer={onSplitFooter ? (dismissMenu) => (
          <button
            type="button"
            className="category-split-footer"
            onClick={() => {
              dismissMenu();
              onSplitFooter();
            }}
          >
            Split into multiple categories →
          </button>
        ) : undefined}
      />
      {triggerBadge && (
        <span
          data-tip={triggerBadgeTooltip}
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--amT)', marginLeft: 7 }}
        >
          {triggerBadge}
        </span>
      )}
      {triggerDescription && (
        <span
          id={descriptionId}
          style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
        >
          {triggerDescription}
        </span>
      )}
    </span>
  );
}
