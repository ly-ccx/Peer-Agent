import { memo, useMemo, useState } from 'react';
import { inputImageReference, loadInputImageDataUrl } from '../../chat/state/inputImagePreview';
import { useResourceRead } from '../../ui/resources/useResourceState';
import type { ChatAttachment } from '../../chat/state/types';
import { ImageLightbox, imageLightboxSourceFromAttachment } from '../../chat/components/thread/ImageLightbox';
import { getCachedLocalImageDataUrl, loadLocalImageDataUrl } from '../../chat/state/localImagePreview';
import { Overlay } from '../../app/components/Overlay';
import { formatBytes } from '../../chat/state/format';
import { PeerIcon } from '../../ui/icons';
import type { I18nRuntime } from '@peer-agent/i18n';

function BotImageThumbnail({ item, workspaceId, i18n }: {
  readonly item: ChatAttachment;
  readonly workspaceId?: string;
  readonly i18n: I18nRuntime;
}) {
  const ref = inputImageReference(item, workspaceId);
  const filePath = ref ? undefined : item.filePath;
  const identity = useMemo(() => ({ workspaceId, digest: item.blobDigest, mime: item.mimeType, filePath }),
    [workspaceId, item.blobDigest, item.mimeType, filePath]);
  const cached = filePath ? getCachedLocalImageDataUrl(filePath) : null;
  const shouldLoad = !item.dataUrl && !cached && Boolean(ref || filePath);
  const image = useResourceRead(identity,
    () => ref ? loadInputImageDataUrl(ref) : filePath ? loadLocalImageDataUrl(filePath) : Promise.resolve(null), shouldLoad);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const src = item.dataUrl || cached || image.value;
  if (src && brokenSrc !== src) {
    return <img src={src} alt={item.name} loading="lazy" decoding="async" onError={() => setBrokenSrc(src)} />;
  }
  if (shouldLoad && !image.loaded && !image.error) {
    return <span className="bot-attachment-meta" role="status"><span>{item.name}</span><small>{i18n.t('resources.loading')}</small></span>;
  }
  return <><PeerIcon name="fileText" size={20} /><span className="bot-attachment-meta">
    <span title={item.name}>{item.name}</span>
    <small>{formatBytes(item.size)}</small>
  </span></>;
}

/** Drafts and durable messages share one preview; metadata never implies an available body. */
export const BotAttachments = memo(function BotAttachments({ attachments, workspaceId, i18n, onRemove }: {
  readonly attachments: readonly ChatAttachment[];
  readonly workspaceId?: string;
  readonly i18n: I18nRuntime;
  readonly onRemove?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  return <>
    <div className="bot-attachments">
      {attachments.map(item => <div className={`bot-attachment ${item.kind}`} key={item.id}>
        <button type="button" className={item.kind === 'image' ? 'bot-attachment-image' : 'bot-attachment-preview'}
          aria-label={`${i18n.t('projectAgent.chat.previewAttachment')} ${item.name}`} onClick={() => setPreview(item)}>
          {item.kind === 'image'
            ? <BotImageThumbnail item={item} workspaceId={workspaceId} i18n={i18n} />
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
    {preview?.kind === 'image' ? <ImageLightbox key={preview.id} source={imageLightboxSourceFromAttachment(preview, workspaceId)}
      isZh={i18n.locale.startsWith('zh')} onClose={() => setPreview(null)} /> : preview ? <Overlay
      ariaLabel={i18n.t('resources.attachmentText')} panelClassName="bot-attachment-text-preview" onClose={() => setPreview(null)}>
      {({ requestClose }) => <section><header><h2>{preview.name}</h2><button type="button" className="ui-button" onClick={requestClose}>{i18n.t('resources.close')}</button></header>
        <p>{i18n.t('resources.previewOnly')}</p>
        {preview.kind === 'text' && typeof preview.text === 'string' ? <pre tabIndex={0}>{preview.text}</pre> : <p role="status">{i18n.t('resources.previewUnavailable')}</p>}
      </section>}
    </Overlay> : null}
  </>;
});
