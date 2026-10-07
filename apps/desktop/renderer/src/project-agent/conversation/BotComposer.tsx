import type { I18nRuntime } from '@peer-agent/i18n';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { QuoteChip } from './QuoteChip';
import { PeerIcon } from '../../ui/icons';
import type { ProjectInputAttachment } from '@peer-agent/protocol';
import { getClipboardFiles } from '../../chat/state/quickChatAttachments';
import { useComposerAttachments } from './useComposerAttachments';
import { BotAttachments } from './BotAttachments';

export function BotComposer({
  i18n,
  botName,
  quote,
  quoteSource,
  onQuoteRemove,
  onSend,
  generating = false,
  stopping = false,
  onStop,
  modelControls,
  modelUpdating = false,
  draftRequest = null,
  onDraftPrepared,
}: {
  readonly i18n: I18nRuntime;
  readonly botName: string;
  readonly quote: string;
  readonly quoteSource?: string | null;
  readonly onQuoteRemove: () => void;
  readonly onSend: (text: string, attachments: readonly ProjectInputAttachment[]) => void;
  readonly generating?: boolean;
  readonly stopping?: boolean;
  readonly onStop?: () => void;
  readonly modelControls?: ReactNode;
  readonly modelUpdating?: boolean;
  readonly draftRequest?: { readonly id: number; readonly text: string } | null;
  readonly onDraftPrepared?: (id: number) => void;
}) {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const uploads = useComposerAttachments(i18n.locale.startsWith('zh'));
  const fileInput = useRef<HTMLInputElement>(null);
  const trimmed = text.trim();
  const hasContent = Boolean(trimmed) || uploads.attachments.length > 0;
  const tooLong = trimmed.length > 100_000;
  const prompt = i18n.t('projectAgent.chat.placeholder', { name: botName });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!draftRequest) return;
    // Preparing a follow-up never sends it, discards attachments or replaces an existing draft.
    if (!text.trim() && uploads.attachments.length === 0) {
      setText(draftRequest.text);
      onDraftPrepared?.(draftRequest.id);
    }
    textareaRef.current?.focus();
  }, [draftRequest?.id]);
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    resizeComposerInput(node);
  }, [text]);
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      resizeComposerInput(node);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function send() {
    if (!hasContent || tooLong || uploads.isReading() || modelUpdating) return;
    onSend(trimmed, uploads.attachments);
    setText('');
    uploads.clear();
  }

  return (
    <form
      className={`bot-composer${dragging ? ' is-file-drop' : ''}`}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(false);
        uploads.add(Array.from(event.dataTransfer.files));
        textareaRef.current?.focus();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {quote ? (
        <QuoteChip text={quote} source={quoteSource || i18n.t('projectAgent.chat.quote')}
          removeLabel={i18n.t('projectAgent.chat.quoteRemove')} onRemove={onQuoteRemove} />
      ) : null}
      <input ref={fileInput} type="file" multiple hidden onChange={event => {
        uploads.add(Array.from(event.target.files ?? []));
        event.target.value = '';
        textareaRef.current?.focus();
      }} />
      {uploads.attachments.length ? <BotAttachments attachments={uploads.attachments} i18n={i18n} onRemove={uploads.remove} /> : null}
      {dragging ? <span className="bot-file-drop-hint" aria-hidden="true">{i18n.t('projectAgent.chat.dropAttachments')}</span> : null}
      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        placeholder={prompt}
        aria-label={prompt}
        title={i18n.t('projectAgent.chat.hint')}
        aria-invalid={tooLong}
        aria-describedby={tooLong ? 'bot-input-error' : undefined}
        onChange={(event) => setText(event.target.value)}
        onPaste={event => {
          const files = getClipboardFiles(event.clipboardData.items);
          if (!files.length) return;
          event.preventDefault();
          uploads.add(files);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key === 'Process') return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      {tooLong ? <p id="bot-input-error" role="alert">{i18n.t('projectAgent.chat.inputTooLong')}</p> : null}
      {uploads.error ? <p className="bot-attachment-error" role="alert">{uploads.error}</p> : null}
      {uploads.reading ? <p className="bot-attachment-status" role="status">{i18n.t('projectAgent.chat.readingAttachments')}</p> : null}
      <div className="bot-composer-bar">
        <div className="bot-composer-leading">
          <button type="button" className="bot-attach-button" aria-label={i18n.t('projectAgent.chat.attach')}
            title={i18n.t('projectAgent.chat.attach')} onClick={() => fileInput.current?.click()}><PeerIcon name="plus" size={18} /></button>
          {!modelControls ? <p>{i18n.t('projectAgent.chat.hint')}</p> : null}
        </div>
        <div className="bot-composer-actions">
          {modelControls}
          {generating ? <button type="button" className="bot-stop-response" disabled={stopping} title={i18n.t('projectAgent.chat.stopHint')} aria-label={i18n.t(stopping ? 'projectAgent.chat.stopping' : 'projectAgent.chat.stop')} onClick={onStop}><PeerIcon name="stop" size={15} /></button> : null}
          {!generating || hasContent ? <button type="submit" disabled={!hasContent || tooLong || uploads.reading || modelUpdating} aria-label={i18n.t('projectAgent.chat.send')} title={i18n.t('projectAgent.chat.send')}><PeerIcon name="send" size={17} /></button> : null}
        </div>
      </div>
    </form>
  );
}

function resizeComposerInput(node: HTMLTextAreaElement) {
  node.style.height = '0px';
  const height = node.scrollHeight;
  node.style.height = `${Math.min(200, Math.max(36, height))}px`;
  node.style.overflowY = height > 200 ? 'auto' : 'hidden';
}
