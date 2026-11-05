import { getStreamProfiler } from "./streamProfiler.ts";

const CURRENT_TURN_CONTEXT_PROBE_PX = 96;

/**
 * 贴底锚点。跟随期间用它按高度差改 scrollTop，不再每帧做命中测试。
 * turnId 在锚点建立后保持不变，直到用户真的把滚动位置挪走。
 */
export interface StickScrollAnchor {
  readonly turnId: string | null;
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

export function planStickToBottomScroll(input: {
  readonly anchor: StickScrollAnchor | null;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** true：用户点「回到底部」或首次贴底，直接落到新的底部。 */
  readonly snap: boolean;
}): { readonly scrollTop: number; readonly probe: boolean } {
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight);
  if (input.snap || !input.anchor) {
    return { scrollTop: maxScroll, probe: true };
  }
  const delta = input.scrollHeight - input.anchor.scrollHeight;
  const scrollTop = Math.max(0, Math.min(maxScroll, input.anchor.scrollTop + delta));
  return { scrollTop, probe: false };
}

/** 滚动位置没变时，视口里的轮次不会变，不要再做 elementFromPoint。 */
export function shouldProbeTurnForScroll(input: {
  readonly anchoredScrollTop: number | null;
  readonly scrollTop: number;
}): boolean {
  if (input.anchoredScrollTop === null) return true;
  return input.scrollTop !== input.anchoredScrollTop;
}

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
