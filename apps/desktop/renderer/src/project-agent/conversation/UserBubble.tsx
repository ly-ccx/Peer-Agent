import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotChatMessage } from '../state/botConversationState';
import { BotAttachments } from './BotAttachments';
import { ReplyAnchorPreview } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { useState } from 'react';

export function UserBubble({
  message,
  replied,
  highlighted = false,
  i18n,
  anchors,
  onJump,
  onRetry,
  onLocateSession,
}: {
  readonly message: BotChatMessage;
  readonly replied: boolean;
  readonly highlighted?: boolean;
  readonly i18n: I18nRuntime;
  readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly onJump: (messageId: string) => void;
  readonly onRetry: (inputId: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
}) {
  const [arriving, setArriving] = useState(message.pending === 'sending');
  const excerpt = message.quoteRefs.length > 1 ? message.quoteRefs[1] : '';
  const answered = message.dispositions.some((item) => item.kind === 'answered');
  const markText = (item: BotChatMessage['dispositions'][number]) => (
    item.kind === 'out_of_scope'
      ? i18n.t(item.labelKey, { title: item.title || i18n.t('projectAgent.chat.taskFallback') })
      : i18n.t(item.labelKey)
  );
  return (
    <article className={`bot-user${highlighted ? ' is-anchored' : ''}${arriving ? ' is-arriving' : ''}`}
      onAnimationEnd={() => setArriving(false)} id={`bot-msg-${message.id}`} data-kind="user_input" data-input-id={message.inputId}>
      <div className="bot-user-content">
        {excerpt ? (
          <ReplyAnchorPreview id={message.quoteRefs[0]} anchor={anchors.get(message.quoteRefs[0])}
            excerpt={excerpt} className="bot-user-quote" i18n={i18n} onJump={onJump} />
        ) : null}
        {message.attachments?.length ? <BotAttachments attachments={message.attachments} i18n={i18n} /> : message.images?.length ? (
          <div className="bot-user-images">
            {message.images.map((image) => (
              <img key={image.id} src={image.dataUrl} alt={image.name} />
            ))}
          </div>
        ) : null}
        {message.content ? <p className="bot-user-text">{message.content}</p> : null}
      </div>
      <div className="bot-user-marks">
        {message.pending === 'received' || (!message.pending && message.inputId && !replied && message.dispositions.length === 0)
          ? <span>{i18n.t('projectAgent.chat.received')}</span> : null}
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
    </article>
  );
}
