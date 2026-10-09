import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationDisplayRow } from '../state/botConversationState';
import { motionDurationMs, sendScrollProgress } from '../state/conversationMotion';
import { conversationRowKey, conversationOffsets, conversationRowAt, conversationViewport, restoreConversationOffset } from '../state/conversationWindow';

export { conversationRowKey } from '../state/conversationWindow';

/** Owns scroll geometry and reading identity; no IPC or conversation data ownership. */
export function useConversationWindow(rows: readonly ConversationDisplayRow[], highlightedId: string | null, highlightRequestId: number, followRequestId = 0) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const pinned = useRef(true);
  const observedTop = useRef<number | null>(null);
  const reading = useRef<{ key: string; delta: number } | null>(null);
  const located = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [following, setFollowing] = useState(true);
  const sendScroll = useRef<{ frame: number } | null>(null);
  const stopSendScroll = () => {
    if (sendScroll.current) cancelAnimationFrame(sendScroll.current.frame);
    sendScroll.current = null;
  };
  useEffect(() => stopSendScroll, []);
  const keys = useMemo(() => rows.map(conversationRowKey), [rows]);
  const offsets = useMemo(() => conversationOffsets(keys, heights.current), [keys, revision]);
  const origin = () => {
    const node = scrollerRef.current, marker = originRef.current;
    return node && marker ? marker.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop : 0;
  };
  const view = conversationViewport(offsets, Math.max(0, top - origin()), height);
  const updateTop = (value: number) => { observedTop.current = value; setTop(current => Math.abs(current - value) < 0.5 ? current : value); };
  const followLatest = () => {
    stopSendScroll();
    const node = scrollerRef.current;
    pinned.current = true; reading.current = null; setFollowing(true);
    if (node) { node.scrollTop = node.scrollHeight; updateTop(node.scrollTop); }
  };
  const previousFollow = useRef(followRequestId);
  useLayoutEffect(() => {
    if (previousFollow.current === followRequestId) return;
    previousFollow.current = followRequestId;
    const node = scrollerRef.current;
    stopSendScroll();
    pinned.current = true; reading.current = null; setFollowing(true);
    if (!node) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { followLatest(); return; }
    const from = node.scrollTop, started = performance.now();
    const duration = motionDurationMs(getComputedStyle(node).getPropertyValue('--za-motion-medium'));
    const motion = { frame: 0 }; sendScroll.current = motion;
    const step = (now: number) => {
      if (sendScroll.current !== motion) return;
      const progress = sendScrollProgress(now, started, duration);
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = from + (target - from) * progress;
      updateTop(node.scrollTop);
      if (progress < 1) motion.frame = requestAnimationFrame(step);
      else sendScroll.current = null;
    };
    motion.frame = requestAnimationFrame(step);
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
    // A provider update can reach layout before the browser delivers a user's scroll event.
    // Read the actual movement first so an upward scroll cannot be overwritten by follow.
    if (!sendScroll.current && observedTop.current !== null && node.scrollTop < observedTop.current - 0.5
      && node.scrollHeight - node.scrollTop - node.clientHeight >= 80) {
      pinned.current = false; setFollowing(false); remember();
    }
    if (pinned.current && !sendScroll.current) node.scrollTop = node.scrollHeight;
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
    const index = rows.findIndex(row => row.type === 'message' && row.message.id === highlightedId), node = scrollerRef.current;
    if (index < 0 || !node) return;
    located.current = request;
    stopSendScroll(); pinned.current = false;
    setFollowing(false);
    reading.current = { key: keys[index]!, delta: Math.max(0, (node.clientHeight - (heights.current.get(keys[index]!) ?? 72)) / 2) };
    node.scrollTop = restoreConversationOffset(keys, offsets, reading.current, origin())!;
    updateTop(node.scrollTop);
  }, [highlightedId, highlightRequestId, keys, offsets]);

  return { scrollerRef, originRef, view, visibleRows: rows.slice(view.start, view.end), following, followLatest,
    interruptFollow: () => { if (sendScroll.current) { stopSendScroll(); remember(); pinned.current = false; setFollowing(false); } },
    holdPosition: () => { remember(); pinned.current = false; setFollowing(false); },
    onScroll: () => {
      const node = scrollerRef.current;
      if (!node) return;
      if (sendScroll.current) { updateTop(node.scrollTop); return; }
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      setFollowing(pinned.current);
      remember(); updateTop(node.scrollTop);
    } };
}
