import type { ReactNode } from 'react';

export interface ResourceTabItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
}

interface ResourceTabStripProps {
  readonly ariaLabel: string;
  readonly items: readonly ResourceTabItem[];
  readonly activeId: string | null;
  readonly closeLabel: string;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly action?: {
    readonly label: string;
    readonly icon: ReactNode;
    readonly onClick: () => void;
  };
}

const ICON_PROPS = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function CloseIcon() {
  return <svg {...ICON_PROPS}><path d="m7 7 10 10M17 7 7 17" /></svg>;
}

export function ResourceTabStrip({
  ariaLabel,
  items,
  activeId,
  closeLabel,
  onActivate,
  onClose,
  action,
}: ResourceTabStripProps) {
  return (
    <div className="resource-tab-strip">
      <div className="resource-tabs" role="tablist" aria-label={ariaLabel}>
        {items.map((item) => {
          const selected = item.id === activeId;
          return (
            <div
              key={item.id}
              className={`resource-tab${selected ? ' resource-tab--active' : ''}`}
              role="presentation"
            >
              <button
                type="button"
                className="resource-tab-select"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={item.label}
                onClick={() => onActivate(item.id)}
              >
                <span className="resource-tab-icon" aria-hidden="true">{item.icon}</span>
                <span className="resource-tab-label">{item.label}</span>
              </button>
              <button
                type="button"
                className="resource-tab-close"
                aria-label={`${closeLabel}: ${item.label}`}
                title={closeLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(item.id);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      {action ? (
        <button
          type="button"
          className="resource-tab-action"
          aria-label={action.label}
          title={action.label}
          onClick={action.onClick}
        >
          {action.icon}
        </button>
      ) : null}
    </div>
  );
}
