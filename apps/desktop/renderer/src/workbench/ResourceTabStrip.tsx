import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { selectionNavigation } from '../app/components/selectionNavigation';
import { isImeKey } from '../chat/state/compositionGuard';

export interface ResourceTabItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
}

export const resourceTabIds = (prefix: string, id: string) => ({ tab: `${prefix}-tab-${encodeURIComponent(id)}`, panel: `${prefix}-panel-${encodeURIComponent(id)}` });

interface ResourceTabStripProps {
  readonly idPrefix: string;
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
  idPrefix,
  items,
  activeId,
  closeLabel,
  onActivate,
  onClose,
  action,
}: ResourceTabStripProps) {
  const root = useRef<HTMLDivElement>(null), pendingFocus = useRef<{ id: string | null; from: HTMLElement } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const close = (id: string, from: HTMLElement) => {
    const index = items.findIndex(item => item.id === id);
    if (from.closest('.resource-tab')?.contains(document.activeElement)) pendingFocus.current = { id: items[index + 1]?.id ?? items[index - 1]?.id ?? null, from };
    onClose(id);
  };
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request || request.from.isConnected) return;
    pendingFocus.current = null;
    if (document.activeElement !== document.body) return;
    const next = request.id ? document.getElementById(resourceTabIds(idPrefix, request.id).tab) : null;
    (next ?? root.current?.querySelector<HTMLElement>('.resource-tab-action') ?? root.current)?.focus({ preventScroll: true });
  }, [items, idPrefix]);
  const selectedId = items.some(item => item.id === activeId) ? activeId : items[0]?.id;
  if (items.length === 0 && !action) {
    return null;
  }
  return (
    <div className="resource-tab-strip" ref={root} tabIndex={-1}>
      <div className="resource-tabs" role="tablist" aria-label={ariaLabel} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
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
                id={resourceTabIds(idPrefix, item.id).tab} aria-controls={resourceTabIds(idPrefix, item.id).panel}
                onFocus={() => setFocused(item.id)}
                onKeyDown={event => {
                  if (isImeKey(event.nativeEvent)) return;
                  if (event.key === 'Delete') { event.preventDefault(); close(item.id, event.currentTarget); return; }
                  const next = selectionNavigation(items.map(() => ({})), items.findIndex(row => row.id === item.id), event.key, 'horizontal', getComputedStyle(event.currentTarget).direction === 'rtl');
                  if (next === null) return; event.preventDefault();
                  const target = items[next]!; onActivate(target.id);
                  document.getElementById(resourceTabIds(idPrefix, target.id).tab)?.focus({ preventScroll: true });
                }}
                aria-selected={selected}
                tabIndex={item.id === (focused && items.some(row => row.id === focused) ? focused : selectedId) ? 0 : -1}
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
                  close(item.id, event.currentTarget);
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
