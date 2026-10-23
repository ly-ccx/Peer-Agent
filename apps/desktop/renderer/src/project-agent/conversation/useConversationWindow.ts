import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { replyRowContains, type BotConversationViewRow } from '../state/botReplyContinuity';
import { conversationRowKey, conversationOffsets, conversationRowAt, conversationViewport, restoreConversationOffset } from '../state/conversationWindow';
import { conversationReadingMemory, type ReadingAnchor } from '../state/conversationReadingMemory';
import { resolveThreadFollowAfterScroll } from '../../chat/state/threadScrollPolicy';
import { createStreamingScrollScheduler } from '../../chat/state/streamingScrollScheduler';
import { isImeKey } from '../../chat/state/compositionGuard';
export { conversationRowKey } from '../state/conversationWindow';

type Direction = 'up' | 'down' | 'unknown';
const sourceId = (row: BotConversationViewRow | undefined) => row?.type === 'reply'
  ? row.messages[0]?.id ?? row.activity?.replyTo[0] : row?.type === 'message' ? row.message.id : undefined;

/** Geometry/reading only. Navigation memory is bounded and never persists conversation facts. */
export function useConversationWindow(rows: readonly BotConversationViewRow[], highlightedId: string | null, highlightRequestId: number, followRequestId = 0,
  options: { identity: string; ready: boolean; hasOlder: boolean; locateMessage: (id: string, pages: number, active: () => boolean) => Promise<boolean> }) {
  const initial = useRef(conversationReadingMemory.read(options.identity));
  const scrollerRef = useRef<HTMLDivElement>(null), originRef = useRef<HTMLDivElement>(null), tailRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map(initial.current?.heights)), tailHeight = useRef(0);
  const pinned = useRef(!highlightedId && (initial.current?.following ?? true));
  const reading = useRef<ReadingAnchor | null>(highlightedId ? null : initial.current?.anchor ?? null);
  const pendingRestore = useRef<ReadingAnchor | null>(!pinned.current ? reading.current : null);
  const located = useRef<string | null>(null), restoration = useRef(0), navigationEpoch = useRef(0);
  const gesture = useRef<{ active: boolean; direction: Direction }>({ active: false, direction: 'unknown' });
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), touchY = useRef<number | null>(null);
  const readingFrame = useRef<number | null>(null);
  const [revision, setRevision] = useState(0), [top, setTop] = useState(initial.current?.top ?? 0), [height, setHeight] = useState(0);
  const [following, setFollowing] = useState(pinned.current), [restoreStatus, setRestoreStatus] = useState<'none' | 'loading' | 'more' | 'missing'>('none');
  const [referenceStatus, setReferenceStatus] = useState<'none' | 'loading' | 'missing'>('none');
  const referenceRequest = useRef(0);
  const latest = useRef(options); latest.current = options;
  const previousKeys = useRef<readonly string[]>([]), nextKeys = rows.map(conversationRowKey);
  if (nextKeys.length !== previousKeys.current.length || nextKeys.some((key, index) => key !== previousKeys.current[index])) previousKeys.current = nextKeys;
  const keys = previousKeys.current;
  const offsets = useMemo(() => conversationOffsets(keys, heights.current), [keys, revision]);
  const origin = () => {
    const node = scrollerRef.current, marker = originRef.current;
    return node && marker ? marker.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop : 0;
  };
  const view = conversationViewport(offsets, Math.max(0, top - origin()), height);
  const updateTop = (value: number) => setTop(current => Math.abs(current - value) < 0.5 ? current : value);
  const persist = () => {
    if (!latest.current.ready || !keys.length || pendingRestore.current) return;
    const center = reading.current ? keys.indexOf(reading.current.key) : keys.length - 1;
    const measured = [...new Set([...keys.slice(Math.max(0, center - 60), center + 80), ...keys.slice(-20)])]
      .flatMap(key => heights.current.has(key) ? [[key, heights.current.get(key)!] as const] : []);
    conversationReadingMemory.save(options.identity, { following: pinned.current, anchor: reading.current,
      top: scrollerRef.current?.scrollTop ?? top, heights: measured });
  };
  const saveOnLeave = useRef(persist); saveOnLeave.current = persist;
  useLayoutEffect(() => () => saveOnLeave.current(), [options.identity]);
  const remember = () => {
    const node = scrollerRef.current;
    if (!node || !keys.length) return;
    const viewportTop = node.getBoundingClientRect().top;
    const candidate = [...node.querySelectorAll<HTMLElement>('[data-conversation-row]')].find(row => row.getBoundingClientRect().bottom > viewportTop);
    const visible = candidate && candidate.getBoundingClientRect().top < viewportTop + node.clientHeight ? candidate : undefined;
    const index = visible ? keys.indexOf(visible.dataset.conversationRow!) : conversationRowAt(offsets, Math.max(0, node.scrollTop - origin()));
    if (index < 0 || !keys[index]) return;
    reading.current = { key: keys[index]!, delta: visible ? visible.getBoundingClientRect().top - viewportTop : origin() + offsets[index]! - node.scrollTop,
      messageId: sourceId(rows[index]) ?? sourceId(rows[index + 1]) };
  };
  const cancelRestore = () => { pendingRestore.current = null; restoration.current++; setRestoreStatus('none'); };
  const followLatest = () => {
    if (readingFrame.current !== null) { window.cancelAnimationFrame(readingFrame.current); readingFrame.current = null; }
    navigationEpoch.current++;
    referenceRequest.current++; setReferenceStatus('none');
    located.current = highlightedId ? `${highlightRequestId}:${highlightedId}` : null;
    cancelRestore(); gesture.current.active = false; clearTimeout(gestureTimer.current);
    pinned.current = true; reading.current = null; setFollowing(true);
    const node = scrollerRef.current;
    if (node) { node.scrollTop = node.scrollHeight; updateTop(node.scrollTop); }
    persist();
  };
  const schedulerCallbacks = useRef({ follow: () => {}, refresh: () => {} });
  schedulerCallbacks.current = {
    follow: () => { const node = scrollerRef.current; if (pinned.current && node) { node.scrollTop = node.scrollHeight; updateTop(node.scrollTop); } },
    refresh: () => { const node = scrollerRef.current; if (node) updateTop(node.scrollTop); },
  };
  const scheduler = useRef<ReturnType<typeof createStreamingScrollScheduler> | null>(null);
  useLayoutEffect(() => {
    scheduler.current = createStreamingScrollScheduler({ scheduler: { request: callback => window.requestAnimationFrame(callback), cancel: frameId => window.cancelAnimationFrame(frameId) },
      follow: () => schedulerCallbacks.current.follow(), refresh: () => schedulerCallbacks.current.refresh() });
    return () => { scheduler.current?.cancel(); scheduler.current = null; };
  }, []);
  useEffect(() => () => {
    clearTimeout(gestureTimer.current); restoration.current++; referenceRequest.current++;
    if (readingFrame.current !== null) window.cancelAnimationFrame(readingFrame.current);
  }, []);
  const previousFollow = useRef(followRequestId);
  useLayoutEffect(() => {
    if (previousFollow.current === followRequestId) return;
    previousFollow.current = followRequestId; followLatest();
  }, [followRequestId]);

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    if (pinned.current) scheduler.current?.scheduleFollow();
    else if (reading.current) {
      const anchor = pendingRestore.current;
      if (anchor && !keys.includes(anchor.key) && anchor.messageId) {
        const match = rows.findIndex(row => replyRowContains(row, anchor.messageId));
        if (match >= 0) reading.current = { ...anchor, key: keys[match]! };
      }
      const target = restoreConversationOffset(keys, offsets, reading.current, origin());
      if (target !== null) { node.scrollTop = target; pendingRestore.current = null; setRestoreStatus('none'); }
    }
    updateTop(node.scrollTop); persist();
  }, [keys, offsets, height]);

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const measure = () => {
      setHeight(current => current === node.clientHeight ? current : node.clientHeight);
      const tail = tailRef.current?.getBoundingClientRect().height ?? 0;
      let changed = Math.abs(tailHeight.current - tail) > 0.5; tailHeight.current = tail;
      for (const row of node.querySelectorAll<HTMLElement>('[data-conversation-row]')) {
        const key = row.dataset.conversationRow!, measured = row.getBoundingClientRect().height;
        if (measured > 0 && Math.abs((heights.current.get(key) ?? -1) - measured) > 0.5) { heights.current.set(key, measured); changed = true; }
      }
      if (changed) setRevision(value => value + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node); if (tailRef.current) observer?.observe(tailRef.current);
    for (const row of node.querySelectorAll<HTMLElement>('[data-conversation-row]')) observer?.observe(row);
    node.addEventListener('load', measure, true); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); node.removeEventListener('load', measure, true); window.removeEventListener('resize', measure); };
  }, [keys, view.start, view.end]);

  const restoreReading = async () => {
    const anchor = pendingRestore.current;
    if (!anchor?.messageId || restoreStatus === 'loading') { if (anchor && !anchor.messageId) setRestoreStatus('missing'); return; }
    const ticket = ++restoration.current; setRestoreStatus('loading');
    const found = await latest.current.locateMessage(anchor.messageId, 4, () => restoration.current === ticket && pendingRestore.current === anchor);
    if (restoration.current !== ticket || !pendingRestore.current) return;
    if (found) setRestoreStatus('none');
    else setRestoreStatus(latest.current.hasOlder ? 'more' : 'missing');
  };
  useEffect(() => {
    if (options.ready && pendingRestore.current && restoreStatus === 'none' && !highlightedId) void restoreReading();
  }, [options.ready, keys, highlightedId]);
  const locateReference = async () => {
    if (!highlightedId || !latest.current.ready) return;
    const ticket = ++referenceRequest.current, intent = navigationEpoch.current;
    located.current = null;
    setReferenceStatus('loading');
    const active = () => ticket === referenceRequest.current && intent === navigationEpoch.current;
    try {
      const found = await latest.current.locateMessage(highlightedId, 4, active);
      if (active()) setReferenceStatus(found ? 'none' : 'missing');
    } catch { if (active()) setReferenceStatus('missing'); }
  };
  useEffect(() => {
    if (highlightedId && options.ready) void locateReference();
    else setReferenceStatus('none');
    return () => { referenceRequest.current++; };
  }, [highlightedId, highlightRequestId, options.ready]);
  useLayoutEffect(() => {
    if (!highlightedId) { located.current = null; return; }
    const request = `${highlightRequestId}:${highlightedId}`;
    if (located.current === request) return;
    const index = rows.findIndex(row => replyRowContains(row, highlightedId)), node = scrollerRef.current;
    cancelRestore(); pinned.current = false; setFollowing(false);
    if (index < 0 || !node) return;
    located.current = request;
    reading.current = { key: keys[index]!, messageId: sourceId(rows[index]), delta: Math.max(0, (node.clientHeight - (heights.current.get(keys[index]!) ?? 72)) / 2) };
    node.scrollTop = restoreConversationOffset(keys, offsets, reading.current, origin())!;
    updateTop(node.scrollTop); persist();
  }, [highlightedId, highlightRequestId, keys, offsets, referenceStatus]);

  const userGesture = (direction: Direction) => {
    navigationEpoch.current++;
    referenceRequest.current++; setReferenceStatus('none');
    located.current = highlightedId ? `${highlightRequestId}:${highlightedId}` : null;
    cancelRestore(); gesture.current = { active: true, direction };
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => { gesture.current.active = false; }, 120);
    if (direction !== 'down') { pinned.current = false; setFollowing(false); remember(); persist(); }
    // Wheel/touch input arrives before the browser applies its scroll. Capture
    // that position on the next frame even if scroll delivery is delayed.
    if (readingFrame.current !== null) window.cancelAnimationFrame(readingFrame.current);
    readingFrame.current = window.requestAnimationFrame(() => {
      readingFrame.current = null;
      if (!pinned.current && !pendingRestore.current) {
        remember(); updateTop(scrollerRef.current?.scrollTop ?? top); persist();
      }
    });
  };
  return { scrollerRef, originRef, tailRef, view, visibleRows: rows.slice(view.start, view.end), following, followLatest, restoreStatus, restoreReading, referenceStatus, locateReference, navigationEpoch: navigationEpoch.current,
    onWheel: (event: React.WheelEvent<HTMLElement>) => { if (event.deltaY) userGesture(event.deltaY < 0 ? 'up' : 'down'); },
    onTouchStart: (event: React.TouchEvent<HTMLElement>) => { touchY.current = event.touches[0]?.clientY ?? null; userGesture('unknown'); },
    onTouchMove: (event: React.TouchEvent<HTMLElement>) => { const y = event.touches[0]?.clientY; if (y !== undefined && touchY.current !== null) userGesture(y > touchY.current ? 'up' : 'down'); touchY.current = y ?? null; },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => { if (event.target === event.currentTarget) userGesture('unknown'); },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || isImeKey(event.nativeEvent) || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) userGesture('up');
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) userGesture('down');
    },
    wantsOlder: () => gesture.current.active && gesture.current.direction !== 'down' && !pendingRestore.current,
    holdPosition: () => { cancelRestore(); remember(); pinned.current = false; setFollowing(false); persist(); },
    onScroll: () => {
      const node = scrollerRef.current; if (!node) return;
      if (pendingRestore.current) { updateTop(node.scrollTop); return; }
      const decision = resolveThreadFollowAfterScroll({ currentlyFollowing: pinned.current, atBottom: node.scrollHeight - node.scrollTop - node.clientHeight < 80,
        userInitiated: gesture.current.active, direction: gesture.current.direction });
      pinned.current = decision.nextFollowing; setFollowing(decision.nextFollowing);
      if (decision.shouldReaffirmBottom) scheduler.current?.scheduleFollow();
      else { if (!pinned.current) remember(); scheduler.current?.scheduleRefresh(); }
      persist();
    } };
}
