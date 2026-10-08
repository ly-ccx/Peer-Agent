import { createI18n } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons/PeerIcon';
import { useQuickChatBotModel } from '../../project-agent/state/useQuickChatBotModel';
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
  hasTunableEffortLevels,
  isChatMode,
  isLocalAccessLevel,
  modeLabel,
  modePickerValue,
  modeTitle,
  normalizeEffortLevels,
  resolveDraftModelProviderId,
  resolvePreferredEffort,
  resolveProviderById,
  writeLastModelProviderId,
  type ChatMode,
  type EffortLevel,
} from '../../chat/state/preferences';
import { getProviderModelDisplayLabel } from '../../chat/state/providerDisplay';
import { getClipboardFiles, hasQuickChatContent } from '../../chat/state/quickChatAttachments';
import type { ChatAttachment, ChatMsg } from '../../chat/state/types';
import { AttachmentStrip, PEER_ATTACHMENT_DND_TYPE } from '../../chat/components/thread/AttachmentStrip';
import type { QuickChatPopoverAnchorRect, QuickChatPopoverKind } from '../../preload/contracts/bootstrapPreloadApi';
import { type InlineQuickChatPopoverState } from './QuickChatPopover';
import { pickQuickChatBot, quickChatShell, quickChatSubmission } from '../state/quickChatBotTarget';
import { runQuickChatSubmission } from '../state/quickChatSubmission';
import '../../styles/quick-chat.css';

type Workspace = { path: string; name?: string };

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function QuickChatWindow() {
  const [locale, setLocale] = useState(() => String((clientApi.initialSettings as Record<string, unknown>)?.locale || 'zh-CN'));
  const i18n = useMemo(() => createI18n(locale), [locale]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacePath, setWorkspacePath] = useState('');
  const [botMode, setBotMode] = useState(() => quickChatShell(clientApi.initialSettings) === 'bots');
  const [bots, setBots] = useState<readonly { workspaceId: string; name: string; lastActiveAt: string }[]>([]);
  const [botId, setBotId] = useState('');
  const botModel = useQuickChatBotModel(botMode ? botId : null);
  const [draft, setDraft] = useState(() => localStorage.getItem('quick-chat:draft') ?? '');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [popoverState, setPopoverState] = useState<InlineQuickChatPopoverState | null>(null);
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
  const barRef = useRef<HTMLElement | null>(null);
  const lastReportedHeightRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    if (botMode) return;
    void clientApi.workspaceList().then((result) => {
      const items = [...(result.workspaces ?? [])];
      setWorkspaces(items);
      const remembered = localStorage.getItem('quick-chat:workspace');
      setWorkspacePath(remembered && items.some((item) => item.path === remembered)
        ? remembered
        : result.activeWorkspace ?? items[0]?.path ?? '');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    // Quick Chat 与主聊天保持同一口径：只列已配置模型，不把 provider 目录自动投影进选择器。
    void clientApi.llmListProviders().then((items) => {
      const available = items.filter((provider) => provider.apiKeyConfigured);
      setProviders(available);
      // 优先读主聊天共享记忆，不再被独立的 quick-chat:model-provider 压过。
      // 兼容历史 groupId::model 绑定。
      const remembered = resolveDraftModelProviderId(available);
      const selected = (remembered ? available.find((provider) => provider.id === remembered) : null)
        ?? available.find((provider) => provider.isDefault)
        ?? available[0];
      if (!selected) return;
      setModelProviderId(selected.id);
      const levels = normalizeEffortLevels(selected.reasoningEffortLevels);
      const rememberedEffort = localStorage.getItem('quick-chat:effort') as EffortLevel | null;
      setEffort(
        rememberedEffort && levels.includes(rememberedEffort)
          ? rememberedEffort
          : resolvePreferredEffort(levels, selected.reasoningDefaultEffort),
      );
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [botMode]);

  const loadBotRouting = useCallback(() => {
    void clientApi.getSettings().then((settings) => {
      setLocale(String((settings as Record<string, unknown>)?.locale || 'zh-CN'));
      const shell = quickChatShell(settings as { projectAgent?: { shell?: string } });
      setBotMode(shell === 'bots');
      if (shell !== 'bots') {
        setBots([]);
        setBotId('');
        return;
      }
      return clientApi.projectAgentList().then((listed) => {
        const choices = (listed.items ?? []).map((item) => ({
          workspaceId: item.workspaceId,
          name: item.profile.displayName,
          lastActiveAt: item.lastActiveAt,
        }));
        setBots(choices);
        setBotId((current) => (
          choices.some((bot) => bot.workspaceId === current)
            ? current
            : (pickQuickChatBot(choices)?.workspaceId ?? '')
        ));
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadBotRouting();
  }, [loadBotRouting]);

  useEffect(() => { localStorage.setItem('quick-chat:draft', draft); }, [draft]);
  useEffect(() => {
    if (workspacePath) localStorage.setItem('quick-chat:workspace', workspacePath);
  }, [workspacePath]);
  // 每次显示 Quick 时：先聚焦输入框；模型对齐等非关键工作延后到下一帧，避免和首帧争抢。
  useEffect(() => clientApi.onQuickChatShown?.(() => {
    setPopoverState(null);
    loadBotRouting();
    inputRef.current?.focus();
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(cb, 0);
    schedule(() => {
      if (botMode) return;
      const remembered = resolveDraftModelProviderId(providers);
      if (!remembered) return;
      setModelProviderId((current) => {
        if (providers.some((provider) => provider.id === remembered)) return remembered;
        return current;
      });
    });
  }), [botMode, loadBotRouting, providers]);
  // Quick 内切换模型也回写共享记忆，保持与主聊天同一条“上次模型”链路。
  useEffect(() => {
    if (!botMode) writeLastModelProviderId(modelProviderId);
  }, [botMode, modelProviderId]);
  useEffect(() => { localStorage.setItem('quick-chat:effort', effort); }, [effort]);
  useEffect(() => { localStorage.setItem('quick-chat:mode', mode); }, [mode]);
  const selectedProvider = useMemo(
    () => resolveProviderById(providers, modelProviderId) ?? providers[0],
    [modelProviderId, providers],
  );
  const effortLevels = useMemo(
    () => normalizeEffortLevels(selectedProvider?.reasoningEffortLevels),
    [selectedProvider],
  );

  const openPopover = popoverState?.kind ?? null;

  const selectPopoverValue = useCallback((kind: QuickChatPopoverKind, value: string) => {
    if (botMode) {
      if (sending || botModel.busy) return;
      if (kind === 'workspace' && bots.some(bot => bot.workspaceId === value)) setBotId(value);
      if (kind === 'model') botModel.chooseModel(value);
      if (kind === 'effort') botModel.chooseEffort(value);
      return;
    }
    if (kind === 'workspace' && workspaces.some((workspace) => workspace.path === value)) {
      setWorkspacePath(value);
      // Keep main app workspace in sync when possible.
      void clientApi.workspaceSetActive?.({ path: value }).catch(() => {});
    }
    if (kind === 'model') {
      const provider = providers.find((item) => item.id === value);
      if (provider) {
        const levels = normalizeEffortLevels(provider.reasoningEffortLevels);
        setModelProviderId(provider.id);
        writeLastModelProviderId(provider.id);
        setEffort((current) => (
          levels.includes(current)
            ? current
            : resolvePreferredEffort(levels, provider.reasoningDefaultEffort)
        ));
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
  }, [botMode, bots, botModel, sending, effortLevels, providers, workspaces]);

  // Main process (native Menu / window popover) reports selection here.
  // Without this subscription the bar never updates after Menu.popup.
  useEffect(() => clientApi.onQuickChatPopoverSelected?.((payload) => {
    if (!payload || typeof payload.kind !== 'string' || typeof payload.value !== 'string') return;
    selectPopoverValue(payload.kind as QuickChatPopoverKind, payload.value);
    setPopoverState(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }), [selectPopoverValue]);

  useEffect(() => clientApi.onQuickChatPopoverClosed(() => {
    setPopoverState(null);
    inputRef.current?.focus();
  }), []);

  const dismissPopover = useCallback(() => {
    setPopoverState(null);
    void clientApi.quickChatHidePopover();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const togglePopover = useCallback((
    kind: QuickChatPopoverKind,
    anchor: HTMLButtonElement,
  ) => {
    if (openPopover === kind) {
      dismissPopover();
      return;
    }
    // Horizontal: trigger button. Vertical: flush under the whole input bar bottom.
    const trigger = anchor.getBoundingClientRect();
    const bar = barRef.current?.getBoundingClientRect();
    const barBottom = bar ? bar.y + bar.height : trigger.y + trigger.height;
    const rect = {
      x: trigger.x,
      y: bar?.y ?? trigger.y,
      width: trigger.width,
      height: barBottom - (bar?.y ?? trigger.y),
    };
    const items = botMode
      ? kind === 'workspace'
        ? bots.map(bot => ({ value: bot.workspaceId, label: bot.name }))
        : kind === 'model'
          ? botModel.choices.map(model => ({ value: model.id, label: model.label, group: model.providerName }))
          : (botModel.model?.reasoningEffortLevels ?? []).map(value => ({ value, label: effortLabel(value, i18n.locale.startsWith('zh')) }))
      : kind === 'workspace'
      ? workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name || workspace.path.split('/').filter(Boolean).pop() || workspace.path, detail: workspace.path }))
      : kind === 'model'
        // group = provider name → native Menu submenu; leaf label = model only.
        ? providers.map((provider) => ({
            value: provider.id,
            label: getProviderModelDisplayLabel(provider, true),
            group: (provider.name || provider.id || 'Provider').trim(),
          }))
        : kind === 'effort'
          ? effortLevels.map((level) => ({ value: level, label: effortLabel(level, true) }))
          : kind === 'mode'
            // Menu shows "Agent：说明 / Plan：说明" as one line (user-requested density).
            ? CHAT_MODES.map((value) => ({
                value,
                label: `${modeLabel(value, true)}：${modeTitle(value, true)}`,
              }))
            : ACCESS_LEVELS.map((value) => ({ value, label: accessLevelLabel(value, true), detail: accessLevelTitle(value, true) }));
    const selectedValue = botMode
      ? kind === 'workspace' ? botId : kind === 'model' ? botModel.model?.id ?? '' : botModel.effort ?? ''
      : kind === 'workspace'
      ? workspacePath
      : kind === 'model'
        ? modelProviderId
        : kind === 'effort'
          ? effort
          : kind === 'mode'
            ? modePickerValue(mode)
            : localAccessLevel;
    const nextState: InlineQuickChatPopoverState & { anchorRect: QuickChatPopoverAnchorRect } = {
      kind,
      items,
      selectedValue,
      anchorRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    setPopoverState(nextState);
    void clientApi.quickChatShowPopover(nextState).then((result) => {
      if (!result.ok) setPopoverState((current) => current?.kind === kind ? null : current);
    }).catch((reason: unknown) => {
      setPopoverState((current) => current?.kind === kind ? null : current);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [botMode, botId, bots, botModel, i18n, dismissPopover, effort, effortLevels, localAccessLevel, mode, modelProviderId, openPopover, providers, workspacePath, workspaces]);

  const selectedBot = bots.find(bot => bot.workspaceId === botId);

  const selectedName = useMemo(() => {
    const selected = workspaces.find((item) => item.path === workspacePath);
    return selected?.name || workspacePath.split('/').filter(Boolean).pop() || i18n.t('projectAgent.quick.workspace');
  }, [workspacePath, workspaces, i18n]);

  const addFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;
    if (botMode) {
      setError(i18n.t('projectAgent.quick.textOnly'));
      return;
    }
    setError('');
    const next: ChatAttachment[] = [];
    for (const file of incoming) {
      if (attachments.length + next.length >= MAX_ATTACHMENTS) {
        setError(i18n.t('projectAgent.quick.attachmentLimit', { count: MAX_ATTACHMENTS }));
        break;
      }
      try {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_BYTES) { setError(i18n.t('projectAgent.quick.imageLimit', { name: file.name })); continue; }
          next.push({ id: id('attachment'), name: file.name || 'clipboard-image.png', mimeType: file.type, size: file.size, kind: 'image', dataUrl: await readAsDataUrl(file) });
        } else if (isTextLikeFile(file)) {
          if (file.size > MAX_TEXT_FILE_BYTES) { setError(i18n.t('projectAgent.quick.fileLimit', { name: file.name })); continue; }
          next.push({ id: id('attachment'), name: file.name, mimeType: file.type || 'text/plain', size: file.size, kind: 'text', text: await readAsText(file) });
        } else {
          next.push({ id: id('attachment'), name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, kind: 'unsupported' });
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    if (next.length) setAttachments((current) => [...current, ...next]);
  }, [attachments.length, botMode, i18n]);

  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [draft, attachments.length]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const reportHeight = () => {
      const nextHeight = Math.ceil(bar.getBoundingClientRect().height);
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
      if (Math.abs(nextHeight - lastReportedHeightRef.current) < 1) return;
      lastReportedHeightRef.current = nextHeight;
      void clientApi.quickChatSetContentHeight?.(nextHeight).catch(() => {});
    };

    reportHeight();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => reportHeight());
    observer?.observe(bar);
    const unsubscribeShown = clientApi.onQuickChatShown?.(() => {
      requestAnimationFrame(reportHeight);
    });
    return () => {
      observer?.disconnect();
      unsubscribeShown?.();
    };
  }, [attachments.length, draft, error]);

  const reorderAttachments = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setAttachments((prev) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  }, []);

  async function submit(openMainWindow: boolean) {
    const text = draft.trim();
    if (botMode) {
      if (botModel.busy || !botModel.ready) return;
      if (attachments.length) {
        setError(i18n.t('projectAgent.quick.textOnly'));
        return;
      }
      const routed = quickChatSubmission({ shell: 'bots', workspaceId: botId, text });
      if (!routed.ok || sending) {
        if (!routed.ok) setError(bots.length === 0 ? i18n.t('projectAgent.quick.noBots') : i18n.t('projectAgent.quick.empty'));
        return;
      }
      setSending(true);
      setError('');
      await runQuickChatSubmission(async () => {
        const result = await clientApi.projectAgentSubmitInput({
          workspaceId: routed.workspaceId,
          inputId: `qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          text: routed.text,
          surface: routed.surface,
        });
        if (!result?.ok) throw new Error(result?.code || i18n.t('projectAgent.quick.failed'));
        setDraft('');
        setAttachments([]);
        localStorage.removeItem('quick-chat:draft');
        await clientApi.quickChatHide?.();
      }, (reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        inputRef.current?.focus();
      }, () => setSending(false));
      return;
    }
    if (!hasQuickChatContent(text, attachments) || !workspacePath || sending) return;
    setSending(true);
    setError('');
    await runQuickChatSubmission(async () => {
      const conversation = await clientApi.conversationsCreate({ title: text.slice(0, 48) || attachments[0]?.name || i18n.t('app.newTask'), workspacePath, mode });
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
    }, (reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      inputRef.current?.focus();
    }, () => setSending(false));
  }

  return (
    <main className={`quick-chat-shell${botMode ? ' quick-chat-shell--bots' : ''}${popoverState ? ' has-open-popover' : ''}`}>
      <section ref={barRef} className={`quick-chat-bar${error ? ' quick-chat-bar--error' : ''}${sending ? ' quick-chat-bar--sending' : ''}`} aria-label={i18n.t('projectAgent.quick.title')} aria-busy={sending}>
        <div
          className={`quick-chat-composer${dragActive ? ' is-drag-active' : ''}`}
          onDragOver={(event) => {
            const types = Array.from(event.dataTransfer.types);
            if (types.includes(PEER_ATTACHMENT_DND_TYPE)) return;
            if (types.includes('Files')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setDragActive(true);
            }
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            const types = Array.from(event.dataTransfer.types);
            if (types.includes(PEER_ATTACHMENT_DND_TYPE)) return;
            event.preventDefault();
            setDragActive(false);
            void addFiles(event.dataTransfer.files);
          }}
        >
          {attachments.length ? (
            <AttachmentStrip
              attachments={attachments}
              isZh={i18n.locale === 'zh-CN'}
              onRemove={(attachmentId) => setAttachments((current) => current.filter((item) => item.id !== attachmentId))}
              onReorder={reorderAttachments}
            />
          ) : null}
          <div className="quick-chat-input-row">
            <textarea ref={inputRef} rows={1} value={draft} placeholder={botMode && selectedBot ? i18n.t('projectAgent.chat.placeholder', { name: selectedBot.name }) : i18n.t('projectAgent.quick.placeholder')} aria-label={i18n.t('projectAgent.quick.content')} onChange={(event) => { setDraft(event.target.value); setError(''); }} onPaste={(event) => {
              const files = getClipboardFiles(event.clipboardData.items);
              if (files.length) { event.preventDefault(); void addFiles(files); }
            }} onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (popoverState) dismissPopover();
                else void clientApi.quickChatHide?.();
                return;
              }
              // IME composition: Enter confirms candidate; also ignore keyCode 229 (legacy IME).
              if (
                event.key === 'Enter'
                && !event.shiftKey
                && !event.nativeEvent.isComposing
                && event.keyCode !== 229
              ) {
                event.preventDefault();
                void submit(event.metaKey || event.ctrlKey);
              }
            }} />
            <input ref={fileInputRef} className="quick-chat-file-input" type="file" multiple onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ''; }} />
            {botMode ? null : <button type="button" className="quick-chat-attach" aria-label={i18n.t('projectAgent.quick.attach')} title={i18n.t('projectAgent.quick.attach')} disabled={sending} onClick={() => fileInputRef.current?.click()}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>}
            <button type="button" className="quick-chat-send" aria-label={i18n.t(sending ? 'projectAgent.quick.sending' : 'projectAgent.chat.send')} disabled={(botMode ? !draft.trim() || !botId || !botModel.ready || botModel.busy : ((!draft.trim() && !attachments.length) || !workspacePath)) || sending} onClick={() => void submit(false)}>
              {sending ? <PeerIcon name="loader" className="quick-chat-spinner" /> : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className="quick-chat-meta-row">
          <div className="quick-chat-selectors">
            {botMode ? (
              <button className="quick-chat-workspace quick-chat-bot" type="button"
                aria-label={i18n.t('projectAgent.quick.chooseBot')} aria-haspopup="listbox" aria-expanded={openPopover === 'workspace'}
                disabled={sending || botModel.busy || !bots.length} onClick={event => togglePopover('workspace', event.currentTarget)}>
                <span className="quick-chat-workspace-name">{selectedBot?.name ?? i18n.t('projectAgent.quick.noBots')}</span>
                <PeerIcon name="chevronDown" className={`quick-chat-chevron${openPopover === 'workspace' ? ' is-open' : ''}`} />
              </button>
            ) : null}
            {botMode ? null : <button
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
            </button>}
            {botMode ? null : <div className="quick-chat-selector-group quick-chat-selector-group-primary">
              <button className={`quick-chat-mode${mode !== 'chat' ? ' is-emphasized' : ''}`} type="button" title={modeTitle(mode, true)} aria-haspopup="listbox" aria-expanded={openPopover === 'mode'} onClick={(event) => togglePopover('mode', event.currentTarget)}>
                <span>{modeLabel(mode, true)}</span>
                <svg className={`quick-chat-chevron${openPopover === 'mode' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              <button className={`quick-chat-access${localAccessLevel === 'full_local' ? ' is-danger' : ''}`} type="button" title={accessLevelTitle(localAccessLevel, true)} aria-haspopup="listbox" aria-expanded={openPopover === 'access'} onClick={(event) => togglePopover('access', event.currentTarget)}>
                <span>{accessLevelLabel(localAccessLevel, true)}</span>
                <svg className={`quick-chat-chevron${openPopover === 'access' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
            </div>}
            <div className="quick-chat-selector-spacer" aria-hidden="true" />
            <div className="quick-chat-selector-group quick-chat-selector-group-secondary">
              {botMode ? <>
                <button className="quick-chat-model" type="button" aria-label={i18n.t('projectAgent.model.select')}
                  aria-haspopup="listbox" aria-expanded={openPopover === 'model'} disabled={sending || botModel.busy || !botModel.choices.length}
                  onClick={event => togglePopover('model', event.currentTarget)}>
                  <span>{botModel.model?.label ?? i18n.t('projectAgent.model.unavailable')}</span>
                  <PeerIcon name="chevronDown" className={`quick-chat-chevron${openPopover === 'model' ? ' is-open' : ''}`} />
                </button>
                {botModel.effort && (botModel.model?.reasoningEffortLevels?.length ?? 0) > 1 ? <button className="quick-chat-effort" type="button"
                  aria-label={i18n.t('projectAgent.quick.effort')} aria-haspopup="listbox" aria-expanded={openPopover === 'effort'} disabled={sending || botModel.busy}
                  onClick={event => togglePopover('effort', event.currentTarget)}>
                  <span>{effortLabel(botModel.effort as EffortLevel, i18n.locale.startsWith('zh'))}</span>
                  <PeerIcon name="chevronDown" className={`quick-chat-chevron${openPopover === 'effort' ? ' is-open' : ''}`} />
                </button> : null}
              </> : selectedProvider ? (
                <button className="quick-chat-model" type="button" aria-haspopup="listbox" aria-expanded={openPopover === 'model'} onClick={(event) => togglePopover('model', event.currentTarget)}>
                  <span>{getProviderModelDisplayLabel(selectedProvider, true)}</span>
                  <svg className={`quick-chat-chevron${openPopover === 'model' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              ) : null}
              {!botMode && selectedProvider?.supportsReasoning && hasTunableEffortLevels(effortLevels) ? (
                <button className="quick-chat-effort" type="button" aria-haspopup="listbox" aria-expanded={openPopover === 'effort'} onClick={(event) => togglePopover('effort', event.currentTarget)}>
                  <span>{effortLabel(effort, true)}</span>
                  <svg className={`quick-chat-chevron${openPopover === 'effort' ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              ) : null}
            </div>
          </div>
          {error || (botMode && botModel.error) ? <span className="quick-chat-error" role="alert">{error || i18n.t(botModel.saveFailed ? 'projectAgent.model.saveFailed' : 'projectAgent.quick.loadFailed')}</span> : null}
        </div>
      </section>
      {/* Enums (incl. effort) + model provider submenus → native Menu (ADR 60). */}
    </main>
  );
}
