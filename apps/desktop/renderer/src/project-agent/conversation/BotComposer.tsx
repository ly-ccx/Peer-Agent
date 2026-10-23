import type { I18nRuntime } from '@peer-agent/i18n';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { QuoteChip } from './QuoteChip';
import { PeerIcon } from '../../ui/icons';
import type { InputDraftValue } from '@peer-agent/protocol';
import { useCompositionGuard } from '../../app/hooks/useCompositionGuard';
import { getClipboardFiles } from '../../chat/state/quickChatAttachments';
import { useComposerAttachments } from './useComposerAttachments';
import { BotAttachments } from './BotAttachments';

export function BotComposer({
  i18n,
  botName,
  draft, onDraftChange, ready,
  quote,
  quoteSource,
  onQuoteLocate,
  onQuoteRemove,
  onSend,
  generating = false,
  stopping = false,
  onStop,
  modelControls,
  permissionControls,
  modelUpdating = false,
  draftRequest = null,
  onDraftPrepared,
}: {
  readonly i18n: I18nRuntime;
  readonly botName: string;
  readonly draft: InputDraftValue;
  readonly onDraftChange: (patch: Partial<InputDraftValue>) => void;
  readonly ready: boolean;
  readonly quote: string;
  readonly quoteSource?: string | null;
  readonly onQuoteLocate?: () => void;
  readonly onQuoteRemove: () => void;
  readonly onSend: () => void;
  readonly generating?: boolean;
  readonly stopping?: boolean;
  readonly onStop?: () => void;
  readonly modelControls?: ReactNode;
  readonly permissionControls?: (onSavingChange: (saving: boolean) => void) => ReactNode;
  readonly modelUpdating?: boolean;
  readonly draftRequest?: { readonly id: number; readonly text: string } | null;
  readonly onDraftPrepared?: (id: number) => void;
}) {
  const text = draft.text;
  const setText = (text: string) => onDraftChange({ text });
  const composition = useCompositionGuard();
  const [dragging, setDragging] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const uploads = useComposerAttachments(i18n.locale.startsWith('zh'), { attachments: draft.attachments, onChange: attachments => onDraftChange({ attachments }) });
  const fileInput = useRef<HTMLInputElement>(null);
  const trimmed = text.trim();
  const hasContent = Boolean(trimmed) || uploads.attachments.length > 0;
  const tooLong = trimmed.length > 100_000;
  const prompt = i18n.t('projectAgent.chat.placeholder', { name: botName });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!draftRequest || !ready) return;
    // Preparing a follow-up never sends it, discards attachments or replaces an existing draft.
    if (!text.trim() && uploads.attachments.length === 0) {
      setText(draftRequest.text);
      onDraftPrepared?.(draftRequest.id);
    }
    textareaRef.current?.focus();
  }, [draftRequest?.id, ready]);
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
    if (!ready || !hasContent || tooLong || uploads.isReading() || modelUpdating || permissionSaving || composition.active()) return;
    onSend();
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
        if (!ready) return;
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
          removeLabel={i18n.t('projectAgent.chat.quoteRemove')} onRemove={() => { onQuoteRemove(); textareaRef.current?.focus({ preventScroll: true }); }}
          locateLabel={i18n.t('resources.quoteSource')} onLocate={onQuoteLocate} />
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
        disabled={!ready}
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
        onCompositionStart={event => composition.start(event.currentTarget)}
        onCompositionEnd={event => composition.end(event.currentTarget)}
        onKeyUp={event => composition.keyUp(event.nativeEvent)}
        onBlur={() => composition.reset()}
        onKeyDown={(event) => {
          if (composition.keyDown(event.nativeEvent)) return;
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
            title={i18n.t('projectAgent.chat.attach')} disabled={!ready} onClick={() => fileInput.current?.click()}><PeerIcon name="plus" size={18} /></button>
          {!modelControls ? <p>{i18n.t('projectAgent.chat.hint')}</p> : null}
          {permissionControls?.(setPermissionSaving)}
        </div>
        <div className="bot-composer-actions">
          {modelControls}
          {generating ? <button type="button" className="bot-stop-response" disabled={stopping} title={i18n.t('projectAgent.chat.stopHint')} aria-label={i18n.t(stopping ? 'projectAgent.chat.stopping' : 'projectAgent.chat.stop')} onClick={onStop}><PeerIcon name="stop" size={15} /></button> : null}
          {!generating || hasContent ? <button type="submit" disabled={!ready || !hasContent || tooLong || uploads.reading || modelUpdating || permissionSaving} aria-label={i18n.t('projectAgent.chat.send')} title={i18n.t('projectAgent.chat.send')}><PeerIcon name="send" size={17} /></button> : null}
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
