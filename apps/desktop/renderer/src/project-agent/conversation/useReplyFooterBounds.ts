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
      const start = style ? parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) : 0;
      // Even a one-word bubble must leave room for a readable details label.
      footer.style.width = bounds ? `${Math.max(0, parent.right - bounds.left - start - 14)}px` : 'calc(100% - 28px)';
      // Match the message text inset before the first streamed bubble arrives.
      const inset = bounds ? `${Math.max(0, bounds.left - parent.left + start)}px` : '14px';
      footer.style.setProperty('--bot-reply-inset', inset);
      footer.style.marginInlineStart = inset;
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
