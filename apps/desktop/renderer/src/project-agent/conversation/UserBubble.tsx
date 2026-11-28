import { ResourceFeedbackCards } from './ResourceFeedbackCards';
import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { ProjectInputMutationResult } from '@peer-agent/protocol';
import type { BotChatMessage } from '../state/botConversationState';
import { BotAttachments } from './BotAttachments';
import { ReplyAnchorPreview } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { useEffect, useState } from 'react';
import { userReceipt, type UserReplyWait } from '../state/userReceiptState';

import type { BotWorkIndex } from '../state/botWorkState';

export function UserBubble({
  message,
  workspaceId,
  replied,
  replyWait,
  highlighted = false,
  workIndex,
  i18n,
  anchors,
  onJump,
  onRetry,
  onDiscard,
  onRestoreToDraft,
  onLocateSession,
}: {
  readonly message: BotChatMessage;
  readonly workspaceId: string;
  readonly replied: boolean;
  readonly replyWait?: UserReplyWait;
  readonly highlighted?: boolean;
  readonly workIndex?: BotWorkIndex;
  readonly i18n: I18nRuntime;
  readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly onJump: (messageId: string) => void;
  readonly onRetry: (inputId: string) => void;
  readonly onDiscard?: (inputId: string) => Promise<ProjectInputMutationResult> | void;
  readonly onRestoreToDraft?: (inputId: string) => Promise<ProjectInputMutationResult> | void;
  readonly onLocateSession: (sessionId: string) => void;
}) {
  const [arriving, setArriving] = useState(message.pending === 'sending');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<TranslationKey | null>(null);
  const excerpt = message.quoteRefs.length > 1 ? message.quoteRefs[1] : '';
  const receipt = userReceipt(message, replied, replyWait);
  const busy = Boolean(message.pendingBusy);
  useEffect(() => {
    if (message.pending !== 'unknown') setConfirmingDiscard(false);
    if (!message.pending || message.pending === 'sending' || message.pending === 'received') setActionFeedback(null);
  }, [message.inputId, message.pending]);
  async function handleDiscard(inputId: string) {
    if (!onDiscard || busy) return;
    setActionFeedback(null);
    const result = await onDiscard(inputId);
    if (result && result.ok) setConfirmingDiscard(false);
  }
  async function handleRestore(inputId: string) {
    if (!onRestoreToDraft || busy) return;
    setActionFeedback(null);
    const result = await onRestoreToDraft(inputId);
    if (result && !result.ok && result.code === 'DRAFT_NOT_EMPTY') {
      setActionFeedback('projectAgent.chat.restoreDraftOccupied');
    }
  }
  const markText = (item: BotChatMessage['dispositions'][number]) => (
    item.kind === 'out_of_scope'
      ? i18n.t(item.labelKey, { title: item.title || i18n.t('projectAgent.chat.taskFallback') })
      : i18n.t(item.labelKey)
  );
  return (
    <article className={`bot-user${highlighted ? ' is-anchored' : ''}${arriving ? ' is-arriving' : ''}`}
      onAnimationEnd={() => setArriving(false)} id={`bot-msg-${message.id}`} data-kind="user_input" data-input-id={message.inputId}>
      <div className="bot-user-content">
        <ResourceFeedbackCards rows={message.resourceFeedback ?? []} botName="" sent isZh={i18n.locale.startsWith('zh')} />
        {message.resourceFeedbackInvalid ? <p role="status">{i18n.locale.startsWith('zh') ? '此消息的资源引用暂不可用，原消息保留。' : 'Resource references for this message are unavailable. The original message is preserved.'}</p> : null}
        {message.taskRefs?.length ? (
          <div className="bot-user-task-refs">
            {message.taskRefs.map((sessionId) => {
              const title = workIndex?.byId.get(sessionId)?.title || sessionId;
              return (
                <button
                  key={sessionId}
                  type="button"
                  className="bot-user-task-ref"
                  onClick={() => onLocateSession(sessionId)}
                >
                  @ {title}
                </button>
              );
            })}
          </div>
        ) : null}
        {excerpt ? (
          <ReplyAnchorPreview id={message.quoteRefs[0]} anchor={anchors.get(message.quoteRefs[0])}
            excerpt={excerpt} className="bot-user-quote" i18n={i18n} onJump={onJump} />
        ) : null}
        {message.attachments?.length ? <BotAttachments attachments={message.attachments} workspaceId={workspaceId} i18n={i18n} /> : message.images?.length ? (
          <div className="bot-user-images">
            {message.images.map((image) => (
              <img key={image.id} src={image.dataUrl} alt={image.name} />
            ))}
          </div>
        ) : null}
        {message.content ? <p className="bot-user-text">{message.content}</p> : null}
      </div>
      <div
        className="bot-user-marks"
        aria-busy={busy || undefined}
        onKeyDown={(event) => {
          if (confirmingDiscard && event.key === 'Escape') {
            event.stopPropagation();
            setConfirmingDiscard(false);
          }
        }}
      >
        {confirmingDiscard && receipt.discardInputId ? (
          <>
            <span role="status">{i18n.t('projectAgent.chat.discardUnconfirmedHint')}</span>
            <button
              type="button"
              className="bot-user-action-danger"
              disabled={busy}
              onClick={() => void handleDiscard(receipt.discardInputId!)}
            >
              {i18n.t('projectAgent.chat.confirmDiscardPending')}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmingDiscard(false)}>
              {i18n.t('projectAgent.chat.cancelDiscardPending')}
            </button>
          </>
        ) : (
          <>
            {receipt.labelKey ? <span>{i18n.t(receipt.labelKey)}</span> : null}
            {receipt.retryInputId ? (
              <button type="button" disabled={busy} onClick={() => { setActionFeedback(null); onRetry(receipt.retryInputId!); }}>
                {i18n.t(message.pending === 'unknown' ? 'projectAgent.chat.retrySameInput' : 'projectAgent.chat.retry')}
              </button>
            ) : null}
            {receipt.restoreInputId && onRestoreToDraft ? (
              <button type="button" disabled={busy} onClick={() => void handleRestore(receipt.restoreInputId!)}>
                {i18n.t('projectAgent.chat.restoreToDraft')}
              </button>
            ) : null}
            {receipt.discardInputId && onDiscard ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setActionFeedback(null);
                  if (receipt.requiresDiscardConfirm) setConfirmingDiscard(true);
                  else void handleDiscard(receipt.discardInputId!);
                }}
              >
                {i18n.t(receipt.requiresDiscardConfirm ? 'projectAgent.chat.removePending' : 'projectAgent.chat.deletePending')}
              </button>
            ) : null}
          </>
        )}
        {actionFeedback ? <span className="bot-user-marks-feedback" role="status">{i18n.t(actionFeedback)}</span> : null}
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
