// chat 表达层的共享领域类型。
//
// 这些类型原先私有定义在 ChatSurface.tsx 内，被多个纯逻辑 Module（attachmentIntake /
// streamSegments / apiMessageMapping / contextSources）以及组件本身共同依赖。
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

/**
 * 待发送消息队列项：当一轮 agent turn 正在运行/压缩时，用户继续提交的消息先入队，
 * 待当前轮结束后由 ChatSurface 的 dequeue effect 复用同一发送路径自动发送下一条。
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  effort: import('./preferences').EffortLevel;
}

/** 发送给模型 API 的内容分片：纯文本或图片 URL。 */
export type ChatApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** OpenAI-style 工具调用记录：表达层统一用它回放本地工具历史，provider encoder 再降级到各自协议。 */
export interface ChatApiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 发送给模型 API 的单条消息（content 可为空、纯文本或多模态分片数组）。 */
export interface ChatApiMessage {
  role: string;
  content: string | ChatApiContentPart[] | null;
  tool_calls?: ChatApiToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** 流式内容分段：正文 / 思考 / 工具调用。 */
export type ContentSegment =
  | { type: 'text'; content?: string }
  | { type: 'thinking'; content?: string }
  | {
      type: 'tool-call';
      tool?: string;
      // 后端 Runtime Projection 注入的展示文案（MCP 工具为「服务名: 工具名」）。
      // 仅作工具卡标题展示用；缺省时渲染层回退到裸 capability 名（tool）。
      displayName?: string | null;
      args?: Record<string, unknown>;
      result?: string;
      synthetic?: boolean;
      toolCallId?: string;
      /** 主进程记录的工具生命周期时间；旧历史可缺省。 */
      startedAtMs?: number;
      endedAtMs?: number;
      durationMs?: number;
    };

/** 渲染分组时使用的工具调用形态（聚合相邻 tool-call 段后的展示模型）。 */
export interface ToolCallLegacy {
  tool: string;
  // 后端注入的展示文案（同 ContentSegment.displayName），渲染层优先用于标题。
  displayName?: string | null;
  args: Record<string, unknown>;
  result?: string;
  synthetic?: boolean;
  toolCallId?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
}

/** 压缩（compaction）留痕元数据：随消息走的表达层元数据。 */
export interface CompactionMeta {
  method: string;
  /**
   * 当本次压缩未走 LLM 语义摘要、落到结构/截断兜底时，记录原因分类：
   * no_provider / llm_empty / llm_prompt_too_long / llm_error / llm_unavailable / circuit_breaker。
   * 走 LLM 成功时为空。让"为什么没走 LLM"在 Evidence 与压缩卡上可见。
   */
  fallbackReason?: string;
  /** 兜底原因的明细（错误信息片段，截断到 500 字），仅诊断用。 */
  fallbackDetail?: string;
  originalMessageCount: number;
  deltaMessageCount?: number;
  previousMessageCount?: number;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
}

export type CompactionProgressStage = 'preparing' | 'summarizing' | 'retrying' | 'fallback';

/** 聊天上下文压缩过程的显式状态机。 */
export type CompactionState =
  | { phase: 'idle' }
  | {
      phase: 'running';
      percent: number | null;
      progressStage?: CompactionProgressStage;
      attempt?: number;
      maxAttempts?: number;
      inputTokenBudget?: number;
      streamId?: string;
      startedAt: number;
    }
  | {
      phase: 'finalizing';
      percent: 100;
      streamId?: string;
      completedAt: number;
    }
  | {
      phase: 'failed';
      percent: number | null;
      streamId?: string;
      error?: string;
      failedAt: number;
    };

export const IDLE_COMPACTION_STATE: CompactionState = Object.freeze({ phase: 'idle' });

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
  // (b) 长流中断保留：已产出内容的 assistant 消息因连接中断而未自然收尾时，
  // 标记为 interrupted=true。表达层据此显示"已中断"文案；
  // 经既有 replace-messages 开放袋持久化，重启后仍可见。
  // 会话继续后会清掉历史 interrupted，避免旧标记残留。
  interrupted?: boolean;
}

/** 渲染分组：连续正文 / 思考 / 工具调用组。 */
export interface TextGroup { type: 'text'; content: string }
export interface ThinkingGroup { type: 'thinking'; content: string }
export interface ToolCallGroup { type: 'tool-call-group'; calls: ToolCallLegacy[] }
export type SegmentGroup = TextGroup | ThinkingGroup | ToolCallGroup;

/** 表达层展示用的 token 用量累计（输入/输出/缓存写/缓存读）。 */
export interface TokenUsageState {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/**
 * 流式工具参数进度（Codex 式实时体感）：工具调用参数在落地为正式 tool-call 段之前
 * 会先以增量形式抵达，这里描述「正在接收/准备调用」这一过程，仅为过程提示，
 * 不声称工具已执行或文件已落地——真正的结果由后续 tool-call 段与本地能力 Evidence 接管。
 */
export type ToolProgress = { tool: string; path: string | null; receivedLines: number };

/**
 * provider / connection 恢复提示（表达层横幅用）。
 *
 * 原私有定义在 useChatStreamSubscription.ts 内；为支撑「按会话分桶的运行态 store」
 * （conversationStore）需要一个共享的规范类型，下沉到 state/types.ts，与其它表达层
 * 视图模型同级。store 与 hook 都从这里 import，避免重复定义导致的结构漂移。
 */
export interface ProviderRecoveryNotice {
  kind?: 'provider' | 'connection';
  fromProvider?: string;
  toProvider?: string;
  provider?: string;
  model?: string;
  status?: 'retrying' | 'recovered';
  fromConnection?: string;
  toConnection?: string;
  connection?: string;
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  reason?: string;
}
