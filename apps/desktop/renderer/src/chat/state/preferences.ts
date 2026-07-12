import type { LocalAccessLevel } from '@peer-agent/protocol';

// chat 表达层的偏好领域定义（类型 + 常量 + 类型守卫）——纯逻辑，无副作用、不依赖 React。
//
// 从 ChatSurface.tsx 下沉而来，行为逐字保持不变。下沉目的：useEffortPreference /
// useLocalAccessPreference 等 hook 与 ChatSurface 组件都需要这些守卫/常量，下沉到 state 层后
// 双方都从这里 import，避免 hook 反向 import 组件文件造成依赖倒置。
//
// 注意 LocalAccessLevel 跨进程契约类型仍来自 @peer-agent/protocol，不在此重复定义。

/** 思考强度：通用五档 + GPT-5.6 等模型暴露的 max 档。 */
export type EffortLevel = 'off' | 'low' | 'default' | 'high' | 'xhigh' | 'max';

/** 通用 provider 的思考强度档位（四档）。 */
export const BASE_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high'];

/** OpenAI 系 provider 的思考强度档位（五档，含 xhigh）。 */
export const OPENAI_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high', 'xhigh'];

/**
 * 把后端透传的 provider 原生档位（reasoningEffortLevels）归一化成 UI 可直接渲染的档位列表。
 *
 * 归一化规则（解决 channel 各自档位口径不一致的问题）：
 * - 过滤掉非法值（非 EffortLevel 的字符串一律丢弃）。
 * - 强制把 'off'（关闭思考）放到列表首位：它是通用开关，部分 channel（如 Anthropic/OpenAI）
 *   的 effortLevels 并不含 off，需要补齐；含 off 的（如 Google）则去重后归位。
 * - 按 EffortLevel 的标准顺序（off→low→default→high→xhigh→max）排序，确保 UI 档位顺序稳定。
 * - 入参为空 / 全部非法 / 未提供时，回退到通用四档 BASE_EFFORT_LEVELS。
 */
export function normalizeEffortLevels(raw: readonly string[] | undefined | null): readonly EffortLevel[] {
  const ORDER: readonly EffortLevel[] = ['off', 'low', 'default', 'high', 'xhigh', 'max'];
  if (!raw || raw.length === 0) return BASE_EFFORT_LEVELS;
  const valid = new Set<EffortLevel>();
  for (const item of raw) {
    if (isEffortLevel(item)) valid.add(item);
  }
  valid.add('off'); // off 是通用开关，始终提供。
  const result = ORDER.filter((level) => valid.has(level));
  return result.length > 1 ? result : BASE_EFFORT_LEVELS;
}

/** EffortLevel 类型守卫。 */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'off' || value === 'low' || value === 'default' || value === 'high' || value === 'xhigh' || value === 'max';
}

/**
 * 切换模型时把会话当前档位投影到目标模型能力集。
 * xhigh/max 都表达“该模型的最高强度”，跨模型切换时优先保持这一语义。
 */
export function resolveModelSwitchEffort(
  current: EffortLevel,
  targetLevels: readonly EffortLevel[],
): EffortLevel {
  if (targetLevels.includes(current)) return current;
  if (current === 'xhigh' && targetLevels.includes('max')) return 'max';
  if (current === 'max' && targetLevels.includes('xhigh')) return 'xhigh';
  if (targetLevels.includes('default')) return 'default';
  return targetLevels.find((level) => level !== 'off') ?? 'off';
}

/** 模型切换的表达层原子状态：绑定目标模型、投影思考档位、废弃旧模型窗口快照。 */
export function resolveModelSwitchState({
  providerId,
  currentEffort,
  targetLevels,
}: {
  providerId: string;
  currentEffort: EffortLevel;
  targetLevels: readonly EffortLevel[];
}): {
  modelProviderId: string;
  effort: EffortLevel;
  authoritativeContext: null;
} {
  return {
    modelProviderId: providerId,
    effort: resolveModelSwitchEffort(currentEffort, targetLevels),
    authoritativeContext: null,
  };
}

/** LocalAccessLevel 类型守卫（认 4 个合法值，含 restricted_local）。 */
export function isLocalAccessLevel(value: unknown): value is LocalAccessLevel {
  return value === 'ask_before_local'
    || value === 'session_local'
    || value === 'restricted_local'
    || value === 'full_local';
}

// 对话模式:进入 System Context 的 L6_MODE_REMINDER 层。
// 'chat' 为默认直答模式;'plan' 为先规划后执行的审批门模式;'goal' 为自驱目标模式
// (用户给目标+边界,Runner 托管 explore→plan→act→verify 闭环,最小打扰)。
//
// wire 值迁移(见 ADR 41 与 goal-mode-ultrathink-workflow 设计文档十六章):历史 'goal'
// (旧 plan 语义)已由 conversation-store 的一次性数据迁移改写为 'plan','goal' 字面量
// 腾空后重新承载自驱语义。因此这里不再把 'goal' 兼容映射为 'plan'。
export type ChatMode = 'chat' | 'plan' | 'goal';

/** 合法对话模式枚举。 */
export const CHAT_MODES: readonly ChatMode[] = ['chat', 'plan', 'goal'];

/** ChatMode 类型守卫（只接受当前 wire 值）。 */
export function isChatMode(value: unknown): value is ChatMode {
  return value === 'chat' || value === 'plan' || value === 'goal';
}

/**
 * 对持久化/跨进程输入做归一化。
 *
 * 注意:存量会话里历史的 'goal'（旧 plan 语义）由 conversation-store 初始化时的一次性
 * 数据迁移改写为 'plan';迁移完成后,'goal' 一律按新的自驱语义处理,不再兼容映射。
 */
export function normalizeChatMode(value: unknown): ChatMode {
  if (value === 'plan') return 'plan';
  if (value === 'goal') return 'goal';
  return 'chat';
}
