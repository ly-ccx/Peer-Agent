import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { useConfirm } from './ConfirmProvider';

interface ArchivedConversationMeta {
  readonly id: string;
  readonly title: string;
  readonly messageCount: number;
  readonly archivedAt?: string | null;
  readonly updatedAt: string;
}

function formatArchivedDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

export function ArchivedConversationsPanel({
  i18n,
  workspacePath,
  onConversationsChanged,
}: {
  readonly i18n: I18nRuntime;
  readonly workspacePath: string | null;
  readonly onConversationsChanged?: () => Promise<void> | void;
}) {
  const confirm = useConfirm();
  const requestSequenceRef = useRef(0);
  const [conversations, setConversations] = useState<readonly ArchivedConversationMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    const sequence = ++requestSequenceRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await clientApi.conversationsList({
        workspacePath,
        status: 'archived',
      });
      if (sequence === requestSequenceRef.current) {
        setConversations(result as readonly ArchivedConversationMeta[]);
      }
    } catch {
      if (sequence === requestSequenceRef.current) {
        setError(i18n.t('settings.archived.loadFailed'));
      }
    } finally {
      if (sequence === requestSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }, [i18n, workspacePath]);

  useEffect(() => {
    void loadConversations();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [loadConversations]);

  const handleRestore = useCallback(async (conversation: ArchivedConversationMeta) => {
    if (pendingId) return;
    setPendingId(conversation.id);
    setError(null);
    try {
      await clientApi.conversationsRestore({ id: conversation.id });
      setConversations((current) => current.filter((item) => item.id !== conversation.id));
      await onConversationsChanged?.();
    } catch {
      setError(i18n.t('settings.archived.actionFailed'));
    } finally {
      setPendingId(null);
    }
  }, [i18n, onConversationsChanged, pendingId]);

  const handleDelete = useCallback(async (conversation: ArchivedConversationMeta) => {
    if (pendingId) return;
    const title = conversation.title || i18n.t('chat.conversations.untitled');
    const accepted = await confirm({
      title: i18n.t('settings.archived.deleteTitle'),
      message: i18n.t('settings.archived.confirmDelete', { title }),
      confirmText: i18n.t('settings.archived.delete'),
      cancelText: i18n.t('share.cancel'),
      tone: 'danger',
    });
    if (!accepted) return;

    setPendingId(conversation.id);
    setError(null);
    try {
      await clientApi.conversationsDelete({ id: conversation.id });
      setConversations((current) => current.filter((item) => item.id !== conversation.id));
      await onConversationsChanged?.();
    } catch {
      setError(i18n.t('settings.archived.actionFailed'));
    } finally {
      setPendingId(null);
    }
  }, [confirm, i18n, onConversationsChanged, pendingId]);

  return (
    <div className="archived-conversations-panel">
      <header className="archived-conversations-header">
        <h2>{i18n.t('settings.archived')}</h2>
        <p>{i18n.t('settings.archived.description')}</p>
      </header>

      {error ? <p className="archived-conversations-error" role="alert">{error}</p> : null}

      {isLoading ? (
        <div className="archived-conversations-state" aria-live="polite">
          {i18n.t('settings.archived.loading')}
        </div>
      ) : conversations.length === 0 ? (
        <div className="archived-conversations-state">
          <strong>{i18n.t('settings.archived.empty')}</strong>
          <p>{i18n.t('settings.archived.emptyDescription')}</p>
        </div>
      ) : (
        <div className="archived-conversations-list" role="list">
          {conversations.map((conversation) => {
            const archivedDate = formatArchivedDate(
              conversation.archivedAt ?? conversation.updatedAt,
              i18n.locale,
            );
            const isPending = pendingId === conversation.id;
            return (
              <article className="archived-conversation-row" role="listitem" key={conversation.id}>
                <div className="archived-conversation-copy">
                  <h3>{conversation.title || i18n.t('chat.conversations.untitled')}</h3>
                  <p>
                    <span>{i18n.t('settings.archived.messageCount', { count: conversation.messageCount })}</span>
                    {archivedDate ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <time dateTime={conversation.archivedAt ?? conversation.updatedAt}>
                          {i18n.t('settings.archived.date', { date: archivedDate })}
                        </time>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="archived-conversation-actions">
                  <button
                    type="button"
                    className="archived-conversation-restore"
                    disabled={Boolean(pendingId)}
                    onClick={() => { void handleRestore(conversation); }}
                  >
                    {isPending ? i18n.t('settings.archived.working') : i18n.t('settings.archived.restore')}
                  </button>
                  <button
                    type="button"
                    className="archived-conversation-delete"
                    disabled={Boolean(pendingId)}
                    onClick={() => { void handleDelete(conversation); }}
                  >
                    {i18n.t('settings.archived.delete')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
