import { MotionSurface } from '../../app/components/MotionSurface';
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { PeerIcon } from '../../ui/icons';
import '../styles/bot-selection-quote.css';

interface QuoteEntry {
  readonly root: RefObject<HTMLDivElement | null>;
  readonly toolbar: RefObject<HTMLButtonElement | null>;
  readonly selecting: { current: boolean };
  readonly active: { current: boolean };
  readonly setSelected: (value: { range: Range; text: string } | null) => void;
}

const quoteEntries = new Set<QuoteEntry>();
let hubAttached = false;

function isTextFieldActive(): boolean {
  const active = document.activeElement;
  return Boolean(active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT'));
}

function inspectAllEntries() {
  if (isTextFieldActive()) {
    for (const entry of quoteEntries) {
      if (entry.active.current && !entry.selecting.current) entry.setSelected(null);
    }
    return;
  }
  const selection = window.getSelection();
  const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
  if (!range || range.collapsed) {
    for (const entry of quoteEntries) {
      if (entry.active.current && !entry.selecting.current && !entry.toolbar.current?.contains(document.activeElement)) {
        entry.setSelected(null);
      }
    }
    return;
  }
  const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
  for (const entry of quoteEntries) {
    if (entry.selecting.current || entry.toolbar.current?.contains(document.activeElement)) continue;
    const body = entry.root.current;
    if (body && text && body.contains(range.startContainer) && body.contains(range.endContainer)) {
      entry.setSelected({ range: range.cloneRange(), text });
    } else if (entry.active.current) {
      entry.setSelected(null);
    }
  }
}

function onHubPointerDown(event: PointerEvent) {
  const target = event.target as Node | null;
  for (const entry of quoteEntries) {
    if (entry.toolbar.current?.contains(target)) continue;
    entry.selecting.current = Boolean(entry.root.current?.contains(target));
    if (entry.active.current) entry.setSelected(null);
  }
}

function onHubMouseUp(event: MouseEvent) {
  const target = event.target as Node | null;
  let shouldInspect = false;
  for (const entry of quoteEntries) {
    if (entry.toolbar.current?.contains(target)) continue;
    const inside = entry.selecting.current || Boolean(entry.root.current?.contains(target));
    entry.selecting.current = false;
    if (inside) shouldInspect = true;
    else if (entry.active.current) entry.setSelected(null);
  }
  if (shouldInspect) inspectAllEntries();
}

function onHubPointerCancel() {
  for (const entry of quoteEntries) {
    entry.selecting.current = false;
    if (entry.active.current) entry.setSelected(null);
  }
}

function attachQuoteHub() {
  if (hubAttached) return;
  hubAttached = true;
  document.addEventListener('selectionchange', inspectAllEntries);
  document.addEventListener('pointerdown', onHubPointerDown, true);
  document.addEventListener('mouseup', onHubMouseUp);
  document.addEventListener('pointercancel', onHubPointerCancel);
}

function detachQuoteHubIfEmpty() {
  if (!hubAttached || quoteEntries.size > 0) return;
  hubAttached = false;
  document.removeEventListener('selectionchange', inspectAllEntries);
  document.removeEventListener('pointerdown', onHubPointerDown, true);
  document.removeEventListener('mouseup', onHubMouseUp);
  document.removeEventListener('pointercancel', onHubPointerCancel);
}

/** Keep the action beside a body-owned selection, outside the scrolling message layout. */
export const BotSelectionQuote = memo(function BotSelectionQuote({ root, label, onQuote }: {
  readonly root: RefObject<HTMLDivElement | null>;
  readonly label: string;
  readonly onQuote: (excerpt: string) => void;
}) {
  const toolbar = useRef<HTMLButtonElement>(null);
  const selecting = useRef(false);
  const active = useRef(false);
  const [selected, setSelectedState] = useState<{ range: Range; text: string } | null>(null);
  const [portalMounted, setPortalMounted] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const setSelected = useRef((value: { range: Range; text: string } | null) => {
    active.current = value !== null;
    if (value !== null) setPortalMounted(true);
    setSelectedState(value);
  }).current;

  useEffect(() => {
    const entry: QuoteEntry = { root, toolbar, selecting, active, setSelected };
    quoteEntries.add(entry);
    attachQuoteHub();
    return () => {
      quoteEntries.delete(entry);
      detachQuoteHubIfEmpty();
    };
  }, [root, setSelected]);

  useLayoutEffect(() => {
    if (!selected) { setPosition(null); return; }
    const dismiss = () => { setSelected(null); setPosition(null); };
    const place = () => {
      const body = root.current, button = toolbar.current;
      const thread = body?.closest('.bot-thread');
      if (!body?.contains(selected.range.startContainer) || !thread || !button) { dismiss(); return; }
      const bounds = thread.getBoundingClientRect();
      const clip = { left: Math.max(8, bounds.left + 8), right: Math.min(innerWidth - 8, bounds.right - 8),
        top: Math.max(8, bounds.top + 8), bottom: Math.min(innerHeight - 8, bounds.bottom - 8) };
      const rect = [...selected.range.getClientRects()].find(box => box.width > 0 && box.height > 0
        && box.bottom > clip.top && box.top < clip.bottom && box.right > clip.left && box.left < clip.right);
      if (!rect) { dismiss(); return; }
      const { width, height } = button.getBoundingClientRect();
      const above = rect.top - height - 8;
      setPosition({ left: Math.max(clip.left, Math.min(rect.left + rect.width / 2 - width / 2, clip.right - width)),
        top: Math.max(clip.top, Math.min(above >= clip.top ? above : rect.bottom + 8, clip.bottom - height)) });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        window.getSelection()?.removeAllRanges(); dismiss();
      } else if (event.key === 'Tab' && !event.shiftKey && document.activeElement !== toolbar.current) {
        event.preventDefault(); toolbar.current?.focus({ preventScroll: true });
      }
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', keydown, true);
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    if (root.current?.closest('.bot-thread')) observer.observe(root.current.closest('.bot-thread')!);
    if (toolbar.current) observer.observe(toolbar.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [selected, root]);

  if (!portalMounted && !selected) return null;
  return createPortal(<MotionSurface kind="fade">{selected ? (<button ref={toolbar} type="button" className="bot-quote-action bot-selection-quote"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
    onMouseDown={event => event.preventDefault()}
    onClick={() => {
      onQuote(selected.text);
      window.getSelection()?.removeAllRanges(); setSelected(null);
      root.current?.closest('.bot-convo')?.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.focus({ preventScroll: true });
    }}>
    <PeerIcon name="back" size={14} />{label}
  </button>) : null}</MotionSurface>, document.body);
});
