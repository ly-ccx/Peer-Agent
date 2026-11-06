import { MotionSurface } from '../../../app/components/MotionSurface';
import { useInteractionLayer } from '../../../app/hooks/useInteractionLayer';
import { isImeKey } from '../../state/compositionGuard';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PeerIcon } from '../../../ui/icons';

/**
 * 会话内文本查找(cmd/ctrl+F)。
 *
 * 表达层职责:只在已渲染的消息 DOM 上做匹配高亮与跳转,不修改会话真值,
 * 不写回任何 message/state。高亮使用 CSS Custom Highlight API(CSS.highlights +
 * Range),不向 DOM 注入 <mark> 节点,因此不会与 React 的消息渲染产生冲突。
 */

const HIGHLIGHT_ALL = 'chat-find';
const HIGHLIGHT_ACTIVE = 'chat-find-active';

interface ChatFindBarProps {
  /** 搜索范围容器(消息滚动区)。 */
  containerRef: React.RefObject<HTMLElement | null>;
  isZh: boolean;
  open?: boolean;
  onClose: () => void;
  onNavigate?: () => void;
  /**
   * 触发重新计算匹配的依赖键。容器内容变化(如新消息)时传入新值,
   * 使当前查询结果与最新 DOM 保持一致。
   */
  recomputeKey?: unknown;
}

type HighlightCtor = new (...ranges: Range[]) => { priority?: number };
type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

function getHighlightApi(): { Highlight: HighlightCtor; registry: HighlightRegistry } | null {
  const HighlightImpl = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  if (!HighlightImpl || !registry) return null;
  return { Highlight: HighlightImpl, registry };
}

function collectRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const needle = query.toLowerCase();
  if (!needle) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  while (current) {
    const haystack = (current.nodeValue ?? '').toLowerCase();
    let from = 0;
    let idx = haystack.indexOf(needle, from);
    while (idx !== -1) {
      const range = document.createRange();
      range.setStart(current, idx);
      range.setEnd(current, idx + needle.length);
      ranges.push(range);
      from = idx + needle.length;
      idx = haystack.indexOf(needle, from);
    }
    current = walker.nextNode();
  }
  return ranges;
}

export function ChatFindBar({ containerRef, isZh, open = true, onClose, onNavigate, recomputeKey }: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null), rootRef = useRef<HTMLDivElement>(null);
  const navigate = useRef(onNavigate); navigate.current = onNavigate;
  const [navigationRevision, setNavigationRevision] = useState(0), lastNavigation = useRef(0);
  useInteractionLayer(open, { roots: [rootRef], onClose, onEnter: () => inputRef.current?.focus({ preventScroll: true }) });
  const rangesRef = useRef<Range[]>([]);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [unsupported, setUnsupported] = useState(false);

  const clearHighlights = useCallback(() => {
    const api = getHighlightApi();
    if (!api) return;
    api.registry.delete(HIGHLIGHT_ALL);
    api.registry.delete(HIGHLIGHT_ACTIVE);
  }, []);

  const wasOpen = useRef(open);
  // Hidden instances must not clear another live conversation’s highlights.
  useEffect(() => () => { if (wasOpen.current) clearHighlights(); }, [clearHighlights]);

  useEffect(() => {
    const previous = wasOpen.current; wasOpen.current = open;
    if (open || !previous) return;
    clearHighlights(); rangesRef.current = [];
    setQuery(''); setMatchCount(0); setActiveIndex(-1); setUnsupported(false);
    lastNavigation.current = navigationRevision;
  }, [open, clearHighlights, navigationRevision]);

  // 计算匹配并高亮全部命中。
  useEffect(() => {
    if (!open) return;
    const api = getHighlightApi();
    if (!api) {
      setUnsupported(true);
      setMatchCount(0);
      setActiveIndex(-1);
      return;
    }
    const root = containerRef.current;
    const trimmed = query.trim();
    const ranges = root ? collectRanges(root, trimmed) : [];
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setActiveIndex(index => ranges.length > 0 ? Math.max(0, Math.min(index, ranges.length - 1)) : -1);
    if (ranges.length > 0) {
      api.registry.set(HIGHLIGHT_ALL, new api.Highlight(...ranges));
    } else {
      api.registry.delete(HIGHLIGHT_ALL);
      api.registry.delete(HIGHLIGHT_ACTIVE);
    }
  }, [open, query, recomputeKey, containerRef]);

  // 高亮当前命中并滚动到可见区。
  useEffect(() => {
    if (!open) return;
    const api = getHighlightApi();
    if (!api) return;
    const range = rangesRef.current[activeIndex];
    if (!range) {
      api.registry.delete(HIGHLIGHT_ACTIVE); lastNavigation.current = navigationRevision;
      return;
    }
    const activeHl = new api.Highlight(range);
    activeHl.priority = 1;
    api.registry.set(HIGHLIGHT_ACTIVE, activeHl);
    if (lastNavigation.current !== navigationRevision) {
      lastNavigation.current = navigationRevision; navigate.current?.();
      range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [open, activeIndex, navigationRevision, query, recomputeKey]);

  const goNext = useCallback(() => {
    const count = rangesRef.current.length; if (!count) return;
    setActiveIndex((activeIndex + 1) % count); setNavigationRevision(value => value + 1);
  }, [activeIndex]);
  const goPrev = useCallback(() => {
    const count = rangesRef.current.length; if (!count) return;
    setActiveIndex((activeIndex - 1 + count) % count); setNavigationRevision(value => value + 1);
  }, [activeIndex]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.defaultPrevented || isImeKey(event.nativeEvent)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        onClose();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) goPrev();
        else goNext();
      }
    },
    [goNext, goPrev, onClose],
  );

  const statusText = unsupported
    ? isZh
      ? '当前环境不支持查找'
      : 'Find not supported'
    : matchCount > 0
      ? `${activeIndex + 1}/${matchCount}`
      : query.trim()
        ? isZh
          ? '无结果'
          : 'No results'
        : '';

  return (
    <MotionSurface kind="fade">{open ? <div ref={rootRef} className="chat-find-bar" role="search">
      <input
        ref={inputRef}
        type="text"
        className="chat-find-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isZh ? '在对话中查找' : 'Find in conversation'}
        aria-label={isZh ? '在对话中查找' : 'Find in conversation'}
        spellCheck={false}
      />
      <span className="chat-find-count" aria-live="polite">
        {statusText}
      </span>
      <button
        type="button"
        className="chat-find-btn"
        onClick={goPrev}
        disabled={matchCount === 0}
        aria-label={isZh ? '上一个' : 'Previous'}
        title={isZh ? '上一个 (Shift+Enter)' : 'Previous (Shift+Enter)'}
      >
        <PeerIcon name="chevronUp" size={14} />
      </button>
      <button
        type="button"
        className="chat-find-btn"
        onClick={goNext}
        disabled={matchCount === 0}
        aria-label={isZh ? '下一个' : 'Next'}
        title={isZh ? '下一个 (Enter)' : 'Next (Enter)'}
      >
        <PeerIcon name="chevronDown" size={14} />
      </button>
      <button
        type="button"
        className="chat-find-btn chat-find-close"
        onClick={onClose}
        aria-label={isZh ? '关闭查找' : 'Close find'}
        title={isZh ? '关闭 (Esc)' : 'Close (Esc)'}
      >
        <PeerIcon name="close" size={14} />
      </button>
    </div> : null}</MotionSurface>
  );
}
