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

type AcceptanceItem = { readonly taskId: string };

type AcceptanceTransitionItem<T extends AcceptanceItem> = {
  readonly item: T;
  readonly phase: AcceptancePhase;
};

export type DisplayedAcceptanceItem<T extends AcceptanceItem> = {
  readonly item: T;
  readonly phase?: AcceptancePhase;
};

/**
 * 验收刷新期间按点击前的完整视觉顺序合并卡片。
 *
 * 只保存被点卡片的旧下标会与刷新后前移的兄弟卡片产生下标碰撞，
 * 最终把过渡卡片追加到末尾。完整 taskId 快照是过渡窗口内唯一的排序真源。
 */
export function mergeAcceptanceTransitionItems<T extends AcceptanceItem>(options: {
  readonly currentItems: readonly T[];
  readonly transitions: readonly AcceptanceTransitionItem<T>[];
  readonly orderSnapshot: readonly string[];
}): DisplayedAcceptanceItem<T>[] {
  const transitionByTaskId = new Map(options.transitions.map((transition) => [transition.item.taskId, transition]));
  const currentByTaskId = new Map(options.currentItems.map((item) => [item.taskId, item]));
  const displayed: DisplayedAcceptanceItem<T>[] = [];
  const includedTaskIds = new Set<string>();

  for (const taskId of options.orderSnapshot) {
    const transition = transitionByTaskId.get(taskId);
    const current = currentByTaskId.get(taskId);
    if (transition) {
      displayed.push(transition);
      includedTaskIds.add(taskId);
    } else if (current) {
      displayed.push({ item: current });
      includedTaskIds.add(taskId);
    }
  }

  // 新进入待验收列表、但不在冻结快照中的卡片沿用后端顺序并追加显示。
  for (const item of options.currentItems) {
    if (!includedTaskIds.has(item.taskId)) {
      displayed.push({ item });
      includedTaskIds.add(item.taskId);
    }
  }

  // 防御并发过渡：即使某个过渡开始前不在首份快照中，也不能丢卡。
  for (const transition of options.transitions) {
    if (!includedTaskIds.has(transition.item.taskId)) {
      displayed.push(transition);
    }
  }

  return displayed;
}

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
