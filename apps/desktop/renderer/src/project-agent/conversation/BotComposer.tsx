import type { I18nRuntime } from '@peer-agent/i18n';
import { useLayoutEffect, useRef, useState } from 'react';
import { QuoteChip } from './QuoteChip';
import { PeerIcon } from '../../ui/icons';

export function BotComposer({
  i18n,
  quote,
  onQuoteRemove,
  onSend,
  generating = false,
  stopping = false,
  onStop,
}: {
  readonly i18n: I18nRuntime;
  readonly quote: string;
  readonly onQuoteRemove: () => void;
  readonly onSend: (text: string) => void;
  readonly generating?: boolean;
  readonly stopping?: boolean;
  readonly onStop?: () => void;
}) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooLong = trimmed.length > 100_000;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(160, Math.max(44, node.scrollHeight))}px`;
    node.style.overflowY = node.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [text]);

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
        ref={textareaRef}
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
        <div className="bot-composer-actions">
          {generating ? <button type="button" className="bot-stop-response" disabled={stopping} title={i18n.t('projectAgent.chat.stopHint')} aria-label={i18n.t(stopping ? 'projectAgent.chat.stopping' : 'projectAgent.chat.stop')} onClick={onStop}><PeerIcon name="stop" size={15} /></button> : null}
          {!generating || trimmed ? <button type="submit" disabled={!trimmed || tooLong} aria-label={i18n.t('projectAgent.chat.send')} title={i18n.t('projectAgent.chat.send')}><PeerIcon name="send" size={17} /></button> : null}
        </div>
      </div>
    </form>
  );
}
