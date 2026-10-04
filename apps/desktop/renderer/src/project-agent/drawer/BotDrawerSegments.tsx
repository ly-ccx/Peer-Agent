import { useRef, useState, type CSSProperties } from 'react';
import type { DrawerTab } from '../state/drawerState';

export function BotDrawerSegments({ workspaceId, selected, items, onChange }: {
  readonly workspaceId: string;
  readonly selected: DrawerTab;
  readonly items: readonly { readonly id: DrawerTab; readonly label: string }[];
  readonly onChange: (tab: DrawerTab) => void;
}) {
  const gesture = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const selectedIndex = Math.max(0, items.findIndex(item => item.id === selected));
  const indexAt = (clientX: number, node: HTMLDivElement) => {
    const box = node.getBoundingClientRect();
    return Math.max(0, Math.min(items.length - 1, Math.floor((clientX - box.left - 3) / ((box.width - 6) / items.length))));
  };
  return <div className={`bot-drawer-tabs bot-drawer-segments${dragIndex !== null ? ' is-sliding' : ''}`} role="tablist"
    style={{ '--segment-count': items.length, '--segment-index': dragIndex ?? selectedIndex } as CSSProperties}
    onPointerDown={event => {
      if (event.button !== 0) return;
      gesture.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
    }}
    onPointerMove={event => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.abs(event.clientX - current.startX) < 6) return;
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragIndex(indexAt(event.clientX, event.currentTarget));
    }}
    onPointerUp={event => {
      const current = gesture.current;
      if (current?.moved) {
        const next = items[indexAt(event.clientX, event.currentTarget)]!;
        onChange(next.id);
        document.getElementById(`bot-tab-${workspaceId}-${next.id}`)?.focus();
      }
      gesture.current = null;
      setDragIndex(null);
    }}
    onPointerCancel={() => { gesture.current = null; setDragIndex(null); }}>
    <span className="bot-segment-thumb" aria-hidden="true" />
    {items.map((item, index) => <button key={item.id} type="button" role="tab"
      id={`bot-tab-${workspaceId}-${item.id}`} aria-controls={`bot-pane-${workspaceId}`}
      tabIndex={selected === item.id ? 0 : -1} aria-selected={selected === item.id}
      data-overlay-autofocus={selected === item.id ? true : undefined}
      onClick={() => onChange(item.id)}
      onKeyDown={event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % items.length
          : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : null;
        if (next === null) return;
        event.preventDefault();
        const target = items[next]!;
        onChange(target.id);
        document.getElementById(`bot-tab-${workspaceId}-${target.id}`)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
