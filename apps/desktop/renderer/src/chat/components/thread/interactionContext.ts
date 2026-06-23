import { createContext } from 'react';

// 交互上下文：把「选择 request_user_input 选项」的回调下沉给工具卡渲染，
// 避免一长串 props 透传。回调内部复用既有 submitMessage 发送路径（不另造路径）。
// 见 Goal 模式运行时闸门设计。
export interface InteractionControl {
  readonly onSelectOption: (text: string) => void;
  readonly isStreaming: boolean;
}

export const InteractionContext = createContext<InteractionControl | null>(null);

// 「这张交互卡是否已被回复」是消息级事实信号：取值为该 assistant 消息之后紧邻的
// user 回复文本（点选项或下方输入框自由输入都算），没有后续回复则为 null。
// 与会话级的 InteractionContext 区分：后者是能力回调（怎么发），前者是事实（是否已回复）。
// 卡片据此锁定选项、并把与回复文本一致的选项高亮为「已选」。
export const InteractionAnsweredContext = createContext<string | null>(null);
