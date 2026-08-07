import type React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useConversationDraft } from '../hooks/useConversationState';
import { loadComposerEntry, saveComposerEntry, shouldDeferEmptyComposerSave } from '../state/composerPersistence';
import { conversationStore } from '../state/conversationStore';
import type { ChatAttachment, QueuedMessage } from '../state/types';
import {
  detectAtQuery,
  insertSessionMention,
  type SessionReferenceHit,
} from '../state/sessionReference';
import { clientApi } from '../../clientApi';
import { AttachmentStrip } from './thread/AttachmentStrip';

interface SlashCommand {
  readonly id: string;
  readonly value: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'compact',
    value: '/compact',
    labelZh: '/compact',
    labelEn: '/compact',
    descriptionZh: '压缩当前对话历史',
    descriptionEn: 'Compact conversation history',
  },
];

/**
 * 输入壳：不订阅 draft。
 * 附件条/文件按钮停在壳层；逐字 draft 只唤醒下方叶子，避免 dataUrl 缩略图随每个字符重绘。
 */
export const ComposerDraftControls = memo(function ComposerDraftControls({
  conversationId,
  hasProvider,
  isBusy,
  isStreaming,
  isZh,
  attachments,
  attachmentError,
  messageQueue,
  onRemoveAttachment,
  onReorderAttachment,
  onPreviewImage,
  onPaste,
  onAddFiles,
  onAttachSessionReference,
  onPrimaryAction,
  editingMessage = null,
  onCancelEdit,
  homeModelSlot = null,
  variant = 'conversation',
}: {
  readonly conversationId: string | null;
  readonly hasProvider: boolean;
  readonly isBusy: boolean;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
  readonly variant?: 'conversation' | 'home';
  readonly attachments: readonly ChatAttachment[];
  readonly attachmentError: string | null;
  readonly messageQueue: readonly QueuedMessage[];
  readonly onRemoveAttachment: (id: string) => void;
  readonly onReorderAttachment?: (fromIndex: number, toIndex: number) => void;
  readonly onPreviewImage: (attachment: ChatAttachment) => void;
  readonly onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onAddFiles: (files: FileList | File[] | null | undefined) => void | Promise<void>;
  readonly onAttachSessionReference: (hit: SessionReferenceHit) => void | Promise<void>;
  readonly onPrimaryAction: () => void;
  /** 正在编辑的用户消息引用（底部输入框上方展示）。 */
  readonly editingMessage?: { messageId: string; preview: string } | null;
  readonly onCancelEdit?: () => void;
  readonly homeModelSlot?: React.ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 附件条挂在壳层 form 的兄弟节点，绝不进入 ComposerDraftField 子树。
  // 即使 React 协调时 field 重渲，attachment-strip 也不在 draft 叶子 DOM 子树内，
  // 可避免 field-sizing / 文本重排把大图缩略图一起刷掉。
  // 必须是单个包裹节点：composer 是 grid，多个裸兄弟节点会被塞进同一网格单元
  // 并与 textarea 叠放（缩略图压住文字）。包一层后附件条恒为一个 grid item，
  // 占据独立的 home-attachments 行；无附件且无错误时整行不渲染，不占高度。
  const attachmentSlot = useMemo(() => {
    if (!attachments.length && !attachmentError) return null;
    return (
      <div className="composer-attachment-row">
        <AttachmentStrip
          attachments={attachments}
          onRemove={onRemoveAttachment}
          onReorder={onReorderAttachment}
          onPreviewImage={onPreviewImage}
          isZh={isZh}
        />
        {attachmentError ? <div className="attachment-error">{attachmentError}</div> : null}
      </div>
    );
  }, [attachmentError, attachments, isZh, onPreviewImage, onRemoveAttachment, onReorderAttachment]);

  return (
    <form
      className={`chat-composer ${variant === 'home' ? 'chat-composer--home' : 'chat-composer--compact'}`}
      onSubmit={(event) => {
        event.preventDefault();
        onPrimaryAction();
      }}
    >
      {/* 顺序靠 CSS order：编辑引用(-1) → 菜单(0) → 附件(1) → textarea/按钮(2/3) */}
      {editingMessage ? (
        <div className="composer-edit-banner" role="status">
          <div className="composer-edit-banner-main">
            <span className="composer-edit-banner-label">{isZh ? '正在编辑' : 'Editing'}</span>
            <span className="composer-edit-banner-preview">
              {editingMessage.preview || (isZh ? '（空消息）' : '(empty message)')}
            </span>
          </div>
          <button
            type="button"
            className="composer-edit-banner-cancel"
            onClick={() => onCancelEdit?.()}
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
        </div>
      ) : null}
      {attachmentSlot}
      <ComposerDraftField
        conversationId={conversationId}
        hasProvider={hasProvider}
        isBusy={isBusy}
        isStreaming={isStreaming}
        isZh={isZh}
        hasAttachments={attachments.length > 0}
        messageQueue={messageQueue}
        variant={variant}
        homeModelSlot={homeModelSlot}
        fileInputRef={fileInputRef}
        onPaste={onPaste}
        onAddFiles={onAddFiles}
        onAttachSessionReference={onAttachSessionReference}
        onPrimaryAction={onPrimaryAction}
        editingMessage={editingMessage}
        onCancelEdit={onCancelEdit}
      />
    </form>
  );
});

/**
 * 草稿叶子：唯一订阅会话草稿的输入区。
 * 菜单 / textarea / 发送按钮随 draft 更新；附件条已在壳层兄弟节点，不在本叶子子树。
 */
const ComposerDraftField = memo(function ComposerDraftField({
  conversationId,
  hasProvider,
  isBusy,
  isStreaming,
  isZh,
  hasAttachments,
  messageQueue,
  variant,
  homeModelSlot,
  fileInputRef,
  onPaste,
  onAddFiles,
  onAttachSessionReference,
  onPrimaryAction,
  editingMessage = null,
  onCancelEdit,
}: {
  readonly conversationId: string | null;
  readonly hasProvider: boolean;
  readonly isBusy: boolean;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
  readonly hasAttachments: boolean;
  readonly messageQueue: readonly QueuedMessage[];
  readonly variant: 'conversation' | 'home';
  readonly homeModelSlot: React.ReactNode;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onAddFiles: (files: FileList | File[] | null | undefined) => void | Promise<void>;
  readonly onAttachSessionReference: (hit: SessionReferenceHit) => void | Promise<void>;
  readonly onPrimaryAction: () => void;
  readonly editingMessage?: { messageId: string; preview: string } | null;
  readonly onCancelEdit?: () => void;
}) {
  const draft = useConversationDraft(conversationId);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [activeSessionIndex, setActiveSessionIndex] = useState(0);
  const [sessionHits, setSessionHits] = useState<readonly SessionReferenceHit[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const sessionQueryRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const persistedConversationRef = useRef<string | null | undefined>(undefined);
  const hydrationReadyConversationRef = useRef<string | null>(null);

  const slashCommands = useMemo(() => {
    const query = draft.startsWith('/') && !/\s/.test(draft) ? draft.toLowerCase() : null;
    return query
      ? SLASH_COMMANDS.filter((command) => command.value.startsWith(query))
      : [];
  }, [draft]);
  const showSlashCommands = !isBusy && slashCommands.length > 0;
  const atQuery = useMemo(() => {
    if (showSlashCommands) return null;
    return detectAtQuery(draft);
  }, [draft, showSlashCommands]);
  const showSessionMentions = Boolean(atQuery) && !isBusy;
  const hasComposerContent = draft.trim().length > 0 || hasAttachments;

  // 只在 slash 候选列表变化时重置高亮，避免每个字符 setState 二次渲染。
  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashCommands]);

  useEffect(() => {
    setActiveSessionIndex(0);
  }, [atQuery?.query, showSessionMentions]);

  useEffect(() => {
    if (!showSessionMentions || !atQuery) {
      sessionQueryRef.current = null;
      setSessionHits([]);
      setSessionLoading(false);
      return;
    }
    const query = atQuery.query.trim();
    sessionQueryRef.current = query;
    let cancelled = false;
    setSessionLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let hits: SessionReferenceHit[] = [];
          try {
            const search = await clientApi.conversationsSearch?.({ query, status: 'active', limit: 20 });
            if (Array.isArray(search)) {
              hits = search.map((item) => ({
                id: String((item as { id?: string }).id || ''),
                title: (item as { title?: string }).title,
                workspacePath: (item as { workspacePath?: string | null }).workspacePath ?? null,
                updatedAt: (item as { updatedAt?: string }).updatedAt,
                createdAt: (item as { createdAt?: string }).createdAt,
              })).filter((item) => item.id);
            }
          } catch {
            // fall through to list
          }
          if (hits.length === 0) {
            const list = await clientApi.conversationsList({ status: 'active' });
            const rows = Array.isArray(list)
              ? list
              : Array.isArray((list as { items?: readonly unknown[] } | null)?.items)
                ? ((list as { items: readonly unknown[] }).items)
                : [];
            hits = rows.map((item) => ({
              id: String((item as { id?: string }).id || ''),
              title: (item as { title?: string }).title,
              workspacePath: (item as { workspacePath?: string | null }).workspacePath ?? null,
              updatedAt: (item as { updatedAt?: string }).updatedAt,
              createdAt: (item as { createdAt?: string }).createdAt,
            })).filter((item) => item.id);
            if (query) {
              const lower = query.toLowerCase();
              hits = hits.filter((item) =>
                (item.title || '').toLowerCase().includes(lower)
                || item.id.toLowerCase().includes(lower),
              );
            }
          }
          hits = hits.filter((item) => item.id !== conversationId).slice(0, 12);
          if (!cancelled && sessionQueryRef.current === query) {
            setSessionHits(hits);
          }
        } catch {
          if (!cancelled && sessionQueryRef.current === query) {
            setSessionHits([]);
          }
        } finally {
          if (!cancelled && sessionQueryRef.current === query) {
            setSessionLoading(false);
          }
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [atQuery, conversationId, showSessionMentions]);

  // 草稿与队列仍沿用既有表达层持久化缝；仅把订阅移入输入叶子。
  // 切会话时：先把「离开的会话」当前桶态同步写入持久化镜像，避免入队后立刻切走导致
  // 最新队列尚未 debounce 落盘；进入新会话的首帧仍跳过 save，防止用空态覆盖刚恢复的数据。
  useEffect(() => {
    const previousId = persistedConversationRef.current;
    if (previousId && previousId !== conversationId) {
      const previous = conversationStore.getSnapshot(previousId);
      saveComposerEntry(previousId, {
        draft: previous.draft,
        queue: previous.messageQueue.map((item) => ({
          id: item.id,
          text: item.text,
          attachments: item.attachments,
          effort: item.effort,
        })),
      });
    }
    if (previousId !== conversationId) {
      persistedConversationRef.current = conversationId;
      hydrationReadyConversationRef.current = null;
      return;
    }
    if (!conversationId) return;
    // 工作区切换会重新挂载输入叶子。父级恢复会话桶之前，这里可能先观察到初始空态；
    // 若磁盘上仍有该会话的草稿/队列，拒绝这一次空写。恢复完成后即使用户主动清空，
    // hydrationReadyConversationRef 也已就绪，仍会正常删除持久化条目。
    if (shouldDeferEmptyComposerSave(
      hydrationReadyConversationRef.current === conversationId,
      draft,
      messageQueue,
      loadComposerEntry(conversationId),
    )) return;
    hydrationReadyConversationRef.current = conversationId;
    saveComposerEntry(conversationId, {
      draft,
      queue: messageQueue.map((item) => ({
        id: item.id,
        text: item.text,
        attachments: item.attachments,
        effort: item.effort,
      })),
    });
  }, [conversationId, draft, messageQueue]);

  const setDraft = (value: string) => conversationStore.setDraft(conversationId, value);

  const applySlashCommand = (command: SlashCommand) => {
    setDraft(command.value);
    setActiveSlashIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(command.value.length, command.value.length);
    });
  };

  const applySessionMention = (hit: SessionReferenceHit) => {
    if (!atQuery) return;
    const title = hit.title?.trim() || (isZh ? '未命名会话' : 'Untitled session');
    const next = insertSessionMention(draft, atQuery.start, atQuery.query, title);
    setDraft(next);
    void onAttachSessionReference(hit);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const caret = Math.min(next.length, atQuery.start + title.length + 2);
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <>
      {showSlashCommands ? (
        <div className="slash-command-menu" role="listbox" aria-label={isZh ? '命令' : 'Commands'}>
          {slashCommands.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === activeSlashIndex}
              className={`slash-command-item${index === activeSlashIndex ? ' active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                applySlashCommand(command);
              }}
            >
              <span className="slash-command-label">{isZh ? command.labelZh : command.labelEn}</span>
              <span className="slash-command-description">{isZh ? command.descriptionZh : command.descriptionEn}</span>
            </button>
          ))}
        </div>
      ) : null}
      {showSessionMentions ? (
        <div className="slash-command-menu" role="listbox" aria-label={isZh ? '引用会话' : 'Mention session'}>
          {sessionLoading ? (
            <div className="slash-command-empty">{isZh ? '搜索会话…' : 'Searching sessions…'}</div>
          ) : sessionHits.length === 0 ? (
            <div className="slash-command-empty">{isZh ? '没有匹配的会话' : 'No matching sessions'}</div>
          ) : (
            sessionHits.map((hit, index) => (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={index === activeSessionIndex}
                className={`slash-command-item session-mention-item${index === activeSessionIndex ? ' active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySessionMention(hit);
                }}
              >
                <span className="session-mention-main">
                  <span className="session-mention-title">
                    {hit.title?.trim() || (isZh ? '未命名会话' : 'Untitled session')}
                  </span>
                  <span className="session-mention-id">{hit.id}</span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={!hasProvider}
        placeholder={hasProvider
          ? isBusy
            ? (isZh ? '输入消息将在完成后自动发送...' : 'Message will auto-send when done...')
            : variant === 'home'
              ? (isZh ? '描述任务，或告诉 Peer Agent 你想完成什么…' : 'Describe a task, or tell Peer Agent what you want to accomplish…')
              : (isZh ? '输入消息，@ 引用其他会话' : 'Type a message, @ to mention a session')
          : (isZh ? '请先在设置中连接 AI 服务' : 'Connect an AI service in Settings first')}
        rows={1}
        onPaste={onPaste}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (showSlashCommands) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveSlashIndex((index) => (index + 1) % slashCommands.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveSlashIndex((index) => (index - 1 + slashCommands.length) % slashCommands.length);
              return;
            }
            if ((event.key === 'Tab' || event.key === 'Enter')
              && !event.nativeEvent.isComposing
              && event.keyCode !== 229
              && draft !== slashCommands[activeSlashIndex]?.value) {
              event.preventDefault();
              const command = slashCommands[activeSlashIndex] ?? slashCommands[0];
              if (command) applySlashCommand(command);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft('');
              return;
            }
          }
          if (showSessionMentions && atQuery) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (sessionHits.length === 0) return;
              setActiveSessionIndex((index) => (index + 1) % sessionHits.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (sessionHits.length === 0) return;
              setActiveSessionIndex((index) => (index - 1 + sessionHits.length) % sessionHits.length);
              return;
            }
            if ((event.key === 'Tab' || event.key === 'Enter')
              && sessionHits.length > 0
              && !event.nativeEvent.isComposing
              && event.keyCode !== 229) {
              event.preventDefault();
              const hit = sessionHits[activeSessionIndex] ?? sessionHits[0];
              if (hit) applySessionMention(hit);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(`${draft.slice(0, atQuery.start)}${draft.slice(atQuery.start + 1 + atQuery.query.length)}`);
              return;
            }
          }
          if (event.key === 'Escape' && editingMessage) {
            event.preventDefault();
            onCancelEdit?.();
            return;
          }
          // IME composition (Chinese/Japanese/etc.): Enter confirms candidate, must not send.
          if (
            event.key === 'Enter'
            && !event.shiftKey
            && !event.nativeEvent.isComposing
            && event.keyCode !== 229
          ) {
            event.preventDefault();
            onPrimaryAction();
          }
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="chat-file-input"
        onChange={(event) => {
          void onAddFiles(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
      />
      <div className="composer-home-action-row">
        <div className="composer-home-action-left">
          <button
            type="button"
            className="composer-attach-btn"
            disabled={!hasProvider || isStreaming}
            title={isZh ? '添加附件' : 'Attach file'}
            aria-label={isZh ? '添加附件' : 'Attach file'}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {homeModelSlot ? (
            <div className="composer-home-model-slot">{homeModelSlot}</div>
          ) : null}
        </div>
      <button
        type="submit"
        disabled={!hasProvider || (!isStreaming && !hasComposerContent)}
        className={isStreaming ? 'streaming' : undefined}
        title={isStreaming
          ? (isZh ? '停止生成' : 'Stop')
          : editingMessage
            ? (isZh ? '保存并发送' : 'Save and send')
            : (isZh ? '发送' : 'Send')}
        aria-label={isStreaming
          ? (isZh ? '停止生成' : 'Stop')
          : editingMessage
            ? (isZh ? '保存并发送' : 'Save and send')
            : (isZh ? '发送' : 'Send')}
      >
        {isStreaming ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
          </svg>
        )}
      </button>
      </div>
    </>
  );
});
