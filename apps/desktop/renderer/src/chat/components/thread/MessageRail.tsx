import type { I18nRuntime } from '@peer-agent/i18n';

export interface MessageRailItem {
  readonly id: string;
  readonly text: string;
}

interface MessageRailProps {
  readonly items: readonly MessageRailItem[];
  readonly onSelect: (id: string) => void;
  readonly i18n: I18nRuntime;
}

/**
 * 右侧用户消息导航轨。
 *
 * 表达层组件(renderer-only):把当前会话中的用户消息映射成右缘的刻度条。
 * hover/focus 时展开为可点击列表,点击后由调用方负责滚动到对应消息。
 * 不持有任何会话/权限真值,仅消费传入的只读条目并回调选择事件。
 */
export function MessageRail({ items, onSelect, i18n }: MessageRailProps) {
  const isZh = i18n.locale === 'zh-CN';
  if (items.length === 0) return null;

  return (
    <nav className="message-rail" aria-label={isZh ? '用户消息导航' : 'Your message navigation'}>
      <div className="message-rail-ticks" aria-hidden="true">
        {items.map((item) => (
          <span key={item.id} className="message-rail-tick" />
        ))}
      </div>
      <div className="message-rail-panel" role="list">
        <div className="message-rail-panel-title">
          {isZh ? `我的消息 · ${items.length}` : `Your messages · ${items.length}`}
        </div>
        <div className="message-rail-panel-list">
          {items.map((item, index) => (
            <button
              type="button"
              key={item.id}
              role="listitem"
              className="message-rail-item"
              onClick={() => onSelect(item.id)}
              title={item.text}
            >
              <span className="message-rail-item-index">{index + 1}</span>
              <span className="message-rail-item-text">
                {item.text || (isZh ? '(空消息)' : '(empty message)')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
