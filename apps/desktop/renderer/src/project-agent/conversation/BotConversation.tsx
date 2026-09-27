import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { quoteRefsFor } from '../state/botConversationState';
import { useBotConversation } from '../state/useBotConversation';
import { BotComposer } from './BotComposer';
import { BotMessageList } from './BotMessageList';
import '../styles/bot-conversation.css';

export function BotConversation({
  workspaceId,
  i18n,
  onLocateSession,
}: {
  readonly workspaceId: string;
  readonly i18n: I18nRuntime;
  readonly onLocateSession: (sessionId: string) => void;
}) {
  const conversation = useBotConversation(workspaceId);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
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
