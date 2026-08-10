/**
 * 验收动效编排（共用真源）
 *
 * 工作台首页结果卡与「查看结果」抽屉共用同一套三段式验收动画：
 *   submitting（提交中 / 按钮 loading）
 *     -> celebrating（庆祝反馈，停留 ACCEPTANCE_CELEBRATION_MS）
 *       -> exiting（退场，停留 ACCEPTANCE_EXIT_MS）
 *         -> settled（编排结束：卡片移除 / 抽屉关闭）
 *
 * 这里只做时序编排，不触碰 DOM、不依赖 React，便于用 node --test 直接覆盖。
 */

export type AcceptancePhase = 'submitting' | 'celebrating' | 'exiting';

/** 庆祝态停留时长（ms）。首页结果卡与结果抽屉必须一致。 */
export const ACCEPTANCE_CELEBRATION_MS = 980;

/** 退场动画时长（ms）。首页结果卡与结果抽屉必须一致。 */
export const ACCEPTANCE_EXIT_MS = 420;

export type AcceptanceScheduler = (callback: () => void, delayMs: number) => void;

export type RunAcceptanceTransitionOptions = {
  /** 真正的验收提交动作（落库 / 走主进程）。 */
  readonly submit: () => void | Promise<void>;
  /** 每次阶段变化的回调；settled 用 null 表示编排结束。 */
  readonly onPhase: (phase: AcceptancePhase | null) => void;
  /** 定时器注入点，测试里可替换为可控时钟。 */
  readonly schedule?: AcceptanceScheduler;
  /** 编排走完后的收尾动作，例如关闭抽屉、移除卡片。 */
  readonly onSettled?: () => void;
  /** 提交失败时的回调；失败后阶段会回滚为 null。 */
  readonly onFailed?: (error: unknown) => void;
};

const defaultScheduler: AcceptanceScheduler = (callback, delayMs) => {
  setTimeout(callback, delayMs);
};

/**
 * 执行一次完整的三段式验收编排。
 *
 * 成功路径：submitting -> await submit -> celebrating -> (980ms) exiting -> (420ms) settled。
 * 失败路径：submitting -> null（回滚到可重试状态），不进入庆祝与退场。
 */
export async function runAcceptanceTransition(options: RunAcceptanceTransitionOptions): Promise<void> {
  const { submit, onPhase, onSettled, onFailed } = options;
  const schedule = options.schedule ?? defaultScheduler;

  onPhase('submitting');
  try {
    await submit();
  } catch (error) {
    onPhase(null);
    onFailed?.(error);
    return;
  }

  onPhase('celebrating');
  schedule(() => {
    onPhase('exiting');
    schedule(() => {
      onPhase(null);
      onSettled?.();
    }, ACCEPTANCE_EXIT_MS);
  }, ACCEPTANCE_CELEBRATION_MS);
}
