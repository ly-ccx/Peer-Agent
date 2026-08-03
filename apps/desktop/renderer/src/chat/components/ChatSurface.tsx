import type { I18nRuntime } from '@peer-agent/i18n';
import { createUnknownContextAccountingSnapshot } from '@peer-agent/runtime-core';
import type {
  ClientToolCall,
  ConfigInstructionContextItem,
  ContextAccountingSnapshot,
  ContextAttachmentItem,
  ContinuityContextItem,
  LlmProviderConfigView,
} from '@peer-agent/protocol';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import type { DropdownOption } from '../../app/components/Dropdown';
import { clientApi } from '../../clientApi';
import { formatHistoricalLocalRecordForApi, sanitizeAssistantHistoryTextForApi } from '../state/historicalLocalRecord';
import {
  normalizeEffortLevels,
  hasTunableEffortLevels,
  resolveModelSwitchState,
  resolvePreferredEffort,
  ACCESS_LEVELS,
  CHAT_MODES,
  accessLevelLabel,
  accessLevelTitle,
  isEffortLevel,
  isLocalAccessLevel,
  isChatMode,
  modeLabel,
  modePickerValue,
  modeTitle,
  normalizeChatMode,
  resolveDraftModelProviderId,
  resolveProviderById,
  writeLastModelProviderId,
  type EffortLevel,
  type ChatMode,
} from '../state/preferences';
import { useConversationModelEffort } from '../hooks/useConversationModelEffort';
import { useLocalAccessPreference } from '../hooks/useLocalAccessPreference';
import { useConversationMode } from '../hooks/useConversationMode';
import { loadComposerEntry, resolveComposerHydration } from '../state/composerPersistence';
import {
  canAutoDispatchQueuedMessage,
  dispatchQueuedMessage,
} from '../state/messageQueueDispatch';
import {
  contextAccountingRestoreKey,
  shouldStartContextAccountingRestore,
} from '../state/contextRestore';
import { getProviderModelDisplayLabel } from '../state/providerDisplay';
import {
  buildMessageRailItemsIncremental,
  type MessageRailItemCache,
} from '../state/messageRailItems';
import { intakeAttachments } from '../state/attachmentIntake';
import {
  normalizeStreamSegment,
  segmentsSignature,
  mergeReattachedSegments,
  contentFromSegments,
  isEmptyAssistantPlaceholder,
  isEmptyUserMessage,
  groupSegments,
  getTextContent,
  migrateToSegments,
  findNextSerializedToolCall,
  parseSerializedToolSegments,
} from '../state/streamSegments';
import {
  buildConversationAttachmentContext,
  buildConfigInstructionContext,
  buildReplyLanguageContext,
  buildGitBranchPrefixContext,
} from '../state/contextSources';
import {
  compactionProgressPercent as getCompactionProgressPercent,
  compactionStateLabel,
} from '../state/compactionStateView';
import { IDLE_COMPACTION_STATE } from '../state/types';
import type {
  ChatAttachment,
  ContentSegment,
  ToolCallLegacy,
  CompactionMeta,
  CompactionState,
  ChatMsg,
  QueuedMessage,
  TextGroup,
  ThinkingGroup,
  ToolCallGroup,
  SegmentGroup,
} from '../state/types';
import { MarkdownMessage } from './markdown/MarkdownMessage';
import { WorkspacePathContext } from './markdown/InlineMarkdown';
import { ImagePreviewOverlay } from './thread/AttachmentStrip';
import { ComposerDraftControls } from './ComposerDraftControls';
import {
  buildSessionReferenceAttachment,
  type SessionReferenceHit,
} from '../state/sessionReference';
import { ComposerTokenUsageDisplay } from './ComposerTokenUsageDisplay';
import { InteractionActionsContext, InteractionStreamingContext } from './thread/interactionContext';
import { ChatFindBar } from './thread/ChatFindBar';
import { ChatHeader } from './thread/ChatHeader';
import {
  VirtualChatTurnList,
  type VirtualChatTurnListHandle,
} from './thread/VirtualChatTurnList';
import { GoalPlanPanel } from './GoalPlanPanel';
import { ChatGoalApprovalCard } from './goal/ChatGoalApprovalCard';
import { MessageQueue } from './MessageQueue';
import { PermissionGateStrip } from './thread/PermissionGateStrip';
import { MessageActionBar, type MessageActionId } from './thread/MessageActionBar';
import {
  clearInterruptedMarkers,
  historyBeforeEditedUserMessage,
  serializeConversationMessages,
} from '../state/editHistory';
import { MessageRail } from './thread/MessageRail';
import { useConversationState } from '../hooks/useConversationState';
import { beginConversationCompaction } from '../state/automaticCompaction';
import {
  conversationStore,
  type ConversationRuntimeState,
} from '../state/conversationStore';
import { createFrameCoalescer } from '../state/frameCoalescer';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
import { useStreamingReport } from '../hooks/useStreamingReport';
import { useConversationStreamRouter } from '../hooks/useConversationStreamRouter';
import {
  planThreadScrollAfterMessagesChange,
  resolveThreadFollowAfterScroll,
} from '../state/threadScrollPolicy';
import {
  shouldShowConversationEmptyHome,
  shouldShowConversationLoadingPlaceholder,
} from '../state/conversationEmptyStatePolicy';
import { shouldHardBeginConversationLoad } from '../state/conversationLoadGate';
import {
  getTurnUserMessage,
  groupMessagesIntoTurnsIncremental,
  shouldVirtualizeChatTurns,
  type ChatTurnGroupCache,
} from '../state/chatTurns';
import { useWorkbench } from '../../workbench/WorkbenchContext';

const SCROLL_BOTTOM_THRESHOLD_PX = 64;
const CURRENT_TURN_CONTEXT_PROBE_PX = 96;
const EMPTY_EFFORT_LEVELS: readonly EffortLevel[] = [];

function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

function summarizeUserMessageForContext(msg: ChatMsg, isZh: boolean): string {
  const text = msg.content.trim().replace(/\s+/g, ' ');
  if (text) return text;

  const attachmentCount = msg.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    return isZh
      ? `${attachmentCount} 个附件`
      : `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`;
  }

  return isZh ? '（空消息）' : '(empty message)';
}

function findCurrentTurnIdForScroll(container: HTMLDivElement): string | null {
  const probeY = container.getBoundingClientRect().top + CURRENT_TURN_CONTEXT_PROBE_PX;
  const turnElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-turn-id]'));
  let candidate: HTMLElement | null = null;

  for (const turnElement of turnElements) {
    const rect = turnElement.getBoundingClientRect();
    if (rect.top <= probeY && rect.bottom > probeY) {
      candidate = turnElement;
      break;
    }
    if (rect.top <= probeY) {
      candidate = turnElement;
    }
  }

  const turnId = candidate?.dataset.chatTurnId ?? null;
  if (!turnId) return null;

  const userMessage = candidate?.querySelector<HTMLElement>('.chat-msg-user');
  if (userMessage && userMessage.getBoundingClientRect().bottom > probeY) return null;

  return turnId;
}

interface TokenUsageState {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

interface ThreadScrollSnapshot {
  top: number;
  atBottom: boolean;
  turnId: string | null;
  turnOffset: number;
}

let msgSeq = 0;
function nextId() { return `msg-${++msgSeq}-${Date.now()}`; }



function usageFromLifetime(lifetime: {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  return {
    input: lifetime.inputTokens ?? 0,
    output: lifetime.outputTokens ?? 0,
    cacheWrite: lifetime.cacheWriteTokens ?? 0,
    cacheRead: lifetime.cacheReadTokens ?? 0,
  };
}

async function loadConversationMessages(conversationId: string): Promise<{
  messages: ChatMsg[];
  tokenUsage: { input: number; output: number; cacheWrite: number; cacheRead: number } | null;
  mode: ChatMode;
  effort: EffortLevel;
  modelProviderId: string | null;
  contextAccounting: ContextAccountingSnapshot | null;
}> {
  const conv = await clientApi.conversationsGet({ id: conversationId });
  if (!conv?.messages) return {
    messages: [],
    tokenUsage: null,
    mode: 'chat',
    effort: 'default',
    modelProviderId: null,
    contextAccounting: null,
  };
  // 对话模式按会话持久化在会话 meta 上;老会话无该字段时回退 'chat'，历史 'goal' 归一化为 'plan'。
  const convMode: ChatMode = normalizeChatMode(conv.mode);
  // 思考强度 + 模型 provider 也按会话持久化在会话 meta 上（与 mode 同口径，每会话独立）。
  // 老会话无字段时：effort 回退 'default'，modelProviderId 回退 null（用全局默认 provider）。
  const convEffort: EffortLevel = isEffortLevel(conv.effort) ? conv.effort : 'default';
  const convModelProviderId: string | null =
    typeof conv.modelProviderId === 'string' && conv.modelProviderId ? conv.modelProviderId : null;
  const contextAccounting: ContextAccountingSnapshot | null =
    conv.contextSnapshot?.version === 1 ? conv.contextSnapshot : null;
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const loaded = conv.messages.map((m: Record<string, unknown>) => {
    const msg: ChatMsg = {
      id: (m.id as string) || nextId(),
      role: (m.role as ChatMsg['role']) || 'user',
      content: (m.content as string) || '',
      timestamp: m.timestamp as number | undefined,
    };
    if (m.segments) {
      msg.segments = m.segments as ContentSegment[];
    } else if (Array.isArray(m.toolCalls) && (m.toolCalls as unknown[]).length) {
      msg.segments = migrateToSegments(msg.content, m.toolCalls as ToolCallLegacy[]);
    } else if (msg.role === 'assistant') {
      msg.segments = parseSerializedToolSegments(msg.content);
    }
    if (m.usage && typeof m.usage === 'object') {
      const u = m.usage as { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
      msg.usage = { input: u.input ?? 0, output: u.output ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheRead: u.cacheRead ?? 0 };
      totalInput += msg.usage.input;
      totalOutput += msg.usage.output;
      totalCacheWrite += msg.usage.cacheWrite ?? 0;
      totalCacheRead += msg.usage.cacheRead ?? 0;
    }
    if (m._compaction && typeof m._compaction === 'object') {
      const c = m._compaction as unknown as CompactionMeta;
      msg.compaction = c;
    }
    if (Array.isArray(m.attachments)) {
      msg.attachments = m.attachments as ChatAttachment[];
    }
    // ADR 33: 每条消息的整轮工作时长留痕,随消息持久化,重启后仍可见。
    if (typeof m.durationMs === 'number' && Number.isFinite(m.durationMs)) {
      msg.durationMs = m.durationMs;
    }
    // (b) 长流中断保留：连接中断未自然收尾的 assistant 消息标记，重启后仍可见。
    if (m.interrupted === true) {
      msg.interrupted = true;
    }
    return msg;
  }).filter((message) => !isEmptyAssistantPlaceholder(message) && !isEmptyUserMessage(message));
  // ADR 23: 计费优先读 index meta 的权威累计 lifetimeUsage(不受压缩影响)。
  // 仅当老会话尚无该字段时,才回退到遍历消息累加(此路径会被压缩低估,属兼容降级)。
  const lifetime = conv.lifetimeUsage as
    | { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number }
    | undefined;
  if (
    lifetime &&
    ((lifetime.inputTokens ?? 0) > 0 ||
      (lifetime.outputTokens ?? 0) > 0 ||
      (lifetime.cacheWriteTokens ?? 0) > 0 ||
      (lifetime.cacheReadTokens ?? 0) > 0)
  ) {
    return {
      messages: loaded,
      tokenUsage: usageFromLifetime(lifetime),
      mode: convMode,
      effort: convEffort,
      modelProviderId: convModelProviderId,
      contextAccounting,
    };
  }
  return {
    messages: loaded,
    tokenUsage: totalInput > 0 || totalOutput > 0 || totalCacheWrite > 0 || totalCacheRead > 0
      ? { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead }
      : null,
    mode: convMode,
    effort: convEffort,
    modelProviderId: convModelProviderId,
    contextAccounting,
  };
}

export function ChatSurface({
  i18n,
  providers,
  conversationId,
  conversationRevision,
  conversationTitle,
  systemInstructions,
  replyLanguage,
  gitBranchPrefix,
  resumeTask,
  onResumeConsumed,
  onOpenSettings,
  onConversationUpdated,
  onStreamingChange,
  onBranch,
  onEnsureConversation,
  onRenameConversation,
  onArchiveConversation,
  workspacePath,
  isPageActive,
  messageTarget,
}: {
  readonly i18n: I18nRuntime;
  readonly providers: readonly LlmProviderConfigView[];
  readonly conversationId: string | null;
  readonly conversationRevision?: string | null;
  readonly conversationTitle?: string;
  readonly systemInstructions?: string;
  readonly replyLanguage?: string;
  readonly gitBranchPrefix?: string;
  readonly resumeTask?: { sessionId: string; task: string; effort?: string } | null;
  readonly onResumeConsumed?: () => void;
  readonly onOpenSettings: () => void;
  readonly onConversationUpdated?: () => void;
  // 把当前会话的流式运行状态上报给上层(App),供左侧列表显示 Loading 图标。
  readonly onStreamingChange?: (conversationId: string | null, isStreaming: boolean) => void;
  readonly onBranch?: (newConversationId: string) => void;
  // 草稿态发首条消息时创建会话（落库并进入左侧列表）。
  readonly onEnsureConversation?: (seed?: {
    title?: string;
    mode?: string;
    effort?: string;
    modelProviderId?: string | null;
  }) => Promise<{ id: string }>;
  readonly onRenameConversation?: (id: string, title: string) => void;
  readonly onArchiveConversation?: (id: string) => void;
  // 分叉时把当前工作区透传给新建会话，使分叉会话与父会话同属一个工作区（否则会落到「无工作区」而在左侧列表被过滤隐藏）。
  readonly workspacePath?: string | null;
  // 设置页覆盖显示时保活会话树与流事件订阅，但暂停聊天专属全局快捷键。
  readonly isPageActive: boolean;
  readonly messageTarget?: { conversationId: string; messageId: string; requestId: number } | null;
}) {
  const isDraftConversation = conversationId === null;
  // 会话运行时状态的真值已上移到 conversationStore（按 conversationId 分桶的外部 store）。
  // 本组件不再持有 messages/isStreaming/... 的 useState 槽位，改为订阅当前会话切片；
  // 切会话 = 换订阅 key，物理上不存在「被复用的共享 messages 槽位」，跨会话串内容在架构层不可能发生。
  const { state: convState, actions: convActions } = useConversationState(conversationId);
  // providers 异步到达/引用变化不得重跑会话加载 effect；用 ref 读最新列表做 model 解析。
  const providersRef = useRef(providers);
  providersRef.current = providers;
  // 策略甲（薄适配）：保留组件内原有的 setXxx 调用点名字不变，底层改写为对 store 的 patch。
  // makeSetter 把某个会话级字段包装成 React 风格的 Dispatch<SetStateAction<T>>（支持函数式更新）。
  const convStateRef = useRef<ConversationRuntimeState>(convState);
  convStateRef.current = convState;
  const makeSetter = useCallback(
    <K extends keyof ConversationRuntimeState>(key: K): Dispatch<SetStateAction<ConversationRuntimeState[K]>> =>
      (value) => {
        const prev = convStateRef.current[key];
        const next =
          typeof value === 'function'
            ? (value as (p: ConversationRuntimeState[K]) => ConversationRuntimeState[K])(prev)
            : value;
        convActions.set({ [key]: next } as Partial<ConversationRuntimeState>);
      },
    [convActions],
  );
  const messages = convState.messages as ChatMsg[];
  const loadStatus = convState.loadStatus;
  const isStreaming = convState.isStreaming;
  const turnGroupCacheRef = useRef<{
    conversationId: string | null;
    cache: ChatTurnGroupCache;
  } | null>(null);
  const turnGroupCache = useMemo(() => {
    const previous = turnGroupCacheRef.current;
    const sameConversationCache = previous?.conversationId === conversationId
      ? previous.cache
      : undefined;
    const cache = groupMessagesIntoTurnsIncremental(
      messages,
      sameConversationCache,
      isStreaming && Boolean(sameConversationCache),
    );
    turnGroupCacheRef.current = { conversationId, cache };
    return cache;
  }, [conversationId, isStreaming, messages]);
  const chatTurns = turnGroupCache.turns;
  const liveChatTurn = turnGroupCache.liveTurn;
  const setMessages = useMemo(() => makeSetter('messages'), [makeSetter]) as Dispatch<SetStateAction<ChatMsg[]>>;
  const setIsStreaming = useMemo(() => makeSetter('isStreaming'), [makeSetter]);
  const compactionState = convState.compactionState;
  const setCompactionState = useMemo(() => makeSetter('compactionState'), [makeSetter]) as Dispatch<
    SetStateAction<CompactionState>
  >;
  const isCompactionActive = compactionState.phase === 'running' || compactionState.phase === 'finalizing';
  const isCompactionFailed = compactionState.phase === 'failed';
  const showCompactionNotice = isCompactionActive || isCompactionFailed;
  // 压缩进度（0-100）：流式收摘要时按已收字符/预期字符估算；null = 尚无进度。
  const compactionProgressPercent = getCompactionProgressPercent(compactionState);
  // 输入草稿由 ComposerDraftControls 独立订阅；父表面只保留低频队列状态。
  const messageQueue = convState.messageQueue;
  const enqueueMessage = convActions.enqueueMessage;
  const removeQueuedMessage = convActions.removeQueuedMessage;
  const reorderQueuedMessage = convActions.reorderQueuedMessage;
  const queuedDispatchInFlightRef = useRef(new Set<string>());
  // useElapsedTimer 只保留本轮起点 ref；回合时长真值由 useConversationStreamRouter
  // 在 done/aborted/error 时读取。实时跳秒在末端 ChatTurn 内更新，避免每秒重渲染整页。
  const { setTurnStartedAt } = useElapsedTimer();
  // 把流式运行状态(含会话坐标)上报给上层,供左侧列表显示 Loading 图标。
  // 表达层只反映 isStreaming 真值,不引入新的执行真值。下沉到 useStreamingReport。
  useStreamingReport(conversationId, isStreaming, onStreamingChange);
  const streamError = convState.streamError;
  const setStreamError = useMemo(() => makeSetter('streamError'), [makeSetter]);
  // 思考强度 + 模型 provider 按会话持久化在会话 meta 上(与 mode 同口径,每会话独立)。
  // effort 额外回写全局设置作为「新会话默认种子」;modelProviderId 只按会话绑定(null=全局默认
  // provider)。初值给默认,真实值由会话加载 effect 按当前会话 meta 覆盖(见下方 conversationId
  // effect)。真值最终经 chatSend → IPC → 会话 meta 兜底进入后端 provider 选择。逻辑见
  // hooks/useConversationModelEffort。
  const { effort, modelProviderId, setEffort, setModelProviderId, changeEffort, changeModelProviderId } =
    useConversationModelEffort(conversationId);
  // 对话模式按会话持久化在会话 meta 上(非全局设置):模式是「每会话状态」,切换会话
  // 各自独立、互不影响,与计划数据同口径。初值给 'chat',真实值由会话加载 effect 按
  // 当前会话 meta 覆盖(见下方 conversationId effect)。模式真值最终经 chatSend → IPC →
  // mode-source 进入 System Context 的 L6_MODE_REMINDER 层。逻辑见 hooks/useConversationMode。
  const { mode, setMode, changeMode } = useConversationMode(conversationId);
  // 本地访问授权级别全局偏好(读取/回写 settings-store,服务端归一化回执二次校正),
  // 逻辑见 hooks/useLocalAccessPreference。注意:权限真值仍在主进程 PermissionGate,此处仅表达选择。
  const { localAccessLevel, changeLocalAccessLevel } = useLocalAccessPreference();
  const tokenUsage = convState.tokenUsage;
  const setTokenUsage = useMemo(() => makeSetter('tokenUsage'), [makeSetter]) as Dispatch<
    SetStateAction<TokenUsageState | null>
  >;
  const activeUsage = convState.activeUsage;
  const setActiveUsage = useMemo(() => makeSetter('activeUsage'), [makeSetter]) as Dispatch<
    SetStateAction<TokenUsageState | null>
  >;
  // ADR 52：主进程随回合结束下发下一次最终请求投影。
  const contextAccounting = convState.contextAccounting;
  const setContextAccountingSnapshot = useMemo(() => makeSetter('contextAccounting'), [makeSetter]) as Dispatch<
    SetStateAction<ContextAccountingSnapshot | null>
  >;
  const providerRecoveryNotice = convState.providerRecoveryNotice;
  const setProviderRecoveryNotice = useMemo(() => makeSetter('providerRecoveryNotice'), [makeSetter]) as Dispatch<
    SetStateAction<{
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
    } | null>
  >;
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // 草稿态首条消息：create 完成后等会话 ready 再走 submitMessage，避免与加载竞态。
  const pendingFirstSendRef = useRef<{
    text: string;
    attachments: ChatAttachment[];
    effort?: string;
  } | null>(null);
  const creatingConversationRef = useRef(false);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);
  const pendingPermissionCalls = convState.pendingPermissionCalls as ClientToolCall[];
  const setPendingPermissionCalls = useMemo(() => makeSetter('pendingPermissionCalls'), [makeSetter]) as Dispatch<
    SetStateAction<ClientToolCall[]>
  >;
  const [isThreadAtBottom, setIsThreadAtBottom] = useState(true);
  // 工具参数进度由活动 AssistantContent 局部订阅，避免高频 IPC 更新唤醒整棵 ChatSurface。
  const setToolProgress = useMemo(() => makeSetter('toolProgress'), [makeSetter]);
  // 会话内查找(cmd/ctrl+F):仅在表达层对已渲染消息做高亮跳转,不触碰会话真值。
  const [findOpen, setFindOpen] = useState(false);
  // 顶部 header 滚动感知:chat-thread 滚动后给 header 加底线区分。
  const [threadScrolled, setThreadScrolled] = useState(false);
  // 当前问题条：只记录滚动位置对应的会话回合，不改变消息真值。
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  // 快捷键触发重命名:透传给 ChatHeader 让其进入编辑模式。
  const headerEditTriggerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!providerRecoveryNotice || providerRecoveryNotice.status !== 'recovered') return undefined;
    const timeoutId = window.setTimeout(() => {
      setProviderRecoveryNotice((current) => (current === providerRecoveryNotice ? null : current));
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [providerRecoveryNotice]);

  // connection retry 横幅倒计时：主进程只在进入 retrying 时推送一次 delayMs，
  // 表达层需要本地剩余秒数，才能每秒递减「约 Xs 后重试」。
  const [connectionRetryRemainingSeconds, setConnectionRetryRemainingSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (
      !providerRecoveryNotice
      || providerRecoveryNotice.kind !== 'connection'
      || providerRecoveryNotice.status !== 'retrying'
    ) {
      setConnectionRetryRemainingSeconds(null);
      return undefined;
    }
    const delayMs = Math.max(0, providerRecoveryNotice.delayMs ?? 0);
    const startedAt = Date.now();
    const computeRemaining = () =>
      Math.max(0, Math.ceil((delayMs - (Date.now() - startedAt)) / 1000));
    setConnectionRetryRemainingSeconds(computeRemaining());
    // 1s is enough for "约 Xs 后重试"; 250ms forced 4 React updates/sec for the whole ChatSurface.
    const intervalId = window.setInterval(() => {
      setConnectionRetryRemainingSeconds(computeRemaining());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [
    providerRecoveryNotice?.kind,
    providerRecoveryNotice?.status,
    providerRecoveryNotice?.attempt,
    providerRecoveryNotice?.delayMs,
  ]);

  useEffect(() => {
    if (!isPageActive || !imagePreview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImagePreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imagePreview, isPageActive]);

  // cmd/ctrl+F 打开会话内查找。常驻监听,与图片预览的 Escape 监听相互独立。
  useEffect(() => {
    if (!isPageActive) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPageActive]);

  // 顶部 header 快捷键:⌥⌘R 重命名、⌥⇧A 归档。
  useEffect(() => {
    if (!isPageActive) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌥⌘R → 重命名
      if (event.altKey && event.metaKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (conversationId && onRenameConversation) {
          // 触发 header 内联编辑:设置标志让 ChatHeader 进入编辑模式
          headerEditTriggerRef.current?.();
        }
      }
      // ⌥⇧A → 归档
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        if (conversationId && onArchiveConversation && !isStreaming) {
          onArchiveConversation(conversationId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [conversationId, isPageActive, onRenameConversation, onArchiveConversation, isStreaming]);

  // 任务续传(ADR 21):防止同一 resumeTask 被自动发送多次的一次性闸门。
  const resumeFiredRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  // 当前显示的会话 id（实时镜像）。用于异步回调里判断"完成时是否仍停在发起会话",
  // 避免手动 /compact 完成后把结果/横幅误作用到已切走的当前会话。
  const conversationIdRef = useRef<string | null>(conversationId);
  conversationIdRef.current = conversationId;
  // 正文/思考 delta 的追加逻辑已上移到 useConversationStreamRouter（应用级单例流路由器），
  // 由它按 streamId→conversationId 路由到对应会话桶。本组件不再持有本地 append 逻辑与打字机。

  const threadRef = useRef<HTMLDivElement>(null);
  const virtualTurnListRef = useRef<VirtualChatTurnListHandle>(null);
  const messageTurnIndex = turnGroupCache.messageTurnIndex;
  const virtualizeChatTurns = shouldVirtualizeChatTurns(chatTurns, findOpen);
  const scrollToTurn = useCallback<VirtualChatTurnListHandle['scrollToTurn']>((index, options) => {
    virtualTurnListRef.current?.scrollToTurn(index, options);
  }, []);
  const updateVirtualViewport = useCallback(() => {
    virtualTurnListRef.current?.updateViewport();
  }, []);
  const resetVirtualMeasurements = useCallback(() => {
    virtualTurnListRef.current?.resetMeasurements();
  }, []);
  const shouldAutoScrollRef = useRef(true);
  // 用户主动滚动意图：只有 wheel/touch/pointer 等手势可退出 follow。
  // 流式增高、虚拟列表重测、程序贴底触发的 scroll 不得清掉 follow。
  const userScrollIntentRef = useRef(false);
  const userScrollIntentClearTimerRef = useRef<number | null>(null);
  const threadScrollSnapshotsRef = useRef(new Map<string, ThreadScrollSnapshot>());
  const pendingThreadScrollRestoreRef = useRef<{
    conversationId: string;
    snapshot: ThreadScrollSnapshot | null;
  } | null>(null);
  const messageNavigationRequestRef = useRef(0);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userScrollIntentClearTimerRef.current != null) {
      window.clearTimeout(userScrollIntentClearTimerRef.current);
    }
    // 手势后的惯性滚动仍可能继续触发 scroll；短暂保持 intent，避免误 reaffirm。
    userScrollIntentClearTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollIntentClearTimerRef.current = null;
    }, 120);
  }, []);

  const updateThreadBottomState = useCallback((
    container: HTMLDivElement | null,
    options?: { readonly userInitiated?: boolean },
  ) => {
    if (!container) return true;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
    const decision = resolveThreadFollowAfterScroll({
      currentlyFollowing: shouldAutoScrollRef.current,
      atBottom,
      userInitiated: options?.userInitiated === true,
    });
    shouldAutoScrollRef.current = decision.nextFollowing;
    // Equality gate: avoid re-rendering ChatSurface when stick-to-bottom flag is unchanged.
    setIsThreadAtBottom((previous) => (
      previous === decision.nextFollowing ? previous : decision.nextFollowing
    ));
    if (decision.shouldReaffirmBottom) {
      container.scrollTop = container.scrollHeight;
    }
    return decision.nextFollowing;
  }, []);

  const saveThreadScrollSnapshot = useCallback((id: string | null, container: HTMLDivElement | null) => {
    if (!id || !container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const turnId = findCurrentTurnIdForScroll(container);
    const turnElement = turnId
      ? container.querySelector<HTMLElement>(`[data-chat-turn-id="${CSS.escape(turnId)}"]`)
      : null;
    threadScrollSnapshotsRef.current.set(id, {
      top: container.scrollTop,
      atBottom: distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX,
      turnId,
      turnOffset: turnElement ? container.scrollTop - turnElement.offsetTop : 0,
    });
  }, []);

  const updateCurrentTurnContext = useCallback((container: HTMLDivElement | null) => {
    const nextTurnId = container ? findCurrentTurnIdForScroll(container) : null;
    // Equality gate: rail highlight only needs a state update when the active turn actually changes.
    setCurrentTurnId((previous) => (previous === nextTurnId ? previous : nextTurnId));
  }, []);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = threadRef.current;
    if (!container) return;
    // 程序贴底：进入 follow，并清掉用户上滑意图，避免紧随其后的 scroll 事件误退出。
    userScrollIntentRef.current = false;
    if (userScrollIntentClearTimerRef.current != null) {
      window.clearTimeout(userScrollIntentClearTimerRef.current);
      userScrollIntentClearTimerRef.current = null;
    }
    container.scrollTo({ top: container.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom((previous) => (previous ? previous : true));
    saveThreadScrollSnapshot(conversationIdRef.current, container);
    updateCurrentTurnContext(container);
  }, [saveThreadScrollSnapshot, updateCurrentTurnContext]);

  const threadScrollCoalescerRef = useRef(createFrameCoalescer({
    request: (callback) => requestAnimationFrame(callback),
    cancel: (frameId) => cancelAnimationFrame(frameId),
  }));
  const handleThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const userInitiated = userScrollIntentRef.current;
    // Scroll can dispatch far faster than React can commit a long thread. Keep the latest
    // container state and coalesce virtual range updates and geometry probes to one pass per frame.
    // Virtual viewport only setStates when the window indices/padding change; bottom/turn/scrolled
    // flags also apply equality gates so mid-range scrolling does not re-render the whole surface.
    threadScrollCoalescerRef.current.request(() => {
      updateVirtualViewport();
      updateThreadBottomState(container, { userInitiated });
      updateCurrentTurnContext(container);
      if (pendingThreadScrollRestoreRef.current?.conversationId !== conversationId) {
        saveThreadScrollSnapshot(conversationId, container);
      }
      const nextScrolled = container.scrollTop > 4;
      setThreadScrolled((previous) => (previous === nextScrolled ? previous : nextScrolled));
    });
  }, [conversationId, saveThreadScrollSnapshot, updateCurrentTurnContext, updateThreadBottomState, updateVirtualViewport]);

  useEffect(() => () => {
    threadScrollCoalescerRef.current.cancel();
    if (userScrollIntentClearTimerRef.current != null) {
      window.clearTimeout(userScrollIntentClearTimerRef.current);
      userScrollIntentClearTimerRef.current = null;
    }
  }, []);

  // 表达层导航：虚拟轮次未挂载时先按 turn index 定位并强制挂载，再精确居中消息锚点。
  const scrollToMessage = useCallback((id: string) => {
    const container = threadRef.current;
    if (!container) return;
    const turnIndex = messageTurnIndex.get(id);
    if (turnIndex == null) return;

    const requestId = messageNavigationRequestRef.current + 1;
    messageNavigationRequestRef.current = requestId;
    const requestConversationId = conversationIdRef.current;
    shouldAutoScrollRef.current = false;
    setIsThreadAtBottom((previous) => (previous ? false : previous));
    scrollToTurn(turnIndex, { align: 'center' });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (
          messageNavigationRequestRef.current !== requestId
          || conversationIdRef.current !== requestConversationId
        ) return;
        const target = container.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('chat-msg-flash');
        void target.offsetWidth;
        target.classList.add('chat-msg-flash');
        window.setTimeout(() => target.classList.remove('chat-msg-flash'), 1600);
      });
    });
  }, [messageTurnIndex, scrollToTurn]);

  useEffect(() => {
    if (!messageTarget || messageTarget.conversationId !== conversationId) return;
    scrollToMessage(messageTarget.messageId);
  }, [conversationId, messageTarget, scrollToMessage]);

  const hasProvider = providers.some((p) => p.apiKeyConfigured);
  // 当前激活 provider(默认且已配置 Key,否则取首个已配置)是否勾选了原生推理(reasoning/thinking)。
  // 只有勾选时才显示思考强度选择器；OpenAI 暴露额外 xhigh 档。
  // 优先取会话绑定的已配置模型记录，使推理档位/思考强度随会话选中的模型走；
  // 兼容历史 groupId::model 绑定；会话未绑定或绑定失效时回退全局默认 → 首个已配置 Key。
  const boundProvider = modelProviderId
    ? resolveProviderById(providers, modelProviderId)
    : null;
  const activeProvider = (boundProvider?.apiKeyConfigured ? boundProvider : null)
    || providers.find((p) => p.isDefault && p.apiKeyConfigured)
    || providers.find((p) => p.apiKeyConfigured)
    || null;
  const activeProviderSupportsReasoning = Boolean(activeProvider?.supportsReasoning);
  // 档位列表以后端透传的 provider 原生能力（reasoningEffortLevels）为准，经归一化后渲染；
  // 后端未提供时回退到通用四档。不再按 provider 名硬编码（旧逻辑只认 openai，导致 Anthropic 等被降级到四档）。
  const effortLevels = useMemo(
    () => normalizeEffortLevels(activeProvider?.reasoningEffortLevels),
    [activeProvider?.reasoningEffortLevels],
  );
  const composerEffortLevels = useMemo(
    () => (activeProviderSupportsReasoning && hasTunableEffortLevels(effortLevels) ? effortLevels : EMPTY_EFFORT_LEVELS),
    [activeProviderSupportsReasoning, effortLevels],
  );
  // 渠道能力变化后（如切到 Grok 仅 low/medium/high），把会话旧档位投影到合法默认值。
  useEffect(() => {
    if (!activeProviderSupportsReasoning) return;
    if (effortLevels.includes(effort)) return;
    const preferred = resolvePreferredEffort(
      effortLevels,
      activeProvider?.reasoningDefaultEffort,
    );
    if (preferred !== effort) changeEffort(preferred);
  }, [
    activeProvider?.reasoningDefaultEffort,
    activeProviderSupportsReasoning,
    changeEffort,
    effort,
    effortLevels,
  ]);
  const handleModelChange = useCallback((providerId: string) => {
    const targetProvider = providers.find((provider) => provider.id === providerId && provider.apiKeyConfigured);
    const targetEffortLevels = normalizeEffortLevels(targetProvider?.reasoningEffortLevels);
    const transition = resolveModelSwitchState({
      providerId,
      currentEffort: effort,
      targetLevels: targetEffortLevels,
      preferredDefault: targetProvider?.reasoningDefaultEffort,
    });

    const countCapability =
      targetProvider?.provider === 'anthropic'
        ? { kind: 'provider_count_api' as const }
        : { kind: 'observed_usage_only' as const };
    setContextAccountingSnapshot(
      createUnknownContextAccountingSnapshot({
        identity: {
          conversationId: conversationId || '__draft__',
          contentRevision: contextAccounting?.contentRevision ?? 0,
          modelKey: contextAccountingModelKey(providerId, targetProvider?.model),
        },
        contextWindow: targetProvider?.contextWindow ?? null,
        countCapability,
        phase: 'model_changed',
        revision: (contextAccounting?.revision ?? 0) + 1,
        compactionEpoch: contextAccounting?.compactionEpoch ?? 0,
        pendingUncountedChanges: messages.length > 0,
      }),
    );
    changeModelProviderId(transition.modelProviderId);
    if (transition.effort !== effort) changeEffort(transition.effort);
  }, [
    changeEffort,
    changeModelProviderId,
    contextAccounting,
    conversationId,
    effort,
    messages.length,
    providers,
    setContextAccountingSnapshot,
  ]);
  const isZh = i18n.locale === 'zh-CN';
  const modeOptions = useMemo<readonly DropdownOption[]>(
    () => CHAT_MODES.map((m) => ({ value: m, label: modeLabel(m, isZh) })),
    [isZh],
  );
  const accessLevelOptions = useMemo<readonly DropdownOption[]>(
    () => ACCESS_LEVELS.map((level) => ({
      value: level,
      label: accessLevelLabel(level, isZh),
      tone: level === 'full_local' ? 'danger' : undefined,
    })),
    [isZh],
  );
  const handleModeDropdownChange = useCallback((next: string) => {
    if (isChatMode(next)) changeMode(next);
  }, [changeMode]);
  const handleAccessLevelDropdownChange = useCallback((next: string) => {
    if (isLocalAccessLevel(next)) changeLocalAccessLevel(next);
  }, [changeLocalAccessLevel]);
  const compactionNoticeLabel = compactionStateLabel(compactionState, isZh);
  const currentTurnContext = useMemo(() => {
    if (!currentTurnId) return null;
    const currentTurn = liveChatTurn?.id === currentTurnId
      ? liveChatTurn
      : chatTurns.find((turn) => turn.id === currentTurnId);
    const userMessage = currentTurn ? getTurnUserMessage(currentTurn) : null;
    return userMessage ? summarizeUserMessageForContext(userMessage, isZh) : null;
  }, [chatTurns, currentTurnId, isZh, liveChatTurn]);
  // 模型下拉选项：以持久化的 provider×model 记录为单位，仅列凭据已就绪的可用模型。
  // value=真实模型记录 id（会话据此绑定模型），label 优先取 modelLabel，回退分组名+模型名。
  const modelOptions = useMemo(
    () => providers
      .filter((p) => p.apiKeyConfigured)
      .map((p) => ({
        value: p.id,
        label: getProviderModelDisplayLabel(p, isZh),
      })),
    [isZh, providers],
  );
  // 有两个及以上可用模型时才允许切换（单模型无切换意义）。
  const canSwitchModel = modelOptions.length > 1;

  // 右侧消息轨不依赖流式 assistant 内容；同会话流式尾部替换时复用上次投影。
  const railItemsCacheRef = useRef<{
    conversationId: string | null;
    isZh: boolean;
    cache: MessageRailItemCache;
  } | null>(null);
  const railItems = useMemo(() => {
    const previous = railItemsCacheRef.current;
    const sameProjection = previous?.conversationId === conversationId && previous.isZh === isZh
      ? previous.cache
      : undefined;
    const cache = buildMessageRailItemsIncremental(
      messages,
      isZh ? '对话已压缩' : 'Conversation compacted',
      sameProjection,
      isStreaming && Boolean(sameProjection),
    );
    railItemsCacheRef.current = { conversationId, isZh, cache };
    return cache.items;
  }, [conversationId, isStreaming, isZh, messages]);
  const contextAccountingWindow = contextAccounting?.contextWindow ?? undefined;
  // 当前轮进行中(流式/压缩)。草稿是否有内容由输入叶子自行判断。
  const isBusy = isStreaming || isCompactionActive;

  // restored 计量:会话就绪但无权威快照(缺失/失效/跨宿主被守卫置 null)时,
  // 请求 Runtime 按完整成分重算;未知期间圆环保持 unknown,不渲染伪造百分比。
  // 同一会话、模型和内容版本只尝试一次。unknown 是合法结果，不能让它触发重投影死循环。
  // 运行中不触发:计量由 Runtime context.accounting 事件接管。
  const contextRestoreAttemptedKeysRef = useRef(new Set<string>());
  useEffect(() => {
    if (loadStatus !== 'ready' || !conversationId || isDraftConversation) return;
    const restoreInput = {
      conversationId,
      snapshot: contextAccounting,
      providerId: activeProvider?.id ?? modelProviderId,
      model: activeProvider?.model,
    };
    const requiresRestore = shouldStartContextAccountingRestore({
      attemptedKeys: contextRestoreAttemptedKeysRef.current,
      ...restoreInput,
    });
    if (!requiresRestore || isBusy) return;
    if (typeof clientApi.chatContextRestored !== 'function') return;
    contextRestoreAttemptedKeysRef.current.add(contextAccountingRestoreKey(restoreInput));
    let cancelled = false;
    void clientApi.chatContextRestored({
      conversationId,
      modelProviderId: activeProvider?.id ?? modelProviderId,
    })
      .then((snap) => {
        if (cancelled || !snap) return;
        contextRestoreAttemptedKeysRef.current.add(contextAccountingRestoreKey({
          ...restoreInput,
          snapshot: snap,
        }));
        setContextAccountingSnapshot(snap);
      })
      .catch(() => {
        // 重投影失败保持未知；内容修订或模型变化会生成新 key，并允许再次恢复。
      });
    return () => { cancelled = true; };
  }, [
    loadStatus,
    conversationId,
    isDraftConversation,
    contextAccounting,
    activeProvider?.id,
    activeProvider?.model,
    modelProviderId,
    isBusy,
    setContextAccountingSnapshot,
  ]);

  useEffect(() => {
    setAttachments([]);
    setAttachmentError(null);
    setPendingPermissionCalls([]);
    setProviderRecoveryNotice(null);
    // 切换会话时清掉上一会话的流式错误横幅，避免错误提示跨会话残留。
    setStreamError(null);
    // 切换会话时恢复「该会话」输入框状态(草稿文本 + 待发送队列):
    // - 同会话二次进入：优先保留 conversationStore 桶内已有草稿/队列，避免被尚未落盘的空持久化冲掉；
    // - 冷启动 / 首次进入：回落 composerPersistence。
    // 草稿区附件不持久化(见 composerPersistence 取舍说明),故切换会话后附件区始终清空。
    const liveComposer = conversationStore.getSnapshot(conversationId);
    const persisted = conversationId ? loadComposerEntry(conversationId) : null;
    const hydrated = resolveComposerHydration(liveComposer, persisted);
    convActions.set({
      draft: hydrated.draft,
      // live 路径直接复用桶内 QueuedMessage；persisted 路径形状兼容。
      messageQueue: hydrated.queue as typeof liveComposer.messageQueue,
    });
    const threadScrollSnapshot = conversationId
      ? threadScrollSnapshotsRef.current.get(conversationId) ?? null
      : null;
    pendingThreadScrollRestoreRef.current = conversationId
      ? { conversationId, snapshot: threadScrollSnapshot }
      : null;
    const nextAtBottom = threadScrollSnapshot?.atBottom ?? true;
    shouldAutoScrollRef.current = nextAtBottom;
    setIsThreadAtBottom((previous) => (previous === nextAtBottom ? previous : nextAtBottom));
    // 切换会话时,先把流式表达状态按会话归零,避免上一会话的 isStreaming/streamId/toolProgress 残留:
    // 否则从"正在输出的 A"切到"未运行的 B",B 会误显示运行中(左侧列表 Loading、
    // 右下角停止按钮误亮),也会让"正在准备工具参数"残留到新会话。
    // 归零后由下方 reattach 按"新会话是否确有活跃流"重新点亮,仅以真值为准。
    setIsStreaming(false);
    streamIdRef.current = null;
    setToolProgress(null);
    // 压缩横幅真值在主进程登记表（按会话），切会话时先归零本地表达，避免上一会话的
    // 压缩横幅/进度残留到新会话；随后由下方查询按"新会话是否确在压缩"重新点亮。
    setCompactionState(IDLE_COMPACTION_STATE);
    // contextAccounting 已按 conversationId 分桶。切换订阅时必须保留目标会话自己的
    // triggerTokens 快照；主动清空会让同一会话退回本地历史估算，造成百分比口径跳变。
    // 切换会话时一并清掉本轮计时锚点,避免上一会话的实时跳秒残留到新会话。
    // 打字机缓冲的清空已上移到 useConversationStreamRouter（随前台会话切换自动 reset）。
    setTurnStartedAt(null);
    if (!conversationId) {
      // 草稿态：不拉磁盘、不进左侧列表；直接 ready，允许输入与发送。
      // 再次点「新建任务」时 conversationId 仍为 null，本 effect 不会重跑，draft 得以保留。
      // 模型选择沿用上次使用的模型（可解析时），而不是强制显示全局默认。
      // 读 providersRef：providers 到达由下方独立 effect 补种，不触发本加载 effect。
      const draftModelId = resolveDraftModelProviderId(providersRef.current);
      if (draftModelId) setModelProviderId(draftModelId);
      setTokenUsage(null);
      convActions.commitLoad({
        messages: [],
        tokenUsage: null,
      });
      return;
    }
    // 已有 ready 消息时不要 beginLoad 清空，否则切回会话会先闪加载占位。
    // providers 等无关依赖变化时同样走这里：静默刷新，不硬清空。
    const existingSnapshot = conversationStore.getSnapshot(conversationId);
    const hardBegin = shouldHardBeginConversationLoad({
      loadStatus: existingSnapshot.loadStatus,
      messageCount: existingSnapshot.messages.length,
    });
    if (hardBegin) {
      convActions.beginLoad();
      setTokenUsage(null);
    }
    let cancelled = false;
    void (async () => {
      const {
        messages: loaded,
        tokenUsage: usage,
        mode: convMode,
        effort: convEffort,
        modelProviderId: convModelProviderId,
        contextAccounting: storedContextAccountingSnapshot,
      } = await loadConversationMessages(conversationId);
      if (cancelled) return;
      // 消息可以先投影到 UI；硬加载时 loadStatus 仍保持 loading，直到 compaction/stream
      // reattach 全部收敛；静默刷新则保持 ready，避免闪空。
      convActions.set({
        messages: loaded,
        tokenUsage: usage,
        contextAccounting: storedContextAccountingSnapshot,
      });
      // 对话模式随会话恢复:每会话各自独立,切换会话即切到该会话自己的模式。
      setMode(convMode);
      // 思考强度 + 模型 provider 随会话恢复:与 mode 同口径,切换会话即切到该会话自己的绑定值。
      // 直接 setState(不触发回写),避免恢复动作被当成用户切换而反写 meta。
      setEffort(convEffort);
      // 兼容历史 groupId::model 绑定：能解析到真实记录就回写真实 id，并迁移会话 meta。
      const resolvedBound = resolveProviderById(providersRef.current, convModelProviderId);
      const restoredModelProviderId = resolvedBound?.id ?? convModelProviderId;
      setModelProviderId(restoredModelProviderId);
      if (
        convModelProviderId
        && resolvedBound?.id
        && resolvedBound.id !== convModelProviderId
      ) {
        void clientApi.conversationsUpdateModelEffort({
          id: conversationId,
          modelProviderId: resolvedBound.id,
        }).catch(() => {
          // 迁移失败不影响本轮 UI；下次进入仍会再尝试。
        });
      }
      // 会话恢复的模型也写共享记忆，让 Quick 跟主聊天「当前/上次」模型一致。
      writeLastModelProviderId(restoredModelProviderId);

      // 压缩横幅按会话恢复:压缩态真值在主进程登记表,切回正在压缩的会话时恢复横幅与进度,
      // 并把 streamIdRef 指向压缩流,使后续 progress/done 事件(按 streamId 门控)能继续匹配收尾。
      try {
        const comp = await clientApi.chatCompactionGet({ conversationId });
        if (cancelled) return;
        if (comp && 'phase' in comp && comp.phase === 'failed' && comp.streamId) {
          streamIdRef.current = comp.streamId;
          setCompactionState({
            phase: 'failed',
            percent: null,
            streamId: comp.streamId,
            failedAt: typeof comp.failedAt === 'number' ? comp.failedAt : Date.now(),
            errorCode: typeof comp.errorCode === 'string' ? comp.errorCode : undefined,
            error: typeof comp.message === 'string' ? comp.message : undefined,
          });
        } else if (comp && comp.compacting && comp.streamId) {
          streamIdRef.current = comp.streamId;
          conversationStore.routeStream(comp.streamId, conversationId);
          conversationStore.setState(conversationId, { streamId: comp.streamId });
          setCompactionState({
            phase: 'running',
            percent: typeof comp.percent === 'number' ? comp.percent : null,
            streamId: comp.streamId,
            startedAt: Date.now(),
          });
        }
      } catch {
        // 查询失败不影响正常加载;降级为无横幅(压缩仍会在后台完成)。
      }

      // ADR 22: HMR 重载/重新打开后,main 进程的流式推理可能仍在进行。
      // 询问后端是否有本会话的活跃流;若有,把已累积的思考/正文接回 UI,
      // 并恢复 streamIdRef,使现有 delta 监听重新匹配、无缝续上(不重发、不打断)。
      try {
        const live = await clientApi.chatStreamReattach({ conversationId });
        if (cancelled) return;
        if (live && live.streamId) {
          // 方案 3：reattach 既可能返回「运行中的流」，也可能返回「已终结但保留的终态快照」。
          // - running：接回 streamIdRef + isStreaming，使 delta 监听续上（既有无缝续接）。
          // - terminal：不重新武装流式，只用终态快照补齐完整正文/工具段，并标注 interrupted，
          //   让切回已结束的后台轮次也能无缝回放（正文真值已由主进程落盘，这里仅做表达补齐）。
          const running = live.isStreaming === true;
          const liveStartedAt = typeof live.startedAt === 'number' && Number.isFinite(live.startedAt)
            ? live.startedAt
            : Date.now();
          const liveSegments: ContentSegment[] = Array.isArray(live.segments) && live.segments.length > 0
            ? live.segments.map((segment) => normalizeStreamSegment(segment as ContentSegment))
            : [];
          if (liveSegments.length === 0) {
            if (live.accumulatedThinking) liveSegments.push({ type: 'thinking', content: live.accumulatedThinking });
            if (live.accumulatedText) liveSegments.push({ type: 'text', content: live.accumulatedText });
          }
          const terminalInterrupted = !running && live.interrupted === true;
          // 重新打开会话时,loaded 末尾通常已是这一轮进行中的 assistant 消息。
          // 续接不能用 main 的活跃流快照直接覆盖它:renderer 侧可能已经把更完整的
          // 分段思考/工具调用记录落盘了。这里以 loaded/prev 中已有 segments
          // 为证据基线,只接受可证明更完整的 live suffix,避免切回后历史段被清空。
          setMessages((prev) => {
            const base = prev.length > 0 ? prev : loaded;
            const last = base[base.length - 1];
            const persistedAssistant = last && last.role === 'assistant' ? last : null;
            const segments = mergeReattachedSegments(persistedAssistant?.segments, liveSegments);
            const liveMsg: ChatMsg = {
              ...(persistedAssistant || {}),
              id: persistedAssistant?.id || nextId(),
              role: 'assistant',
              content: contentFromSegments(segments, live.accumulatedText ?? persistedAssistant?.content ?? ''),
              segments,
              timestamp: persistedAssistant?.timestamp || Date.now(),
              // 终态回放：异常中断标记保留；正常完成则清除既有 interrupted（轮次确已完成）。
              interrupted: running ? persistedAssistant?.interrupted : terminalInterrupted,
            };
            if (persistedAssistant) {
              return [...base.slice(0, -1), liveMsg];
            }
            return [...base, liveMsg];
          });
          if (running) {
            streamIdRef.current = live.streamId;
            setTurnStartedAt(liveStartedAt);
            conversationStore.routeStream(live.streamId, conversationId);
            conversationStore.setState(conversationId, { streamId: live.streamId, turnStartedAt: liveStartedAt });
            setIsStreaming(true);
          }
        }
      } catch {
        // reattach 失败不影响正常加载;降级为无续接(用户可重新发送)。
      }
      if (cancelled) return;
      // 只有 main 侧流状态已经查询完毕，才把会话标记为可发送；running=true 已在上面先恢复，
      // 因而 ready 首帧不会暴露错误的「非流式空闲」窗口。
      convActions.commitLoad({});
    })();
    return () => { cancelled = true; };
  }, [conversationId, convActions]);

  // providers 异步到达后，草稿态若还没绑定模型则补一次上次模型种子。
  useEffect(() => {
    if (conversationId) return;
    if (modelProviderId) return;
    const draftModelId = resolveDraftModelProviderId(providers);
    if (draftModelId) setModelProviderId(draftModelId);
  }, [conversationId, modelProviderId, providers]);

  const appliedExternalRevisionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId || !conversationRevision || isStreaming) return;
    if (appliedExternalRevisionRef.current === conversationRevision) return;
    let cancelled = false;
    void loadConversationMessages(conversationId).then(({
      messages: loaded,
      tokenUsage: usage,
      contextAccounting: storedContextAccountingSnapshot,
    }) => {
      if (cancelled) return;
      appliedExternalRevisionRef.current = conversationRevision;
      convActions.commitLoad({
        messages: loaded,
        tokenUsage: usage,
        contextAccounting: storedContextAccountingSnapshot,
      });
    });
    return () => { cancelled = true; };
  }, [conversationId, conversationRevision, convActions, isStreaming]);

  useEffect(() => {
    return clientApi.onGoalRunnerChanged((payload) => {
      if (payload?.type !== 'goalRunner:streamStarted') return;
      if (!conversationId || payload.conversationId !== conversationId) return;
      const streamId = typeof payload.streamId === 'string' ? payload.streamId : '';
      if (!streamId) return;
      const now = typeof payload.startedAt === 'number' ? payload.startedAt : Date.now();
      // 主进程 runGoalTurn 已创建并落盘 assistant 占位；渲染端必须绑定同一 id，
      // 否则流式内容无法对上，且会再 append 一条空消息污染会话。
      const assistantMessageIdFromMain =
        typeof (payload as { assistantMessageId?: unknown }).assistantMessageId === 'string'
          ? (payload as { assistantMessageId: string }).assistantMessageId.trim()
          : '';
      const assistantMsg: ChatMsg = {
        id: assistantMessageIdFromMain || nextId(),
        role: 'assistant',
        content: '',
        segments: [],
        timestamp: now,
      };
      streamIdRef.current = streamId;
      setTurnStartedAt(now);
      conversationStore.routeStream(streamId, conversationId);
      conversationStore.setState(conversationId, { streamId, turnStartedAt: now });
      setStreamError(null);
      setActiveUsage(null);
      setProviderRecoveryNotice(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      setIsStreaming(true);
      setMessages((prev) => {
        if (prev.some((msg) => msg.id === assistantMsg.id)) {
          return prev.map((msg) => (
            msg.id === assistantMsg.id
              ? {
                  ...msg,
                  role: 'assistant',
                  content: msg.content || '',
                  segments: msg.segments || [],
                  timestamp: msg.timestamp || now,
                }
              : msg
          ));
        }
        const tail = prev[prev.length - 1];
        if (tail && isEmptyAssistantPlaceholder(tail)) {
          return [...prev.slice(0, -1), assistantMsg];
        }
        return [...prev, assistantMsg];
      });
      // 主进程已 append 同 id 占位；此处不再二次 append，避免重复空 assistant。
      onConversationUpdated?.();
    });
  }, [conversationId, onConversationUpdated]);

  // Workbench Goal slot：portal target 由右侧工作台 GoalView 提供。
  const {
    goalSlot,
    setHasGoalPlan,
    open: workbenchOpen,
    activeTab: workbenchActiveTab,
    setOpen: setWorkbenchOpen,
    setActiveTab: setWorkbenchTab,
  } = useWorkbench();
  // Agent 调用内置浏览器工具（browser_*）时自动展开工作台并切到 Browser Tab，
  // 复用 Goal 计划创建时的自动切 Tab 先例，避免 webview 隐藏导致用户看不到 Agent 操作。
  const handleBrowserToolActivity = useCallback(() => {
    setWorkbenchTab('browser');
    setWorkbenchOpen(true);
  }, [setWorkbenchTab, setWorkbenchOpen]);

  // 显式 /compact 的 renderer 入口。自动压缩只能发生在 Runtime provider 请求前的
  // 阻塞式 preflight 中，不能从 stream done 旁路启动，否则会与 Goal Runner 下一 tick 并发写会话。
  const runCompaction = useCallback(async (compactConversationId: string): Promise<boolean> => {
    const streamId = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const compactStartedAt = Date.now();
    beginConversationCompaction(compactConversationId, streamId, compactStartedAt);
    const result = await clientApi.chatCompact({ conversationId: compactConversationId, streamId });
    if (result.compacted) onConversationUpdated?.();
    return result.compacted;
  }, [onConversationUpdated]);

  // 应用级单例流路由器（方案 C / 甲-1）：订阅全部 chatStream 事件，按 streamId→conversationId
  // 路由到对应会话桶。前台会话（=当前 conversationId）的 delta 走打字机平滑吐字，后台会话的
  // delta 直接整段写入其桶。因 App 只渲染单个稳定的 ChatSurface 实例（切会话只改 conversationId
  // 这个 prop、不重挂载），此处挂载即「全应用唯一一份」订阅，终结了旧的 streamIdRef 单流过滤。
  useConversationStreamRouter({
    activeConversationId: conversationId,
    onConversationUpdated,
    onBrowserToolActivity: handleBrowserToolActivity,
  });

  useLayoutEffect(() => {
    const pending = pendingThreadScrollRestoreRef.current;
    if (!pending || pending.conversationId !== conversationId) return;
    const container = threadRef.current;
    if (!container) return;
    if (messages.length === 0 && pending.snapshot && pending.snapshot.top > 0) return;

    const finishRestore = () => {
      if (
        pendingThreadScrollRestoreRef.current !== pending
        || conversationIdRef.current !== pending.conversationId
      ) return;
      updateVirtualViewport();
      updateThreadBottomState(container);
      updateCurrentTurnContext(container);
      const nextScrolled = container.scrollTop > 4;
      setThreadScrolled((previous) => (previous === nextScrolled ? previous : nextScrolled));
      saveThreadScrollSnapshot(conversationId, container);
      pendingThreadScrollRestoreRef.current = null;
    };

    if (pending.snapshot) {
      if (pending.snapshot.atBottom) {
        container.scrollTop = container.scrollHeight;
        finishRestore();
        return;
      }

      const anchoredTurnId = pending.snapshot.turnId;
      const anchoredTurnIndex = anchoredTurnId
        ? messageTurnIndex.get(anchoredTurnId)
        : undefined;
      if (anchoredTurnId && anchoredTurnIndex != null) {
        scrollToTurn(anchoredTurnIndex);
        let secondFrameId: number | null = null;
        const firstFrameId = window.requestAnimationFrame(() => {
          secondFrameId = window.requestAnimationFrame(() => {
            if (
              pendingThreadScrollRestoreRef.current !== pending
              || conversationIdRef.current !== pending.conversationId
            ) return;
            const anchoredTurn = container.querySelector<HTMLElement>(
              `[data-chat-turn-id="${CSS.escape(anchoredTurnId)}"]`,
            );
            if (anchoredTurn) {
              container.scrollTop = Math.max(
                0,
                anchoredTurn.offsetTop + pending.snapshot!.turnOffset,
              );
            } else {
              const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
              container.scrollTop = Math.min(pending.snapshot!.top, maxTop);
            }
            finishRestore();
          });
        });
        return () => {
          window.cancelAnimationFrame(firstFrameId);
          if (secondFrameId != null) window.cancelAnimationFrame(secondFrameId);
        };
      }

      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(pending.snapshot.top, maxTop);
      finishRestore();
      return;
    }

    container.scrollTop = container.scrollHeight;
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom((previous) => (previous ? previous : true));
    finishRestore();
  }, [
    conversationId,
    messageTurnIndex,
    messages,
    saveThreadScrollSnapshot,
    scrollToTurn,
    updateCurrentTurnContext,
    updateThreadBottomState,
    updateVirtualViewport,
  ]);

  // 记录上一帧消息条数：压缩/整表重写通常会减少条数，此时旧的 index 高度缓存与新时间线错位。
  const previousMessageCountRef = useRef(messages.length);
  useLayoutEffect(() => {
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    const plan = planThreadScrollAfterMessagesChange({
      previousCount,
      nextCount: messages.length,
      shouldAutoScroll: shouldAutoScrollRef.current,
    });

    if (!plan.stickToBottom) {
      const container = threadRef.current;
      updateThreadBottomState(container);
      updateCurrentTurnContext(container);
      return;
    }

    // 压缩完成后 messages 会被整表重写：旧的按 index 缓存高度与新时间线错位，
    // 若先按错误 totalSize 贴底，浏览器可能把 scrollTop 钳到 0，随后高度回升却停在顶部。
    // 仅在结构重写时清空虚拟测量；流式追加/替换仍走轻量贴底。
    if (plan.resetVirtualMeasurements) {
      resetVirtualMeasurements();
    }
    scrollThreadToBottom('auto');
    if (plan.reaffirmFrames <= 0) return;

    let cancelled = false;
    let remaining = plan.reaffirmFrames;
    const reaffirm = () => {
      if (cancelled || !shouldAutoScrollRef.current || remaining <= 0) return;
      remaining -= 1;
      scrollThreadToBottom('auto');
      if (remaining > 0) {
        requestAnimationFrame(reaffirm);
      }
    };
    const outer = requestAnimationFrame(reaffirm);
    return () => {
      cancelled = true;
      cancelAnimationFrame(outer);
    };
  }, [
    messages,
    resetVirtualMeasurements,
    scrollThreadToBottom,
    updateCurrentTurnContext,
    updateThreadBottomState,
  ]);

  // 手动 /compact 不改 messages，上面的自动滚动 effect 不会重跑；而压缩进度横幅
  // 渲染在滚动容器最底部。若用户此时已向上滚，横幅会落在视口外，造成"点了没反应"
  // 的错觉。压缩一开始就强制滚到底，让进度横幅立即进入视口。
  // 压缩结束（finalizing -> done/idle）时再清一次测量并贴底，避免 merge 后仍停在顶部。
  const wasCompactionActiveRef = useRef(false);
  useLayoutEffect(() => {
    if (isCompactionActive) {
      wasCompactionActiveRef.current = true;
      shouldAutoScrollRef.current = true;
      scrollThreadToBottom('auto');
      return;
    }
    if (wasCompactionActiveRef.current) {
      wasCompactionActiveRef.current = false;
      shouldAutoScrollRef.current = true;
      resetVirtualMeasurements();
      scrollThreadToBottom('auto');
      const outer = requestAnimationFrame(() => {
        if (!shouldAutoScrollRef.current) return;
        scrollThreadToBottom('auto');
      });
      return () => cancelAnimationFrame(outer);
    }
  }, [isCompactionActive, resetVirtualMeasurements, scrollThreadToBottom]);

  const removePendingPermissionCall = useCallback((toolCallId: string) => {
    setPendingPermissionCalls((prev) => prev.filter((call) => call.toolCallId !== toolCallId));
  }, []);

  const approvePendingPermissionCall = useCallback((call: ClientToolCall) => {
    removePendingPermissionCall(call.toolCallId);
    void clientApi.approveLocalAction(call.toolCallId);
  }, [removePendingPermissionCall]);

  const approveAlwaysPendingPermissionCall = useCallback((call: ClientToolCall) => {
    removePendingPermissionCall(call.toolCallId);
    void clientApi.approveLocalAction(call.toolCallId, {
      duration: 'scope',
      scope: call.capabilityId,
    });
  }, [removePendingPermissionCall]);

  const denyPendingPermissionCall = useCallback((call: ClientToolCall) => {
    removePendingPermissionCall(call.toolCallId);
    void clientApi.denyLocalAction(call.toolCallId);
  }, [removePendingPermissionCall]);

  const addFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const result = await intakeAttachments(files, attachments.length, isZh);
    setAttachmentError(result.error);
    if (result.attachments.length) {
      setAttachments((prev) => [...prev, ...result.attachments]);
    }
  }, [attachments.length, isZh]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }, []);

  const attachSessionReference = useCallback(async (hit: SessionReferenceHit) => {
    try {
      const loaded = await loadConversationMessages(hit.id);
      const attachment = buildSessionReferenceAttachment({
        conversationId: hit.id,
        title: hit.title,
        messages: loaded.messages,
      });
      setAttachments((prev) => {
        // 同一会话重复引用时替换旧附件，避免叠多份
        const filtered = prev.filter((item) => !item.name.startsWith('session:') || !item.id.includes(hit.id));
        return [...filtered, attachment];
      });
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : (isZh ? '读取会话失败' : 'Failed to load session'));
    }
  }, [isZh]);

  const reorderAttachment = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setAttachments((prev) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  }, []);

  /** 点编辑回填输入框：文案/附件回到 composer，不从队列移除（只有 × 才移除）。 */
  const refillQueuedMessageToComposer = useCallback((item: QueuedMessage) => {
    const currentDraft = conversationStore.getSnapshot(conversationId).draft;
    const nextDraft = currentDraft.trim()
      ? `${currentDraft.trimEnd()}\n${item.text}`
      : item.text;
    conversationStore.setDraft(conversationId, nextDraft);
    if (item.attachments.length > 0) {
      setAttachments((prev) => {
        const existingIds = new Set(prev.map((attachment) => attachment.id));
        const merged = item.attachments.filter((attachment) => !existingIds.has(attachment.id));
        return merged.length > 0 ? [...prev, ...merged] : prev;
      });
    }
    setAttachmentError(null);
  }, [conversationId]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileItems = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!fileItems.length) return;
    event.preventDefault();
    void addFiles(fileItems);
  }, [addFiles]);

  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const fileDragDepthRef = useRef(0);
  const canAcceptFileDrop = hasProvider && !isStreaming;
  const hasFileTransfer = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.types ?? []).includes('Files')) return true;
    return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file');
  }, []);
  const resetFileDropState = useCallback(() => {
    fileDragDepthRef.current = 0;
    setIsFileDropActive(false);
  }, []);
  const handleSurfaceDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDropActive(true);
  }, [canAcceptFileDrop, hasFileTransfer]);
  const handleSurfaceDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDropActive(true);
  }, [canAcceptFileDrop, hasFileTransfer]);
  const handleSurfaceDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsFileDropActive(false);
  }, [canAcceptFileDrop, hasFileTransfer]);
  const handleSurfaceDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const droppedFiles = event.dataTransfer.files;
    resetFileDropState();
    if (!droppedFiles.length) return;
    void addFiles(droppedFiles);
  }, [addFiles, canAcceptFileDrop, hasFileTransfer, resetFileDropState]);

  // 核心发送路径:给定文本(+ 可选附件)就执行一次 agent turn。
  // handleSend(用户输入)与 pending-task 续传(跨重启)都复用它,避免另造发送路径。
  const submitMessage = useCallback(async (
    text: string,
    sentAttachments: ChatAttachment[],
    submitEffort?: string,
    historyOverride?: readonly ChatMsg[],
  ) => {
    if ((!text && sentAttachments.length === 0) || isStreaming || !hasProvider || !conversationId || loadStatus !== 'ready') return false;
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);
    const turnEffort = submitEffort ?? effort;

    // /compact: run compaction in-place without an agent turn。
    // 捕获发起会话并复用共享的 runCompaction 安全链路；完成后的消息与上下文快照
    // 统一由 chat:compaction 事件投影，避免命令路径再做第二次状态收尾。
    if (text === '/compact' && sentAttachments.length === 0) {
      await runCompaction(conversationId);
      return true;
    }

    const now = Date.now();
    const userMsg: ChatMsg = { id: nextId(), role: 'user', content: text, timestamp: now, attachments: sentAttachments.length ? sentAttachments : undefined };
    const assistantMsg: ChatMsg = { id: nextId(), role: 'assistant', content: '', segments: [], timestamp: now };
    const baseHistory = historyOverride ?? messages;
    const clearedHistory = clearInterruptedMarkers(baseHistory);
    setMessages([...clearedHistory.messages, userMsg, assistantMsg]);

    // Continuing a conversation retires historical interrupted markers so Desktop no longer
    // shows a stale "已中断" label on older assistant turns after CLI/Desktop resume.
    if (clearedHistory.changed) {
      await clientApi.conversationsReplaceMessages({
        id: conversationId,
        messages: serializeConversationMessages(clearedHistory.messages),
      });
    }
    await clientApi.conversationsAppendMessage({ id: conversationId, message: { id: userMsg.id, role: 'user', content: text, timestamp: now, attachments: userMsg.attachments } });
    await clientApi.conversationsAppendMessage({ id: conversationId, message: { id: assistantMsg.id, role: 'assistant', content: '', timestamp: now } });
    onConversationUpdated?.();

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnStartedAt = Date.now();
    streamIdRef.current = streamId;
    setTurnStartedAt(turnStartedAt);
    // 应用级路由器凭 streamId 反查会话桶：登记归属并把 streamId/turnStartedAt 写入本会话桶，
    // 使后台流事件（delta/done/…）即使 ChatSurface 已切走也能落到正确的桶。
    conversationStore.routeStream(streamId, conversationId);
    conversationStore.setState(conversationId, { streamId, turnStartedAt });
    setIsStreaming(true);

    const contextMessages = [...clearedHistory.messages, userMsg];
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
      ...buildGitBranchPrefixContext(gitBranchPrefix),
    ];
    void clientApi.chatSend({ streamId, assistantMessageId: assistantMsg.id, effort: turnEffort, mode, conversationId, modelProviderId, workspacePath, contextAttachments, configInstructions });
    return true;
  }, [
    isStreaming,
    hasProvider,
    conversationId,
    loadStatus,
    messages,
    onConversationUpdated,
    effort,
    mode,
    modelProviderId,
    systemInstructions,
    replyLanguage,
    gitBranchPrefix,
    workspacePath,
  ]);

  const handleSend = useCallback(async () => {
    // 恢复历史尚未完成时绝不允许发送：否则空 renderer 桶会先追加新回合，
    // 随后的流收尾再以短列表 replaceMessages，覆盖仍在磁盘上的完整历史。
    if (loadStatus !== 'ready') return;
    // 草稿由输入叶子独立订阅；发送瞬间直接读取会话桶，避免父表面闭包持有旧文本。
    const text = conversationStore.getSnapshot(conversationId).draft.trim();
    if ((!text && attachments.length === 0) || !hasProvider) return;
    const sentAttachments = attachments;

    // 草稿态：先创建会话进入左侧列表，再等 ready 后发出首条消息。
    if (!conversationId) {
      if (!onEnsureConversation || creatingConversationRef.current) return;
      creatingConversationRef.current = true;
      conversationStore.setDraft(conversationId, '');
      setAttachments([]);
      setAttachmentError(null);
      try {
        const title = text.slice(0, 48) || sentAttachments[0]?.name || (isZh ? '新对话' : 'New Chat');
        pendingFirstSendRef.current = { text, attachments: sentAttachments, effort };
        await onEnsureConversation({
          title,
          mode,
          effort,
          modelProviderId,
        });
      } catch (error) {
        pendingFirstSendRef.current = null;
        // 创建失败：恢复草稿与附件，用户可重试。
        conversationStore.setDraft(null, text);
        setAttachments(sentAttachments);
        setAttachmentError(error instanceof Error ? error.message : String(error));
      } finally {
        creatingConversationRef.current = false;
      }
      return;
    }

    conversationStore.setDraft(conversationId, '');
    setAttachments([]);
    setAttachmentError(null);
    // 当前轮(流式或压缩)进行中时,不丢弃也不阻塞输入:把消息排队,
    // 由 dequeue effect 在空闲后复用 submitMessage 自动发出下一条(类似 Codex 队列)。
    if (isStreaming || isCompactionActive) {
      enqueueMessage({ id: nextId(), text, attachments: sentAttachments, effort });
      return;
    }
    await submitMessage(text, sentAttachments);
  }, [
    attachments,
    isStreaming,
    isCompactionActive,
    hasProvider,
    conversationId,
    loadStatus,
    submitMessage,
    effort,
    enqueueMessage,
    onEnsureConversation,
    mode,
    modelProviderId,
    isZh,
  ]);

  // 草稿首条：会话 create 后 activeConversationId 切换并 load ready 时，自动发出挂起消息。
  useEffect(() => {
    if (!conversationId || loadStatus !== 'ready') return;
    const pending = pendingFirstSendRef.current;
    if (!pending) return;
    pendingFirstSendRef.current = null;
    void submitMessage(pending.text, pending.attachments, pending.effort);
  }, [conversationId, loadStatus, submitMessage]);

  // 任务续传(ADR 21):就绪后在「正确的会话内」自动发送。
  // App.tsx 已 peek 到会话锚定的待办、切到 resumeTask.sessionId 并经 prop 传入;这里要求
  // 当前 conversationId 已切到该 sessionId(回到中断现场)、provider 就绪、无流式进行中,
  // 才自动发出一次。resumeFiredRef 作一次性闸门防重发;发送成功后回调 onResumeConsumed,
  // 由 App.tsx 清空内存 resumeTask 并清除磁盘文件(成功后才删,确保失败不丢)。
  useEffect(() => {
    if (!resumeTask || !conversationId || !hasProvider || isStreaming) return;
    // 必须落到续传记录指定的那个会话,避免把任务发进错误/新建的会话。
    if (conversationId !== resumeTask.sessionId) return;
    if (resumeFiredRef.current === resumeTask.sessionId) return;
    resumeFiredRef.current = resumeTask.sessionId;
    const taskEffort =
      isEffortLevel(resumeTask.effort)
        ? resumeTask.effort
        : undefined;
    if (taskEffort) setEffort(taskEffort);
    void (async () => {
      await submitMessage(resumeTask.task, [], taskEffort);
      onResumeConsumed?.();
    })();
  }, [resumeTask, conversationId, hasProvider, isStreaming, submitMessage, onResumeConsumed]);

  const handleStop = useCallback(() => {
    if (streamIdRef.current) void clientApi.chatAbort({ streamId: streamIdRef.current });
  }, []);

  // 队列自动出队：loadStatus 只有在 reattach 收敛后才会 ready，避免切回运行中会话时
  // 把暂时的 isStreaming=false 当成真正空闲。每个会话同一时间只投递一条；发送路径明确
  // 接受后才移除队首，IPC 失败或前置条件变化时消息仍留在队列中。
  useEffect(() => {
    if (!canAutoDispatchQueuedMessage({
      loadStatus,
      isStreaming,
      isCompactionActive,
      hasProvider,
      hasConversation: Boolean(conversationId),
      hasResumeTask: Boolean(resumeTask),
      queueLength: messageQueue.length,
    })) return;
    if (!conversationId || queuedDispatchInFlightRef.current.has(conversationId)) return;
    const head = messageQueue[0];
    if (!head) return;
    queuedDispatchInFlightRef.current.add(conversationId);
    void dispatchQueuedMessage({
      message: head,
      submit: (message) => submitMessage(message.text, message.attachments, message.effort),
      remove: removeQueuedMessage,
    })
      .catch((error) => {
        setStreamError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        queuedDispatchInFlightRef.current.delete(conversationId);
      });
  }, [
    loadStatus,
    isStreaming,
    isCompactionActive,
    hasProvider,
    conversationId,
    resumeTask,
    messageQueue,
    removeQueuedMessage,
    submitMessage,
    setStreamError,
  ]);

  // 主操作按钮/回车键的统一入口。草稿内容由输入叶子决定按钮语义；这里按触发瞬间
  // 读取会话桶，确保不依赖父表面的高频草稿订阅。
  const handlePrimaryAction = useCallback(() => {
    const hasDraft = conversationStore.getSnapshot(conversationId).draft.trim().length > 0;
    if (hasDraft || attachments.length > 0) {
      void handleSend();
      return;
    }
    if (isStreaming) handleStop();
  }, [conversationId, attachments, isStreaming, handleSend, handleStop]);
  const stableHandlePrimaryAction = useStableCallback(handlePrimaryAction);

  const handleRegenerate = useCallback(async (msgIndex: number) => {
    if (isStreaming || !hasProvider || !conversationId) return;
    const target = messages[msgIndex];
    if (!target || target.role !== 'assistant') return;

    const contextMessages = messages.slice(0, msgIndex);
    const newAssistant: ChatMsg = {
      id: nextId(),
      role: 'assistant',
      content: '',
      segments: [],
      timestamp: Date.now(),
    };
    setMessages([...contextMessages, newAssistant]);
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);

    await clientApi.conversationsReplaceMessages({
      id: conversationId,
      messages: serializeConversationMessages([...contextMessages, newAssistant]),
    });

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnStartedAt = Date.now();
    streamIdRef.current = streamId;
    setTurnStartedAt(turnStartedAt);
    conversationStore.routeStream(streamId, conversationId);
    conversationStore.setState(conversationId, { streamId, turnStartedAt });
    setIsStreaming(true);

    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
      ...buildGitBranchPrefixContext(gitBranchPrefix),
    ];
    void clientApi.chatSend({ streamId, assistantMessageId: newAssistant.id, effort, mode, conversationId, modelProviderId, workspacePath, contextAttachments, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, effort, mode, modelProviderId, systemInstructions, replyLanguage, gitBranchPrefix, workspacePath]);

  const handleBranch = useCallback(async (msgIndex: number) => {
    if (!conversationId || isStreaming) return;
    const contextMessages = messages.slice(0, msgIndex + 1);
    const branchTitle = contextMessages.find((m) => m.role === 'user')?.content.slice(0, 50) || 'Branch';
    const conv = await clientApi.conversationsCreate({ title: branchTitle, workspacePath }) as { id: string };
    for (const m of contextMessages) {
      await clientApi.conversationsAppendMessage({ id: conv.id, message: { id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, durationMs: m.durationMs, timestamp: m.timestamp, _compaction: m.compaction, attachments: m.attachments, interrupted: m.interrupted } });
    }
    onConversationUpdated?.();
    onBranch?.(conv.id);
  }, [conversationId, isStreaming, messages, onConversationUpdated, onBranch, workspacePath]);

  const handleDeleteMessage = useCallback(async (msgIndex: number) => {
    if (!conversationId || isStreaming) return;
    // Drop the target message and any residual empty user bubbles so a later
    // stream-end full-list replace cannot resurrect a bare "你" message.
    const updated = messages
      .filter((_, i) => i !== msgIndex)
      .filter((m) => !isEmptyUserMessage(m));
    setMessages(updated);
    await clientApi.conversationsReplaceMessages({
      id: conversationId,
      messages: updated.map((m) => ({ id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, durationMs: m.durationMs, timestamp: m.timestamp, _compaction: m.compaction, attachments: m.attachments, interrupted: m.interrupted })),
      allowEmpty: updated.length === 0,
    });
    onConversationUpdated?.();
  }, [conversationId, isStreaming, messages, onConversationUpdated]);

  const handleEditMessage = useCallback(async (
    messageId: string,
    editedText: string,
    editedAttachments: readonly ChatAttachment[],
  ) => {
    if (isStreaming || !hasProvider || !conversationId || loadStatus !== 'ready') return false;
    const text = editedText.trim();
    if (!text && editedAttachments.length === 0) return false;
    const retainedMessages = historyBeforeEditedUserMessage(messages, messageId);
    if (!retainedMessages) return false;

    // 先把目标原消息及后续旧分支从持久化中清掉，再沿现有发送链路创建唯一的新消息。
    await clientApi.conversationsReplaceMessages({
      id: conversationId,
      messages: serializeConversationMessages(retainedMessages),
      allowEmpty: true,
    });
    await submitMessage(text, [...editedAttachments], undefined, retainedMessages);
    return true;
  }, [isStreaming, hasProvider, conversationId, loadStatus, messages, submitMessage]);
  const stableHandleEditMessage = useStableCallback(handleEditMessage);

  const handleMessageAction = useCallback((msgIndex: number, action: MessageActionId) => {
    if (action === 'regenerate') void handleRegenerate(msgIndex);
    else if (action === 'branch') void handleBranch(msgIndex);
    else if (action === 'delete') void handleDeleteMessage(msgIndex);
  }, [handleRegenerate, handleBranch, handleDeleteMessage]);
  const stableHandleMessageAction = useStableCallback(handleMessageAction);
  const stableHandleRegenerate = useStableCallback(handleRegenerate);

  // 顶部 header 级别的分叉:从当前最后一条消息分叉(复用已有 handleBranch)。
  const handleHeaderBranch = useCallback(() => {
    if (messages.length > 0) {
      void handleBranch(messages.length - 1);
    }
  }, [messages, handleBranch]);

  const showScrollToBottom = messages.length > 0 && !isThreadAtBottom;

  // 选择 request_user_input 的选项 = 把该选项作为用户消息，复用既有 submitMessage 发送路径。
  // 见 Goal 模式运行时闸门设计。
  // 稳定 action：引用不随 isStreaming / effort / conversationId 变化；
  // 调用时读最新闭包，避免流式帧让 GoalPlanPanel 的 onNextAction 失效。
  const selectInteractionOption = useStableCallback((text: string) => {
    if (!text || isStreaming || !hasProvider || !conversationId) return;
    void submitMessage(text, [], effort);
  });
  const interactionActions = useMemo(
    () => ({ onSelectOption: selectInteractionOption }),
    [selectInteractionOption],
  );
  const interactionStreaming = useMemo(
    () => ({ isStreaming }),
    [isStreaming],
  );

  // GoalPlanPanel 的批准动作只记录治理事实；真正执行由 main process Goal Runner
  // 监听 goalPlans:approve 后托管推进，renderer 不再伪造一条用户消息来启动执行。

  const handleGoalPlansCountChange = useCallback((count: number) => {
    setHasGoalPlan(count > 0);
  }, [setHasGoalPlan]);
  const handleGoalRequestFocus = useCallback(() => {
    if (workbenchOpen && workbenchActiveTab === 'plan') {
      setWorkbenchOpen(false);
      return;
    }
    setWorkbenchTab('plan');
    if (!workbenchOpen) setWorkbenchOpen(true);
  }, [workbenchOpen, workbenchActiveTab, setWorkbenchOpen, setWorkbenchTab]);
  // 仅当「本会话内真正新建了计划」（plans 0→N，由 GoalPlanPanel 的广播 reload 路径判定）
  // 时自动展开工作台并切到 Plan tab。切换到一个本来就有计划的会话不会触发，
  // 因为 GoalPlanPanel 的 load 路径只刷新基线、不回调。
  const handleGoalPlanCreated = useCallback(() => {
    setWorkbenchTab('plan');
    setWorkbenchOpen(true);
  }, [setWorkbenchTab, setWorkbenchOpen]);
  // hasGoalPlan 的唯一来源是 GoalPlanPanel 上报的 plans 数量（handleGoalPlansCountChange）。
  // 不要在 mode !== 'plan' 时强制清 false：goal 模式同样会创建/持有计划，
  // 清掉会导致 Workbench 的 plan tab 被 disabled，切到 browser 后无法切回。

  const workspaceLabel = useMemo(() => {
    if (!workspacePath) return null;
    const normalized = workspacePath.replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }, [workspacePath]);

  const emptyStarterCards = useMemo(() => {
    if (isZh) {
      return [
        {
          id: 'understand',
          title: '梳理现状',
          prompt: workspaceLabel
            ? `帮我梳理一下 ${workspaceLabel} 的当前状态，指出关键结构和最近值得关注的点。`
            : '帮我梳理一下当前工作区的状态，指出关键结构和最近值得关注的点。',
          icon: 'scan' as const,
        },
        {
          id: 'goal',
          title: '推进一个目标',
          prompt: workspaceLabel
            ? `我想在 ${workspaceLabel} 推进一个目标，先帮我拆成可执行步骤。`
            : '我想推进一个目标，先帮我拆成可执行步骤。',
          icon: 'target' as const,
        },
        {
          id: 'debug',
          title: '排查问题',
          prompt: workspaceLabel
            ? `我在 ${workspaceLabel} 遇到一个问题，先帮我定位可能原因和验证路径。`
            : '我遇到一个问题，先帮我定位可能原因和验证路径。',
          icon: 'debug' as const,
        },
      ];
    }
    return [
      {
        id: 'understand',
        title: 'Understand the current state',
        prompt: workspaceLabel
          ? `Help me understand the current state of ${workspaceLabel}, including structure and what matters most right now.`
          : 'Help me understand the current workspace state, including structure and what matters most right now.',
        icon: 'scan' as const,
      },
      {
        id: 'goal',
        title: 'Drive a goal forward',
        prompt: workspaceLabel
          ? `I want to drive a goal in ${workspaceLabel}. Break it into executable steps first.`
          : 'I want to drive a goal forward. Break it into executable steps first.',
        icon: 'target' as const,
      },
      {
        id: 'debug',
        title: 'Investigate a problem',
        prompt: workspaceLabel
          ? `I hit a problem in ${workspaceLabel}. Help me find likely causes and a verification path.`
          : 'I hit a problem. Help me find likely causes and a verification path.',
        icon: 'debug' as const,
      },
    ];
  }, [isZh, workspaceLabel]);

  const applyEmptyStarter = useCallback((prompt: string) => {
    if (!hasProvider) {
      onOpenSettings();
      return;
    }
    conversationStore.setDraft(conversationId, prompt);
    requestAnimationFrame(() => {
      const el = document.querySelector('.chat-composer textarea') as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus();
      const end = prompt.length;
      el.setSelectionRange(end, end);
    });
  }, [conversationId, hasProvider, onOpenSettings]);

  // 草稿态（conversationId === null）也渲染完整聊天面：可输入，首条发送时再落库。
  return (
    <WorkspacePathContext.Provider value={workspacePath ?? null}>
    <InteractionActionsContext.Provider value={interactionActions}>
    <InteractionStreamingContext.Provider value={interactionStreaming}>
    <div className="chat-workspace">
    <div
      className="chat-surface"
      onDragEnter={handleSurfaceDragEnter}
      onDragOver={handleSurfaceDragOver}
      onDragLeave={handleSurfaceDragLeave}
      onDrop={handleSurfaceDrop}
    >
      {isFileDropActive ? (
        <div className="chat-file-drop-overlay" aria-hidden="true">
          <div className="chat-file-drop-card">
            <div className="chat-file-drop-icon">＋</div>
            <div className="chat-file-drop-title">{isZh ? '松手添加到当前对话' : 'Drop to attach to this chat'}</div>
            <div className="chat-file-drop-subtitle">{isZh ? '文件会复用现有附件规则加入输入区' : 'Files will be added with the existing attachment rules'}</div>
          </div>
        </div>
      ) : null}
      <ChatHeader
        title={conversationTitle || (isDraftConversation ? (isZh ? '新对话' : 'New Chat') : '')}
        isZh={isZh}
        i18n={i18n}
        isStreaming={isStreaming}
        hasScroll={threadScrolled}
        localAccessLevel={localAccessLevel}
        editTriggerRef={headerEditTriggerRef}
        onOpenSettings={onOpenSettings}
        onRename={!isDraftConversation && onRenameConversation && conversationId
          ? (newTitle) => onRenameConversation(conversationId, newTitle)
          : undefined}
        onArchive={!isDraftConversation && onArchiveConversation && conversationId
          ? () => onArchiveConversation(conversationId)
          : undefined}
        onBranch={!isDraftConversation && messages.length > 0 ? handleHeaderBranch : undefined}
        onFind={() => setFindOpen(true)}
      />
      {findOpen ? (
        <ChatFindBar
          containerRef={threadRef}
          isZh={isZh}
          onClose={() => setFindOpen(false)}
          recomputeKey={messages.length}
        />
      ) : null}
      {currentTurnContext ? (
        <div className="current-turn-context" aria-label={isZh ? '当前问题' : 'Current question'}>
          <span className="current-turn-context-label">{isZh ? '当前问题' : 'Current'}</span>
          <span className="current-turn-context-text">{currentTurnContext}</span>
        </div>
      ) : null}
      <div
        className="chat-thread"
        ref={threadRef}
        onScroll={handleThreadScroll}
        onWheel={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
      >
        {/* 切会话 beginLoad 会先清空 messages；空首页仅 loadStatus === 'ready' 且无消息时显示。 */}
        {shouldShowConversationLoadingPlaceholder({ loadStatus, messageCount: messages.length }) ? (
          <div className="chat-thread-loading" role="status" aria-live="polite">
            <div className="chat-thread-loading-mark" aria-hidden="true" />
            <p>{isZh ? '正在加载会话…' : 'Loading conversation…'}</p>
          </div>
        ) : shouldShowConversationEmptyHome({ loadStatus, messageCount: messages.length }) ? (
          <div className="chat-empty-state">
            <div className="chat-empty-mark" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 9h8" />
                <path d="M8 13h5" />
                <path d="M5 5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
              </svg>
            </div>
            <h2>
              {!hasProvider
                ? (isZh ? '先连接 AI 服务，再开始任务' : 'Connect an AI service to get started')
                : workspaceLabel
                  ? (isZh ? `接下来在 ${workspaceLabel} 做什么？` : `What should we work on in ${workspaceLabel}?`)
                  : (isZh ? '接下来做什么？' : 'What should we work on?')}
            </h2>
            {!hasProvider ? (
              <>
                <p>
                  {isZh ? '请先' : 'Please '}
                  <button type="button" className="chat-link-btn" onClick={onOpenSettings}>
                    {isZh ? '连接 AI 服务' : 'connect an AI service'}
                  </button>
                  {isZh ? '后开始对话。' : ' to start chatting.'}
                </p>
                <div className="chat-empty-actions">
                  <button type="button" className="chat-empty-primary-btn" onClick={onOpenSettings}>
                    {isZh ? '连接 AI 服务' : 'Connect AI service'}
                  </button>
                </div>
              </>
            ) : (
              <p>{isZh ? '描述任务，或从下面选一个开始' : 'Describe a task, or pick a starting point below'}</p>
            )}
            {hasProvider ? (
              <div className="chat-empty-cards">
                {emptyStarterCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="chat-empty-card"
                    onClick={() => applyEmptyStarter(card.prompt)}
                  >
                    <span className={`chat-empty-card-icon chat-empty-card-icon--${card.icon}`} aria-hidden="true">
                      {card.icon === 'scan' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="7" />
                          <path d="m20 20-3.5-3.5" />
                        </svg>
                      ) : card.icon === 'target' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="8" />
                          <circle cx="12" cy="12" r="3" />
                          <path d="M12 2v2" />
                          <path d="M12 20v2" />
                          <path d="M2 12h2" />
                          <path d="M20 12h2" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 9v4" />
                          <path d="M12 17h.01" />
                          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                        </svg>
                      )}
                    </span>
                    <span className="chat-empty-card-title">{card.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <VirtualChatTurnList
            ref={virtualTurnListRef}
            conversationId={conversationId}
            turns={chatTurns}
            liveTurn={liveChatTurn}
            lastMessage={messages.at(-1)}
            isStreaming={isStreaming}
            streamStartedAt={convState.turnStartedAt}
            isZh={isZh}
            i18n={i18n}
            enabled={virtualizeChatTurns}
            scrollRef={threadRef}
            onMessageAction={stableHandleMessageAction}
            onEditMessage={stableHandleEditMessage}
            onRegenerate={stableHandleRegenerate}
            onPreviewImage={setImagePreview}
          />
        )}
        {providerRecoveryNotice ? (
          <div className={`provider-recovery-notice${providerRecoveryNotice.kind === 'connection' ? ' provider-recovery-notice--connection' : ''}`}>
            <div className="provider-recovery-body">
              {providerRecoveryNotice.kind === 'connection'
                ? providerRecoveryNotice.status === 'retrying'
                  ? isZh
                    ? `网络连接波动，正在重试连接（第 ${providerRecoveryNotice.attempt ?? 1}/${providerRecoveryNotice.maxRetries ?? 10} 次，约 ${connectionRetryRemainingSeconds ?? Math.ceil((providerRecoveryNotice.delayMs ?? 0) / 1000)}s 后重试）`
                    : `Network connection interrupted; retrying (${providerRecoveryNotice.attempt ?? 1}/${providerRecoveryNotice.maxRetries ?? 10}, in about ${connectionRetryRemainingSeconds ?? Math.ceil((providerRecoveryNotice.delayMs ?? 0) / 1000)}s)`
                  : isZh
                    ? '连接已恢复，正在继续生成'
                    : 'Connection recovered; continuing generation'
                : isZh
                  ? `主模型连接失败，已切换到 ${providerRecoveryNotice.toProvider || '备用模型'}`
                  : `Primary provider failed; switched to ${providerRecoveryNotice.toProvider || 'fallback provider'}`}
            </div>
            {providerRecoveryNotice.reason ? (
              <span className="provider-recovery-meta">
                {providerRecoveryNotice.kind === 'connection'
                  ? `${providerRecoveryNotice.provider || providerRecoveryNotice.model || 'connection'}: `
                  : providerRecoveryNotice.fromProvider ? `${providerRecoveryNotice.fromProvider}: ` : ''}
                {providerRecoveryNotice.reason}
              </span>
            ) : null}
          </div>
        ) : null}
        {showCompactionNotice ? (
          <div
            className={`compaction-notice${compactionProgressPercent === null ? ' compaction-notice--indeterminate' : ''}${isCompactionFailed ? ' compaction-notice--failed' : ''}`}
            role="progressbar"
            aria-label={isCompactionFailed ? compactionNoticeLabel : (isZh ? '压缩上下文进度' : 'Compaction progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={compactionProgressPercent ?? undefined}
            style={
              compactionProgressPercent !== null
                ? ({ '--compaction-fill': `${compactionProgressPercent}%` } as React.CSSProperties)
                : undefined
            }
          >
            {/* 底层：未填充全貌（灰波浪 + 灰字），全宽铺满 */}
            <span className="compaction-track compaction-track--base" aria-hidden="true">
              <span className="compaction-wave" />
              <span className="compaction-notice-label">
                {compactionNoticeLabel}
                {compactionProgressPercent !== null ? (
                  <span className="compaction-notice-percent">{compactionProgressPercent}%</span>
                ) : null}
              </span>
              <span className="compaction-wave" />
            </span>
            {/* 顶层：azure 全貌，按 --compaction-fill 从左裁剪露出（与底层逐像素对齐） */}
            <span className="compaction-track compaction-track--fill" aria-hidden="true">
              <span className="compaction-track__inner">
                <span className="compaction-wave" />
                <span className="compaction-notice-label">
                  {compactionNoticeLabel}
                  {compactionProgressPercent !== null ? (
                    <span className="compaction-notice-percent">{compactionProgressPercent}%</span>
                  ) : null}
                </span>
                <span className="compaction-wave" />
              </span>
            </span>
          </div>
        ) : null}
        {streamError ? (
          <div className="chat-stream-error">
            <span>
              ⚠{' '}
              {streamError === 'repetition_detected'
                ? isZh
                  ? '检测到重复输出，已自动停止本轮回复。'
                  : 'Repetitive output detected; this reply was stopped automatically.'
                : streamError}
            </span>
          </div>
        ) : null}
      </div>

      <MessageRail items={railItems} onSelect={scrollToMessage} i18n={i18n} />

      {showScrollToBottom ? (
        <button
          type="button"
          className="chat-scroll-bottom-btn"
          onClick={() => scrollThreadToBottom()}
          aria-label={isZh ? '滚动到底部' : 'Scroll to bottom'}
          title={isZh ? '滚动到底部' : 'Scroll to bottom'}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      ) : null}

      <div className="chat-composer-wrap">
        <GoalPlanPanel conversationId={conversationId} isZh={isZh} sidePanelContainer={goalSlot} onPlansCountChange={handleGoalPlansCountChange} onGoalPlanCreated={handleGoalPlanCreated} onRequestHostFocus={handleGoalRequestFocus} />
        <PermissionGateStrip
          pendingCalls={pendingPermissionCalls}
          onApprove={approvePendingPermissionCall}
          onApproveAlways={approveAlwaysPendingPermissionCall}
          onReject={denyPendingPermissionCall}
          i18n={i18n}
        />
        {/* 聊天侧镜像受治理批准卡：在 Plan 与 Goal 模式且存在 awaiting_approval 计划时显示。
            - plan:批准即放行后续执行(审批门)。
            - goal:批准即冻结目标契约并自动启动 Runner 托管自驱(A1)。
            点击复用与右侧面板同一条 goalPlansApprove 治理链路，状态互相消解。
            实质性追问（request_user_input）仍走对话流，二者正交。 */}
        <ChatGoalApprovalCard
          conversationId={conversationId}
          isZh={isZh}
          isStreaming={isStreaming}
          enabled={mode === 'plan' || mode === 'goal' || mode === 'chat'}
        />
        {messageQueue.length > 0 ? (
          <MessageQueue
            items={messageQueue}
            isZh={isZh}
            onRemove={removeQueuedMessage}
            onReorder={reorderQueuedMessage}
            onRefillToComposer={refillQueuedMessageToComposer}
          />
        ) : null}
        <ComposerDraftControls
          conversationId={conversationId}
          hasProvider={hasProvider}
          isBusy={isBusy}
          isStreaming={isStreaming}
          isZh={isZh}
          attachments={attachments}
          attachmentError={attachmentError}
          messageQueue={messageQueue}
          onRemoveAttachment={removeAttachment}
          onReorderAttachment={reorderAttachment}
          onPreviewImage={setImagePreview}
          onPaste={handlePaste}
          onAddFiles={addFiles}
          onAttachSessionReference={attachSessionReference}
          onPrimaryAction={stableHandlePrimaryAction}
        />
        <div className="chat-composer-toolbar">
          <div className="chat-composer-toolbar-left">
            <Dropdown
              className="composer-dropdown composer-mode-dropdown"
              value={modePickerValue(mode)}
              options={modeOptions}
              onChange={handleModeDropdownChange}
              ariaLabel={isZh ? '对话模式' : 'Chat mode'}
              title={modeTitle(mode, isZh)}
              menuPlacement="up"
            />
            <Dropdown
              className="composer-dropdown composer-access-dropdown"
              value={localAccessLevel}
              options={accessLevelOptions}
              onChange={handleAccessLevelDropdownChange}
              ariaLabel={isZh ? '本地访问模式' : 'Local access mode'}
              title={accessLevelTitle(localAccessLevel, isZh)}
              menuPlacement="up"
            />
          </div>
          <ComposerTokenUsageDisplay
            conversationId={conversationId}
            providers={providers}
            tokenUsage={tokenUsage}
            activeUsage={activeUsage}
            contextWindow={contextAccountingWindow}
            isStreaming={isStreaming}
            isZh={isZh}
            effort={effort}
            effortLevels={composerEffortLevels}
            onEffortChange={changeEffort}
            modelOptions={modelOptions}
            canSwitchModel={canSwitchModel}
            onModelChange={handleModelChange}
            selectedModelProviderId={modelProviderId}
          />
        </div>
      </div>
      {imagePreview?.kind === 'image' && imagePreview.dataUrl ? (
        <ImagePreviewOverlay attachment={imagePreview} isZh={isZh} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
    </div>
    </InteractionStreamingContext.Provider>
    </InteractionActionsContext.Provider>
    </WorkspacePathContext.Provider>
  );
}
