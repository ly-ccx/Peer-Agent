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

import type {
  AutomationCreateContext,
  ClientToolCall,
  ContextAccountingSnapshot,
} from '@peer-agent/protocol';

import type { ChatMode, EffortLevel } from './preferences';
import { getStreamProfiler } from './streamProfiler.ts';
import { IDLE_COMPACTION_STATE } from './types.ts';
import type {
  ChatMsg,
  CompactionState,
  ProviderRecoveryNotice,
  QueuedMessage,
  TokenUsageState,
  ToolProgress,
} from './types';

/** 单个会话的运行时状态切片：从 ChatSurface 迁出的会话级字段集合。 */
export interface ConversationRuntimeState {
  /** 会话内容加载阶段：判别式状态，把「旧内容配新 id」中间态显式化为 loading。 */
  readonly loadStatus: 'idle' | 'loading' | 'ready';
  /**
   * 切会话时 renderer 会先把 isStreaming 归零，再异步 reattach。
   * unknown = 流状态尚未确认，自动出队必须让路；confirmed = reattach 已收敛。
   */
  readonly streamStatus: 'unknown' | 'confirmed';
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
  /** ADR 56: renderer consumes the provider-backed snapshot verbatim. */
  readonly contextAccounting: ContextAccountingSnapshot | null;
  /** 结构化 Automation 创建提案的会话级事实；执行与确认真值仍在 Main。 */
  readonly automationCreateContext: AutomationCreateContext | null;
  readonly providerRecoveryNotice: ProviderRecoveryNotice | null;
  readonly toolProgress: ToolProgress | null;
  readonly pendingPermissionCalls: readonly ClientToolCall[];
  /** 对话模式（按会话持久化在 meta 上）；初值 chat，由会话加载 effect 覆盖。 */
  readonly mode: ChatMode;
  /** 当前会话/草稿选择的模型 provider；已落库会话由加载 effect 用 meta 校准。 */
  readonly modelProviderId: string | null;
  /** 当前会话/草稿选择的思考强度；已落库会话由加载 effect 用 meta 校准。 */
  readonly effort: EffortLevel;
  /** GPT 订阅本轮请求是否使用 Fast mode；按 renderer 会话桶隔离，不进入 Provider 配置。 */
  readonly fastMode: boolean;
  /** 本轮 wall-clock 起点（供流事件计算 turnDurationMs）；null = 未在跑。 */
  readonly turnStartedAt: number | null;
  /** 当前会话正在进行的流 id（取代旧的组件内 streamIdRef.current）。 */
  readonly streamId: string | null;
}

/** 未知会话返回的稳定空切片单例（冻结，引用恒定，避免订阅死循环）。 */
export const EMPTY_CONVERSATION_STATE: ConversationRuntimeState = Object.freeze({
  loadStatus: 'idle',
  streamStatus: 'confirmed',
  messages: Object.freeze([]) as readonly ChatMsg[],
  draft: '',
  messageQueue: Object.freeze([]) as readonly QueuedMessage[],
  isStreaming: false,
  compactionState: IDLE_COMPACTION_STATE,
  streamError: null,
  tokenUsage: null,
  activeUsage: null,
  contextAccounting: null,
  automationCreateContext: null,
  providerRecoveryNotice: null,
  toolProgress: null,
  pendingPermissionCalls: Object.freeze([]) as readonly ClientToolCall[],
  mode: 'chat',
  modelProviderId: null,
  effort: 'default',
  fastMode: false,
  turnStartedAt: null,
  streamId: null,
});

/**
 * 未落库草稿会话的运行时桶 key。
 * 点「新建任务」后、首条消息发送前：activeConversationId 为 null，
 * 但 Composer 仍需要可写 draft / ready 态；统一映射到此 key，避免污染真实会话桶。
 * 仅存内存，不落盘、不进左侧列表。
 */
export const DRAFT_CONVERSATION_ID = '__draft__';

/** null（UI 草稿态）→ DRAFT 桶；真实 id 原样返回。 */
export function resolveConversationBucketId(
  conversationId: string | null | undefined,
): string {
  if (conversationId === null || conversationId === undefined || conversationId === '') {
    return DRAFT_CONVERSATION_ID;
  }
  return conversationId;
}

const CONVERSATION_STATE_KEYS = Object.keys(
  EMPTY_CONVERSATION_STATE,
) as (keyof ConversationRuntimeState)[];

/**
 * 通知重入补发的最大轮数。
 *
 * 订阅者在通知回调里回写 store 时，补发会一轮接一轮；这个上限保证它不会变成活锁。
 * 达到上限后停止补发并告警（少一次渲染好过卡死渲染进程）。
 */
const MAX_DEFERRED_NOTIFY_ROUNDS = 8;

/**
 * 通知风暴检测阈值（始终生效，无需任何开关）。
 *
 * 「Maximum update depth exceeded」抛错时的那一帧往往落在 store 通知上，但那一帧只是受害者；
 * 真正把 React 嵌套更新推过 50 次上限的源头在别处。同一桶在极短时间里被反复通知时打印
 * 写入方调用栈，用来定位源头，而不是继续静态猜。
 *
 * 之所以不挂在埋点开关后面：定位这个 bug 需要用户复现一次，而要求用户先记得开开关
 * 已经失败过一次（拿回来的日志只有主进程那一半）。这里正常路径的开销只是每次通知一次
 * Date.now() 比较；只有真的判定为风暴时才建栈。
 */
const NOTIFY_STORM_WINDOW_MS = 16;
const NOTIFY_STORM_THRESHOLD = 20;

/**
 * 会话状态「是否发生实质变化」的判定。
 *
 * 只比较引用不够：很多写法会重建一个内容相同的数组，例如
 * `setPendingPermissionCalls([])`、`segments: []`、`messageQueue: [...queue]`。
 * 纯引用比较会把它们判成「变了」→ 通知订阅者 → 触发重渲染；一旦这种写入位于依赖
 * 不稳定的 effect 里，就会演变成无限更新（React 抛 Maximum update depth exceeded）。
 *
 * 因此对数组做浅比较（长度 + 逐元素引用）：内容相同的新数组不再产生通知。
 * 只比一层是安全的——本 store 的写入都是不可变更新（被改动的元素会换成新对象引用，
 * 例如 appendThinking 会构造新的末尾消息对象），语义变化不会漏判。
 */
function isConversationValueEqual(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return false;
    }
    return true;
  }
  return false;
}

/** 高频工具参数进度由局部提示订阅，不应唤醒整棵 ChatSurface。 */
export function areConversationStatesEqualForSurface(
  previous: ConversationRuntimeState,
  next: ConversationRuntimeState,
): boolean {
  if (previous === next) return true;
  return CONVERSATION_STATE_KEYS.every((key) =>
    key === 'draft'
    || key === 'toolProgress'
    || Object.is(previous[key], next[key]),
  );
}

/**
 * 缓存供 ChatSurface 使用的快照引用。仅 draft / toolProgress 变化时继续返回上一引用，
 * 满足 useSyncExternalStore 的稳定快照要求；两者由输入区和活动工具提示各自叶子订阅，
 * 其他任意字段变化都会立即透出新快照。
 */
export function createConversationSurfaceSnapshotReader(
  readSnapshot: () => ConversationRuntimeState,
): () => ConversationRuntimeState {
  let current = readSnapshot();
  return () => {
    const next = readSnapshot();
    if (!areConversationStatesEqualForSurface(current, next)) current = next;
    return current;
  };
}

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
  /** 是否正处于「通知订阅者」的过程中（用于识别通知重入）。 */
  private notifying = false;
  /** 通知重入时被推迟补发的桶。 */
  private readonly deferredNotifyBuckets = new Set<string>();
  private deferredNotifyScheduled = false;
  /** 本轮补发次数与超限告警标记（见 scheduleDeferredNotify）。 */
  private deferredNotifyRounds = 0;
  private deferredNotifyOverflowWarned = false;
  /** 通知风暴检测状态（见 trackNotifyStorm）。 */
  private notifyStormWindowStartMs = 0;
  private notifyStormCount = 0;
  private notifyStormReported = false;

  /** 判断某会话/草稿桶是否已经建立；用于只在首次进入时播种界面默认值。 */
  hasBucket(conversationId: string | null): boolean {
    return this.buckets.has(resolveConversationBucketId(conversationId));
  }

  /** 读取某会话的当前快照；未知会话返回稳定的 EMPTY 单例。 */
  getSnapshot(conversationId: string | null): ConversationRuntimeState {
    const bucketId = resolveConversationBucketId(conversationId);
    return this.buckets.get(bucketId) ?? EMPTY_CONVERSATION_STATE;
  }

  /** 订阅某会话的快照变化；返回取消订阅函数。 */
  subscribe(conversationId: string | null, listener: Listener): () => void {
    const bucketId = resolveConversationBucketId(conversationId);
    let set = this.listeners.get(bucketId);
    if (!set) {
      set = new Set();
      this.listeners.set(bucketId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(bucketId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(bucketId);
    };
  }

  /**
   * Subscribe to one derived field instead of every write to the conversation bucket.
   * This keeps sidebar projections out of the hot token/message update path.
   */
  subscribeSelector<Value>(
    conversationId: string | null,
    selector: (state: ConversationRuntimeState) => Value,
    listener: Listener,
    isEqual: (previous: Value, next: Value) => boolean = Object.is,
  ): () => void {
    let previous = selector(this.getSnapshot(conversationId));
    return this.subscribe(conversationId, () => {
      const next = selector(this.getSnapshot(conversationId));
      if (isEqual(previous, next)) return;
      previous = next;
      listener();
    });
  }

  /**
   * 以不可变方式更新某会话切片：基于上一快照（缺省取 EMPTY）应用 patch，
   * 仅当产生实际变化时写回新引用并通知该桶订阅者。
   */
  setState(conversationId: string | null, patch: Patch): void {
    const bucketId = resolveConversationBucketId(conversationId);
    const prev = this.buckets.get(bucketId) ?? EMPTY_CONVERSATION_STATE;
    const delta = typeof patch === 'function' ? patch(prev) : patch;
    if (!delta) return;
    let changed = false;
    for (const key of Object.keys(delta) as (keyof ConversationRuntimeState)[]) {
      if (!isConversationValueEqual(prev[key], (delta as ConversationRuntimeState)[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next: ConversationRuntimeState = { ...prev, ...delta };
    this.buckets.set(bucketId, next);
    // 观测：每次真正写入都会同步通知订阅者（useSyncExternalStore → React 重渲染）。
    // 流式期间这个频率直接决定界面卡不卡，所以单独计时。
    const profiler = getStreamProfiler();
    profiler.bump('write.store');
    profiler.measure('write.store.notify', () => this.notify(bucketId));
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

  /** 更新当前会话待发送队列中指定消息的文案（原地编辑）。 */
  updateQueuedMessage(conversationId: string | null, id: string, text: string): void {
    this.setState(conversationId, (prev) => {
      const index = prev.messageQueue.findIndex((item) => item.id === id);
      if (index < 0) return prev;
      const current = prev.messageQueue[index];
      if (current.text === text) return prev;
      const next = prev.messageQueue.slice();
      next[index] = { ...current, text };
      return { messageQueue: next };
    });
  }

  /** 拖动排序：把 fromIndex 处的消息移动到 toIndex。 */
  reorderQueuedMessage(conversationId: string | null, fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    this.setState(conversationId, (prev) => {
      const queue = prev.messageQueue;
      if (
        fromIndex < 0
        || toIndex < 0
        || fromIndex >= queue.length
        || toIndex >= queue.length
      ) {
        return prev;
      }
      const next = queue.slice();
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return { messageQueue: next };
    });
  }

  /**
   * 插队：把指定排队消息提到队首。
   * 已在队首 / 找不到 id 时为 no-op。配合 ChatSurface 的 abort + 自动出队实现「强送」。
   */
  promoteQueuedMessageToFront(conversationId: string | null, id: string): void {
    this.setState(conversationId, (prev) => {
      const queue = prev.messageQueue;
      const index = queue.findIndex((item) => item.id === id);
      if (index <= 0) return prev;
      const next = queue.slice();
      const [item] = next.splice(index, 1);
      next.unshift(item);
      return { messageQueue: next };
    });
  }

  /** 当前会话待发送队列出队一条消息；队列为空时返回 null。 */
  shiftQueuedMessage(conversationId: string | null): QueuedMessage | null {
    const prev = this.getSnapshot(conversationId);
    const [head, ...rest] = prev.messageQueue;
    if (!head) return null;
    this.setState(conversationId, { messageQueue: rest });
    return head;
  }

  /** 进入加载阶段：归零内容并标记 loading（切会话时调用，消灭脏中间态）。 */
  beginLoad(conversationId: string | null): void {
    this.setState(conversationId, {
      loadStatus: 'loading',
      streamStatus: 'unknown',
      messages: Object.freeze([]) as readonly ChatMsg[],
      isStreaming: false,
      compactionState: IDLE_COMPACTION_STATE,
      streamError: null,
      toolProgress: null,
      pendingPermissionCalls: Object.freeze([]) as readonly ClientToolCall[],
      providerRecoveryNotice: null,
      turnStartedAt: null,
      streamId: null,
    });
  }

  /**
   * 静默刷新入口：保留可见消息和 composer 态，只把流状态标成尚未确认。
   * 切回已 ready 会话时不能 beginLoad 清空，但自动出队仍必须等 reattach 收敛。
   */
  beginStreamReattach(conversationId: string | null): void {
    this.setState(conversationId, {
      streamStatus: 'unknown',
      isStreaming: false,
      compactionState: IDLE_COMPACTION_STATE,
      toolProgress: null,
      pendingPermissionCalls: Object.freeze([]) as readonly ClientToolCall[],
      providerRecoveryNotice: null,
      turnStartedAt: null,
      streamId: null,
    });
  }

  /** 加载完成：写入消息并标记 ready。 */
  commitLoad(
    conversationId: string | null,
    patch: Partial<ConversationRuntimeState>,
  ): void {
    this.setState(conversationId, { streamStatus: 'confirmed', ...patch, loadStatus: 'ready' });
  }

  /**
   * 把草稿桶的草稿、消息、流状态迁移到真实会话桶。
   * 用于选区子会话首次发送：打开时只准备草稿，发送时创建持久会话后接续。
   */
  adoptBucket(fromConversationId: string | null, toConversationId: string): void {
    const fromKey = resolveConversationBucketId(fromConversationId);
    const toKey = resolveConversationBucketId(toConversationId);
    if (fromKey === toKey) return;
    const source = this.buckets.get(fromKey);
    if (!source) return;
    this.buckets.set(toKey, { ...source, loadStatus: 'ready' });
    this.buckets.delete(fromKey);
    this.notify(fromKey);
    this.notify(toKey);
  }

  /** 丢弃某会话桶（会话删除时清理内存）。 */
  reset(conversationId: string | null): void {
    const bucketId = resolveConversationBucketId(conversationId);
    if (this.buckets.delete(bucketId)) this.notify(bucketId);
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

  /**
   * 解析带会话身份的事件。显式 conversationId 是跨进程事件的权威归属，
   * 同时补登记 stream 路由；仅为兼容旧事件才回退到 renderer 本地映射。
   */
  resolveEventConversation(streamId: string, conversationId?: string | null): string | null {
    if (conversationId) {
      this.routeStream(streamId, conversationId);
      return conversationId;
    }
    return this.resolveConversation(streamId);
  }

  /** 终结事件（done/aborted/error）后清理路由表项，避免泄漏。 */
  clearStream(streamId: string): void {
    if (!streamId) return;
    this.streamRoutes.delete(streamId);
  }

  /**
   * 用 main 进程的权威活跃流快照收口 renderer 遗留运行态。
   * 只清理当前 streamId 已不在权威集合里的会话，避免误结束其它仍在运行的会话。
   */
  settleInactiveStreams(activeStreamIds: Iterable<string>): readonly string[] {
    const active = new Set(Array.from(activeStreamIds, (streamId) => String(streamId)));
    const settled: string[] = [];
    for (const [conversationId, state] of this.buckets) {
      const streamId = state.streamId;
      if (!state.isStreaming || !streamId || active.has(streamId)) continue;
      this.setState(conversationId, {
        isStreaming: false,
        activeUsage: null,
        pendingPermissionCalls: [],
        toolProgress: null,
        providerRecoveryNotice: null,
        turnStartedAt: null,
        streamId: null,
      });
      this.clearStream(streamId);
      settled.push(conversationId);
    }
    return settled;
  }

  /**
   * 通知某桶的订阅者。
   *
   * 重入保护：监听器回调里可能再次写入同一个 store（例如订阅了某个字段的组件在回调里
   * 又写另一个字段）。此时若直接递归通知，就会在同一次 JS 调用栈里连续触发 React 的
   * 更新；累计超过 React 的嵌套更新上限（50）后即抛
   * `Maximum update depth exceeded`（本项目实际报过的错误）。
   *
   * 因此：嵌套写入不递归通知，改为合并成一次微任务补发——通知不丢、按桶保序，
   * 但不再嵌进 React 的渲染/提交阶段。正常路径（无重入）仍然完全同步，行为不变。
   */
  private notify(conversationId: string): void {
    this.trackNotifyStorm(conversationId);
    if (this.notifying) {
      this.deferredNotifyBuckets.add(conversationId);
      this.scheduleDeferredNotify();
      return;
    }
    // 一次全新的外层写入：重置补发预算，下一次重入又有完整的补发额度。
    this.deferredNotifyRounds = 0;
    this.deferredNotifyOverflowWarned = false;
    this.notifying = true;
    try {
      this.notifyBucketNow(conversationId);
    } finally {
      this.notifying = false;
    }
  }

  private notifyBucketNow(conversationId: string): void {
    const set = this.listeners.get(conversationId);
    if (!set) return;
    for (const listener of set) listener();
  }

  /**
   * 通知风暴检测：同一桶在极短时间窗口内被反复通知时，打印一次写入方调用栈。
   *
   * 为什么需要它：报错堆栈里出现 store 通知，只说明「第 50 次嵌套更新发生在这里」，
   * 不代表循环源在这里。把源头定位权交还给一次真机复现，比继续静态猜测更可靠。
   *
   * 始终开启：正常路径每次通知只多一次 Date.now() 比较，只有判定成立才建栈。
   */
  private trackNotifyStorm(conversationId: string): void {
    const now = Date.now();
    if (now - this.notifyStormWindowStartMs > NOTIFY_STORM_WINDOW_MS) {
      this.notifyStormWindowStartMs = now;
      this.notifyStormCount = 0;
      this.notifyStormReported = false;
    }
    this.notifyStormCount += 1;
    if (this.notifyStormCount < NOTIFY_STORM_THRESHOLD || this.notifyStormReported) return;
    this.notifyStormReported = true;
    console.warn(
      `[conversationStore] ${NOTIFY_STORM_WINDOW_MS}ms 内桶 ${conversationId} 被通知 ` +
        `${this.notifyStormCount} 次，疑似更新循环。写入方调用栈：\n${new Error('notify storm').stack}`,
    );
  }

  private scheduleDeferredNotify(): void {
    if (this.deferredNotifyScheduled) return;
    // 防御活锁：订阅者若「每次收到通知都回写 store」，补发会一轮接一轮。到达上限后
    // 停止补发并告警——宁可少一次渲染，也不能让渲染进程卡死。
    if (this.deferredNotifyRounds >= MAX_DEFERRED_NOTIFY_ROUNDS) {
      if (!this.deferredNotifyOverflowWarned) {
        this.deferredNotifyOverflowWarned = true;
        console.warn(
          '[conversationStore] 通知重入超过上限，已停止补发；请检查订阅者是否在通知回调里回写 store',
        );
      }
      return;
    }
    this.deferredNotifyRounds += 1;
    this.deferredNotifyScheduled = true;
    queueMicrotask(() => {
      this.deferredNotifyScheduled = false;
      if (this.deferredNotifyBuckets.size === 0) return;
      const buckets = Array.from(this.deferredNotifyBuckets);
      this.deferredNotifyBuckets.clear();
      this.notifying = true;
      try {
        for (const bucket of buckets) this.notifyBucketNow(bucket);
      } finally {
        this.notifying = false;
      }
    });
  }
}

/** 全应用共享的单例 store。 */
export const conversationStore = new ConversationStore();
