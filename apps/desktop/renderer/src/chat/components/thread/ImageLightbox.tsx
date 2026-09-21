/**
 * ImageLightbox —— 统一图片灯箱（全应用唯一实现）。
 *
 * 0.0.14 为消息流 Markdown 图片做了灯箱（缩放 / 在文件管理器中显示 / 复制路径），
 * 聊天附件预览却停留在另一套「图 + 文件名 + 大小」实现。本组件把两者收敛为
 * 同一个可复用 Module：入口只负责「打开一张图片」，能力与样式由这里统一提供。
 *
 * - 数据源用 ImageLightboxSource 表达：path 必备（文件名 / 访达 / 复制路径都依赖它）；
 *   dataUrl 可后到，缺失且 path 为真实路径时按需从主进程加载（ADR 59：不内联整图）。
 * - 样式族沿用 markdown-local-image-lightbox-*（markdown.css），不再有第二套预览样式。
 * - 附件来源请通过 imageLightboxSourceFromAttachment 归一化，避免各入口自拼字段。
 */

import { useEffect, useState } from 'react';
import { clientApi } from '../../../clientApi';
import { Overlay } from '../../../app/components/Overlay';
import { formatBytes } from '../../state/format';
import { loadLocalImageDataUrl } from '../../state/localImagePreview';
import type { ChatAttachment } from '../../state/types';

/** 灯箱数据源：path 必备；name/dataUrl 缺省时组件自行推导或按需加载。 */
export interface ImageLightboxSource {
  /** 本地路径（绝对路径才提供访达 / 复制路径动作）。 */
  readonly path: string;
  /** 展示名；缺省取 path 最后一段。 */
  readonly name?: string;
  /** 已就绪的图片 dataUrl；缺失时组件按 path 按需加载。 */
  readonly dataUrl?: string;
  /** 附加元信息（如附件大小「130.9 KB」），展示在尺寸旁。 */
  readonly sizeLabel?: string;
}

/** 附件 → 灯箱数据源：优先 dataUrl，缺省回退 filePath（无路径时仅展示图片本身）。 */
export function imageLightboxSourceFromAttachment(attachment: ChatAttachment): ImageLightboxSource {
  const path = attachment.filePath ?? attachment.name;
  return {
    path,
    name: attachment.name,
    dataUrl: attachment.dataUrl,
    sizeLabel: typeof attachment.size === 'number' ? formatBytes(attachment.size) : undefined,
  };
}

function looksLikeRealPath(path: string): boolean {
  return /[\\/]/.test(path);
}

/**
 * 暗房式图片查看器：图片带 alpha 感知投影浮在磨砂遮罩上，
 * 底部胶囊工具条提供尺寸、缩放切换、在文件管理器中显示、复制路径与关闭。
 */
export function ImageLightbox({
  source,
  isZh,
  onClose,
}: {
  readonly source: ImageLightboxSource;
  readonly isZh: boolean;
  readonly onClose: () => void;
}) {
  const fileName = source.name ?? source.path.split(/[\\/]/).pop() ?? source.path;
  const realPath = looksLikeRealPath(source.path) ? source.path : null;
  const [src, setSrc] = useState<string>(() => (source.dataUrl ? source.dataUrl : ''));
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (source.dataUrl) {
      setSrc(source.dataUrl);
      return;
    }
    if (!realPath) return;
    let cancelled = false;
    void loadLocalImageDataUrl(realPath).then((url) => {
      if (!cancelled && url) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [source.dataUrl, realPath]);

  const zoomLabel = zoomed
    ? (isZh ? '适应窗口' : 'Fit to window')
    : (isZh ? '查看原始尺寸' : 'View actual size');

  const handleCopyPath = () => {
    if (!realPath) return;
    void navigator.clipboard.writeText(realPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const dimsLabel = dims ? (isZh ? `${dims.w} × ${dims.h}` : `${dims.w} × ${dims.h}`) : null;

  return (
    <Overlay
      ariaLabel={isZh ? '图片预览' : 'Image preview'}
      backdropClassName="markdown-local-image-lightbox"
      panelClassName={`markdown-local-image-lightbox-panel${zoomed ? ' is-zoomed' : ''}`}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <div className="markdown-local-image-lightbox-stage">
            {src ? (
              <img
                src={src}
                alt={fileName}
                draggable={false}
                title={zoomLabel}
                onClick={() => setZoomed((value) => !value)}
                onLoad={(event) => {
                  const img = event.currentTarget;
                  setDims({ w: img.naturalWidth, h: img.naturalHeight });
                }}
              />
            ) : (
              <span className="markdown-local-image-lightbox-pending">
                {isZh ? '加载中…' : 'Loading…'}
              </span>
            )}
          </div>
          <div className="markdown-local-image-lightbox-bar">
            <div className="markdown-local-image-lightbox-info">
              <span className="markdown-local-image-lightbox-name">{fileName}</span>
              <span className="markdown-local-image-lightbox-path" title={realPath ?? fileName}>
                <bdi>{realPath ?? fileName}</bdi>
              </span>
            </div>
            <div className="markdown-local-image-lightbox-actions">
              {source.sizeLabel ? (
                <span className="markdown-local-image-lightbox-dims">{source.sizeLabel}</span>
              ) : null}
              {dimsLabel ? (
                <span className="markdown-local-image-lightbox-dims">{dimsLabel}</span>
              ) : null}
              <button
                type="button"
                title={zoomLabel}
                aria-label={zoomLabel}
                onClick={() => setZoomed((value) => !value)}
              >
                {zoomed ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                )}
              </button>
              {realPath ? (
                <button
                  type="button"
                  title={isZh ? '在文件管理器中显示' : 'Reveal in file manager'}
                  aria-label={isZh ? '在文件管理器中显示' : 'Reveal in file manager'}
                  onClick={() => void clientApi.openPath(realPath, undefined, { mode: 'reveal' })}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              ) : null}
              {realPath ? (
                <button
                  type="button"
                  title={copied ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制路径' : 'Copy path')}
                  aria-label={copied ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制路径' : 'Copy path')}
                  onClick={handleCopyPath}
                >
                  {copied ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              ) : null}
              <span className="markdown-local-image-lightbox-divider" aria-hidden="true" />
              <button
                type="button"
                title={isZh ? '关闭预览' : 'Close preview'}
                aria-label={isZh ? '关闭预览' : 'Close preview'}
                onClick={requestClose}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}
