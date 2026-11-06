import { useState } from 'react';
import type { ChatAttachment } from '../../chat/state/types';
import { ImageLightbox, imageLightboxSourceFromAttachment } from '../../chat/components/thread/ImageLightbox';
import { Overlay } from '../../app/components/Overlay';
import { formatBytes } from '../../chat/state/format';
import { PeerIcon } from '../../ui/icons';
import type { I18nRuntime } from '@peer-agent/i18n';

/** Drafts and durable messages share one preview; metadata never implies an available body. */
export function BotAttachments({ attachments, i18n, onRemove }: {
  readonly attachments: readonly ChatAttachment[];
  readonly i18n: I18nRuntime;
  readonly onRemove?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  const [broken, setBroken] = useState<Record<string, string>>({});
  return <>
    <div className="bot-attachments">
      {attachments.map(item => <div className={`bot-attachment ${item.kind}`} key={item.id}>
        <button type="button" className={item.kind === 'image' ? 'bot-attachment-image' : 'bot-attachment-preview'}
          aria-label={`${i18n.t('projectAgent.chat.previewAttachment')} ${item.name}`} onClick={() => setPreview(item)}>
          {item.kind === 'image' && item.dataUrl && broken[item.id] !== item.dataUrl
            ? <img src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" onError={() => setBroken(value => ({ ...value, [item.id]: item.dataUrl! }))} />
            : <><PeerIcon name="fileText" size={20} /><span className="bot-attachment-meta">
              <span title={item.name}>{item.name}</span>
              <small>{item.kind === 'unsupported' ? i18n.t('projectAgent.chat.attachmentMetadataOnly') : formatBytes(item.size)}</small>
            </span></>}
        </button>
        {onRemove ? <button type="button" className="bot-attachment-remove" aria-label={`${i18n.t('projectAgent.chat.removeAttachment')} ${item.name}`}
          onClick={event => {
            const container = event.currentTarget.closest('.bot-attachments');
            const next = event.currentTarget.closest('.bot-attachment')?.nextElementSibling?.querySelector<HTMLButtonElement>('button')
              ?? event.currentTarget.closest('.bot-attachment')?.previousElementSibling?.querySelector<HTMLButtonElement>('button')
              ?? container?.closest('.bot-composer')?.querySelector<HTMLTextAreaElement>('textarea');
            next?.focus({ preventScroll: true }); onRemove(item.id);
          }}><PeerIcon name="close" size={12} /></button> : null}
      </div>)}
    </div>
    {preview?.kind === 'image' ? <ImageLightbox key={preview.id} source={imageLightboxSourceFromAttachment(preview)}
      isZh={i18n.locale.startsWith('zh')} onClose={() => setPreview(null)} /> : preview ? <Overlay
      ariaLabel={i18n.t('resources.attachmentText')} panelClassName="bot-attachment-text-preview" onClose={() => setPreview(null)}>
      {({ requestClose }) => <section><header><h2>{preview.name}</h2><button type="button" className="ui-button" onClick={requestClose}>{i18n.t('resources.close')}</button></header>
        <p>{i18n.t('resources.previewOnly')}</p>
        {preview.kind === 'text' && typeof preview.text === 'string' ? <pre tabIndex={0}>{preview.text}</pre> : <p role="status">{i18n.t('resources.previewUnavailable')}</p>}
      </section>}
    </Overlay> : null}
  </>;
}
