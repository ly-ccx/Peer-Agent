import type { LlmProviderConfigView, LocalAccessLevel } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import {
  isTextLikeFile,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_FILE_BYTES,
  readAsDataUrl,
  readAsText,
} from '../../chat/state/attachmentIntake';
import { getApiMessageContent } from '../../chat/state/apiMessageMapping';
import { buildAttachmentContext } from '../../chat/state/contextSources';
import {
  ACCESS_LEVELS,
  CHAT_MODES,
  accessLevelLabel,
  accessLevelTitle,
  effortLabel,
  isChatMode,
  isLocalAccessLevel,
  modeLabel,
  modeTitle,
  normalizeEffortLevels,
  type ChatMode,
  type EffortLevel,
} from '../../chat/state/preferences';
import { getProviderModelDisplayLabel } from '../../chat/state/providerDisplay';
import { getClipboardFiles, hasQuickChatContent } from '../../chat/state/quickChatAttachments';
import type { ChatAttachment, ChatMsg } from '../../chat/state/types';
import { AttachmentStrip } from '../../chat/components/thread/AttachmentStrip';
import '../../styles/quick-chat.css';

type Workspace = { path: string; name?: string };

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function QuickChatWindow() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacePath, setWorkspacePath] = useState('');
  const [draft, setDraft] = useState(() => localStorage.getItem('quick-chat:draft') ?? '');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [openPopover, setOpenPopover] = useState<'workspace' | 'model' | 'effort' | 'mode' | 'access' | null>(null);
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [modelProviderId, setModelProviderId] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('default');
  const [mode, setMode] = useState<ChatMode>(() => {
    const remembered = localStorage.getItem('quick-chat:mode');
    return isChatMode(remembered) ? remembered : 'chat';
  });
  const [localAccessLevel, setLocalAccessLevel] = useState<LocalAccessLevel>(() => {
    const configured = (clientApi.initialSettings as Record<string, unknown>)?.localAccessLevel;
    return isLocalAccessLevel(configured) ? configured : 'ask_before_local';
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void clientApi.workspaceList().then((result) => {
      const items = [...(result.workspaces ?? [])];
      setWorkspaces(items);
      const remembered = localStorage.getItem('quick-chat:workspace');
      setWorkspacePath(remembered && items.some((item) => item.path === remembered)
        ? remembered
        : result.activeWorkspace ?? items[0]?.path ?? '');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    void clientApi.llmListChatProviders().then((items) => {
      const available = items.filter((provider) => provider.apiKeyConfigured);
      setProviders(available);
      const remembered = localStorage.getItem('quick-chat:model-provider');
      const selected = available.find((provider) => provider.id === remembered)
        ?? available.find((provider) => provider.isDefault)
        ?? available[0];
      if (!selected) return;
      setModelProviderId(selected.id);
      const levels = normalizeEffortLevels(selected.reasoningEffortLevels);
      const rememberedEffort = localStorage.getItem('quick-chat:effort') as EffortLevel | null;
      setEffort(rememberedEffort && levels.includes(rememberedEffort) ? rememberedEffort : levels[0] ?? 'default');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    inputRef.current?.focus();
  }, []);

  useEffect(() => { localStorage.setItem('quick-chat:draft', draft); }, [draft]);
  useEffect(() => {
    if (workspacePath) localStorage.setItem('quick-chat:workspace', workspacePath);
  }, [workspacePath]);
  useEffect(() => clientApi.onQuickChatShown?.(() => {
    setOpenPopover(null);
    inputRef.current?.focus();
  }), []);
  useEffect(() => {
    if (modelProviderId) localStorage.setItem('quick-chat:model-provider', modelProviderId);
  }, [modelProviderId]);
  useEffect(() => { localStorage.setItem('quick-chat:effort', effort); }, [effort]);
  useEffect(() => { localStorage.setItem('quick-chat:mode', mode); }, [mode]);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === modelProviderId) ?? providers[0],
    [modelProviderId, providers],
  );
  const effortLevels = useMemo(
    () => normalizeEffortLevels(selectedProvider?.reasoningEffortLevels),
    [selectedProvider],
  );

  useEffect(() => clientApi.onQuickChatPopoverClosed(() => {
    setOpenPopover(null);
    inputRef.current?.focus();
  }), []);

  useEffect(() => clientApi.onQuickChatPopoverSelected(({ kind, value }) => {
    setOpenPopover(null);
    if (kind === 'workspace' && workspaces.some((workspace) => workspace.path === value)) {
      setWorkspacePath(value);
    }
    if (kind === 'model') {
      const provider = providers.find((item) => item.id === value);
      if (provider) {
        const levels = normalizeEffortLevels(provider.reasoningEffortLevels);
        setModelProviderId(provider.id);
        setEffort((current) => levels.includes(current) ? current : levels[0] ?? 'default');
      }
    }
    if (kind === 'effort' && effortLevels.includes(value as EffortLevel)) {
      setEffort(value as EffortLevel);
    }
    if (kind === 'mode' && isChatMode(value)) setMode(value);
    if (kind === 'access' && isLocalAccessLevel(value)) {
      setLocalAccessLevel(value);
      void clientApi.updateSettings({ localAccessLevel: value });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }), [effortLevels, providers, workspaces]);

  const togglePopover = useCallback((
    kind: 'workspace' | 'model' | 'effort' | 'mode' | 'access',
    anchor: HTMLButtonElement,
  ) => {
    if (openPopover === kind) {
      setOpenPopover(null);
      void clientApi.quickChatHidePopover();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const items = kind === 'workspace'
      ? workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name || workspace.path.split('/').filter(Boolean).pop() || workspace.path, detail: workspace.path }))
      : kind === 'model'
        ? providers.map((provider) => ({ value: provider.id, label: getProviderModelDisplayLabel(provider, true), detail: provider.name }))
        : kind === 'effort'
          ? effortLevels.map((level) => ({ value: level, label: effortLabel(level, true) }))
          : kind === 'mode'
            ? CHAT_MODES.map((value) => ({ value, label: modeLabel(value, true), detail: modeTitle(value, true) }))
            : ACCESS_LEVELS.map((value) => ({ value, label: accessLevelLabel(value, true), detail: accessLevelTitle(value, true) }));
    const selectedValue = kind === 'workspace'
      ? workspacePath
      : kind === 'model'
        ? modelProviderId
        : kind === 'effort'
          ? effort
          : kind === 'mode'
            ? mode
            : localAccessLevel;
    setOpenPopover(kind);
    void clientApi.quickChatShowPopover({
      kind,
      items,
      selectedValue,
      anchorRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }, [effort, effortLevels, localAccessLevel, mode, modelProviderId, openPopover, providers, workspacePath, workspaces]);

  const selectedName = useMemo(() => {
    const selected = workspaces.find((item) => item.path === workspacePath);
    return selected?.name || workspacePath.split('/').filter(Boolean).pop() || '选择工作区';
  }, [workspacePath, workspaces]);

  const addFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;
    setError('');
    const next: ChatAttachment[] = [];
    for (const file of incoming) {
      if (attachments.length + next.length >= MAX_ATTACHMENTS) {
        setError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`);
        break;
      }
      try {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_BYTES) { setError(`图片 ${file.name} 超过 8 MB`); continue; }
          next.push({ id: id('attachment'), name: file.name || 'clipboard-image.png', mimeType: file.type, size: file.size, kind: 'image', dataUrl: await readAsDataUrl(file) });
        } else if (isTextLikeFile(file)) {
          if (file.size > MAX_TEXT_FILE_BYTES) { setError(`文件 ${file.name} 超过 512 KB`); continue; }
          next.push({ id: id('attachment'), name: file.name, mimeType: file.type || 'text/plain', size: file.size, kind: 'text', text: await readAsText(file) });
        } else {
          next.push({ id: id('attachment'), name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, kind: 'unsupported' });
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    if (next.length) setAttachments((current) => [...current, ...next]);
  }, [attachments.length]);

  async function submit(openMainWindow: boolean) {
    const text = draft.trim();
    if (!hasQuickChatContent(text, attachments) || !workspacePath || sending) return;
    setSending(true);
    setError('');
    try {
      const conversation = await clientApi.conversationsCreate({ title: text.slice(0, 48) || attachments[0]?.name || '新会话', workspacePath, mode });
      const now = Date.now();
      const userMessage: ChatMsg = { id: id('user'), role: 'user', content: text, attachments, timestamp: now };
      const assistantMessage = { id: id('assistant'), role: 'assistant', content: '', timestamp: now + 1 };
      await clientApi.conversationsAppendMessage({ id: conversation.id, message: { id: userMessage.id, role: userMessage.role, content: userMessage.content, timestamp: userMessage.timestamp, attachments: userMessage.attachments } });
      await clientApi.conversationsAppendMessage({ id: conversation.id, message: assistantMessage });
      await Promise.all([
        clientApi.conversationsUpdateMode({ id: conversation.id, mode }),
        clientApi.conversationsUpdateModelEffort({ id: conversation.id, modelProviderId, effort }),
      ]);
      const streamId = id('quick');
      await clientApi.quickChatSubmit?.({ conversationId: conversation.id, workspacePath, openMainWindow, streamId });
      void clientApi.chatSend({
        messages: [{ role: 'user', content: getApiMessageContent(userMessage) }],
        contextAttachments: buildAttachmentContext(attachments), streamId,
        assistantMessageId: assistantMessage.id, effort, mode, conversationId: conversation.id,
        modelProviderId, workspacePath,
      });
      setDraft('');
      setAttachments([]);
      localStorage.removeItem('quick-chat:draft');
      await clientApi.quickChatHide?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <main className="quick-chat-shell">
      <section className={`quick-chat-bar${error ? ' quick-chat-bar--error' : ''}${sending ? ' quick-chat-bar--sending' : ''}`} aria-label="快速会话" aria-busy={sending}>
        <div className={`quick-chat-composer${dragActive ? ' is-drag-active' : ''}`} onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); } }} onDragLeave={() => setDragActive(false)} onDrop={(event) => { event.preventDefault(); setDragActive(false); void addFiles(event.dataTransfer.files); }}>
          <div className="quick-chat-input-row">
            <AttachmentStrip
              attachments={attachments}
              isZh
              onRemove={(attachmentId) => setAttachments((current) => current.filter((item) => item.id !== attachmentId))}
            />
            <textarea ref={inputRef} value={draft} placeholder="向 Peer Agent 发起任务…" aria-label="快速会话内容" onChange={(event) => { setDraft(event.target.value); setError(''); }} onPaste={(event) => {
              const files = getClipboardFiles(event.clipboardData.items);
              if (files.length) { event.preventDefault(); void addFiles(files); }
            }} onKeyDown={(event) => {
              if (event.key === 'Escape') { void clientApi.quickChatHide?.(); return; }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event.metaKey || event.ctrlKey); }
            }} />
            <input ref={fileInputRef} className="quick-chat-file-input" type="file" multiple onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ''; }} />
            <button type="button" className="quick-chat-attach" aria-label="添加附件" title="添加附件" disabled={sending} onClick={() => fileInputRef.current?.click()}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <button type="button" className="quick-chat-send" aria-label={sending ? '正在发送' : '发送'} disabled={(!draft.trim() && !attachments.length) || !workspacePath || sending} onClick={() => void submit(false)}>
              {sending ? <span className="quick-chat-spinner" aria-hidden="true" /> : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className="quick-chat-meta-row">
          <div className="quick-chat-selectors">
            <button
              className="quick-chat-workspace"
              type="button"
              title={workspacePath}
              aria-haspopup="listbox"
              aria-expanded={openPopover === 'workspace'}
              disabled={!workspaces.length}
              onClick={(event) => togglePopover('workspace', event.currentTarget)}
            >
              <span className="quick-chat-workspace-dot" aria-hidden="true" />
              <span className="quick-chat-workspace-name">{selectedName}</span>
              <svg className={`quick-chat-chevron${openPopover === 'workspace' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div className="quick-chat-selector-group quick-chat-selector-group-primary">
              <button className={`quick-chat-mode${mode !== 'chat' ? ' is-emphasized' : ''}`} type="button" title={modeTitle(mode, true)} aria-haspopup="listbox" aria-expanded={openPopover === 'mode'} onClick={(event) => togglePopover('mode', event.currentTarget)}>
                <span>{modeLabel(mode, true)}</span>
                <svg className={`quick-chat-chevron${openPopover === 'mode' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              <button className={`quick-chat-access${localAccessLevel === 'full_local' ? ' is-danger' : ''}`} type="button" title={accessLevelTitle(localAccessLevel, true)} aria-haspopup="listbox" aria-expanded={openPopover === 'access'} onClick={(event) => togglePopover('access', event.currentTarget)}>
                <span>{accessLevelLabel(localAccessLevel, true)}</span>
                <svg className={`quick-chat-chevron${openPopover === 'access' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
            </div>
            <div className="quick-chat-selector-spacer" aria-hidden="true" />
            <div className="quick-chat-selector-group quick-chat-selector-group-secondary">
              {selectedProvider ? (
                <button className="quick-chat-model" type="button" aria-haspopup="listbox" aria-expanded={openPopover === 'model'} onClick={(event) => togglePopover('model', event.currentTarget)}>
                  <span>{getProviderModelDisplayLabel(selectedProvider, true)}</span>
                  <svg className={`quick-chat-chevron${openPopover === 'model' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              ) : null}
              {selectedProvider?.supportsReasoning && effortLevels.length ? (
                <button className="quick-chat-effort" type="button" aria-haspopup="listbox" aria-expanded={openPopover === 'effort'} onClick={(event) => togglePopover('effort', event.currentTarget)}>
                  <span>{effortLabel(effort, true)}</span>
                  <svg className={`quick-chat-chevron${openPopover === 'effort' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              ) : null}
            </div>
          </div>
          {error ? <span className="quick-chat-error" role="alert">{error}</span> : null}
        </div>
      </section>
    </main>
  );
}
