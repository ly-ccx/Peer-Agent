import type { I18nRuntime } from '@zeus-atlas/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../../clientApi';
import type { AgentSummary } from '../../state/useAgentList';
import type { CloudChatRuntime } from '../../state/cloudChatRuntimeTypes';
import { ImagePreviewBar } from './ImagePreviewBar';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

type ComposerVariant = 'thread' | 'empty';

export function ChatComposer({
  activeAgent,
  agents,
  autoFocus = false,
  draft,
  i18n,
  onSelectAgent,
  runtime,
  setDraft,
  variant = 'thread',
}: {
  readonly activeAgent?: AgentSummary | null;
  readonly agents?: readonly AgentSummary[];
  readonly autoFocus?: boolean;
  readonly draft: string;
  readonly i18n: I18nRuntime;
  readonly onSelectAgent?: (agent: AgentSummary) => void;
  readonly runtime: CloudChatRuntime;
  readonly setDraft: (draft: string) => void;
  readonly variant?: ComposerVariant;
}) {
  const isStreaming = runtime.state.isStreaming;
  const isConversationLoading = Boolean(runtime.loadingConversationId);
  const composerButtonLabel = isStreaming ? i18n.t('chat.thread.stop') : i18n.t('chat.composer.send');
  const placeholder = variant === 'empty' ? i18n.t('chat.empty.placeholder') : i18n.t('chat.composer.placeholder');

  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUploadImageFile = useCallback(async (file: File) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return;
    if (file.size > MAX_IMAGE_SIZE) return;
    setUploadingCount((prev) => prev + 1);
    try {
      const buffer = await file.arrayBuffer();
      const url = await clientApi.chat.uploadImage({
        buffer: Array.from(new Uint8Array(buffer)),
        fileName: file.name,
        mimeType: file.type,
      });
      if (url) {
        setPendingImages((prev) => [...prev, url]);
      }
    } catch {
      // silent
    } finally {
      setUploadingCount((prev) => prev - 1);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) void handleUploadImageFile(file);
    }
  }, [handleUploadImageFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    for (const file of files) {
      void handleUploadImageFile(file);
    }
  }, [handleUploadImageFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const submitDraft = () => {
    if (isConversationLoading) return;
    if (uploadingCount > 0) return;
    if (isStreaming) {
      void runtime.stopStream();
      return;
    }
    const value = draft.trim();
    if (!value && pendingImages.length === 0) return;
    setDraft('');
    const images = pendingImages.length > 0 ? [...pendingImages] : undefined;
    setPendingImages([]);
    void runtime.sendMessage(value || '请看图片', images);
  };

  return (
    <form
      className={`cloud-chat-composer ${variant}`}
      onSubmit={(event) => {
        event.preventDefault();
        submitDraft();
      }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ImagePreviewBar
        images={pendingImages}
        uploadingCount={uploadingCount}
        onRemove={(index) => setPendingImages((prev) => prev.filter((_, i) => i !== index))}
        onAdd={() => fileInputRef.current?.click()}
      />
      <textarea
        autoFocus={autoFocus}
        value={draft}
        disabled={isStreaming || isConversationLoading}
        placeholder={placeholder}
        rows={variant === 'empty' ? 4 : 1}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          const isComposing = event.nativeEvent.isComposing;
          if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
            event.preventDefault();
            submitDraft();
          }
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          for (const file of files) void handleUploadImageFile(file);
          e.target.value = '';
        }}
      />
      {agents && agents.length > 0 && onSelectAgent ? (
        runtime.state.messages.length > 0 ? (
          <span className="agent-picker-label">{activeAgent?.name || 'Agent'}</span>
        ) : (
          <AgentPicker
            activeAgent={activeAgent ?? null}
            agents={agents}
            onSelect={onSelectAgent}
          />
        )
      ) : null}
      <button
        type="submit"
        className={isStreaming ? 'streaming' : undefined}
        aria-label={composerButtonLabel}
        disabled={isConversationLoading || (!isStreaming && !draft.trim() && pendingImages.length === 0) || uploadingCount > 0}
      >
        <span aria-hidden="true">
          {isStreaming ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </span>
      </button>
    </form>
  );
}

function AgentPicker({
  activeAgent,
  agents,
  onSelect,
}: {
  readonly activeAgent: AgentSummary | null;
  readonly agents: readonly AgentSummary[];
  readonly onSelect: (agent: AgentSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    setSearch('');
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.trim().toLowerCase()))
    : agents;

  if (agents.length <= 1) {
    return activeAgent ? (
      <span className="agent-picker-label">{activeAgent.name}</span>
    ) : null;
  }

  return (
    <div className="agent-picker" ref={ref}>
      <button type="button" className="agent-picker-trigger" onClick={() => setOpen(!open)}>
        {activeAgent?.name || 'Agent'} <span className="agent-picker-caret">▾</span>
      </button>
      {open ? (
        <div className="agent-picker-dropdown">
          <input
            className="agent-picker-search"
            placeholder="搜索 Agent..."
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {filtered.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className={agent.id === activeAgent?.id ? 'selected' : ''}
              onClick={() => { onSelect(agent); setOpen(false); }}
            >
              {agent.name}
            </button>
          ))}
          {filtered.length === 0 ? (
            <span className="agent-picker-empty">无匹配</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
