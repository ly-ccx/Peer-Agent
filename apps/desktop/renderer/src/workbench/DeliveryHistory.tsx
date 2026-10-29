import type { EvidenceDelivery } from '@peer-agent/protocol';
import { RasterImageView } from './file-preview/RasterImageView';

/** Only the saved projection is shown here. Never read today's file to fill missing history. */
export function DeliveryHistory({ delivery, isZh }: { readonly delivery: EvidenceDelivery; readonly isZh: boolean }) {
  const preview = delivery.savedPreview;
  return <div className="resource-delivery-history">
    <p className="resource-source-label">{preview?.kind === 'image'
      ? (isZh ? '这是当时保存的图片预览，不代表当前文件。' : 'This is the saved image preview, not the current file.')
      : (isZh ? '未保存完整历史正文。打开当前文件会显示现在的内容。' : 'The full historical file was not saved. Opening the current file shows today’s content.')}</p>
    {preview?.kind === 'diff-summary' ? <><p className="resource-source-label">{isZh ? '当时保存的变更摘要（可能不完整）' : 'Saved change summary (may be incomplete)'}</p><pre>{preview.text}</pre></> : null}
    {preview?.kind === 'image' ? <RasterImageView dataUrl={preview.dataUrl} name={delivery.label} isZh={isZh} /> : null}
    {delivery.previewUnavailable ? <p role="status" className="resource-source-label">{isZh ? '已保存的预览当前无法显示。' : 'The saved preview cannot be displayed.'}</p> : null}
  </div>;
}
