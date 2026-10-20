import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotChatMessage } from '../state/botConversationState';
import { BotAttachments } from './BotAttachments';
import { ReplyAnchorPreview } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { useState } from 'react';
import { userReceipt } from '../state/userReceiptState';

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
  const receipt = userReceipt(message, replied);
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
        {receipt.labelKey ? <span>{i18n.t(receipt.labelKey)}</span> : null}
        {receipt.retryInputId ? <button type="button" onClick={() => onRetry(receipt.retryInputId!)}>{i18n.t('projectAgent.chat.retry')}</button> : null}
        {receipt.taskMarks.map((item, index) => (
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
