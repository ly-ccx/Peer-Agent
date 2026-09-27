import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import type { BotInspect } from '../drawer/agentProcess';
import { quoteRefsFor, roundsForReply } from '../state/botConversationState';
import { useBotConversation } from '../state/useBotConversation';
import { BotComposer } from './BotComposer';
import { BotMessageList } from './BotMessageList';
import '../styles/bot-conversation.css';

export function BotConversation({
  workspaceId,
  i18n,
  onLocateSession,
  onInspect,
  focusMessageId = null,
  focusRequestId = 0,
}: {
  readonly workspaceId: string;
  readonly i18n: I18nRuntime;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onInspect?: (inspect: BotInspect) => void;
  readonly focusMessageId?: string | null;
  readonly focusRequestId?: number;
}) {
  const conversation = useBotConversation(workspaceId);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => {
    if (focusMessageId) setHighlightedId(focusMessageId);
  }, [focusMessageId, focusRequestId]);
  const [quote, setQuote] = useState<{ messageId: string; text: string } | null>(null);

  return (
    <div className="bot-convo">
      {conversation.status === 'error' ? (
        <p className="bot-thread-error">{i18n.t('projectAgent.chat.loadFailed')}</p>
      ) : (
        <BotMessageList
          workspaceId={workspaceId}
          rows={conversation.rows}
          highlightedId={highlightedId}
          i18n={i18n}
          onJump={(messageId) => setHighlightedId(messageId)}
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
      {conversation.thinking ? <p className="bot-thinking">{i18n.t('projectAgent.chat.thinking')}</p> : null}
      <BotComposer
        i18n={i18n}
        quote={quote?.text ?? ''}
        onQuoteRemove={() => setQuote(null)}
        onSend={(text) => {
          const refs = quote ? quoteRefsFor(quote.messageId, quote.text) : [];
          setQuote(null);
          void conversation.send(text, refs);
        }}
      />
    </div>
  );
}
