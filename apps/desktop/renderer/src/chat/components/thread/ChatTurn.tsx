import type { I18nRuntime } from '@peer-agent/i18n';
import { memo, useCallback, useEffect, useState } from 'react';
import { formatDuration, formatTime } from '../../state/format';
import type { ChatAttachment, ToolProgress } from '../../state/types';
import type { ChatTurn as ChatTurnModel } from '../../state/chatTurns';
import { areChatTurnRenderPropsEqual } from '../../state/chatTurnRenderEquality';
import { AssistantContent, CompactionSummaryCard } from './AssistantContent';
import { AttachmentStrip } from './AttachmentStrip';
import { InteractionAnsweredContext } from './interactionContext';
import { MessageActionBar, type MessageActionId } from './MessageActionBar';

interface ChatTurnProps {
  readonly turn: ChatTurnModel;
  readonly isLive: boolean;
  readonly streamStartedAt: number | null;
  readonly toolProgress: ToolProgress | null;
  readonly isZh: boolean;
  readonly i18n: I18nRuntime;
  readonly onMessageAction: (messageIndex: number, action: MessageActionId) => void;
  readonly onRegenerate: (messageIndex: number) => void;
  readonly onPreviewImage: (attachment: ChatAttachment) => void;
  readonly turnIndex: number;
  readonly onMeasure: (index: number, element: HTMLElement | null) => void;
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
  turn,
  isLive,
  streamStartedAt,
  toolProgress,
  isZh,
  i18n,
  onMessageAction,
  onRegenerate,
  onPreviewImage,
  turnIndex,
  onMeasure,
}: ChatTurnProps) {
  const lastMessage = turn.messages.at(-1)?.msg;
  const measureRef = useCallback(
    (element: HTMLElement | null) => onMeasure(turnIndex, element),
    [onMeasure, turnIndex],
  );

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
              {msg.timestamp ? <time className="chat-msg-time">{formatTime(msg.timestamp)}</time> : null}
              <span className="chat-msg-role-label">
                {msg.role === 'user' ? (isZh ? '你' : 'You') : 'Peer Agent'}
              </span>
              <div className="chat-msg-body">
                {msg.role === 'user' ? (
                  <>
                    {msg.content ? <p>{msg.content}</p> : null}
                    {msg.attachments?.length ? (
                      <AttachmentStrip
                        attachments={msg.attachments}
                        readOnly
                        isZh={isZh}
                        onPreviewImage={onPreviewImage}
                      />
                    ) : null}
                  </>
                ) : (
                  <InteractionAnsweredContext.Provider value={answeredText}>
                    <AssistantContent
                      segments={msg.segments}
                      content={msg.content}
                      isStreaming={isLive && msg === lastMessage}
                      toolProgress={isLive && msg === lastMessage ? toolProgress : null}
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
                  onAction={(action) => onMessageAction(messageIndex, action)}
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
                  <span className="chat-msg-interrupted">
                    <span
                      className="chat-msg-interrupted-mark"
                      title={isZh ? '连接中断，本轮未自然结束' : 'Connection interrupted; this turn did not finish'}
                    >
                      {isZh ? '已中断' : 'Interrupted'}
                    </span>
                    <button
                      type="button"
                      className="chat-msg-continue-btn"
                      onClick={() => onRegenerate(messageIndex)}
                    >
                      {isZh ? '继续生成' : 'Continue'}
                    </button>
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
