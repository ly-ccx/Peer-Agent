import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotChatMessage } from '../state/botConversationState';

export function UserBubble({
  message,
  replied,
  i18n,
  onRetry,
  onLocateSession,
}: {
  readonly message: BotChatMessage;
  readonly replied: boolean;
  readonly i18n: I18nRuntime;
  readonly onRetry: (inputId: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
}) {
  const excerpt = message.quoteRefs.length > 1 ? message.quoteRefs[1] : '';
  const answered = message.dispositions.some((item) => item.kind === 'answered');
  const markText = (item: BotChatMessage['dispositions'][number]) => (
    item.kind === 'out_of_scope'
      ? i18n.t(item.labelKey, { title: item.title || (i18n.locale === 'zh-CN' ? '这个任务' : 'that task') })
      : i18n.t(item.labelKey)
  );
  return (
    <article className="bot-user" id={`bot-msg-${message.id}`} data-kind="user_input">
      <div className="bot-user-marks">
        {message.pending === 'sending' ? <span>{i18n.t('projectAgent.chat.sending')}</span> : null}
        {message.pending === 'failed' && message.inputId ? (
          <>
            <span>{i18n.t('projectAgent.chat.failed')}</span>
            <button type="button" onClick={() => onRetry(message.inputId!)}>
              {i18n.t('projectAgent.chat.retry')}
            </button>
          </>
        ) : null}
        {replied && !message.pending && !answered ? <span>{i18n.t('projectAgent.chat.replied')}</span> : null}
        {message.dispositions.map((item, index) => (
          item.sessionIds.length > 0
            ? item.sessionIds.map((sessionId) => (
              <button
                key={`${item.kind}-${sessionId}`}
                type="button"
                onClick={() => onLocateSession(sessionId)}
              >
                {markText(item)}
              </button>
            ))
            : <span key={`${item.kind}-${index}`}>{markText(item)}</span>
        ))}
      </div>
      {excerpt ? <p className="bot-user-quote">{excerpt}</p> : null}
      <p className="bot-user-text">{message.content}</p>
    </article>
  );
}
