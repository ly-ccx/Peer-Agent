import { PeerIcon } from '../../../ui/icons';

export function ImagePreviewBar({
  images,
  uploadingCount,
  maxCount = 9,
  onRemove,
  onAdd,
}: {
  readonly images: readonly string[];
  readonly uploadingCount: number;
  readonly maxCount?: number;
  readonly onRemove: (index: number) => void;
  readonly onAdd: () => void;
}) {
  if (images.length === 0 && uploadingCount === 0) return null;

  return (
    <div className="image-preview-bar">
      {images.map((url, index) => (
        <div key={url} className="image-preview-item">
          <img src={url} alt="" />
          <button
            type="button"
            className="image-preview-remove"
            onClick={() => onRemove(index)}
            aria-label="删除图片"
          >
            ×
          </button>
        </div>
      ))}

      {Array.from({ length: uploadingCount }).map((_, i) => (
        <div key={`uploading-${i}`} className="image-preview-item uploading">
          <span className="image-preview-spinner" />
        </div>
      ))}

      {images.length + uploadingCount < maxCount && (
        <button
          type="button"
          className="image-preview-add"
          onClick={onAdd}
          aria-label="添加图片"
        >
          <PeerIcon name="plus" size={16} />
        </button>
      )}
    </div>
  );
}
