import { getStreamProfiler } from "./streamProfiler.ts";

const CURRENT_TURN_CONTEXT_PROBE_PX = 96;

export function findCurrentTurnIdForScroll(container: HTMLDivElement): string | null {
  // 观测：本函数是流式热路径上最贵的一步——getBoundingClientRect + elementFromPoint
  // （命中测试）+ 再次 getBoundingClientRect，每次都会强制同步布局。
  // 它此前在每个 delta 写入后被调用两次（saveThreadScrollSnapshot 与
  // updateCurrentTurnContext 各自算一遍），所以单独计时以确认量级与去重效果。
  return getStreamProfiler().measure('scroll.hitTest', () => {
    const containerRect = container.getBoundingClientRect();
    const probeX = containerRect.left + Math.min(Math.max(container.clientWidth / 2, 1), Math.max(containerRect.width - 1, 1));
    const probeY = containerRect.top + CURRENT_TURN_CONTEXT_PROBE_PX;
    const hit = container.ownerDocument.elementFromPoint(probeX, probeY);
    const candidate = hit instanceof Element
      ? hit.closest<HTMLElement>('[data-chat-turn-id]')
      : null;
    if (!candidate || !container.contains(candidate)) return null;

    const turnId = candidate.dataset.chatTurnId ?? null;
    if (!turnId) return null;

    const userMessage = candidate.querySelector<HTMLElement>('.chat-msg-user');
    if (userMessage && userMessage.getBoundingClientRect().bottom > probeY) return null;

    return turnId;
  });
}
