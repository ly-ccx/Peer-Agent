import type { LocalAccessLevel } from '@peer-agent/protocol';

// chat 表达层的偏好领域定义（类型 + 常量 + 类型守卫）——纯逻辑，无副作用、不依赖 React。
//
// 从 ChatSurface.tsx 下沉而来，行为逐字保持不变。下沉目的：useEffortPreference /
// useLocalAccessPreference 等 hook 与 ChatSurface 组件都需要这些守卫/常量，下沉到 state 层后
// 双方都从这里 import，避免 hook 反向 import 组件文件造成依赖倒置。
//
// 注意 LocalAccessLevel 跨进程契约类型仍来自 @peer-agent/protocol，不在此重复定义。

/** 思考强度：通用档位 + GPT-5.6 等模型暴露的 max 档 + Grok 的 medium 档。 */
export type EffortLevel = 'off' | 'low' | 'medium' | 'default' | 'high' | 'xhigh' | 'max';

/** 通用 provider 的思考强度档位（四档）。 */
export const BASE_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high'];

/** OpenAI 系 provider 的思考强度档位（五档，含 xhigh）。 */
export const OPENAI_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high', 'xhigh'];

/** 固定档位排序：off → low → medium → default → high → xhigh → max。 */
const CANONICAL_EFFORT_ORDER: readonly EffortLevel[] = [
  'off',
  'low',
  'medium',
  'default',
  'high',
  'xhigh',
  'max',
];

/**
 * 把后端透传的 provider 原生档位（reasoningEffortLevels）归一化成 UI 可直接渲染的档位列表。
 *
 * 归一化规则（解决 channel 各自档位口径不一致的问题）：
 * - 过滤掉非法值（非 EffortLevel 的字符串一律丢弃）。
 * - 渠道声明什么就渲染什么：Grok 仅 low/medium/high，不强制补 off。
 * - 按固定顺序排序，确保 UI 档位顺序稳定。
 * - 入参为空 / 全部非法 / 未提供时，回退到通用四档 BASE_EFFORT_LEVELS。
 */
export function normalizeEffortLevels(raw: readonly string[] | undefined | null): readonly EffortLevel[] {
  if (!raw || raw.length === 0) return BASE_EFFORT_LEVELS;
  const valid = new Set<EffortLevel>();
  for (const item of raw) {
    if (isEffortLevel(item)) valid.add(item);
  }
  const result = CANONICAL_EFFORT_ORDER.filter((level) => valid.has(level));
  return result.length > 0 ? result : BASE_EFFORT_LEVELS;
}

/**
 * 判断档位列表是否还有「除 off 外」的可调档位。
 *
 * 退化场景：supportsReasoning=true 但渠道只上报 ['off']（例如 Qoder Cantus）。
 * 此时 UI 不应再渲染思考强度滑块/按钮，避免「只有关闭思考的单点滑块」。
 */
export function hasTunableEffortLevels(levels: readonly EffortLevel[] | undefined | null): boolean {
  if (!levels || levels.length === 0) return false;
  return levels.some((level) => level !== 'off');
}

/** EffortLevel 类型守卫。 */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'off'
    || value === 'low'
    || value === 'medium'
    || value === 'default'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max';
}

/**
 * 在目标档位中解析渠道默认思考强度。
 * 优先使用渠道声明的 defaultEffort；否则按 high → default → medium → low 回落。
 */
export function resolvePreferredEffort(
  targetLevels: readonly EffortLevel[],
  preferredDefault?: string | null,
): EffortLevel {
  if (preferredDefault && isEffortLevel(preferredDefault) && targetLevels.includes(preferredDefault)) {
    return preferredDefault;
  }
  for (const candidate of ['high', 'default', 'medium', 'low'] as const) {
    if (targetLevels.includes(candidate)) return candidate;
  }
  return targetLevels[0] ?? 'default';
}

/**
 * 切换模型时把会话当前档位投影到目标模型能力集。
 * xhigh/max 都表达“该模型的最高强度”，跨模型切换时优先保持这一语义。
 * preferredDefault 用于 Grok 等渠道把默认落到 high，而不是第一个可用档。
 */
export function resolveModelSwitchEffort(
  current: EffortLevel,
  targetLevels: readonly EffortLevel[],
  preferredDefault?: string | null,
): EffortLevel {
  if (targetLevels.includes(current)) return current;
  if (current === 'xhigh' && targetLevels.includes('max')) return 'max';
  if (current === 'max' && targetLevels.includes('xhigh')) return 'xhigh';
  // default/off 不是 Grok 原生档；切到不可关闭 Thinking 的渠道时按渠道默认。
  if ((current === 'default' || current === 'off') && preferredDefault) {
    return resolvePreferredEffort(targetLevels, preferredDefault);
  }
  if (targetLevels.includes('default')) return 'default';
  return resolvePreferredEffort(targetLevels, preferredDefault);
}

/** 模型切换的表达层原子状态：绑定目标模型、投影思考档位、废弃旧模型窗口快照。 */
export function resolveModelSwitchState({
  providerId,
  currentEffort,
  targetLevels,
  preferredDefault,
}: {
  providerId: string;
  currentEffort: EffortLevel;
  targetLevels: readonly EffortLevel[];
  preferredDefault?: string | null;
}): {
  modelProviderId: string;
  effort: EffortLevel;
  authoritativeContext: null;
} {
  return {
    modelProviderId: providerId,
    effort: resolveModelSwitchEffort(currentEffort, targetLevels, preferredDefault),
    authoritativeContext: null,
  };
}

/**
 * 主聊天「当前/上次」模型的共享记忆键。
 * Quick 漂浮窗与主聊天共用：主聊天切换或恢复会话模型时写入，Quick 优先读取，
 * 不再使用独立的 quick-chat:model-provider 覆盖。
 */
export const LAST_MODEL_PROVIDER_KEY = 'peer-agent:last-model-provider';

/** 读取共享的主聊天上次/当前模型 providerId；无有效值时返回 null。 */
export function readLastModelProviderId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem(LAST_MODEL_PROVIDER_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** 写入共享的主聊天上次/当前模型 providerId；空值不写。 */
export function writeLastModelProviderId(providerId: string | null | undefined): void {
  if (!providerId || !providerId.trim()) return;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAST_MODEL_PROVIDER_KEY, providerId);
  } catch {
    // localStorage 不可用时静默忽略（隐私模式 / 配额满）。
  }
}

/**
 * 解析会话/记忆中的 modelProviderId 到当前 providers 列表中的真实记录。
 * 兼容历史 groupId::model 与 groupId 绑定；解析失败返回 null。
 */
export function resolveProviderById<T extends {
  id?: string | null;
  groupId?: string | null;
  model?: string | null;
  apiKeyConfigured?: boolean;
}>(providers: readonly T[] | null | undefined, modelProviderId: string | null | undefined): T | null {
  if (!modelProviderId || !providers?.length) return null;
  const exact = providers.find((provider) => provider.id === modelProviderId) || null;
  if (exact) return exact;

  if (modelProviderId.includes('::')) {
    const separator = modelProviderId.indexOf('::');
    const groupId = modelProviderId.slice(0, separator).trim();
    const model = modelProviderId.slice(separator + 2).trim();
    if (groupId && model) {
      const byComposite = providers.find((provider) => {
        const providerGroupId = typeof provider.groupId === 'string' ? provider.groupId.trim() : '';
        const providerModel = typeof provider.model === 'string' ? provider.model.trim() : '';
        return (
          providerModel === model
          && (providerGroupId === groupId || provider.id === groupId)
        );
      }) || null;
      if (byComposite) return byComposite;
    }
  }

  return providers.find((provider) => {
    const providerGroupId = typeof provider.groupId === 'string' ? provider.groupId.trim() : '';
    return providerGroupId === modelProviderId || provider.id === modelProviderId;
  }) || null;
}

/**
 * 草稿态模型种子：优先上次使用模型；可解析时返回真实 id，否则 null（UI 回退默认显示）。
 */
export function resolveDraftModelProviderId<T extends {
  id?: string | null;
  groupId?: string | null;
  model?: string | null;
  apiKeyConfigured?: boolean;
}>(
  providers: readonly T[] | null | undefined,
  rememberedId: string | null | undefined = readLastModelProviderId(),
): string | null {
  const resolved = resolveProviderById(providers, rememberedId);
  if (!resolved?.id) return null;
  if (resolved.apiKeyConfigured === false) return null;
  return resolved.id;
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

export const ACCESS_LEVELS: readonly LocalAccessLevel[] = ['ask_before_local', 'session_local', 'full_local'];

export function accessLevelLabel(level: LocalAccessLevel, isZh: boolean): string {
  if (level === 'full_local') return isZh ? '完全访问' : 'Full access';
  if (level === 'session_local') return isZh ? '帮我批准' : 'Approve for me';
  if (level === 'restricted_local') return isZh ? '受限' : 'Restricted';
  return isZh ? '每次询问' : 'Ask';
}

export function accessLevelTitle(level: LocalAccessLevel, isZh: boolean): string {
  if (level === 'full_local') return isZh ? '自动批准所有本地工具调用；请只在信任当前任务时使用' : 'Auto-approve all local tool calls; use only when you trust the current task';
  if (level === 'session_local') return isZh ? '自动批准低/中风险命令；高风险动作仍会询问' : 'Auto-approve low/medium-risk commands; high-risk actions still ask';
  if (level === 'restricted_local') return isZh ? '使用受限本地访问' : 'Use restricted local access';
  return isZh ? '所有本地动作都先询问' : 'Ask before local actions';
}

export function modeLabel(mode: ChatMode, isZh: boolean): string {
  if (mode === 'plan') return isZh ? '计划模式' : 'Plan mode';
  if (mode === 'goal') return isZh ? '目标模式' : 'Goal mode';
  return isZh ? 'Agent模式' : 'Agent mode';
}

export function modeTitle(mode: ChatMode, isZh: boolean): string {
  if (mode === 'plan') return isZh ? '先规划后执行：先与你共同产出结构化实现计划，批准后再执行' : 'Plan before execute: co-author a structured plan, then execute after approval';
  if (mode === 'goal') return isZh ? '自驱目标模式：你给目标和边界，Agent 自主推进到可验证完成，只在高风险或需决策时打扰你' : 'Self-driven goal mode: give a goal and boundaries; the agent drives to a verifiable done state, interrupting only for high-risk or decision points';
  return isZh ? '直接对话并按需调用工具' : 'Answer directly and call tools as needed';
}

export function effortLabel(level: EffortLevel, isZh: boolean): string {
  if (level === 'off') return isZh ? '关闭思考' : 'Reasoning off';
  if (level === 'low') return isZh ? '简洁思考' : 'Low reasoning';
  if (level === 'medium') return isZh ? '均衡思考' : 'Medium reasoning';
  if (level === 'high') return isZh ? '深度思考' : 'High reasoning';
  if (level === 'xhigh') return isZh ? '超深度思考' : 'Extra-high reasoning';
  if (level === 'max') return isZh ? '超深度思考' : 'Extra-high reasoning';
  return isZh ? '标准思考' : 'Default reasoning';
}

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
