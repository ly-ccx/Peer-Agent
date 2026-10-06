import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import type { BotInspect } from '../drawer/agentProcess';
import type { BotAvatarMood } from '../state/botAvatarState';
import { quoteRefsFor, roundsForReply } from '../state/botConversationState';
import { useBotConversation } from '../state/useBotConversation';
import { BotModelControls } from '../BotModelControls';
import type { BotModelsControlState } from '../state/useBotModels';
import { DelegatedWork } from './DelegatedWork';
import { backgroundWork, type BotWorkIndex } from '../state/botWorkState';
import { BotComposer } from './BotComposer';
import { BotMessageList } from './BotMessageList';
import '../styles/bot-conversation.css';

export function BotConversation({
  workspaceId,
  workIndex,
  profile,
  modelControls,
  avatar,
  label,
  avatarMood,
  i18n,
  onReplyArrived,
  onLocateSession,
  onInspect,
  focusMessageId = null,
  focusRequestId = 0,
}: {
  readonly workspaceId: string;
  readonly workIndex: BotWorkIndex;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly avatarMood: BotAvatarMood;
  readonly i18n: I18nRuntime;
  readonly onReplyArrived?: (workspaceId: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onInspect?: (inspect: BotInspect) => void;
  readonly focusMessageId?: string | null;
  readonly focusRequestId?: number;
}) {
  const conversation = useBotConversation(workspaceId);
  const lastReplyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (conversation.status !== 'ready') return;
    const replies = conversation.messages.filter((message) => message.kind === 'agent_reply');
    const lastId = replies[replies.length - 1]?.id ?? null;
    if (lastReplyRef.current !== undefined && lastId && lastId !== lastReplyRef.current) {
      onReplyArrived?.(workspaceId);
    }
    lastReplyRef.current = lastId;
  }, [conversation.status, conversation.messages, onReplyArrived, workspaceId]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [highlightRequestId, setHighlightRequestId] = useState(0);
  useEffect(() => {
    if (highlightedId) void conversation.locateMessage(highlightedId);
  }, [highlightedId, conversation.locateMessage]);
  useEffect(() => {
    if (focusMessageId) { setHighlightedId(focusMessageId); setHighlightRequestId(value => value + 1); }
  }, [focusMessageId, focusRequestId]);
  const [quote, setQuote] = useState<{ messageId: string; text: string } | null>(null);

  const background = useMemo(() => backgroundWork(workIndex), [workIndex]);

  return (
    <div className="bot-convo">
      {conversation.status === 'error' ? (
        <p className="bot-thread-error">{i18n.t('projectAgent.chat.loadFailed')}</p>
      ) : (
        <BotMessageList
          workspaceId={workspaceId}
          workIndex={workIndex}
          avatar={avatar}
          label={label}
          avatarMood={avatarMood}
          rows={conversation.rows}
          followRequestId={conversation.followRequestId}
          waiting={conversation.thinking}
          hasOlder={conversation.hasOlder}
          olderError={conversation.olderError}
          onLoadOlder={conversation.loadOlder}
          highlightedId={highlightedId}
          highlightRequestId={highlightRequestId}
          i18n={i18n}
          onJump={(messageId) => { setHighlightedId(messageId); setHighlightRequestId(value => value + 1); }}
          onQuote={(messageId, excerpt) => setQuote({ messageId, text: excerpt })}
          onRetry={(inputId) => {
            void conversation.retry(inputId);
          }}
          onLocateSession={onLocateSession}
          onOpenEvidence={(evidenceRef) => {
            void clientApi.projectAgentReadEvidence({ evidenceRef }).then((result) => {
              onInspect?.({
                evidence: {
                  ok: result?.ok === true,
                  evidenceRef: result?.evidenceRef || evidenceRef,
                  kind: result?.kind || 'command',
                  summary: result?.summary || '',
                  truncated: result?.truncated === true,
                  code: result?.code || '',
                },
                rounds: null,
              });
            }).catch(() => {
              onInspect?.({
                evidence: {
                  ok: false,
                  evidenceRef,
                  kind: 'command',
                  summary: '',
                  truncated: false,
                  code: 'NOT_FOUND',
                },
                rounds: null,
              });
            });
          }}
          onOpenProcess={(replyId) => {
            onInspect?.({
              evidence: null,
              rounds: roundsForReply(conversation.messages, replyId),
            });
          }}
        />
      )}
      {conversation.stopError ? <p className="bot-thread-error" role="alert">{i18n.t('projectAgent.chat.stopFailed')}</p> : null}
      {modelControls.error ? <p className="bot-model-error" role="alert">{i18n.t('projectAgent.model.saveFailed')}</p> : null}
      {background.count ? <details className="bot-background-work"><summary>{i18n.t('projectAgent.chat.work.background', { count: background.count })}<PeerIcon name="chevronDown" size={12} /></summary>
        <DelegatedWork rows={background.rows} i18n={i18n} onOpen={onLocateSession} /></details> : null}
      <BotComposer
        key={workspaceId}
        i18n={i18n}
        modelUpdating={modelControls.busy}
        modelControls={<div className="bot-model-toolbar"><BotModelControls role="project_agent" compact
          policy={profile.modelPolicy} models={modelControls.models} view={modelControls.views.project_agent}
          activeSelection={conversation.activeModelSelection} busy={modelControls.busy || conversation.generating}
          i18n={i18n} onChange={policy => modelControls.save(policy)} /></div>}
        quote={quote?.text ?? ''}
        generating={conversation.generating}
        stopping={conversation.stopping}
        onStop={() => void conversation.stop()}
        onQuoteRemove={() => setQuote(null)}
        onSend={(text, attachments) => {
          const refs = quote ? quoteRefsFor(quote.messageId, quote.text) : [];
          setQuote(null);
          void conversation.send(text, refs, attachments);
        }}
      />
    </div>
  );
}
