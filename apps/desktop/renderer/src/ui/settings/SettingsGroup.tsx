import { useId, type ReactNode } from 'react';

/** A single paper group: its heading, description and controls share one boundary. */
export function SettingsGroup({ title, description, children, className = '' }: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const headingId = useId();
  return (
    <section className={`frost-settings-group ${className}`} aria-labelledby={headingId}>
      <header className="frost-group-heading">
        <h2 id={headingId}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="frost-group-content">{children}</div>
    </section>
  );
}
