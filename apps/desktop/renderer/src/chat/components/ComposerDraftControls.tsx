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
}: {
  readonly conversationId: string | null;
  readonly hasProvider: boolean;
  readonly isBusy: boolean;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
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
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 附件条挂在壳层 form 的兄弟节点，绝不进入 ComposerDraftField 子树。
  // 即使 React 协调时 field 重渲，attachment-strip 也不在 draft 叶子 DOM 子树内，
  // 可避免 field-sizing / 文本重排把大图缩略图一起刷掉。
  const attachmentSlot = useMemo(
    () => (
      <>
        <AttachmentStrip
          attachments={attachments}
          onRemove={onRemoveAttachment}
          onReorder={onReorderAttachment}
          onPreviewImage={onPreviewImage}
          isZh={isZh}
        />
        {attachmentError ? <div className="attachment-error">{attachmentError}</div> : null}
      </>
    ),
    [attachmentError, attachments, isZh, onPreviewImage, onRemoveAttachment, onReorderAttachment],
  );

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onPrimaryAction();
      }}
    >
      {/* 顺序靠 CSS order：菜单(0) → 附件(1) → textarea/按钮(2/3) */}
      {attachmentSlot}
      <ComposerDraftField
        conversationId={conversationId}
        hasProvider={hasProvider}
        isBusy={isBusy}
        isStreaming={isStreaming}
        isZh={isZh}
        hasAttachments={attachments.length > 0}
        messageQueue={messageQueue}
        fileInputRef={fileInputRef}
        onPaste={onPaste}
        onAddFiles={onAddFiles}
        onAttachSessionReference={onAttachSessionReference}
        onPrimaryAction={onPrimaryAction}
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
  fileInputRef,
  onPaste,
  onAddFiles,
  onAttachSessionReference,
  onPrimaryAction,
}: {
  readonly conversationId: string | null;
  readonly hasProvider: boolean;
  readonly isBusy: boolean;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
  readonly hasAttachments: boolean;
  readonly messageQueue: readonly QueuedMessage[];
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onAddFiles: (files: FileList | File[] | null | undefined) => void | Promise<void>;
  readonly onAttachSessionReference: (hit: SessionReferenceHit) => void | Promise<void>;
  readonly onPrimaryAction: () => void;
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
                className={`slash-command-item${index === activeSessionIndex ? ' active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySessionMention(hit);
                }}
              >
                <span className="slash-command-label">{hit.title?.trim() || (isZh ? '未命名会话' : 'Untitled session')}</span>
                <span className="slash-command-description">{hit.id}</span>
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
            : (isZh ? '输入消息，@ 引用其他会话' : 'Type a message, @ to mention a session')
          : (isZh ? '请先在设置中配置模型提供商' : 'Configure a model provider in Settings first')}
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
            if ((event.key === 'Tab' || event.key === 'Enter') && sessionHits.length > 0) {
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
          if (event.key === 'Enter' && !event.shiftKey) {
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
      <button
        type="button"
        className="composer-attach-btn"
        disabled={!hasProvider || isStreaming}
        title={isZh ? '添加附件' : 'Attach file'}
        aria-label={isZh ? '添加附件' : 'Attach file'}
        onClick={() => fileInputRef.current?.click()}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <button
        type="submit"
        disabled={!hasProvider || (!isStreaming && !hasComposerContent)}
        className={isStreaming ? 'streaming' : undefined}
        title={isStreaming ? (isZh ? '停止生成' : 'Stop') : (isZh ? '发送' : 'Send')}
        aria-label={isStreaming ? (isZh ? '停止生成' : 'Stop') : (isZh ? '发送' : 'Send')}
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
    </>
  );
});
