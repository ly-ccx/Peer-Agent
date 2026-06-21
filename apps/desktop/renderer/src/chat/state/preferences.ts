import type { LocalAccessLevel } from '@peer-agent/protocol';

// chat 表达层的偏好领域定义（类型 + 常量 + 类型守卫）——纯逻辑，无副作用、不依赖 React。
//
// 从 ChatSurface.tsx 下沉而来，行为逐字保持不变。下沉目的：useEffortPreference /
// useLocalAccessPreference 等 hook 与 ChatSurface 组件都需要这些守卫/常量，下沉到 state 层后
// 双方都从这里 import，避免 hook 反向 import 组件文件造成依赖倒置。
//
// 注意 LocalAccessLevel 跨进程契约类型仍来自 @peer-agent/protocol，不在此重复定义。

/** 思考强度（reasoning effort）五档：off(关闭) / low / default / high / xhigh(Extra High, OpenAI)。 */
export type EffortLevel = 'off' | 'low' | 'default' | 'high' | 'xhigh';

/** 通用 provider 的思考强度档位（四档）。 */
export const BASE_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high'];

/** OpenAI 系 provider 的思考强度档位（五档，含 xhigh）。 */
export const OPENAI_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high', 'xhigh'];

/** EffortLevel 类型守卫。 */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'off' || value === 'low' || value === 'default' || value === 'high' || value === 'xhigh';
}

/** LocalAccessLevel 类型守卫（认 4 个合法值，含 restricted_local）。 */
export function isLocalAccessLevel(value: unknown): value is LocalAccessLevel {
  return value === 'ask_before_local'
    || value === 'session_local'
    || value === 'restricted_local'
    || value === 'full_local';
}

// 对话模式:进入 System Context 的 L6_MODE_REMINDER 层(见 Goal 模式设计)。
// 'chat' 为默认直答模式;'goal' 为先规划后执行模式。
export type ChatMode = 'chat' | 'goal';

/** 合法对话模式枚举。 */
export const CHAT_MODES: readonly ChatMode[] = ['chat', 'goal'];

/** ChatMode 类型守卫。 */
export function isChatMode(value: unknown): value is ChatMode {
  return value === 'chat' || value === 'goal';
}
