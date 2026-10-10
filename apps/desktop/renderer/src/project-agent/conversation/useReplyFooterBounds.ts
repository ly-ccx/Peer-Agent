import { useLayoutEffect, useRef } from 'react';

/** Follow the last displayed bubble, including streamed paragraphs and drawer reflow. */
export function useReplyFooterBounds() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const footer = ref.current, reply = footer?.parentElement;
    if (!footer || !reply) return;
    let observed: Element[] = [];
    const resize = new ResizeObserver(update);
    function update() {
      if (!footer || !reply) return;
      const bubbles = [...reply.querySelectorAll<HTMLElement>(
        ':scope > .bot-reply-body, :scope > .bot-narration .markdown-content > *, '
        + ':scope > .bot-cards > .bot-stopped-reply > .bot-reply-body, '
        + ':scope > .bot-cards > .bot-unavailable-reply > .bot-reply-body',
      )];
      const target = [...bubbles].reverse().find(node => node.getBoundingClientRect().width > 0);
      const bounds = target?.getBoundingClientRect(), parent = reply.getBoundingClientRect();
      footer.style.width = bounds ? `${bounds.width}px` : '';
      footer.style.marginInlineStart = bounds ? `${Math.max(0, bounds.left - parent.left)}px` : '';
      footer.dataset.compact = String(Boolean(bounds && bounds.width < 210));
      if (observed.length !== bubbles.length || observed.some((node, index) => node !== bubbles[index])) {
        observed.forEach(node => resize.unobserve(node));
        observed = bubbles; observed.forEach(node => resize.observe(node));
      }
    }
    resize.observe(reply);
    const mutation = new MutationObserver(update);
    mutation.observe(reply, { childList: true, subtree: true });
    update();
    return () => { resize.disconnect(); mutation.disconnect(); };
  }, []);
  return ref;
}
