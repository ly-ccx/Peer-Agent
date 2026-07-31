import { memo, useEffect, useState } from 'react';
import { Overlay } from '../../../app/components/Overlay';
import { formatBytes } from '../../state/format';
import type { ChatAttachment } from '../../state/types';

export const PEER_ATTACHMENT_DND_TYPE = 'application/x-peer-attachment-id';

/** 按附件 id 缓存已降采样的缩略图，避免每字输入反复解码 2MB 原图 dataUrl。 */
const attachmentThumbCache = new Map<string, string>();

/** 显示 38px，缓存 76px@2x 足够；超过此边长的原图才降采样。 */
const THUMB_EDGE_PX = 76;
/** 小于约 64KB 的 dataUrl 直接用原图，跳过 canvas。 */
const THUMB_SKIP_BYTES = 64 * 1024;

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  // base64 ≈ 3/4 of encoded length
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/**
 * 把大图 dataUrl 降采样成小 JPEG dataUrl。
 * 失败时回落原图，不阻塞预览。
 */
function downscaleDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    if (estimateDataUrlBytes(dataUrl) <= THUMB_SKIP_BYTES) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const srcW = img.naturalWidth || 1;
        const srcH = img.naturalHeight || 1;
        const scale = Math.min(1, THUMB_EDGE_PX / Math.max(srcW, srcH));
        if (scale >= 1) {
          resolve(dataUrl);
          return;
        }
        const w = Math.max(1, Math.round(srcW * scale));
        const h = Math.max(1, Math.round(srcH * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * 附件条含 image dataUrl 缩略图，渲染成本高。
 * 必须 memo：输入区逐字更新时父级可能重渲染，但 attachments/回调未变时禁止重绘缩略图。
 * 大图还经 AttachmentThumb 降采样缓存，避免 2MB 原图反复解码导致每字闪一下。
 */
export const AttachmentStrip = memo(function AttachmentStrip({
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
              if (!canReorder || !event.dataTransfer.types.includes(PEER_ATTACHMENT_DND_TYPE)) return;
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
              // Codex-style: image chips are thumb-only; no filename/size chrome.
              <button
                type="button"
                className="attachment-thumb-btn"
                onClick={() => onPreviewImage?.(attachment)}
                title={attachment.name}
                aria-label={isZh ? `预览图片 ${attachment.name}` : `Preview image ${attachment.name}`}
              >
                <AttachmentThumb
                  attachmentId={attachment.id}
                  dataUrl={attachment.dataUrl}
                  loading={readOnly ? 'lazy' : 'eager'}
                />
              </button>
            ) : attachment.appshot ? (
              // Appshot 缺缩略图（artifact 未接线或文件丢失）：损坏/占位态，
              // 不伪装成正常图片成功卡片（产品 §12.1「不出现空白成功卡片」）。
              <span
                className="attachment-file-icon attachment-appshot-broken"
                title={isZh ? '截图不可用' : 'Screenshot unavailable'}
                aria-label={isZh ? '截图不可用' : 'Screenshot unavailable'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                  <path d="m3 3 18 18" />
                </svg>
              </span>
            ) : (
              <span className="attachment-file-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
            )}
            {attachment.kind === 'image' && attachment.dataUrl ? null : (
              <div className="attachment-meta">
                <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
                <span className="attachment-sub">
                  {attachment.appshot
                    ? (isZh ? '截图' : 'Shot')
                    : (isZh ? '文件' : 'File')}
                  {' · '}
                  {formatBytes(attachment.size)}
                </span>
              </div>
            )}
            {!readOnly && onRemove ? (
              <button
                type="button"
                className="attachment-remove"
                onClick={() => onRemove(attachment.id)}
                title={isZh ? '移除' : 'Remove'}
                aria-label={isZh ? `移除 ${attachment.name}` : `Remove ${attachment.name}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
});

/**
 * 缩略图叶子：只对单个附件做小图缓存，预览仍用原 dataUrl。
 */
const AttachmentThumb = memo(function AttachmentThumb({
  attachmentId,
  dataUrl,
  loading,
}: {
  readonly attachmentId: string;
  readonly dataUrl: string;
  readonly loading: 'lazy' | 'eager';
}) {
  const [thumbSrc, setThumbSrc] = useState<string>(() => attachmentThumbCache.get(attachmentId) ?? '');

  useEffect(() => {
    const cached = attachmentThumbCache.get(attachmentId);
    if (cached) {
      setThumbSrc(cached);
      return;
    }
    let cancelled = false;
    // 先占位空 src，避免首帧直接解码 2MB 原图；降采样完成后写入缓存。
    void downscaleDataUrl(dataUrl).then((thumb) => {
      attachmentThumbCache.set(attachmentId, thumb);
      if (!cancelled) setThumbSrc(thumb);
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentId, dataUrl]);

  if (!thumbSrc) {
    return <span className="attachment-thumb attachment-thumb-pending" aria-hidden="true" />;
  }

  return (
    <img
      src={thumbSrc}
      alt=""
      className="attachment-thumb"
      loading={loading}
      decoding="async"
      draggable={false}
    />
  );
});

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
    <Overlay className="image-preview-overlay" onBackdropClick={onClose}>
      <figure className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={isZh ? '图片预览' : 'Image preview'}>
        <img src={attachment.dataUrl ?? ''} alt={attachment.name} className="image-preview-img" />
        <figcaption className="image-preview-meta">
          <span className="image-preview-name">{attachment.name}</span>
          <span className="image-preview-size">{formatBytes(attachment.size)}</span>
          <button type="button" className="image-preview-close" onClick={onClose} aria-label={isZh ? '关闭预览' : 'Close preview'}>
            ×
          </button>
        </figcaption>
      </figure>
    </Overlay>
  );
}
