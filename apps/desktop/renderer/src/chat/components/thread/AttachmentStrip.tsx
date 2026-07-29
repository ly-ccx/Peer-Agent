import { useState } from 'react';
import { Overlay } from '../../../app/components/Overlay';
import { formatBytes } from '../../state/format';
import type { ChatAttachment } from '../../state/types';

export const PEER_ATTACHMENT_DND_TYPE = 'application/x-peer-attachment-id';

export function AttachmentStrip({
  attachments,
  onRemove,
  onReorder,
  onPreviewImage,
  readOnly = false,
  isZh,
}: {
  readonly attachments: readonly ChatAttachment[];
  readonly onRemove?: (id: string) => void;
  readonly onReorder?: (fromIndex: number, toIndex: number) => void;
  readonly onPreviewImage?: (attachment: ChatAttachment) => void;
  readonly readOnly?: boolean;
  readonly isZh: boolean;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const canReorder = !readOnly && typeof onReorder === 'function' && attachments.length > 1;

  if (!attachments.length) return null;

  return (
    <div className={`attachment-strip ${readOnly ? 'readonly' : ''}${canReorder ? ' reorderable' : ''}`}>
      {attachments.map((attachment, index) => {
        const isDragging = draggingId === attachment.id;
        const isDropTarget = dropTargetId === attachment.id && draggingId !== attachment.id;
        return (
          <div
            key={attachment.id}
            className={`attachment-chip ${attachment.kind}${isDragging ? ' is-dragging' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
            draggable={canReorder}
            onDragStart={(event) => {
              if (!canReorder) return;
              event.dataTransfer.setData(PEER_ATTACHMENT_DND_TYPE, attachment.id);
              event.dataTransfer.effectAllowed = 'move';
              setDraggingId(attachment.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropTargetId(null);
            }}
            onDragOver={(event) => {
              if (!canReorder || !draggingId || draggingId === attachment.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (dropTargetId !== attachment.id) setDropTargetId(attachment.id);
            }}
            onDragLeave={() => {
              if (dropTargetId === attachment.id) setDropTargetId(null);
            }}
            onDrop={(event) => {
              if (!canReorder || !onReorder) return;
              event.preventDefault();
              event.stopPropagation();
              const fromId = event.dataTransfer.getData(PEER_ATTACHMENT_DND_TYPE) || draggingId;
              setDraggingId(null);
              setDropTargetId(null);
              if (!fromId || fromId === attachment.id) return;
              const fromIndex = attachments.findIndex((item) => item.id === fromId);
              if (fromIndex < 0 || fromIndex === index) return;
              onReorder(fromIndex, index);
            }}
          >
            {attachment.kind === 'image' && attachment.dataUrl ? (
              <button
                type="button"
                className="attachment-thumb-btn"
                onClick={() => onPreviewImage?.(attachment)}
                title={isZh ? '预览图片' : 'Preview image'}
                aria-label={isZh ? `预览图片 ${attachment.name}` : `Preview image ${attachment.name}`}
              >
                <img
                  src={attachment.dataUrl}
                  alt=""
                  className="attachment-thumb"
                  loading={readOnly ? 'lazy' : 'eager'}
                  decoding="async"
                  draggable={false}
                />
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
                onMouseDown={(event) => event.stopPropagation()}
                onDragStart={(event) => event.preventDefault()}
                aria-label={isZh ? `移除 ${attachment.name}` : `Remove ${attachment.name}`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            ) : null}
          </div>
        );
      })}
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
    <Overlay onClose={onClose} ariaLabel={attachment.name} panelClassName="image-preview-card" backdropClassName="image-preview-backdrop">
      <img src={attachment.dataUrl ?? ''} alt={attachment.name} className="image-preview-img" />
      <figcaption className="image-preview-caption">
        <span className="image-preview-name">{attachment.name}</span>
        <span className="image-preview-size">{formatBytes(attachment.size)}</span>
        <button type="button" className="image-preview-close" onClick={onClose} aria-label={isZh ? '关闭预览' : 'Close preview'}>
          ×
        </button>
      </figcaption>
    </Overlay>
  );
}
