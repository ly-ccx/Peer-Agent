import { useState, type ReactNode } from 'react';
import { selectionNavigation } from '../../app/components/selectionNavigation';
import { isImeKey } from '../../chat/state/compositionGuard';

/** Tabs browse on focus and activate explicitly; local radio choices follow arrow selection. */
export function ChoiceStrip<T extends string>({ value, options, onChange, kind = 'tabs', label, idPrefix, panelId, className, itemClassName = '' }: {
  readonly value: T;
  readonly options: readonly { value: T; label: ReactNode; disabled?: boolean }[];
  readonly onChange: (value: T) => void;
  readonly kind?: 'tabs' | 'radio';
  readonly label: string;
  readonly idPrefix?: string;
  readonly panelId?: string;
  readonly className?: string;
  readonly itemClassName?: string;
}) {
  const [focused, setFocused] = useState<T | null>(null);
  const enabled = (choice: T | null) => options.some(option => option.value === choice && !option.disabled);
  const focusValue = enabled(focused) ? focused : enabled(value) ? value : options.find(option => !option.disabled)?.value;
  return <div className={`ui-choice-strip${className ? ` ${className}` : ''}`} role={kind === 'tabs' ? 'tablist' : 'radiogroup'} aria-label={label} aria-orientation="horizontal"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
    {options.map((option, index) => <button key={option.value} type="button" disabled={option.disabled}
      role={kind === 'tabs' ? 'tab' : 'radio'}
      id={idPrefix ? `${idPrefix}-tab-${option.value}` : undefined}
      aria-controls={kind === 'tabs' ? panelId : undefined}
      aria-selected={kind === 'tabs' ? value === option.value : undefined}
      aria-checked={kind === 'radio' ? value === option.value : undefined}
      tabIndex={!option.disabled && focusValue === option.value ? 0 : -1}
      className={`${itemClassName}${value === option.value ? ' active is-active' : ''}`}
      onFocus={() => setFocused(option.value)}
      onKeyDown={event => {
        if (isImeKey(event.nativeEvent)) return;
        const next = selectionNavigation(options, index, event.key, 'horizontal', getComputedStyle(event.currentTarget).direction === 'rtl');
        if (next === null) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true });
        if (kind === 'radio') onChange(options[next]!.value);
      }} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
