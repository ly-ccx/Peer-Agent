import { useMemo, useRef, useState } from 'react';
import { PeerIcon } from '../../ui/icons';
import { inspectRasterDataUrl, RASTER_MAX_DIMENSION, RASTER_MAX_PIXELS, rasterZoom } from './rasterImageState';

export function RasterImageView({ dataUrl, name, isZh, onReady, onRetry }: {
  readonly dataUrl: string; readonly name: string; readonly isZh: boolean;
  readonly onReady?: () => void; readonly onRetry?: () => void;
}) {
  const inspection = useMemo(() => inspectRasterDataUrl(dataUrl), [dataUrl]);
  const [zoomState, setZoomState] = useState<{ source: string; value: number | null }>({ source: dataUrl, value: null });
  const zoom = zoomState.source === dataUrl ? zoomState.value : null;
  const setZoom = (next: number | null | ((current: number | null) => number)) => setZoomState(state => ({
    source: dataUrl, value: typeof next === 'function' ? next(state.source === dataUrl ? state.value : null) : next,
  }));
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const current = useRef(dataUrl); current.current = dataUrl;
  const failed = failedSource === dataUrl;
  if (!inspection.ok || failed) return <div className="resource-adapter-notice" role="alert">
    {failed ? (isZh ? '图片解码失败，可重新读取。' : 'Image decoding failed. Read it again.')
      : inspection.ok || inspection.reason === 'format' ? (isZh ? '此图片格式或文件头不能由当前适配器确认，未加载图片。' : 'The image format or header could not be confirmed. The image was not loaded.')
      : (isZh ? '图片超出字节或尺寸展示限额，未加载图片。' : 'The image exceeds the byte or dimension display budget and was not loaded.')}
    {onRetry ? <button type="button" className="ui-button is-compact" onClick={() => { setFailedSource(null); onRetry?.(); }}>{isZh ? '重新读取' : 'Read again'}</button> : null}
  </div>;
  return <div className="resource-raster-view">
    <div className="resource-raster-controls" role="group" aria-label={isZh ? '图片缩放' : 'Image zoom'}>
      <button type="button" className="ui-button" onClick={() => setZoom(value => rasterZoom(value ?? 1, -1))} disabled={zoom !== null && zoom <= 0.25} aria-label={isZh ? '缩小图片' : 'Zoom out'}><PeerIcon name="minus" size={14} /></button>
      <button type="button" className="ui-button" onClick={() => setZoom(null)} title={isZh ? '恢复适应宽度' : 'Reset to fit width'} aria-label={isZh ? '恢复适应宽度' : 'Reset to fit width'}>{zoom === null ? (isZh ? '适应宽度' : 'Fit width') : `${Math.round(zoom * 100)}%`}</button>
      <button type="button" className="ui-button" onClick={() => setZoom(value => rasterZoom(value ?? 1, 1))} disabled={zoom !== null && zoom >= 4} aria-label={isZh ? '放大图片' : 'Zoom in'}><PeerIcon name="plus" size={14} /></button>
    </div>
    <img key={dataUrl} ref={image} className="resource-raster-image" src={dataUrl} alt={name} decoding="async"
      style={zoom === null ? { maxWidth: '100%', width: 'auto' } : { width: inspection.width * zoom, maxWidth: 'none' }}
      onError={event => { if (event.currentTarget === image.current && current.current === dataUrl) setFailedSource(dataUrl); }} onLoad={event => {
        if (event.currentTarget !== image.current || current.current !== dataUrl) return;
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        if (!width || !height || width > RASTER_MAX_DIMENSION || height > RASTER_MAX_DIMENSION || width * height > RASTER_MAX_PIXELS) setFailedSource(dataUrl);
        else onReady?.();
      }} />
  </div>;
}
