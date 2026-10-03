import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationDisplayRow } from '../state/botConversationState';
import { conversationOffsets, conversationRowAt, conversationViewport, restoreConversationOffset } from '../state/conversationWindow';

export const conversationRowKey = (row: ConversationDisplayRow) => row.type === 'message' ? row.message.id : row.type === 'activity' ? `live-${row.activity.turnId}` : row.id;

/** Owns scroll geometry and reading identity; no IPC or conversation data ownership. */
export function useConversationWindow(rows: readonly ConversationDisplayRow[], highlightedId: string | null, highlightRequestId: number, followRequestId = 0) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const pinned = useRef(true);
  const reading = useRef<{ key: string; delta: number } | null>(null);
  const located = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [following, setFollowing] = useState(true);
  const keys = useMemo(() => rows.map(conversationRowKey), [rows]);
  const offsets = useMemo(() => conversationOffsets(keys, heights.current), [keys, revision]);
  const origin = () => {
    const node = scrollerRef.current, marker = originRef.current;
    return node && marker ? marker.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop : 0;
  };
  const view = conversationViewport(offsets, Math.max(0, top - origin()), height);
  const updateTop = (value: number) => setTop(current => Math.abs(current - value) < 0.5 ? current : value);
  const followLatest = () => {
    const node = scrollerRef.current;
    pinned.current = true; reading.current = null; setFollowing(true);
    if (node) { node.scrollTop = node.scrollHeight; updateTop(node.scrollTop); }
  };
  const previousFollow = useRef(followRequestId);
  useLayoutEffect(() => {
    if (previousFollow.current === followRequestId) return;
    previousFollow.current = followRequestId;
    followLatest();
  }, [followRequestId]);
  const remember = () => {
    const node = scrollerRef.current;
    if (!node || !keys.length) return;
    const viewportTop = node.getBoundingClientRect().top;
    const visible = [...node.querySelectorAll<HTMLElement>('[data-conversation-row]')].find(row => row.getBoundingClientRect().bottom > viewportTop);
    if (visible && visible.getBoundingClientRect().top < viewportTop + node.clientHeight) {
      reading.current = { key: visible.dataset.conversationRow!, delta: visible.getBoundingClientRect().top - viewportTop };
    } else {
      const index = conversationRowAt(offsets, Math.max(0, node.scrollTop - origin()));
      reading.current = { key: keys[index]!, delta: origin() + offsets[index]! - node.scrollTop };
    }
  };

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    if (pinned.current) node.scrollTop = node.scrollHeight;
    else if (reading.current) {
      const target = restoreConversationOffset(keys, offsets, reading.current, origin());
      if (target !== null) node.scrollTop = target;
    }
    updateTop(node.scrollTop);
  }, [keys, offsets, height]);

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const measure = () => {
      setHeight(current => current === node.clientHeight ? current : node.clientHeight);
      let changed = false;
      for (const row of node.querySelectorAll<HTMLElement>('[data-conversation-row]')) {
        const key = row.dataset.conversationRow!, measured = row.getBoundingClientRect().height;
        if (measured > 0 && Math.abs((heights.current.get(key) ?? -1) - measured) > 0.5) {
          heights.current.set(key, measured); changed = true;
        }
      }
      if (changed) setRevision(value => value + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const row of node.querySelectorAll<HTMLElement>('[data-conversation-row]')) observer.observe(row);
    return () => observer.disconnect();
  }, [keys, view.start, view.end]);

  useLayoutEffect(() => {
    if (!highlightedId) { located.current = null; return; }
    const request = `${highlightRequestId}:${highlightedId}`;
    if (located.current === request) return;
    const index = keys.indexOf(highlightedId), node = scrollerRef.current;
    if (index < 0 || !node) return;
    located.current = request;
    pinned.current = false;
    setFollowing(false);
    reading.current = { key: highlightedId, delta: Math.max(0, (node.clientHeight - (heights.current.get(highlightedId) ?? 72)) / 2) };
    node.scrollTop = restoreConversationOffset(keys, offsets, reading.current, origin())!;
    updateTop(node.scrollTop);
  }, [highlightedId, highlightRequestId, keys, offsets]);

  return { scrollerRef, originRef, view, visibleRows: rows.slice(view.start, view.end), following, followLatest,
    holdPosition: () => { remember(); pinned.current = false; setFollowing(false); },
    onScroll: () => {
      const node = scrollerRef.current;
      if (!node) return;
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      setFollowing(pinned.current);
      remember(); updateTop(node.scrollTop);
    } };
}
