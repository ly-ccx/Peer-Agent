import type { ButtonHTMLAttributes, MouseEvent } from 'react';

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-checked' | 'onChange' | 'role'
> & {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
};

export function Switch({
  checked,
  className,
  disabled,
  onCheckedChange,
  onClick,
  type = 'button',
  ...props
}: SwitchProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) onCheckedChange(!checked);
  };

  return (
    <button
      {...props}
      type={type}
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      className={['peer-switch', className].filter(Boolean).join(' ')}
      disabled={disabled}
      onClick={handleClick}
    >
      <span className="peer-switch-thumb" aria-hidden="true" />
    </button>
  );
}
