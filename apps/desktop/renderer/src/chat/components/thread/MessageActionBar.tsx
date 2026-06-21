import { useCallback, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';

export type MessageActionId = 'copy' | 'regenerate' | 'delete' | 'branch';

interface MessageActionBarProps {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly canEdit: boolean;
  readonly isStreaming: boolean;
  readonly onAction: (action: MessageActionId) => void;
  readonly i18n: I18nRuntime;
}

export function MessageActionBar({
  role,
  content,
  canEdit,
  isStreaming,
  onAction,
  i18n,
}: MessageActionBarProps) {
  const [justCopied, setJustCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1500);
    });
  }, [content]);

  // hover 离开操作条时重置确认态，避免确认态残留
  const handleMouseLeave = useCallback(() => {
    setConfirmingDelete(false);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    setConfirmingDelete(false);
    onAction('delete');
  }, [onAction]);

  const copyLabel = justCopied ? i18n.t('chat.message.action.copied') : i18n.t('chat.message.action.copy');
  const hasContent = content.trim().length > 0;
  const canCopy = hasContent;
  const canRegenerate = role === 'assistant' && canEdit && !isStreaming;
  const canDelete = canEdit && !isStreaming;
  const canBranch = hasContent && !isStreaming;

  if (!canCopy && !canRegenerate && !canDelete && !canBranch) return null;

  return (
    <div className="message-action-bar" onMouseLeave={handleMouseLeave}>
      {canCopy ? (
        <button type="button" onClick={handleCopy} title={copyLabel} aria-label={copyLabel}>
          {justCopied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      ) : null}
      {canRegenerate ? (
        <button type="button" onClick={() => onAction('regenerate')} title={i18n.t('chat.message.action.regenerate')} aria-label={i18n.t('chat.message.action.regenerate')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      ) : null}
      {canBranch ? (
        <button type="button" onClick={() => onAction('branch')} title={i18n.t('chat.message.action.branch')} aria-label={i18n.t('chat.message.action.branch')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
            <path d="M6 21V9a9 9 0 0 0 9 9" />
          </svg>
        </button>
      ) : null}
      {canDelete ? (
        confirmingDelete ? (
          <span className="message-action-confirm" title={i18n.t('chat.message.confirmDelete')}>
            <button type="button" className="confirm-yes" onClick={handleConfirmDelete}>
              {i18n.t('chat.message.action.delete')}
            </button>
            <button type="button" className="confirm-no" onClick={() => setConfirmingDelete(false)}>
              {i18n.t('share.cancel')}
            </button>
          </span>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirmingDelete(true)} title={i18n.t('chat.message.action.delete')} aria-label={i18n.t('chat.message.action.delete')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18" /><path d="M8 6V4h8v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
        )
      ) : null}
    </div>
  );
}
