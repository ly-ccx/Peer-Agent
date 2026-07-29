import { createContext } from 'react';

// 交互上下文拆成 action / streaming 两路，避免流式 token 更新时
// isStreaming 与 onSelectOption 绑在同一 value 对象上，导致 GoalPlanPanel
// 等消费者每次重渲染、并连带刷新 PlanCard 的 onNextAction。
// 见 Goal 模式运行时闸门设计 + P0 渲染修复。

/** 稳定动作：只在真正发消息时调用，引用应跨流式帧保持不变。 */
export interface InteractionActions {
  readonly onSelectOption: (text: string) => void;
}

/** 流式态：仅在 isStreaming 翻转时变化，不随 token 推进。 */
export interface InteractionStreamingState {
  readonly isStreaming: boolean;
}

/**
 * @deprecated 兼容旧组合形态；新代码请分别用 InteractionActionsContext /
 * InteractionStreamingContext，避免 action 与 state 同对象更新。
 */
export interface InteractionControl extends InteractionActions, InteractionStreamingState {}

export const InteractionActionsContext = createContext<InteractionActions | null>(null);
export const InteractionStreamingContext = createContext<InteractionStreamingState | null>(null);

/** @deprecated 请改用 InteractionActionsContext + InteractionStreamingContext */
export const InteractionContext = createContext<InteractionControl | null>(null);

// 「这张交互卡是否已被回复」是消息级事实信号：取值为该 assistant 消息之后紧邻的
// user 回复文本（点选项或下方输入框自由输入都算），没有后续回复则为 null。
// 与会话级的 Interaction*Context 区分：后者是能力回调（怎么发），前者是事实（是否已回复）。
// 卡片据此锁定选项、并把与回复文本一致的选项高亮为「已选」。
export const InteractionAnsweredContext = createContext<string | null>(null);
