import { useState } from 'react';
import type { ChatAttachment } from '../../chat/state/types';
import { ImageLightbox } from '../../chat/components/thread/ImageLightbox';
import { formatBytes } from '../../chat/state/format';
import { PeerIcon } from '../../ui/icons';
import type { I18nRuntime } from '@peer-agent/i18n';

/** One compact presentation for drafts and durable messages; no filesystem reads. */
export function BotAttachments({ attachments, i18n, onRemove }: {
  readonly attachments: readonly ChatAttachment[];
  readonly i18n: I18nRuntime;
  readonly onRemove?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  return <>
    <div className="bot-attachments">
      {attachments.map(item => <div className={`bot-attachment ${item.kind}`} key={item.id}>
        {item.kind === 'image' && item.dataUrl ? <button type="button" className="bot-attachment-image"
          aria-label={`${i18n.t('projectAgent.chat.previewAttachment')} ${item.name}`} onClick={() => setPreview(item)}>
          <img src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" />
        </button> : <><PeerIcon name="fileText" size={20} /><span className="bot-attachment-meta">
          <span title={item.name}>{item.name}</span>
          <small>{item.kind === 'unsupported' ? i18n.t('projectAgent.chat.attachmentMetadataOnly') : formatBytes(item.size)}</small>
        </span></>}
        {onRemove ? <button type="button" className="bot-attachment-remove" aria-label={`${i18n.t('projectAgent.chat.removeAttachment')} ${item.name}`}
          onClick={() => onRemove(item.id)}><PeerIcon name="close" size={12} /></button> : null}
      </div>)}
    </div>
    {preview?.dataUrl ? <ImageLightbox source={{ path: '', name: preview.name, dataUrl: preview.dataUrl }}
      isZh={i18n.locale.startsWith('zh')} onClose={() => setPreview(null)} /> : null}
  </>;
}
