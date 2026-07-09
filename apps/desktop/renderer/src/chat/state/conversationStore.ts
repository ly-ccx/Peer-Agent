// 按 conversationId 分桶的会话运行时状态 store（renderer 侧外部状态）。
//
// 根因背景（为什么需要它）：
//   ChatSurface 过去把会话运行时状态（messages / isStreaming / tokenUsage / 压缩 /
//   工具进度 / 权限 / 恢复提示 / streamId …）摊在组件内的十几个 useState 里，而会话
//   身份（conversationId）是另一份独立状态。两份状态没有原子绑定，任何「切会话」都
//   退化为「先改 id、再用一串 setState 异步追平内容」，于是架构上必然存在「id 已是新、
//   内容还是旧」的中间态——这正是「新会话/切换会话串入其它会话内容」的根因。
//
//   本 store 把会话运行态全部移出组件，以 conversationId 为 key 分桶持有。组件按
//   conversationId 订阅自己的切片，切会话 = 换订阅 key；物理上不存在被复用的共享
//   messages 槽位，跨会话串内容在架构层不可能再发生。
//
// 设计要点：
//   - vanilla store + React 18 useSyncExternalStore，零新依赖，契合本仓库少依赖风格。
//   - 不可变快照：每次写产生新的桶对象引用，未变动的会话桶引用保持不变 → 其订阅者不
//     重渲染。getSnapshot 对未知会话返回同一冻结的 EMPTY 单例，避免 useSyncExternalStore
//     因「每次返回新对象」而误判变化进入死循环。
//   - streamId → conversationId 路由 registry：流事件 payload 只带 streamId、不带
//     conversationId（见 useChatStreamSubscription）。但 renderer 在 streamId 诞生的每个
//     点（发送 / 压缩 / reattach）都同时握有 conversationId，于是在那三处登记映射，事件
//     抵达时用 streamId 反查目标桶。无需改动跨进程协议。
//   - 发送/账本真值仍在主进程：本 store 只持有 renderer 表达层的运行态投影，不引入新的
//     执行真值。

import type { ClientToolCall } from '@peer-agent/protocol';

import type { ChatMode } from './preferences';
import { IDLE_COMPACTION_STATE } from './types';
import type {
  ChatMsg,
  CompactionState,
  ProviderRecoveryNotice,
  QueuedMessage,
  TokenUsageState,
  ToolProgress,
} from './types';

/** 主进程随回合结束下发的权威上下文用量快照（与压缩触发同口径）。 */
export interface AuthoritativeContext {
  contextTokens: number;
  contextWindow: number | null;
}

/** 单个会话的运行时状态切片：从 ChatSurface 迁出的会话级字段集合。 */
export interface ConversationRuntimeState {
  /** 会话内容加载阶段：判别式状态，把「旧内容配新 id」中间态显式化为 loading。 */
  readonly loadStatus: 'idle' | 'loading' | 'ready';
  readonly messages: readonly ChatMsg[];
  /** 当前会话输入草稿。随会话桶存放，避免切会话时复用上一会话输入态。 */
  readonly draft: string;
  /** 当前会话待发送消息队列。随会话桶存放，避免队列在不同会话间串发。 */
  readonly messageQueue: readonly QueuedMessage[];
  readonly isStreaming: boolean;
  readonly compactionState: CompactionState;
  readonly streamError: string | null;
  readonly tokenUsage: TokenUsageState | null;
  readonly activeUsage: TokenUsageState | null;
  readonly authoritativeContext: AuthoritativeContext | null;
  readonly providerRecoveryNotice: ProviderRecoveryNotice | null;
  readonly toolProgress: ToolProgress | null;
  readonly pendingPermissionCalls: readonly ClientToolCall[];
  /** 对话模式（按会话持久化在 meta 上）；初值 chat，由会话加载 effect 覆盖。 */
  readonly mode: ChatMode;
  /** 本轮 wall-clock 起点（供流事件计算 turnDurationMs）；null = 未在跑。 */
  readonly turnStartedAt: number | null;
  /** 当前会话正在进行的流 id（取代旧的组件内 streamIdRef.current）。 */
  readonly streamId: string | null;
  /** 自动压缩闸门（取代旧的 autoCompactingRef），防止重复触发自动压缩。 */
  readonly autoCompacting: boolean;
}

/** 未知会话返回的稳定空切片单例（冻结，引用恒定，避免订阅死循环）。 */
export const EMPTY_CONVERSATION_STATE: ConversationRuntimeState = Object.freeze({
  loadStatus: 'idle',
  messages: Object.freeze([]) as readonly ChatMsg[],
  draft: '',
  messageQueue: Object.freeze([]) as readonly QueuedMessage[],
  isStreaming: false,
  compactionState: IDLE_COMPACTION_STATE,
  streamError: null,
  tokenUsage: null,
  activeUsage: null,
  authoritativeContext: null,
  providerRecoveryNotice: null,
  toolProgress: null,
  pendingPermissionCalls: Object.freeze([]) as readonly ClientToolCall[],
  mode: 'chat',
  turnStartedAt: null,
  streamId: null,
  autoCompacting: false,
});

type Listener = () => void;
type Patch =
  | Partial<ConversationRuntimeState>
  | ((prev: ConversationRuntimeState) => Partial<ConversationRuntimeState>);

/**
 * 会话运行态 store。单例（见文件末尾 conversationStore 导出），全应用共享。
 * 订阅按 conversationId 分桶：某会话桶变化只通知该会话的订阅者。
 */
export class ConversationStore {
  /** conversationId → 该会话当前的不可变运行态快照。 */
  private readonly buckets = new Map<string, ConversationRuntimeState>();
  /** conversationId → 该会话的订阅者集合。 */
  private readonly listeners = new Map<string, Set<Listener>>();
  /** streamId → conversationId 路由表（发送/压缩/reattach 时登记）。 */
  private readonly streamRoutes = new Map<string, string>();

  /** 读取某会话的当前快照；未知会话返回稳定的 EMPTY 单例。 */
  getSnapshot(conversationId: string | null): ConversationRuntimeState {
    if (!conversationId) return EMPTY_CONVERSATION_STATE;
    return this.buckets.get(conversationId) ?? EMPTY_CONVERSATION_STATE;
  }

  /** 订阅某会话的快照变化；返回取消订阅函数。 */
  subscribe(conversationId: string | null, listener: Listener): () => void {
    if (!conversationId) return () => {};
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(conversationId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(conversationId);
    };
  }

  /**
   * 以不可变方式更新某会话切片：基于上一快照（缺省取 EMPTY）应用 patch，
   * 仅当产生实际变化时写回新引用并通知该桶订阅者。
   */
  setState(conversationId: string | null, patch: Patch): void {
    if (!conversationId) return;
    const prev = this.buckets.get(conversationId) ?? EMPTY_CONVERSATION_STATE;
    const delta = typeof patch === 'function' ? patch(prev) : patch;
    if (!delta) return;
    let changed = false;
    for (const key of Object.keys(delta) as (keyof ConversationRuntimeState)[]) {
      if (!Object.is(prev[key], (delta as ConversationRuntimeState)[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next: ConversationRuntimeState = { ...prev, ...delta };
    this.buckets.set(conversationId, next);
    this.notify(conversationId);
  }

  /** 设置当前会话输入草稿。 */
  setDraft(conversationId: string | null, draft: string): void {
    this.setState(conversationId, { draft });
  }

  /** 在当前会话待发送队列末尾追加一条用户消息。 */
  enqueueMessage(conversationId: string | null, item: QueuedMessage): void {
    this.setState(conversationId, (prev) => ({ messageQueue: [...prev.messageQueue, item] }));
  }

  /** 从当前会话待发送队列中移除指定消息。 */
  removeQueuedMessage(conversationId: string | null, id: string): void {
    this.setState(conversationId, (prev) => ({
      messageQueue: prev.messageQueue.filter((item) => item.id !== id),
    }));
  }

  /** 当前会话待发送队列出队一条消息；队列为空时返回 null。 */
  shiftQueuedMessage(conversationId: string | null): QueuedMessage | null {
    if (!conversationId) return null;
    const prev = this.buckets.get(conversationId) ?? EMPTY_CONVERSATION_STATE;
    const [head, ...rest] = prev.messageQueue;
    if (!head) return null;
    this.setState(conversationId, { messageQueue: rest });
    return head;
  }

  /** 进入加载阶段：归零内容并标记 loading（切会话时调用，消灭脏中间态）。 */
  beginLoad(conversationId: string | null): void {
    if (!conversationId) return;
    this.setState(conversationId, {
      loadStatus: 'loading',
      messages: Object.freeze([]) as readonly ChatMsg[],
      isStreaming: false,
      compactionState: IDLE_COMPACTION_STATE,
      streamError: null,
      toolProgress: null,
      pendingPermissionCalls: Object.freeze([]) as readonly ClientToolCall[],
      providerRecoveryNotice: null,
      turnStartedAt: null,
      streamId: null,
      autoCompacting: false,
    });
  }

  /** 加载完成：写入消息并标记 ready。 */
  commitLoad(
    conversationId: string | null,
    patch: Partial<ConversationRuntimeState>,
  ): void {
    if (!conversationId) return;
    this.setState(conversationId, { ...patch, loadStatus: 'ready' });
  }

  /** 丢弃某会话桶（会话删除时清理内存）。 */
  reset(conversationId: string | null): void {
    if (!conversationId) return;
    if (this.buckets.delete(conversationId)) this.notify(conversationId);
  }

  // —— streamId → conversationId 路由 ——

  /** 登记 streamId 归属的会话（发送 / 压缩 / reattach 时调用）。 */
  routeStream(streamId: string, conversationId: string): void {
    if (!streamId || !conversationId) return;
    this.streamRoutes.set(streamId, conversationId);
  }

  /** 反查某流事件应落到哪个会话桶；未登记返回 null（事件被安全忽略）。 */
  resolveConversation(streamId: string): string | null {
    if (!streamId) return null;
    return this.streamRoutes.get(streamId) ?? null;
  }

  /** 终结事件（done/aborted/error）后清理路由表项，避免泄漏。 */
  clearStream(streamId: string): void {
    if (!streamId) return;
    this.streamRoutes.delete(streamId);
  }

  private notify(conversationId: string): void {
    const set = this.listeners.get(conversationId);
    if (!set) return;
    for (const listener of set) listener();
  }
}

/** 全应用共享的单例 store。 */
export const conversationStore = new ConversationStore();
