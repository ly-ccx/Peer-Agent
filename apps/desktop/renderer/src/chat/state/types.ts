// chat 表达层的共享领域类型。
//
// 这些类型原先私有定义在 ChatSurface.tsx 内，被多个纯逻辑 Module（tokenEstimate /
// attachmentIntake / streamSegments / apiMessageMapping / contextSources）以及组件本身共同依赖。
// 下沉到 chat/state/types.ts 后，state 层的纯逻辑 Module 与 components 层都从这里 import，
// 避免出现「state Module 反向 import 组件文件」的依赖倒置，保持「界面表达依赖下层状态/逻辑、
// 而非相反」的分层方向。
//
// 注意：这里只放 chat 表达层内部的视图模型类型。跨进程契约类型（如 ContextAttachmentItem /
// ConfigInstructionContextItem）仍来自 @peer-agent/protocol，不在此重复定义。

/** 单条消息携带的附件（图片 / 文本 / 不支持）。 */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'unsupported';
  dataUrl?: string;
  text?: string;
}

/** 发送给模型 API 的内容分片：纯文本或图片 URL。 */
export type ChatApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 发送给模型 API 的单条消息（content 可为纯文本或多模态分片数组）。 */
export type ChatApiMessage = { role: string; content: string | ChatApiContentPart[] };

/** 流式内容分段：正文 / 思考 / 工具调用。 */
export type ContentSegment =
  | { type: 'text'; content?: string }
  | { type: 'thinking'; content?: string }
  | {
      type: 'tool-call';
      tool?: string;
      args?: Record<string, unknown>;
      result?: string;
      synthetic?: boolean;
      toolCallId?: string;
    };

/** 渲染分组时使用的工具调用形态（聚合相邻 tool-call 段后的展示模型）。 */
export interface ToolCallLegacy {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  synthetic?: boolean;
}

/** 压缩（compaction）留痕元数据：随消息走的表达层元数据。 */
export interface CompactionMeta {
  method: string;
  originalMessageCount: number;
  deltaMessageCount?: number;
  previousMessageCount?: number;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
}

/** 一条聊天消息的视图模型。 */
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  segments?: ContentSegment[];
  timestamp?: number;
  usage?: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
  // 整轮 wall-clock 留痕(毫秒):从发送到本轮终结(done/aborted/error)。
  // ADR 33:随消息走的表达层元数据,与 usage/timestamp 同级,经既有 replace-messages
  // 开放袋持久化,重启后仍可见;不进入 main 拥有的累计账本(ADR 25 lifetimeUsage)。
  durationMs?: number;
  compaction?: CompactionMeta;
  attachments?: ChatAttachment[];
}

/** 渲染分组：连续正文 / 思考 / 工具调用组。 */
export interface TextGroup { type: 'text'; content: string }
export interface ThinkingGroup { type: 'thinking'; content: string }
export interface ToolCallGroup { type: 'tool-call-group'; calls: ToolCallLegacy[] }
export type SegmentGroup = TextGroup | ThinkingGroup | ToolCallGroup;
