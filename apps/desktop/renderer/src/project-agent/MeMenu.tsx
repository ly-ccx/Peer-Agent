import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../ui/icons';

interface MeMenuProps {
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

export function MeMenu({
  open,
  i18n,
  onToggle,
  onClose,
  onOpenSettings,
  onOpenHistory,
  onOpenAutomations,
  onOpenCapabilities,
  metadata,
}: MeMenuProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div className="bot-me" ref={rootRef}>
      {open ? (
        <div className="bot-me-menu" id={menuId} role="menu">
          <button type="button" role="menuitem" onClick={onOpenSettings}>
            {i18n.t('projectAgent.list.settings')}
          </button>
          <button type="button" role="menuitem" onClick={onOpenHistory}>
            {i18n.t('projectAgent.list.history')}
          </button>
          <button type="button" role="menuitem" onClick={onOpenAutomations}>
            {i18n.t('projectAgent.list.automations')}
          </button>
          <button type="button" role="menuitem" onClick={onOpenCapabilities}>
            {i18n.t('projectAgent.list.capabilities')}
            <span>{i18n.t('projectAgent.list.capabilitiesHint')}</span>
          </button>
        </div>
      ) : null}
      <div className="bot-me-details">
        <button
          type="button"
          className="bot-me-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={onToggle}
        >
          <span className="bot-me-mark" aria-hidden="true">
            <PeerIcon name="userRound" size={18} />
          </span>
          <span>{i18n.t('projectAgent.list.me')}</span>
        </button>
        {metadata ? (
          <div className="bot-me-metadata" onPointerDown={() => { if (open) onClose(); }}>
            {metadata}
          </div>
        ) : null}
      </div>
    </div>
  );
}
