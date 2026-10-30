import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile } from '@peer-agent/protocol';
import { useMemo } from 'react';
import { quoteRefsFor } from '../state/botConversationState';
import { composerInputKeys } from '../state/inputRecoveryProjection';
import { replyAnchorsForMessages } from '../state/replyReferenceState';
import type { TaskConversationRequest } from '../state/taskConversationState';
import type { useBotConversation } from '../state/useBotConversation';
import type { BotModelsControlState } from '../state/useBotModels';
import { useInputRecoveryState } from '../state/useInputRecovery';
import { BotAccessControl } from '../BotAccessControl';
import { BotModelControls } from '../BotModelControls';
import { BotComposer } from './BotComposer';
import { InputRecoveryNotice } from './InputRecoveryNotice';

/** Draft keystrokes and save receipts must not invalidate the conversation's history. */
export function BotConversationComposer({ workspaceId, conversation, profile, modelControls, label, i18n, taskRequest, onJump }: {
  readonly workspaceId: string;
  readonly conversation: ReturnType<typeof useBotConversation>;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly label: string;
  readonly i18n: I18nRuntime;
  readonly taskRequest: TaskConversationRequest | null;
  readonly onJump: (messageId: string) => void;
}) {
  const session = conversation.recovery.session;
  const state = useInputRecoveryState(session, composerInputKeys);
  const quote = state.draft.quote;
  const quotedId = quote?.messageId;
  const quoteSource = useMemo(() => {
    const message = quotedId ? conversation.messages.find(message => message.id === quotedId) : undefined;
    return message ? replyAnchorsForMessages([message], {
      user: i18n.t('projectAgent.chat.you'), bot: label,
    }).get(message.id)?.author : null;
  }, [quotedId, conversation.messages, i18n, label]);
  return <>
    <InputRecoveryNotice state={state} session={session} i18n={i18n} />
    <BotComposer
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
        activeSelection={conversation.activeModelSelection} busy={modelControls.busy || conversation.generating}
        feedback={modelControls} i18n={i18n} onChange={policy => modelControls.save(policy)} /></div>}
      quote={quote?.text ?? ''}
      quoteSource={quoteSource}
      onQuoteLocate={quote ? () => onJump(quote.messageId) : undefined}
      generating={conversation.generating}
      stopping={conversation.stopping}
      onStop={() => void conversation.stop()}
      onQuoteRemove={() => session.edit({ quote: null })}
      onSend={() => {
        const current = session.getSnapshot().draft.quote;
        void conversation.send(undefined, current ? quoteRefsFor(current.messageId, current.text) : []);
      }}
    />
  </>;
}
