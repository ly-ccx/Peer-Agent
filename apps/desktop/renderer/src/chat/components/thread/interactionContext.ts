import { createContext } from 'react';

// 交互上下文：把「选择 request_user_input 选项」的回调下沉给工具卡渲染，
// 避免一长串 props 透传。回调内部复用既有 submitMessage 发送路径（不另造路径）。
// 见 Goal 模式运行时闸门设计。
export interface InteractionControl {
  readonly onSelectOption: (text: string) => void;
  readonly isStreaming: boolean;
}

export const InteractionContext = createContext<InteractionControl | null>(null);
