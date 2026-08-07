import type { I18nRuntime } from '@peer-agent/i18n';
import { memo, useEffect, useMemo, useState } from 'react';
import { formatDuration, formatTime } from '../../state/format';
import type { ChatAttachment } from '../../state/types';
import type { ChatTurn as ChatTurnModel } from '../../state/chatTurns';
import { areChatTurnRenderPropsEqual } from '../../state/chatTurnRenderEquality';
import { AssistantContent, CompactionSummaryCard } from './AssistantContent';
import { AttachmentStrip } from './AttachmentStrip';
import { InteractionAnsweredContext } from './interactionContext';
import { MessageActionBar, type MessageActionId } from './MessageActionBar';

interface ChatTurnProps {
  readonly conversationId: string | null;
  readonly turn: ChatTurnModel;
  readonly isLive: boolean;
  readonly streamStartedAt: number | null;
  readonly isZh: boolean;
  readonly i18n: I18nRuntime;
  readonly onMessageAction: (messageIndex: number, action: MessageActionId) => void;
  /** 点击编辑：把目标用户消息装进底部输入框，而不是气泡内联编辑。 */
  readonly onBeginEdit: (messageId: string, text: string, attachments: readonly ChatAttachment[]) => void;
  readonly onRegenerate: (messageIndex: number) => void;
  readonly onPreviewImage: (attachment: ChatAttachment) => void;
  readonly turnIndex: number;
  readonly onMeasure: (
    index: number,
    element: HTMLElement | null,
    previousElement?: HTMLElement | null,
  ) => void;
}

function StreamingElapsedTime({ startedAt, isZh }: { readonly startedAt: number | null; readonly isZh: boolean }) {
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - (startedAt ?? Date.now())));

  useEffect(() => {
    if (startedAt == null) {
      setElapsedMs(0);
      return;
    }
    const tick = () => setElapsedMs(Math.max(0, Date.now() - startedAt));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <span
      className="chat-msg-duration chat-msg-duration-live"
      title={isZh ? '本轮已工作时长' : 'Elapsed this turn'}
    >
      {formatDuration(elapsedMs)}
    </span>
  );
}

function ChatTurnImpl({
  conversationId,
  turn,
  isLive,
  streamStartedAt,
  isZh,
  i18n,
  onMessageAction,
  onBeginEdit,
  onRegenerate,
  onPreviewImage,
  turnIndex,
  onMeasure,
}: ChatTurnProps) {
  const lastMessage = turn.messages.at(-1)?.msg;
  const measureRef = useMemo(() => {
    let ownedElement: HTMLElement | null = null;
    return (element: HTMLElement | null) => {
      if (element) {
        ownedElement = element;
        onMeasure(turnIndex, element);
        return;
      }
      if (ownedElement) onMeasure(turnIndex, null, ownedElement);
      ownedElement = null;
    };
  }, [onMeasure, turnIndex]);
  return (
    <section
      ref={measureRef}
      className="chat-turn"
      data-chat-turn-id={turn.id}
      data-settled={isLive ? 'false' : 'true'}
    >
      {turn.messages.map(({ msg, index: messageIndex, answeredText }) => (
        <div key={msg.id} data-msg-id={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
          {msg.compaction ? (
            <CompactionSummaryCard compaction={msg.compaction} isZh={isZh} />
          ) : (
            <>
              <div className="chat-msg-meta">
                <span className="chat-msg-role-label">
                  {msg.role === 'user' ? (isZh ? '你' : 'You') : 'Peer Agent'}
                </span>
                {msg.timestamp ? <time className="chat-msg-time">{formatTime(msg.timestamp)}</time> : null}
              </div>
              <div className="chat-msg-body">
                {msg.role === 'user' ? (
                  <>
                    {msg.content ? <div className="chat-msg-text">{msg.content}</div> : null}
                    {msg.attachments && msg.attachments.length > 0 ? (
                      <AttachmentStrip
                        attachments={msg.attachments}
                        isZh={isZh}
                        onPreviewImage={onPreviewImage}
                      />
                    ) : null}
                  </>
                ) : (
                  <InteractionAnsweredContext.Provider value={answeredText}>
                    <AssistantContent
                      conversationId={conversationId}
                      segments={msg.segments}
                      content={msg.content}
                      isStreaming={isLive && msg === lastMessage}
                      durationMs={msg.durationMs}
                      isZh={isZh}
                    />
                  </InteractionAnsweredContext.Provider>
                )}
              </div>
              <div className="chat-msg-footer">
                <MessageActionBar
                  role={msg.role}
                  content={msg.content}
                  canEdit={true}
                  isStreaming={isLive}
                  onAction={(action) => {
                    if (action === 'edit') onBeginEdit(msg.id, msg.content, msg.attachments ?? []);
                    else onMessageAction(messageIndex, action);
                  }}
                  i18n={i18n}
                />
                {msg.role === 'assistant' ? (
                  isLive && msg === lastMessage ? (
                    <StreamingElapsedTime startedAt={streamStartedAt} isZh={isZh} />
                  ) : msg.durationMs == null ? null : (
                    <span className="chat-msg-duration" title={isZh ? '本轮工作时长' : 'Turn duration'}>
                      {formatDuration(msg.durationMs)}
                    </span>
                  )
                ) : null}
                {msg.role === 'assistant' && msg.interrupted && !isLive ? (
                  <span
                    className="chat-msg-interrupted-mark"
                    title={isZh ? '连接中断，本轮未自然结束' : 'Connection interrupted; this turn did not finish'}
                  >
                    {isZh ? '已中断' : 'Interrupted'}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

export const ChatTurn = memo(ChatTurnImpl, areChatTurnRenderPropsEqual);
