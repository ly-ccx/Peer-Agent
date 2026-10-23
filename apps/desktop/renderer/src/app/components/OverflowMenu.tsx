import { isImeKey } from '../../chat/state/compositionGuard';
import { PeerIcon } from '../../ui/icons';
import { useId, useRef, useState } from 'react';
import { useInteractionLayer } from '../hooks/useInteractionLayer';
import { selectionNavigation } from './selectionNavigation';

export interface OverflowMenuItem {
  readonly key: string; readonly label: string; readonly danger?: boolean;
  readonly disabled?: boolean; readonly onSelect: () => void;
}

/** A menu owns navigation until Escape, Tab, selection or a genuine outside pointer. */
export function OverflowMenu({ items, zh, label }: { items: readonly OverflowMenuItem[]; zh: boolean; label?: string }) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useInteractionLayer(open, { roots: [menu], trigger, outside: true, closeOnTriggerRemoval: true, dismissOnTab: true, onClose: () => setOpen(false),
    onEnter: () => (menu.current?.querySelector<HTMLElement>(`[data-menu-index="${active}"]:not(:disabled)`)
      ?? menu.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? menu.current)?.focus({ preventScroll: true }) });
  return <div className="pa-overflow">
    <button ref={trigger} type="button" className="pa-overflow-trigger" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} aria-label={label ?? (zh ? '更多操作' : 'More actions')}
      title={label ?? (zh ? '更多操作' : 'More actions')}
      onKeyDown={event => {
        if (isImeKey(event.nativeEvent) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault(); setActive(selectionNavigation(items, -1, event.key, 'vertical') ?? 0); setOpen(true);
      }} onClick={() => { setActive(items.findIndex(item => !item.disabled)); setOpen(value => !value); }}><PeerIcon name="ellipsis" size={16} /></button>
    {open ? <div ref={menu} className="pa-overflow-menu" role="menu" id={menuId} tabIndex={-1}
      onKeyDown={event => {
        if (event.defaultPrevented || isImeKey(event.nativeEvent)) return;
        const next = selectionNavigation(items, active, event.key, 'vertical');
        if (next === null) return;
        event.preventDefault(); setActive(next);
        menu.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus({ preventScroll: true });
      }}>
      {items.map((item, index) => <button key={item.key} type="button" role="menuitem" data-menu-index={index}
        tabIndex={index === active ? 0 : -1} className={item.danger ? 'danger' : undefined} disabled={item.disabled}
        onFocus={() => setActive(index)} onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>)}
    </div> : null}
  </div>;
}
