import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export type ControlOption = {
  value: string;
  label: string;
  searchText?: string;
  group?: string;
  disabled?: boolean;
};

export type ControlCommonProps = {
  id?: string;
  label: string;
  value: string | null;
  options: readonly ControlOption[];
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  describedBy?: string;
  className?: string;
};

export type SelectProps = ControlCommonProps;

export type ComboboxProps = ControlCommonProps & {
  searchPlaceholder?: string;
  emptyText?: string;
  renderOption?: (option: ControlOption, selected: boolean) => ReactNode;
  footer?: ReactNode | ((dismissMenu: () => void) => ReactNode);
};

type InternalOption = ControlOption & { clear?: boolean };

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase();
}

function scrollActiveOption(listbox: HTMLElement, option: HTMLElement): void {
  const listboxRect = listbox.getBoundingClientRect();
  const optionRect = option.getBoundingClientRect();
  const top = optionRect.top - listboxRect.top + listbox.scrollTop;
  const bottom = optionRect.bottom - listboxRect.top + listbox.scrollTop;
  if (top < listbox.scrollTop) listbox.scrollTop = top;
  else if (bottom > listbox.scrollTop + listbox.clientHeight) {
    listbox.scrollTop = bottom - listbox.clientHeight;
  }
}

function ControlBase({
  props,
  combobox,
  searchPlaceholder,
  emptyText,
  renderOption,
  footer,
}: {
  props: ControlCommonProps;
  combobox: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  renderOption?: (option: ControlOption, selected: boolean) => ReactNode;
  footer?: ReactNode | ((dismissMenu: () => void) => ReactNode);
}): JSX.Element {
  const {
    id,
    label,
    value,
    options,
    onValueChange,
    placeholder,
    disabled = false,
    allowClear = false,
    describedBy,
    className,
  } = props;
  const generatedId = useId();
  const triggerId = id ?? `control-${generatedId}`;
  const labelId = `${triggerId}-label`;
  const listboxId = `${triggerId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLElement | null>>([]);
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeahead = useRef('');
  const restoreFocusFrame = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState('');

  const selectedOption = options.find((option) => option.value === value);
  const visibleOptions = useMemo<InternalOption[]>(() => {
    const clearOption: InternalOption[] = allowClear
      ? [{ value: '', label: 'Clear selection', clear: true }]
      : [];
    if (!combobox || !normalize(query)) return [...clearOption, ...options];

    const normalizedQuery = normalize(query);
    const filteredOptions = options.filter((option) =>
      normalize(`${option.label} ${option.searchText ?? ''}`).includes(normalizedQuery),
    );
    const disabledSelectedOption = selectedOption?.disabled && !filteredOptions.includes(selectedOption)
      ? [selectedOption]
      : [];
    return [...clearOption, ...disabledSelectedOption, ...filteredOptions];
  }, [allowClear, combobox, options, query, selectedOption]);

  const firstEnabledIndex = (): number => visibleOptions.findIndex((option) => !option.disabled);
  const lastEnabledIndex = (): number => {
    for (let index = visibleOptions.length - 1; index >= 0; index -= 1) {
      if (!visibleOptions[index]?.disabled) return index;
    }
    return -1;
  };
  const selectedIndex = (): number => visibleOptions.findIndex((option) => option.value === value);

  const dismissMenu = () => {
    setOpen(false);
    setQuery('');
  };

  const closeAndRestoreTriggerFocus = () => {
    dismissMenu();
    restoreFocusFrame.current = requestAnimationFrame(() => {
      restoreFocusFrame.current = null;
      triggerRef.current?.focus({ preventScroll: true });
    });
  };

  const openMenu = () => {
    if (restoreFocusFrame.current !== null) {
      cancelAnimationFrame(restoreFocusFrame.current);
      restoreFocusFrame.current = null;
    }
    setQuery('');
    setOpen(true);
    const selected = selectedIndex();
    setActiveIndex(selected >= 0 && !visibleOptions[selected]?.disabled ? selected : firstEnabledIndex());
  };

  const { context, floatingStyles, refs } = useFloating({
    open,
    onOpenChange: (nextOpen) => {
      if (nextOpen) openMenu();
      else dismissMenu();
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(6),
      flip(),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableWidth, availableHeight, rects, elements }) {
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, availableWidth)}px`,
            maxHeight: `${Math.max(0, availableHeight)}px`,
            '--control-anchor-width': `${rects.reference.width}px`,
          });
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => () => {
    if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
    if (restoreFocusFrame.current !== null) cancelAnimationFrame(restoreFocusFrame.current);
  }, []);

  const focusSearchOnMount = useCallback((input: HTMLInputElement | null) => {
    input?.focus({ preventScroll: true });
  }, []);

  const setListbox = useCallback((listbox: HTMLDivElement | null) => {
    const option = optionRefs.current[activeIndex];
    if (listbox && option) scrollActiveOption(listbox, option);
  }, [activeIndex]);

  useEffect(() => {
    if (activeIndex >= visibleOptions.length || visibleOptions[activeIndex]?.disabled) {
      setActiveIndex(firstEnabledIndex());
    }
  }, [activeIndex, visibleOptions]);

  const selectActive = (index: number) => {
    const option = visibleOptions[index];
    if (!option || option.disabled) return;
    onValueChange(option.clear ? null : option.value);
    closeAndRestoreTriggerFocus();
  };

  const moveActive = (direction: 1 | -1) => {
    if (!visibleOptions.length) return;
    setActiveIndex((currentIndex) => {
      const enabledIndices = visibleOptions.flatMap((option, index) => option.disabled ? [] : [index]);
      if (!enabledIndices.length) return -1;
      const currentPosition = enabledIndices.indexOf(currentIndex);
      if (currentPosition === -1) return direction === 1 ? enabledIndices[0]! : enabledIndices.at(-1)!;
      return enabledIndices[(currentPosition + direction + enabledIndices.length) % enabledIndices.length]!;
    });
  };

  const handleNavigation = (event: KeyboardEvent<HTMLElement>, allowTypeahead: boolean) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open) openMenu();
      setActiveIndex(event.key === 'Home' ? firstEnabledIndex() : lastEnabledIndex());
      return;
    }
    if (event.key === 'Enter' || (!combobox && event.key === ' ')) {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      selectActive(activeIndex);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreTriggerFocus();
      return;
    }
    if (!allowTypeahead || !open || event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;

    typeahead.current += event.key;
    if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = setTimeout(() => {
      typeahead.current = '';
    }, 500);
    const matchIndex = visibleOptions.findIndex((option) =>
      !option.disabled && normalize(`${option.label} ${option.searchText ?? ''}`).includes(normalize(typeahead.current)),
    );
    if (matchIndex >= 0) setActiveIndex(matchIndex);
  };

  const setReference = (node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    refs.setReference(node);
  };
  const triggerText = selectedOption?.label ?? placeholder ?? label;
  const activeDescendant = open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const sourceScope = triggerRef.current?.closest<HTMLElement>('.rr');
  const portalTheme = sourceScope?.dataset.theme ?? 'light';

  return (
    <>
      <span id={labelId} className="control-label">{label}</span>
      <button
        ref={setReference}
        id={triggerId}
        type="button"
        role="combobox"
        className={['control-trigger', className].filter(Boolean).join(' ')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onClick={() => open ? dismissMenu() : openMenu()}
        onKeyDown={(event) => handleNavigation(event, !combobox)}
      >
        <span>{triggerText}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <FloatingPortal>
          <div className="rr" data-theme={portalTheme}>
            <FloatingFocusManager context={context} modal={false} returnFocus={false} initialFocus={-1}>
              <div
                ref={refs.setFloating}
                className="control-popover"
                style={floatingStyles}
                {...getFloatingProps()}
                onClick={(event) => event.stopPropagation()}
              >
                {combobox && (
                  <input
                    ref={focusSearchOnMount}
                    className="control-search"
                    value={query}
                    aria-label={label}
                    aria-controls={listboxId}
                    aria-activedescendant={activeDescendant}
                    placeholder={searchPlaceholder}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => handleNavigation(event, false)}
                  />
                )}
                <div ref={setListbox} id={listboxId} className="control-options" role="listbox" aria-label={label}>
                  {visibleOptions.map((option, index) => {
                    const selected = !option.clear && option.value === value;
                    return (
                      <div
                        key={option.clear ? 'clear-selection' : option.value}
                        ref={(node) => { optionRefs.current[index] = node; }}
                        id={`${listboxId}-option-${index}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={Boolean(option.disabled)}
                        className={[
                          'control-option',
                          index === activeIndex && 'is-active',
                          selected && 'is-selected',
                          option.disabled && 'is-disabled',
                        ].filter(Boolean).join(' ')}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectActive(index)}
                      >
                        {option.clear ? option.label : renderOption?.(option, selected) ?? <>
                          {option.group && <span className="control-option-group">{option.group} · </span>}
                          {option.label}
                        </>}
                      </div>
                    );
                  })}
                  {combobox && visibleOptions.every((option) => option.clear) && (
                    <div className="control-empty" role="status">{emptyText ?? 'No matching options'}</div>
                  )}
                </div>
                {footer && <div className="control-footer">{
                  typeof footer === 'function' ? footer(dismissMenu) : footer
                }</div>}
              </div>
            </FloatingFocusManager>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

export function Select(props: SelectProps): JSX.Element {
  return <ControlBase props={props} combobox={false} />;
}

export function Combobox(props: ComboboxProps): JSX.Element {
  const { searchPlaceholder, emptyText, renderOption, footer, ...commonProps } = props;
  return (
    <ControlBase
      props={commonProps}
      combobox
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      renderOption={renderOption}
      footer={footer}
    />
  );
}
