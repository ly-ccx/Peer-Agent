import type { InputHTMLAttributes } from 'react';
import { useId } from 'react';

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function Checkbox({ className, id, ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <span className={['peer-checkbox', className].filter(Boolean).join(' ')}>
      <input {...props} id={inputId} type="checkbox" className="peer-checkbox-input" />
      <span className="peer-checkbox-box" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
          <path d="m3.5 8.2 2.7 2.7 6.3-6.3" />
        </svg>
      </span>
    </span>
  );
}
