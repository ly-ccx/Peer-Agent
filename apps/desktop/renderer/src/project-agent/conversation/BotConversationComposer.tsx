import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, InputDraftTaskRef } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { quoteRefsFor } from '../state/botConversationState';
import { composerInputKeys } from '../state/inputRecoveryProjection';
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

/** Draft keystrokes and save receipts must not invalidate the conversation's history. */
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
  const state = useInputRecoveryState(session, composerInputKeys);
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

  const quote = state.draft.quote;
  const quotedId = quote?.messageId;
  const quoteSource = useMemo(() => {
    const message = quotedId ? conversation.messages.find(message => message.id === quotedId) : undefined;
    return message ? replyAnchorsForMessages([message], {
      user: i18n.t('projectAgent.chat.you'), bot: label,
    }).get(message.id)?.author : null;
  }, [quotedId, conversation.messages, i18n, label]);

  const toggleTray = useCallback((mode: Exclude<TouchBarTrayMode, null>) => {
    setTrayMode((current) => (current === mode ? null : mode));
  }, []);

  const trayTriggerRef = trayMode === 'active' ? activeTriggerRef : historyTriggerRef;

  return <>
    {trayMode ? (
      <div className="bot-tray-scrim" aria-hidden="true" onClick={() => setTrayMode(null)} />
    ) : null}
    <InputRecoveryNotice state={state} session={session} i18n={i18n} />
    <BotComposer
      predictionContext={{ workspaceId, conversationId: profile.agentConversationId ?? '',
        version: `${[...conversation.messages].reverse().find(message => message.kind === 'agent_reply' || message.role === 'user')?.id ?? ''}:${JSON.stringify(profile.modelPolicy)}`,
        eligible: !state.error && state.pending.length === 0 && state.sending.length === 0,
        quoteMessageId: quote?.messageId }}
      draft={state.draft}
      onDraftChange={session.edit}
      ready={state.ready}
      i18n={i18n}
      botName={label}
      resourceRecipientConversationId={profile.agentConversationId}
      permissionControls={onSavingChange => <BotAccessControl key={workspaceId} workspaceId={workspaceId} i18n={i18n} onSavingChange={onSavingChange} />}
      modelUpdating={modelControls.busy}
      draftRequest={taskRequest?.draft ? { id: taskRequest.id, text: taskRequest.draft } : null}
      onDraftPrepared={id => {
        if (taskRequest?.id === id && taskRequest.messageId && taskRequest.taskTitle) {
          session.edit({ quote: { messageId: taskRequest.messageId, text: taskRequest.taskTitle } });
        }
      }}
      modelControls={<div className="bot-model-toolbar" aria-busy={!modelControls.loaded && modelControls.reading}><BotModelControls role="project_agent" compact
        policy={profile.modelPolicy} models={modelControls.models} view={modelControls.views.project_agent}
        activeSelection={conversation.activeModelSelection} busy={modelControls.busy} replying={conversation.generating}
        feedback={modelControls} i18n={i18n} onChange={policy => modelControls.save(policy)} /></div>}
      quote={quote?.text ?? ''}
      quoteSource={quoteSource}
      onQuoteLocate={quote ? () => onJump(quote.messageId) : undefined}
      generating={conversation.generating}
      stopping={conversation.stopping}
      onStop={() => void conversation.stop()}
      onQuoteRemove={() => session.edit({ quote: null })}
      onOpenTaskRef={onOpenTask}
      trayOpen={trayMode !== null}
      touchBar={(
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
      )}
      touchBarTray={trayMode ? (
        <TouchBarTray
          mode={trayMode}
          workspaceId={workspaceId}
          botName={label}
          activeTasks={activeTasks}
          historyTotalHint={historyTotal}
          i18n={i18n}
          triggerRef={trayTriggerRef}
          onClose={() => setTrayMode(null)}
          onOpenTask={(sessionId) => onOpenTask?.(sessionId)}
          onCiteTask={(ref) => appendTaskRef(ref)}
        />
      ) : null}
      onSend={() => {
        const current = session.getSnapshot().draft.quote;
        void conversation.send(undefined, current ? quoteRefsFor(current.messageId, current.text) : []);
      }}
    />
  </>;
}
