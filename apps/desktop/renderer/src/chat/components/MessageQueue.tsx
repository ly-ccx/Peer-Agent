import { useState } from 'react';
import type { QueuedMessage } from '../state/types';

export const PEER_QUEUED_MESSAGE_DND_TYPE = 'application/x-peer-queued-message-id';

export function MessageQueue({
  items,
  isZh,
  onRemove,
  onReorder,
  onRefillToComposer,
}: {
  readonly items: readonly QueuedMessage[];
  readonly isZh: boolean;
  readonly onRemove: (id: string) => void;
  readonly onReorder: (fromIndex: number, toIndex: number) => void;
  /** 点击编辑：回填输入框（文案 + 附件），不从队列移除。 */
  readonly onRefillToComposer: (item: QueuedMessage) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const canReorder = items.length > 1;

  if (items.length === 0) return null;

  return (
    <div className="message-queue" role="list" aria-label={isZh ? '待发送队列' : 'Queued messages'}>
      <span className="message-queue-label">
        {isZh ? `已排队 ${items.length} 条` : `${items.length} queued`}
      </span>
      {items.map((item, index) => {
        const preview = item.text.trim()
          || (item.attachments.length ? (isZh ? '（附件）' : '(attachments)') : '');
        const isDragging = draggingId === item.id;
        const isDropTarget = dropTargetId === item.id && draggingId !== item.id;

        return (
          <div
            key={item.id}
            className={[
              'message-queue-item',
              canReorder ? 'reorderable' : '',
              isDragging ? 'is-dragging' : '',
              isDropTarget ? 'is-drop-target' : '',
            ].filter(Boolean).join(' ')}
            role="listitem"
            title={
              canReorder
                ? (isZh ? '拖动可调整发送顺序' : 'Drag to reorder')
                : undefined
            }
            draggable={canReorder}
            onDragStart={(event) => {
              if (!canReorder) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(PEER_QUEUED_MESSAGE_DND_TYPE, item.id);
              setDraggingId(item.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropTargetId(null);
            }}
            onDragOver={(event) => {
              if (!canReorder || !draggingId || draggingId === item.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (dropTargetId !== item.id) setDropTargetId(item.id);
            }}
            onDragLeave={() => {
              if (dropTargetId === item.id) setDropTargetId(null);
            }}
            onDrop={(event) => {
              if (!canReorder) return;
              event.preventDefault();
              event.stopPropagation();
              const fromId = event.dataTransfer.getData(PEER_QUEUED_MESSAGE_DND_TYPE) || draggingId;
              setDraggingId(null);
              setDropTargetId(null);
              if (!fromId || fromId === item.id) return;
              const fromIndex = items.findIndex((entry) => entry.id === fromId);
              const toIndex = index;
              if (fromIndex < 0 || fromIndex === toIndex) return;
              onReorder(fromIndex, toIndex);
            }}
          >
            <span className="message-queue-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="message-queue-text" title={preview}>
              {preview}
            </span>
            <button
              type="button"
              className="message-queue-edit"
              onClick={(event) => {
                event.stopPropagation();
                onRefillToComposer(item);
              }}
              aria-label={isZh ? `编辑排队消息 ${index + 1}` : `Edit queued message ${index + 1}`}
              title={isZh ? '编辑' : 'Edit'}
            >
              {isZh ? '编辑' : 'Edit'}
            </button>
            <button
              type="button"
              className="message-queue-remove"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(item.id);
              }}
              aria-label={isZh ? `移除排队消息 ${index + 1}` : `Remove queued message ${index + 1}`}
              title={isZh ? '移除' : 'Remove'}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
