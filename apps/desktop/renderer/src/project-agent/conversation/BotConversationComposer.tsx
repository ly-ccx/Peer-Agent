import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, InputDraftTaskRef } from '@peer-agent/protocol';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { quoteRefsFor } from '../state/botConversationState';
import { composerDraftKeys, composerStatusKeys } from '../state/inputRecoveryProjection';
import { replyAnchorsForMessages } from '../state/replyReferenceState';
import type { TaskConversationRequest } from '../state/taskConversationState';
import type { useBotConversation } from '../state/useBotConversation';
import type { BotModelsControlState } from '../state/useBotModels';
import { useInputRecoveryState } from '../state/useInputRecovery';
import type { SidebarTaskEntry } from '../state/botNavigationState';
import { BotAccessControl } from '../BotAccessControl';
import { BotModelControls } from '../BotModelControls';
import { BotComposer } from './BotComposer';
import { ComposerTouchBar } from './ComposerTouchBar';
import { TouchBarTray, type TouchBarTrayMode } from './TouchBarTray';
import { InputRecoveryNotice } from './InputRecoveryNotice';
import '../styles/bot-touchbar.css';

export interface CiteTaskRequest {
  readonly id: number;
  readonly ref: InputDraftTaskRef;
  readonly prefillText?: string;
}

const BotComposerDraftBridge = memo(function BotComposerDraftBridge({
  workspaceId,
  conversation,
  agentConversationId,
  predictionVersion,
  predictionEligible,
  ready,
  label,
  i18n,
  modelUpdating,
  taskRequest,
  onDraftPrepared,
  permissionControls,
  modelControls,
  touchBar,
  touchBarTray,
  trayOpen,
  onOpenTask,
  onJump,
  onSend,
}: {
  readonly workspaceId: string;
  readonly conversation: ReturnType<typeof useBotConversation>;
  readonly agentConversationId?: string;
  readonly predictionVersion: string;
  readonly predictionEligible: boolean;
  readonly ready: boolean;
  readonly label: string;
  readonly i18n: I18nRuntime;
  readonly modelUpdating: boolean;
  readonly taskRequest: TaskConversationRequest | null;
  readonly onDraftPrepared: (id: number) => void;
  readonly permissionControls: (onSavingChange: (saving: boolean) => void) => ReactNode;
  readonly modelControls: ReactNode;
  readonly touchBar: ReactNode;
  readonly touchBarTray: ReactNode;
  readonly trayOpen: boolean;
  readonly onOpenTask?: (sessionId: string) => void;
  readonly onJump: (messageId: string) => void;
  readonly onSend: () => void;
}) {
  const session = conversation.recovery.session;
  const { draft } = useInputRecoveryState(session, composerDraftKeys);
  const quote = draft.quote;
  const quotedId = quote?.messageId;
  const quoteSource = useMemo(() => {
    const message = quotedId ? conversation.messages.find(message => message.id === quotedId) : undefined;
    return message ? replyAnchorsForMessages([message], {
      user: i18n.t('projectAgent.chat.you'), bot: label,
    }).get(message.id)?.author : null;
  }, [quotedId, conversation.messages, i18n, label]);

  const predictionContext = useMemo(() => ({
    workspaceId,
    conversationId: agentConversationId ?? '',
    version: predictionVersion,
    eligible: predictionEligible,
    quoteMessageId: quote?.messageId,
  }), [workspaceId, agentConversationId, predictionVersion, predictionEligible, quote?.messageId]);

  const draftRequest = useMemo(
    () => (taskRequest?.draft ? { id: taskRequest.id, text: taskRequest.draft } : null),
    [taskRequest?.id, taskRequest?.draft],
  );
  const handleQuoteLocate = useMemo(
    () => (quote ? () => onJump(quote.messageId) : undefined),
    [quote, onJump],
  );
  const handleQuoteRemove = useCallback(() => session.edit({ quote: null }), [session]);
  const handleStop = useCallback(() => { void conversation.stop(); }, [conversation.stop]);

  return (
    <BotComposer
      predictionContext={predictionContext}
      draft={draft}
      onDraftChange={session.edit}
      ready={ready}
      i18n={i18n}
      botName={label}
      resourceRecipientConversationId={agentConversationId}
      permissionControls={permissionControls}
      modelUpdating={modelUpdating}
      draftRequest={draftRequest}
      onDraftPrepared={onDraftPrepared}
      modelControls={modelControls}
      quote={quote?.text ?? ''}
      quoteSource={quoteSource}
      onQuoteLocate={handleQuoteLocate}
      generating={conversation.generating}
      stopping={conversation.stopping}
      onStop={handleStop}
      onQuoteRemove={handleQuoteRemove}
      onOpenTaskRef={onOpenTask}
      trayOpen={trayOpen}
      touchBar={touchBar}
      touchBarTray={touchBarTray}
      onSend={onSend}
    />
  );
});

/** Draft keystrokes and save receipts must not invalidate the conversation's history or composer chrome. */
export function BotConversationComposer({
  workspaceId,
  conversation,
  profile,
  modelControls,
  label,
  i18n,
  taskRequest,
  activeTasks = [],
  historyTotal = 0,
  citeRequest = null,
  onOpenTask,
  onJump,
}: {
  readonly workspaceId: string;
  readonly conversation: ReturnType<typeof useBotConversation>;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly label: string;
  readonly i18n: I18nRuntime;
  readonly taskRequest: TaskConversationRequest | null;
  readonly activeTasks?: readonly SidebarTaskEntry[];
  readonly historyTotal?: number;
  readonly citeRequest?: CiteTaskRequest | null;
  readonly onOpenTask?: (sessionId: string) => void;
  readonly onJump: (messageId: string) => void;
}) {
  const session = conversation.recovery.session;
  const statusState = useInputRecoveryState(session, composerStatusKeys);
  const [trayMode, setTrayMode] = useState<TouchBarTrayMode>(null);
  const activeTriggerRef = useRef<HTMLButtonElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const handledCiteIdRef = useRef<number>(0);

  const appendTaskRef = useCallback((ref: InputDraftTaskRef, prefillText?: string) => {
    const current = session.getSnapshot().draft;
    const existing = current.taskRefs ?? [];
    const nextRefs = existing.some((item) => item.sessionId === ref.sessionId)
      ? existing
      : [...existing, ref].slice(-5);
    const shouldPrefill = Boolean(prefillText && !current.text.trim());
    session.edit({
      taskRefs: nextRefs,
      ...(shouldPrefill ? { text: prefillText } : {}),
    });
  }, [session]);

  useEffect(() => {
    if (!citeRequest || citeRequest.id === handledCiteIdRef.current) return;
    handledCiteIdRef.current = citeRequest.id;
    appendTaskRef(citeRequest.ref, citeRequest.prefillText);
  }, [citeRequest, appendTaskRef]);

  useEffect(() => {
    setTrayMode(null);
  }, [workspaceId]);

  const toggleTray = useCallback((mode: Exclude<TouchBarTrayMode, null>) => {
    setTrayMode((current) => (current === mode ? null : mode));
  }, []);

  const closeTray = useCallback(() => setTrayMode(null), []);
  const trayTriggerRef = trayMode === 'active' ? activeTriggerRef : historyTriggerRef;

  const predictionVersion = useMemo(() => {
    let lastId = '';
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (message && (message.kind === 'agent_reply' || message.role === 'user')) {
        lastId = message.id;
        break;
      }
    }
    return `${lastId}:${JSON.stringify(profile.modelPolicy)}`;
  }, [conversation.messages, profile.modelPolicy]);

  const predictionEligible = !statusState.error && statusState.pending.length === 0 && statusState.sending.length === 0;

  const permissionControls = useCallback(
    (onSavingChange: (saving: boolean) => void) => (
      <BotAccessControl key={workspaceId} workspaceId={workspaceId} i18n={i18n} onSavingChange={onSavingChange} />
    ),
    [workspaceId, i18n],
  );

  const modelControlsNode = useMemo(() => (
    <div className="bot-model-toolbar" aria-busy={!modelControls.loaded && modelControls.reading}>
      <BotModelControls
        role="project_agent"
        compact
        policy={profile.modelPolicy}
        models={modelControls.models}
        view={modelControls.views.project_agent}
        activeSelection={conversation.activeModelSelection}
        busy={modelControls.busy}
        replying={conversation.generating}
        feedback={modelControls}
        i18n={i18n}
        onChange={policy => modelControls.save(policy)}
      />
    </div>
  ), [
    modelControls,
    profile.modelPolicy,
    conversation.activeModelSelection,
    conversation.generating,
    i18n,
  ]);

  const touchBar = useMemo(() => (
    <ComposerTouchBar
      kind="bot"
      activeTasks={activeTasks}
      historyTotal={historyTotal}
      trayMode={trayMode}
      i18n={i18n}
      activeTriggerRef={activeTriggerRef}
      historyTriggerRef={historyTriggerRef}
      onToggleTray={toggleTray}
    />
  ), [activeTasks, historyTotal, trayMode, i18n, toggleTray]);

  const touchBarTray = useMemo(() => (trayMode ? (
    <TouchBarTray
      mode={trayMode}
      workspaceId={workspaceId}
      botName={label}
      activeTasks={activeTasks}
      historyTotalHint={historyTotal}
      i18n={i18n}
      triggerRef={trayTriggerRef}
      onClose={closeTray}
      onOpenTask={(sessionId) => onOpenTask?.(sessionId)}
      onCiteTask={(ref) => appendTaskRef(ref)}
    />
  ) : null), [trayMode, workspaceId, label, activeTasks, historyTotal, i18n, trayTriggerRef, closeTray, onOpenTask, appendTaskRef]);

  const handleDraftPrepared = useCallback((id: number) => {
    if (taskRequest?.id === id && taskRequest.messageId && taskRequest.taskTitle) {
      session.edit({ quote: { messageId: taskRequest.messageId, text: taskRequest.taskTitle } });
    }
  }, [taskRequest, session]);

  const handleSend = useCallback(() => {
    const current = session.getSnapshot().draft.quote;
    void conversation.send(undefined, current ? quoteRefsFor(current.messageId, current.text) : []);
  }, [session, conversation.send]);

  return <>
    {trayMode ? (
      <div className="bot-tray-scrim" aria-hidden="true" onClick={closeTray} />
    ) : null}
    <InputRecoveryNotice state={statusState} session={session} i18n={i18n} />
    {conversation.restoredNotice ? (
      <div className="bot-thread-feedback" role="status">
        <p>{i18n.t(conversation.restoredNotice)}</p>
        <button type="button" onClick={conversation.clearRestoredNotice}>{i18n.t('projectAgent.drawer.close')}</button>
      </div>
    ) : null}
    <BotComposerDraftBridge
      workspaceId={workspaceId}
      conversation={conversation}
      agentConversationId={profile.agentConversationId}
      predictionVersion={predictionVersion}
      predictionEligible={predictionEligible}
      ready={statusState.ready}
      label={label}
      i18n={i18n}
      modelUpdating={modelControls.busy}
      taskRequest={taskRequest}
      onDraftPrepared={handleDraftPrepared}
      permissionControls={permissionControls}
      modelControls={modelControlsNode}
      touchBar={touchBar}
      touchBarTray={touchBarTray}
      trayOpen={trayMode !== null}
      onOpenTask={onOpenTask}
      onJump={onJump}
      onSend={handleSend}
    />
  </>;
}
