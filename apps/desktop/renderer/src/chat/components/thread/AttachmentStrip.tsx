import { formatBytes } from '../../state/format';
import type { ChatAttachment } from '../../state/types';

export function AttachmentStrip({
  attachments,
  onRemove,
  onPreviewImage,
  readOnly = false,
  isZh,
}: {
  readonly attachments: readonly ChatAttachment[];
  readonly onRemove?: (id: string) => void;
  readonly onPreviewImage?: (attachment: ChatAttachment) => void;
  readonly readOnly?: boolean;
  readonly isZh: boolean;
}) {
  if (!attachments.length) return null;
  return (
    <div className={`attachment-strip ${readOnly ? 'readonly' : ''}`}>
      {attachments.map((attachment) => (
        <div key={attachment.id} className={`attachment-chip ${attachment.kind}`}>
          {attachment.kind === 'image' && attachment.dataUrl ? (
            <button
              type="button"
              className="attachment-thumb-btn"
              onClick={() => onPreviewImage?.(attachment)}
              title={isZh ? '预览图片' : 'Preview image'}
              aria-label={isZh ? `预览图片 ${attachment.name}` : `Preview image ${attachment.name}`}
            >
              <img src={attachment.dataUrl} alt="" className="attachment-thumb" />
            </button>
          ) : (
            <span className="attachment-file-icon" aria-hidden="true">
              {attachment.kind === 'text' ? 'TXT' : 'FILE'}
            </span>
          )}
          <span className="attachment-meta">
            <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
            <span className="attachment-size">
              {attachment.kind === 'image'
                ? (isZh ? '图片' : 'Image')
                : attachment.kind === 'text'
                  ? (isZh ? '文本' : 'Text')
                  : (isZh ? '未读取' : 'Metadata only')}
              {' · '}
              {formatBytes(attachment.size)}
            </span>
          </span>
          {!readOnly && onRemove ? (
            <button
              type="button"
              className="attachment-remove"
              onClick={() => onRemove(attachment.id)}
              aria-label={isZh ? `移除 ${attachment.name}` : `Remove ${attachment.name}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ImagePreviewOverlay({
  attachment,
  isZh,
  onClose,
}: {
  readonly attachment: ChatAttachment;
  readonly isZh: boolean;
  readonly onClose: () => void;
}) {
  return (
    <div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={onClose}>
      <figure className="image-preview-card" onClick={(event) => event.stopPropagation()}>
        <img src={attachment.dataUrl ?? ''} alt={attachment.name} className="image-preview-img" />
        <figcaption className="image-preview-caption">
          <span className="image-preview-name">{attachment.name}</span>
          <span className="image-preview-size">{formatBytes(attachment.size)}</span>
          <button type="button" className="image-preview-close" onClick={onClose} aria-label={isZh ? '关闭预览' : 'Close preview'}>
            ×
          </button>
        </figcaption>
      </figure>
    </div>
  );
}
