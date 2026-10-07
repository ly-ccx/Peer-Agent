import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { PeerIcon } from '../../ui/icons';
import '../styles/bot-selection-quote.css';

/** Keep the action beside a body-owned selection, outside the scrolling message layout. */
export function BotSelectionQuote({ root, label, onQuote }: {
  readonly root: RefObject<HTMLDivElement | null>;
  readonly label: string;
  readonly onQuote: (excerpt: string) => void;
}) {
  const toolbar = useRef<HTMLButtonElement>(null);
  const selecting = useRef(false);
  const [selected, setSelected] = useState<{ range: Range; text: string } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const inspect = () => {
      if (selecting.current || toolbar.current?.contains(document.activeElement)) return;
      const selection = window.getSelection(), body = root.current;
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
      setSelected(body && range && !range.collapsed && text
        && body.contains(range.startContainer) && body.contains(range.endContainer)
        ? { range: range.cloneRange(), text } : null);
    };
    const start = (event: PointerEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      selecting.current = Boolean(root.current?.contains(event.target as Node));
      setSelected(null);
    };
    const finish = (event: MouseEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      const inside = selecting.current || root.current?.contains(event.target as Node);
      selecting.current = false;
      if (inside) inspect(); else setSelected(null);
    };
    const cancel = () => { selecting.current = false; setSelected(null); };
    document.addEventListener('selectionchange', inspect);
    document.addEventListener('pointerdown', start, true);
    document.addEventListener('mouseup', finish);
    document.addEventListener('pointercancel', cancel);
    return () => {
      document.removeEventListener('selectionchange', inspect);
      document.removeEventListener('pointerdown', start, true);
      document.removeEventListener('mouseup', finish);
      document.removeEventListener('pointercancel', cancel);
    };
  }, [root]);

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

  return selected ? createPortal(<button ref={toolbar} type="button" className="bot-quote-action bot-selection-quote"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
    onMouseDown={event => event.preventDefault()}
    onClick={() => {
      onQuote(selected.text);
      window.getSelection()?.removeAllRanges(); setSelected(null);
      root.current?.closest('.bot-convo')?.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.focus({ preventScroll: true });
    }}>
    <PeerIcon name="back" size={14} />{label}
  </button>, document.body) : null;
}
