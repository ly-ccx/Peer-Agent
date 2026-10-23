import { useId, type ReactNode } from 'react';

/** Shared row geometry with real label/description associations for its actual control. */
export function SettingsRow({ label, description, children, className = '' }: {
  label: ReactNode; description?: ReactNode; className?: string;
  children: (ids: { id: string; 'aria-labelledby': string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId(), labelId = `${id}-label`, hintId = `${id}-hint`;
  return <div className={`ui-settings-row ${className}`}>
    <div className="ui-settings-copy"><label id={labelId} htmlFor={id}>{label}</label>{description ? <p id={hintId}>{description}</p> : null}</div>
    <div className="ui-settings-control">{children({ id, 'aria-labelledby': labelId, 'aria-describedby': description ? hintId : undefined })}</div>
  </div>;
}
