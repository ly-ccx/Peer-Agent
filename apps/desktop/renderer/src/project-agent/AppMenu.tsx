import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../ui/icons';

interface AppMenuProps {
  readonly open: boolean;
  readonly i18n: I18nRuntime;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHistory: () => void;
  readonly onOpenAutomations: () => void;
  readonly onOpenCapabilities: () => void;
  readonly metadata?: ReactNode;
}

export function AppMenu({
  open,
  i18n,
  onToggle,
  onClose,
  onOpenSettings,
  onOpenHistory,
  onOpenAutomations,
  onOpenCapabilities,
  metadata,
}: AppMenuProps) {
  const menuId = useId();
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<'trigger' | 'metadata' | null>(null);

  useLayoutEffect(() => {
    if (open || !returnFocus.current) return;
    const target = returnFocus.current === 'metadata'
      ? rootRef.current?.querySelector<HTMLButtonElement>('.bot-app-menu-metadata button') : triggerRef.current;
    returnFocus.current = null;
    (target ?? triggerRef.current)?.focus();
  }, [open]);

  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        returnFocus.current = 'trigger';
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const navigateMenu = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length
        : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : undefined;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      returnFocus.current = 'trigger';
      onClose();
    } else if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      returnFocus.current = event.shiftKey ? 'trigger' : 'metadata';
      onClose();
    }
  };

  return (
    <div className="bot-app-menu" ref={rootRef}>
      {open ? (
        <div className="bot-app-menu-menu" id={menuId} role="menu" aria-labelledby={triggerId} onKeyDown={navigateMenu}>
          <button type="button" role="menuitem" tabIndex={-1} onClick={onOpenSettings}>
            <PeerIcon name="settings" size={16} />
            {i18n.t('projectAgent.list.settings')}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { returnFocus.current = 'trigger'; onOpenHistory(); }}>
            <PeerIcon name="history" size={16} />
            {i18n.t('projectAgent.list.history')}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={onOpenAutomations}>
            <PeerIcon name="repeat" size={16} />
            {i18n.t('projectAgent.list.automations')}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={onOpenCapabilities}>
            <PeerIcon name="blocks" size={16} />
            <span className="bot-app-menu-item-copy">
              {i18n.t('projectAgent.list.capabilities')}
              <small>{i18n.t('projectAgent.list.capabilitiesHint')}</small>
            </span>
          </button>
        </div>
      ) : null}
      <div className="bot-app-menu-details">
        <button
          type="button"
          className="bot-app-menu-button"
          id={triggerId}
          ref={triggerRef}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={onToggle}
        >
          <PeerIcon className="bot-app-menu-icon" name="settings" size={18} />
          <span>{i18n.t('projectAgent.list.settings')}</span>
        </button>
        {metadata ? (
          <div className="bot-app-menu-metadata" onPointerDown={() => { if (open) onClose(); }}>
            {metadata}
          </div>
        ) : null}
      </div>
    </div>
  );
}
