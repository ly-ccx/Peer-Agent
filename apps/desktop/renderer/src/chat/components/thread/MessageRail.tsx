import type { I18nRuntime } from '@peer-agent/i18n';

export type MessageRailItem =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly text: string;
      readonly messageNumber: number;
    }
  | {
      readonly kind: 'compaction';
      readonly id: string;
      readonly text: string;
    };

interface MessageRailProps {
  readonly items: readonly MessageRailItem[];
  readonly onSelect: (id: string) => void;
  readonly i18n: I18nRuntime;
}

/**
 * 右侧消息时间线导航轨。
 *
 * 表达层组件(renderer-only):把当前会话中的用户消息与压缩节点按原始顺序映射到右缘。
 * hover/focus 时展开为可点击列表,点击后由调用方负责滚动到对应主时间线节点。
 * 不持有任何会话/权限真值,仅消费传入的只读条目并回调选择事件。
 */
export function MessageRail({ items, onSelect, i18n }: MessageRailProps) {
  const isZh = i18n.locale === 'zh-CN';
  const messageCount = items.reduce((count, item) => count + (item.kind === 'message' ? 1 : 0), 0);
  if (items.length === 0) return null;

  return (
    <nav className="message-rail" aria-label={isZh ? '消息时间线导航' : 'Message timeline navigation'}>
      <div className="message-rail-ticks" aria-hidden="true">
        {items.map((item) => (
          <span
            key={item.id}
            className={`message-rail-tick${item.kind === 'compaction' ? ' message-rail-tick-compaction' : ''}`}
          />
        ))}
      </div>
      <div className="message-rail-panel" role="list">
        <div className="message-rail-panel-title">
          {isZh ? `我的消息 · ${messageCount}` : `Your messages · ${messageCount}`}
        </div>
        <div className="message-rail-panel-list">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              role="listitem"
              className={`message-rail-item${item.kind === 'compaction' ? ' message-rail-item-compaction' : ''}`}
              onClick={() => onSelect(item.id)}
              title={item.text}
            >
              {item.kind === 'message' ? (
                <>
                  <span className="message-rail-item-index">{item.messageNumber}</span>
                  <span className="message-rail-item-text">
                    {item.text || (isZh ? '(空消息)' : '(empty message)')}
                  </span>
                </>
              ) : (
                <>
                  <span className="message-rail-compaction-line" aria-hidden="true" />
                  <span className="message-rail-compaction-label">{item.text}</span>
                  <span className="message-rail-compaction-line" aria-hidden="true" />
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
