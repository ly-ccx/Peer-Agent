import { useState } from 'react';
import type { QueuedMessage } from '../state/types';

export const PEER_QUEUED_MESSAGE_DND_TYPE = 'application/x-peer-queued-message-id';

function QueueDragHandle() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="4" cy="4" r="1" />
      <circle cx="4" cy="8" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="9" cy="4" r="1" />
      <circle cx="9" cy="8" r="1" />
      <circle cx="9" cy="12" r="1" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

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
    <div
      className="message-queue"
      role="list"
      aria-label={isZh ? `待发送队列，共 ${items.length} 条` : `Queued messages, ${items.length} total`}
    >
      {items.map((item, index) => {
        const preview = item.text.trim() || (isZh ? '仅附件消息' : 'Attachments only');
        const attachmentCount = item.attachments?.length ?? 0;
        return (
          <div
            key={item.id}
            role="listitem"
            className={`message-queue-item${draggingId === item.id ? ' is-dragging' : ''}${dropTargetId === item.id ? ' is-drop-target' : ''}`}
            draggable={canReorder}
            onDragStart={(event) => {
              setDraggingId(item.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(PEER_QUEUED_MESSAGE_DND_TYPE, item.id);
              event.dataTransfer.setData('text/plain', item.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropTargetId(null);
            }}
            onDragOver={(event) => {
              if (!canReorder || draggingId === item.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTargetId(item.id);
            }}
            onDragLeave={() => {
              if (dropTargetId === item.id) setDropTargetId(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const fromId = event.dataTransfer.getData(PEER_QUEUED_MESSAGE_DND_TYPE)
                || event.dataTransfer.getData('text/plain');
              setDropTargetId(null);
              setDraggingId(null);
              if (!fromId || fromId === item.id) return;
              const fromIndex = items.findIndex((entry) => entry.id === fromId);
              if (fromIndex < 0 || fromIndex === index) return;
              onReorder(fromIndex, index);
            }}
          >
            <div className="message-queue-card-main">
              <span className="message-queue-drag-handle" aria-hidden="true"><QueueDragHandle /></span>
              <span className="message-queue-index">{index + 1}</span>
              <span className="message-queue-text" title={preview}>{preview}</span>
              {attachmentCount > 0 ? (
                <span className="message-queue-attachment-count" title={isZh ? `${attachmentCount} 个附件` : `${attachmentCount} attachments`}>
                  +{attachmentCount}
                </span>
              ) : null}
            </div>
            <div className="message-queue-actions">
              <button
                type="button"
                className="message-queue-edit"
                onClick={() => onRefillToComposer(item)}
                aria-label={isZh ? `编辑排队消息 ${index + 1}` : `Edit queued message ${index + 1}`}
                title={isZh ? '编辑' : 'Edit'}
              >
                <EditIcon />
              </button>
              <button
                type="button"
                className="message-queue-remove"
                onClick={() => onRemove(item.id)}
                aria-label={isZh ? `移除排队消息 ${index + 1}` : `Remove queued message ${index + 1}`}
                title={isZh ? '移除' : 'Remove'}
              >
                <TrashIcon />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
