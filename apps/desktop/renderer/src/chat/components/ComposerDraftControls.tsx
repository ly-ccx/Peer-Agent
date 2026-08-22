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
import {
  fileMentionSubtitle,
  insertFileMention,
  mergeContextMentionHits,
  type ContextMentionHit,
  type MentionScope,
  type WorkspaceFileHit,
} from '../state/contextMention';
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
  onAttachWorkspaceFile,
  workspacePath = null,
  canStartTask = true,
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
  readonly onAttachWorkspaceFile: (hit: WorkspaceFileHit) => void | Promise<void>;
  readonly workspacePath?: string | null;
  readonly canStartTask?: boolean;
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
        onAttachWorkspaceFile={onAttachWorkspaceFile}
        workspacePath={workspacePath}
        canStartTask={canStartTask}
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
  onAttachWorkspaceFile,
  workspacePath = null,
  canStartTask = true,
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
  readonly onAttachWorkspaceFile: (hit: WorkspaceFileHit) => void | Promise<void>;
  readonly workspacePath?: string | null;
  readonly canStartTask?: boolean;
  readonly onPrimaryAction: () => void;
  readonly editingMessage?: { messageId: string; preview: string } | null;
  readonly onCancelEdit?: () => void;
}) {
  const draft = useConversationDraft(conversationId);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [sessionHits, setSessionHits] = useState<readonly SessionReferenceHit[]>([]);
  const [fileHits, setFileHits] = useState<readonly WorkspaceFileHit[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionScope, setMentionScope] = useState<MentionScope>('all');
  const mentionQueryRef = useRef<string | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
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
  const showContextMentions = Boolean(atQuery) && !isBusy;
  const mentionHits = useMemo(() => mergeContextMentionHits({
    query: atQuery?.query ?? '',
    mentionScope,
    files: fileHits,
    sessions: sessionHits,
  }), [atQuery?.query, fileHits, mentionScope, sessionHits]);
  const hasComposerContent = draft.trim().length > 0 || hasAttachments;

  // 只在 slash 候选列表变化时重置高亮，避免每个字符 setState 二次渲染。
  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashCommands]);

  useEffect(() => {
    setActiveMentionIndex(0);
  }, [atQuery?.query, mentionScope, showContextMentions]);

  useEffect(() => {
    if (!showContextMentions) setMentionScope('all');
  }, [showContextMentions]);

  useEffect(() => {
    if (!showContextMentions) return;
    const active = mentionMenuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeMentionIndex, mentionHits, showContextMentions]);

  useEffect(() => {
    if (!showContextMentions || !atQuery) {
      mentionQueryRef.current = null;
      setSessionHits([]);
      setFileHits([]);
      setMentionLoading(false);
      return;
    }
    const query = atQuery.query.trim();
    mentionQueryRef.current = query;
    let cancelled = false;
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const loadSessions = async (): Promise<SessionReferenceHit[]> => {
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
          return hits.filter((item) => item.id !== conversationId).slice(0, 8);
        };

        const loadFiles = async (): Promise<WorkspaceFileHit[]> => {
          if (!workspacePath) return [];
          try {
            const result = await clientApi.searchWorkspaceFiles?.(workspacePath, query, 12);
            if (!result?.ok || !Array.isArray(result.files)) return [];
            return result.files.map((item): WorkspaceFileHit => ({
              relPath: String(item.relPath || ''),
              name: String(item.name || item.relPath || ''),
              kind: item.kind === 'directory' ? 'directory' : 'file',
            })).filter((item) => item.relPath);
          } catch {
            return [];
          }
        };

        try {
          const shouldLoadFiles = mentionScope !== 'chats' && (Boolean(query) || mentionScope === 'files');
          const shouldLoadSessions = mentionScope !== 'files' && (Boolean(query) || mentionScope === 'chats');
          const [nextSessions, nextFiles] = await Promise.all([
            shouldLoadSessions ? loadSessions() : Promise.resolve([]),
            shouldLoadFiles ? loadFiles() : Promise.resolve([]),
          ]);
          if (!cancelled && mentionQueryRef.current === query) {
            setSessionHits(nextSessions);
            setFileHits(nextFiles);
          }
        } catch {
          if (!cancelled && mentionQueryRef.current === query) {
            setSessionHits([]);
            setFileHits([]);
          }
        } finally {
          if (!cancelled && mentionQueryRef.current === query) {
            setMentionLoading(false);
          }
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [atQuery, conversationId, mentionScope, showContextMentions, workspacePath]);

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

  const applyFileMention = (hit: WorkspaceFileHit) => {
    if (!atQuery) return;
    const next = insertFileMention(draft, atQuery.start, atQuery.query, hit.relPath);
    setDraft(next);
    void onAttachWorkspaceFile(hit);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const caret = Math.min(next.length, atQuery.start + hit.relPath.length + 2);
      el.setSelectionRange(caret, caret);
    });
  };

  const applyMentionHit = (hit: ContextMentionHit) => {
    if (hit.type === 'category') {
      setMentionScope(hit.id);
      setActiveMentionIndex(0);
      return;
    }
    if (hit.type === 'back') {
      setMentionScope('all');
      setActiveMentionIndex(0);
      return;
    }
    if (hit.type === 'file') {
      applyFileMention(hit.file);
      return;
    }
    if (hit.type === 'session') {
      applySessionMention({ id: hit.id, title: hit.title });
    }
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
      {showContextMentions ? (
        <div ref={mentionMenuRef} className="slash-command-menu session-mention-menu" role="listbox" aria-label={isZh ? '引用文件或会话' : 'Mention files or chats'}>
          {mentionHits.map((hit, index) => {
              const key = hit.type === 'file'
                ? `file:${hit.file.relPath}`
                : hit.type === 'session'
                  ? `session:${hit.id}`
                  : hit.type === 'back'
                    ? `back:${hit.from}`
                    : `category:${hit.id}`;
              const title = hit.type === 'file'
                ? (hit.file.kind === 'directory' ? `${hit.file.name}/` : hit.file.name)
                : hit.type === 'session'
                  ? (hit.title?.trim() || (isZh ? '未命名会话' : 'Untitled session'))
                  : hit.type === 'back'
                    ? (isZh ? '返回' : 'Back')
                    : hit.id === 'files' ? 'Files' : 'Chats';
              const subtitle = hit.type === 'file'
                ? fileMentionSubtitle(hit.file.relPath)
                : hit.type === 'session'
                  ? hit.id
                  : hit.type === 'back'
                    ? (isZh ? '全部类别' : 'All categories')
                    : (hit.id === 'files'
                      ? (isZh ? '搜索当前工作区文件' : 'Search workspace files')
                      : (isZh ? '引用另一段会话' : 'Reference another chat'));
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  className={`slash-command-item session-mention-item${hit.type === 'category' || hit.type === 'back' ? ' session-mention-nav' : ''}${index === activeMentionIndex ? ' active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMentionHit(hit);
                  }}
                >
                  <span className="session-mention-main">
                    <span className="session-mention-title">{title}</span>
                    {subtitle ? <span className="session-mention-id">{subtitle}</span> : null}
                  </span>
                </button>
              );
            })}
          {mentionLoading && mentionHits.every((hit) => hit.type === 'back' || hit.type === 'category') ? (
            <div className="slash-command-empty">
              {mentionScope === 'chats'
                ? (isZh ? '搜索会话…' : 'Searching chats…')
                : mentionScope === 'files'
                  ? (isZh ? '搜索文件…' : 'Searching files…')
                  : (isZh ? '搜索文件与会话…' : 'Searching files and chats…')}
            </div>
          ) : mentionHits.every((hit) => hit.type === 'back' || hit.type === 'category') && mentionScope !== 'all' ? (
            <div className="slash-command-empty">
              {mentionScope === 'chats'
                ? (isZh ? '没有匹配的会话' : 'No matching chats')
                : (isZh ? '没有匹配的文件' : 'No matching files')}
            </div>
          ) : null}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={!hasProvider}
        placeholder={hasProvider
          ? isBusy
            ? (isZh ? '随心输入' : 'Message will auto-send when done...')
            : variant === 'home'
              ? (isZh ? '描述任务，或告诉 Peer Agent 你想完成什么…' : 'Describe a task, or tell Peer Agent what you want to accomplish…')
              : (isZh ? '输入消息，@ 引用文件或会话' : 'Type a message, @ to mention a file or session')
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
          if (showContextMentions && atQuery) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (mentionHits.length === 0) return;
              setActiveMentionIndex((index) => (index + 1) % mentionHits.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (mentionHits.length === 0) return;
              setActiveMentionIndex((index) => (index - 1 + mentionHits.length) % mentionHits.length);
              return;
            }
            if ((event.key === 'Tab' || event.key === 'Enter')
              && mentionHits.length > 0
              && !event.nativeEvent.isComposing
              && event.keyCode !== 229) {
              event.preventDefault();
              const hit = mentionHits[activeMentionIndex] ?? mentionHits[0];
              if (hit) applyMentionHit(hit);
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
            <svg width="14" height="14" viewBox="4 4 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {homeModelSlot ? (
            <div className="composer-home-model-slot">{homeModelSlot}</div>
          ) : null}
        </div>
      <button
        type="submit"
        disabled={!hasProvider || (!isStreaming && (!hasComposerContent || !canStartTask))}
        className={isStreaming ? 'streaming' : undefined}
        title={isStreaming
          ? (isZh ? '停止生成' : 'Stop')
          : !canStartTask
            ? (isZh ? '请先选择工作区' : 'Select a workspace first')
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="5" width="14" height="14" rx="2.5" />
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
