import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { QuoteChip } from './QuoteChip';

export function BotComposer({
  i18n,
  quote,
  onQuoteRemove,
  onSend,
}: {
  readonly i18n: I18nRuntime;
  readonly quote: string;
  readonly onQuoteRemove: () => void;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooLong = trimmed.length > 100_000;

  function send() {
    if (!trimmed || tooLong) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <form
      className="bot-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {quote ? (
        <QuoteChip text={quote} removeLabel={i18n.t('projectAgent.chat.quoteRemove')} onRemove={onQuoteRemove} />
      ) : null}
      <textarea
        value={text}
        rows={2}
        placeholder={i18n.t('projectAgent.chat.placeholder')}
        aria-label={i18n.t('projectAgent.chat.placeholder')}
        aria-invalid={tooLong}
        aria-describedby={tooLong ? 'bot-input-error' : undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key === 'Process') return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      {tooLong ? <p id="bot-input-error" role="alert">{i18n.t('projectAgent.chat.inputTooLong')}</p> : null}
      <div className="bot-composer-bar">
        <p>{i18n.t('projectAgent.chat.hint')}</p>
        <button type="submit" disabled={!trimmed || tooLong}>
          {i18n.t('projectAgent.chat.send')}
        </button>
      </div>
    </form>
  );
}
