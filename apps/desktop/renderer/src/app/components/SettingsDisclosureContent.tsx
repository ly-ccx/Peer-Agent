import { useEffect, useState, type ReactNode } from 'react';

/** Keep content mounted through closing motion, then release its controls and effects. */
export function SettingsDisclosureContent({ expanded, id, children }: {
  readonly expanded: boolean;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  const [mounted, setMounted] = useState(expanded);
  const [settled, setSettled] = useState(expanded);
  useEffect(() => {
    setSettled(false);
    if (expanded) setMounted(true);
    const timer = window.setTimeout(() => {
      if (expanded) setSettled(true);
      else setMounted(false);
    },
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [expanded]);
  return (
    <div id={id} className="llm-settings-disclosure" data-expanded={expanded} data-settled={expanded && settled} inert={!expanded} aria-hidden={!expanded}>
      <div className="llm-settings-disclosure-inner">{expanded || mounted ? children : null}</div>
    </div>
  );
}
