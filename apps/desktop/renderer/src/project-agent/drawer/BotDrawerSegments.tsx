import { isImeKey } from '../../chat/state/compositionGuard';
import { selectionNavigation } from '../../app/components/selectionNavigation';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DrawerTab } from '../state/drawerState';

export function BotDrawerSegments({ workspaceId, selected, items, onChange }: {
  readonly workspaceId: string;
  readonly selected: DrawerTab;
  readonly items: readonly { readonly id: DrawerTab; readonly label: string }[];
  readonly onChange: (tab: DrawerTab) => void;
}) {
  const gesture = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null), suppressClick = useRef(false);
  const [focused, setFocused] = useState<DrawerTab | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const selectedIndex = Math.max(0, items.findIndex(item => item.id === selected));
  const indexAt = (clientX: number, node: HTMLDivElement) => {
    const box = node.getBoundingClientRect();
    return Math.max(0, Math.min(items.length - 1, Math.floor((clientX - box.left - 3) / ((box.width - 6) / items.length))));
  };
  const cancel = () => {
    const current = gesture.current; gesture.current = null; setDragIndex(null);
    if (current?.moved) suppressClick.current = true;
    try { if (current && root.current?.hasPointerCapture(current.pointerId)) root.current.releasePointerCapture(current.pointerId); } catch { /* capture already released */ }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (gesture.current && event.key === 'Escape' && !isImeKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } };
    window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true); cancel(); };
  }, []);
  return <div ref={root} className={`bot-drawer-tabs bot-drawer-segments${dragIndex !== null ? ' is-sliding' : ''}`} role="tablist"
    style={{ '--segment-count': items.length, '--segment-index': dragIndex ?? selectedIndex } as CSSProperties}
    onPointerDown={event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      suppressClick.current = false;
      gesture.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
    }}
    onPointerMove={event => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.abs(event.clientX - current.startX) < 6) return;
      current.moved = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); return; }
      setDragIndex(indexAt(event.clientX, event.currentTarget));
    }}
    onPointerUp={event => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.moved) {
        const next = items[indexAt(event.clientX, event.currentTarget)]!;
        onChange(next.id);
        document.getElementById(`bot-tab-${workspaceId}-${next.id}`)?.focus();
      }
      cancel();
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
    <span className="bot-segment-thumb" aria-hidden="true" />
    {items.map((item, index) => <button key={item.id} type="button" role="tab"
      id={`bot-tab-${workspaceId}-${item.id}`} aria-controls={`bot-pane-${workspaceId}`}
      tabIndex={(focused ?? selected) === item.id ? 0 : -1} onFocus={() => setFocused(item.id)} aria-selected={selected === item.id}
      data-overlay-autofocus={selected === item.id ? true : undefined}
      onClick={() => onChange(item.id)}
      onKeyDown={event => {
        if (isImeKey(event.nativeEvent)) return;
        const next = selectionNavigation(items.map(() => ({})), index, event.key, 'horizontal', getComputedStyle(event.currentTarget).direction === 'rtl');
        if (next === null) return;
        event.preventDefault();
        const target = items[next]!;
        document.getElementById(`bot-tab-${workspaceId}-${target.id}`)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
