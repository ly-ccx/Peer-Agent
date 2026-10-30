import { useLayoutEffect, useRef } from 'react';

/** Follow the last displayed text column, including streamed paragraphs and drawer reflow. */
export function useReplyFooterBounds() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const footer = ref.current, reply = footer?.parentElement;
    if (!footer || !reply) return;
    let observed: Element[] = [];
    let frame: number | null = null;
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; update(); }); };
    const resize = new ResizeObserver(schedule);
    function update() {
      if (!footer || !reply) return;
      const bubbles = [...reply.querySelectorAll<HTMLElement>(
        ':scope > .bot-reply-body, :scope > .bot-continuous-paragraphs > .bot-reply-body, :scope > .bot-narration:not(.bot-continuous-paragraphs) .markdown-content > *, '
        + ':scope > .bot-cards > .bot-stopped-reply > .bot-reply-body, '
        + ':scope > .bot-cards > .bot-unavailable-reply > .bot-reply-body',
      )];
      const target = [...bubbles].reverse().find(node => node.getBoundingClientRect().width > 0);
      const bounds = target?.getBoundingClientRect(), parent = reply.getBoundingClientRect();
      const style = target ? getComputedStyle(target) : null;
      const start = style ? parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) : 14;
      const end = style ? parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth) : 14;
      const padStart = Number.isFinite(start) ? start : 14;
      const padEnd = Number.isFinite(end) ? end : 14;
      // Match the text column inside the bubble. Padding stays on the bubble, not added outside this row.
      footer.style.boxSizing = 'border-box';
      footer.style.alignSelf = 'flex-start';
      footer.style.flex = '0 1 auto';
      footer.style.minWidth = '0';
      footer.style.paddingInlineStart = '0';
      footer.style.paddingInlineEnd = '0';
      if (!bounds) {
        footer.style.marginInlineStart = '0px';
        footer.style.width = '100%';
        footer.style.maxWidth = '100%';
        footer.style.paddingInlineStart = `${padStart}px`;
        footer.style.paddingInlineEnd = `${padEnd}px`;
      } else {
        const inner = Math.max(0, bounds.width - padStart - padEnd);
        footer.style.marginInlineStart = `${Math.max(0, bounds.left - parent.left + padStart)}px`;
        footer.style.width = `${inner}px`;
        footer.style.maxWidth = `${inner}px`;
      }
      if (observed.length !== bubbles.length || observed.some((node, index) => node !== bubbles[index])) {
        observed.forEach(node => resize.unobserve(node));
        observed = bubbles; observed.forEach(node => resize.observe(node));
      }
    }
    resize.observe(reply);
    const mutation = new MutationObserver(schedule);
    mutation.observe(reply, { childList: true, subtree: true });
    update();
    return () => { if (frame !== null) cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); };
  }, []);
  return ref;
}
