import type { I18nRuntime } from '@peer-agent/i18n';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { intakeAttachments } from '../../state/attachmentIntake';
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
  readonly onEditMessage: (messageId: string, text: string, attachments: readonly ChatAttachment[]) => Promise<boolean>;
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
  conversationId,
  turn,
  isLive,
  streamStartedAt,
  isZh,
  i18n,
  onMessageAction,
  onEditMessage,
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
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editAttachments, setEditAttachments] = useState<ChatAttachment[]>([]);
  const [editAttachmentError, setEditAttachmentError] = useState<string | null>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);

  const beginEdit = useCallback((messageId: string, content: string, attachments: readonly ChatAttachment[]) => {
    if (isLive) return;
    setEditingMessageId(messageId);
    setEditDraft(content);
    setEditAttachments([...attachments]);
    setEditAttachmentError(null);
  }, [isLive]);
  const cancelEdit = useCallback(() => {
    if (isSubmittingEdit) return;
    setEditingMessageId(null);
    setEditDraft('');
    setEditAttachments([]);
    setEditAttachmentError(null);
  }, [isSubmittingEdit]);
  const addEditFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const result = await intakeAttachments(files, editAttachments.length, isZh);
    setEditAttachmentError(result.error);
    if (result.attachments.length) {
      setEditAttachments((current) => [...current, ...result.attachments]);
    }
  }, [editAttachments.length, isZh]);
  const reorderEditAttachment = useCallback((fromIndex: number, toIndex: number) => {
    setEditAttachments((current) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return current;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);
  const submitEdit = useCallback(async () => {
    if (!editingMessageId || (!editDraft.trim() && editAttachments.length === 0) || isSubmittingEdit) return;
    setIsSubmittingEdit(true);
    try {
      if (await onEditMessage(editingMessageId, editDraft, editAttachments)) {
        setEditingMessageId(null);
        setEditDraft('');
        setEditAttachments([]);
        setEditAttachmentError(null);
      }
    } finally {
      setIsSubmittingEdit(false);
    }
  }, [editAttachments, editDraft, editingMessageId, isSubmittingEdit, onEditMessage]);

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
                    {editingMessageId === msg.id ? (
                      <div className="chat-message-editor">
                        <textarea
                          autoFocus
                          value={editDraft}
                          disabled={isSubmittingEdit}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') cancelEdit();
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submitEdit();
                          }}
                          aria-label={isZh ? '编辑消息内容' : 'Edit message content'}
                        />
                        {editAttachments.length ? (
                          <AttachmentStrip
                            attachments={editAttachments}
                            onRemove={(id) => {
                              setEditAttachments((current) => current.filter((attachment) => attachment.id !== id));
                              setEditAttachmentError(null);
                            }}
                            onReorder={reorderEditAttachment}
                            isZh={isZh}
                            onPreviewImage={onPreviewImage}
                          />
                        ) : null}
                        {editAttachmentError ? <div className="chat-message-editor-error">{editAttachmentError}</div> : null}
                        <div className="chat-message-editor-actions">
                          <button
                            type="button"
                            disabled={isSubmittingEdit}
                            onClick={() => editFileInputRef.current?.click()}
                          >
                            {isZh ? '添加附件' : 'Add attachment'}
                          </button>
                          <input
                            ref={editFileInputRef}
                            type="file"
                            multiple
                            className="chat-file-input"
                            disabled={isSubmittingEdit}
                            onChange={(event) => {
                              void addEditFiles(event.currentTarget.files);
                              event.currentTarget.value = '';
                            }}
                          />
                          <span className="chat-message-editor-spacer" />
                          <button type="button" disabled={isSubmittingEdit} onClick={cancelEdit}>{isZh ? '取消' : 'Cancel'}</button>
                          <button
                            type="button"
                            disabled={(!editDraft.trim() && editAttachments.length === 0) || isSubmittingEdit}
                            onClick={() => { void submitEdit(); }}
                          >
                            {isSubmittingEdit ? (isZh ? '发送中…' : 'Sending…') : (isZh ? '保存并发送' : 'Save & send')}
                          </button>
                        </div>
                      </div>
                    ) : (
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
                    )}
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
                    if (action === 'edit') beginEdit(msg.id, msg.content, msg.attachments ?? []);
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
