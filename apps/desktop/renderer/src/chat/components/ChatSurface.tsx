import type { I18nRuntime } from '@peer-agent/i18n';
import { createUnknownContextAccountingSnapshot } from '@peer-agent/runtime-core';
import type {
  AutomationCreateContext,
  AutomationProposalAction,
  ClientToolCall,
  ConfigInstructionContextItem,
  ContextAccountingSnapshot,
  ContextAttachmentItem,
  ContinuityContextItem,
  GoalRunnerStatus,
  LlmProviderConfigView,
} from '@peer-agent/protocol';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import type { DropdownOption } from '../../app/components/Dropdown';
import { Overlay } from '../../app/components/Overlay';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { updateModelOptionSelection } from '../../app/components/llmModelConfiguration';
import { isWorkspaceRequiredNotice, registeredWorkspacePath, workspaceRequiredNotice } from '../state/registeredWorkspace';
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
import { useWorkspaceGit } from '../hooks/useWorkspaceGit';
import { GitBranchGlyph, GitWorktreeGlyph } from './gitGlyphs';
import { loadComposerEntry, resolveComposerHydration, saveComposerEntry } from '../state/composerPersistence';
import {
  COMPOSER_ENV_ISOLATION_OFF,
  COMPOSER_ENV_ISOLATION_ON,
  buildComposerBranchOptions,
  canSelectComposerSourceBranch,
  defaultComposerUpstreamSpec,
  formatComposerBranchOptionLabel,
  formatComposerEnvCapsule,
  isSafeComposerBranchName,
  parseComposerUpstreamSpec,
  planComposerGitChrome,
  resolveComposerCreateSourceBranch,
  type TaskDeliveryLine,
} from '../state/taskBoundBranch';
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
import { findMessageTargetWithRetry } from '../state/messageNavigation';
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
  canShowStreamResume,
  formatStreamErrorLabel,
  resolveStreamResumeTarget,
  restoreStreamErrorFromInterrupted,
} from '../state/streamResume';
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
  ProviderRecoveryNotice,
  QueuedMessage,
  TextGroup,
  ThinkingGroup,
  ToolCallGroup,
  SegmentGroup,
} from '../state/types';
import { MarkdownMessage } from './markdown/MarkdownMessage';
import { WorkspacePathContext } from './markdown/InlineMarkdown';
import { ImagePreviewOverlay } from './thread/AttachmentStrip';
import {
  applyAutomationProposalActionResult,
  buildAutomationProposalActionRequest,
  selectAutomationChatProposal,
} from '../../automations/automationChatProposal';
import { AutomationProposalCard } from './AutomationProposalCard';
import { ComposerDraftControls } from './ComposerDraftControls';
import {
  buildSessionReferenceAttachment,
  type SessionReferenceHit,
} from '../state/sessionReference';
import {
  buildWorkspaceFileAttachment,
  type WorkspaceFileHit,
} from '../state/contextMention';
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
  DRAFT_CONVERSATION_ID,
  type ConversationRuntimeState,
} from '../state/conversationStore';
import { createFrameCoalescer } from '../state/frameCoalescer';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
import { useStreamingReport } from '../hooks/useStreamingReport';
import { registerBrowserToolReveal } from '../state/streamRouterOwnership';
import {
  planThreadScrollAfterMessagesChange,
  planThreadScrollOnConversationOpen,
  resolveThreadFollowAfterScroll,
} from '../state/threadScrollPolicy';
import {
  conversationHomeGreeting,
  shouldShowConversationEmptyHome,
  shouldShowConversationLoadingPlaceholder,
} from '../state/conversationEmptyStatePolicy';
import {
  shouldHardBeginConversationLoad,
  shouldPersistEffortCorrection,
} from '../state/conversationLoadGate';
import { mapInChunks } from '../state/yieldToMain';
import { resolveTurnStartedAt } from '../state/turnStartedAt';
import {
  getTurnUserMessage,
  groupMessagesIntoTurnsIncremental,
  shouldVirtualizeChatTurns,
  type ChatTurnGroupCache,
} from '../state/chatTurns';
import { useWorkbenchOptional } from '../../workbench/WorkbenchContext';

const SCROLL_BOTTOM_THRESHOLD_PX = 64;
const CURRENT_TURN_CONTEXT_PROBE_PX = 96;
const EMPTY_EFFORT_LEVELS: readonly EffortLevel[] = [];
/** 无 WorkbenchProvider 时的降级空操作（会话抽屉等 Provider 之外场景）。 */
const NOOP = () => {};

function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

// 重试倒计时文案：归零后说「正在重连」，避免本地倒计时钳在 0 时
// 长时间显示「约 0s 后重试」让用户误以为卡死。
function formatRetryCountdownLabel(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return '正在重连…';
  return `约 ${remainingSeconds}s 后重试`;
}

function formatRetryCountdownLabelEn(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return 'reconnecting…';
  return `in about ${remainingSeconds}s`;
}

// 排队等待时长文案：秒级显示 s，分钟级显示 m，避免长等待显示成一大串秒。
function formatQueueDurationLabel(ms: number): string {
  const value = Number(ms) || 0;
  if (value <= 0) return '';
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`;
  return `${Math.max(1, Math.round(value / 60_000))}m`;
}

function formatQueueNoticeText(notice: ProviderRecoveryNotice, isZh: boolean): string {
  const count = typeof notice.queueCount === 'number' && notice.queueCount > 0
    ? (isZh ? `，前方约 ${notice.queueCount} 人` : `, ~${notice.queueCount} ahead`)
    : '';
  const upstream = formatQueueDurationLabel(notice.upstreamWaitTimeMs ?? 0);
  const upstreamLabel = upstream
    ? (isZh ? `，上游预计等待 ~${upstream}` : `, upstream est. ~${upstream}`)
    : '';
  const waited = formatQueueDurationLabel(notice.waitedMs ?? 0);
  const waitedLabel = waited
    ? (isZh ? `，已等待 ${waited}` : `, waited ${waited}`)
    : '';
  const poll = formatQueueDurationLabel(notice.waitMs ?? 0);
  const pollLabel = poll
    ? (isZh ? `；每 ${poll} 查询一次队列` : `; polling every ${poll}`)
    : '';
  return isZh
    ? `Qoder 上游排队中${count}${upstreamLabel}${waitedLabel}${pollLabel}，正在按队列节奏等待…`
    : `Queued upstream at Qoder${count}${upstreamLabel}${waitedLabel}${pollLabel}; waiting on the queue cadence…`;
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
  const containerRect = container.getBoundingClientRect();
  const probeX = containerRect.left + Math.min(Math.max(container.clientWidth / 2, 1), Math.max(containerRect.width - 1, 1));
  const probeY = containerRect.top + CURRENT_TURN_CONTEXT_PROBE_PX;
  const hit = container.ownerDocument.elementFromPoint(probeX, probeY);
  const candidate = hit instanceof Element
    ? hit.closest<HTMLElement>('[data-chat-turn-id]')
    : null;
  if (!candidate || !container.contains(candidate)) return null;

  const turnId = candidate.dataset.chatTurnId ?? null;
  if (!turnId) return null;

  const userMessage = candidate.querySelector<HTMLElement>('.chat-msg-user');
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
  fastMode: boolean;
  preferredExecutionIsolation: 'none' | 'worktree';
  effort: EffortLevel;
  modelProviderId: string | null;
  contextAccounting: ContextAccountingSnapshot | null;
  automationCreateContext: AutomationCreateContext | null;
}> {
  const conv = await clientApi.conversationsGet({ id: conversationId });
  if (!conv?.messages) return {
    messages: [],
    tokenUsage: null,
    mode: 'chat',
    fastMode: false,
    preferredExecutionIsolation: 'none',
    effort: 'default',
    modelProviderId: null,
    contextAccounting: null,
    automationCreateContext: null,
  };
  // 对话模式按会话持久化在会话 meta 上;老会话无该字段时回退 'chat'，历史 'goal' 归一化为 'plan'。
  const convMode: ChatMode = normalizeChatMode(conv.mode);
  const convFastMode = conv.fastMode === true;
  const convPreferredExecutionIsolation: 'none' | 'worktree' =
    conv.preferredExecutionIsolation === 'worktree' ? 'worktree' : 'none';
  // 思考强度 + 模型 provider 也按会话持久化在会话 meta 上（与 mode 同口径，每会话独立）。
  // 老会话无字段时：effort 回退 'default'，modelProviderId 回退 null（用全局默认 provider）。
  const convEffort: EffortLevel = isEffortLevel(conv.effort) ? conv.effort : 'default';
  const convModelProviderId: string | null =
    typeof conv.modelProviderId === 'string' && conv.modelProviderId ? conv.modelProviderId : null;
  const contextAccounting: ContextAccountingSnapshot | null =
    conv.contextSnapshot?.version === 1 ? conv.contextSnapshot : null;
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const mapped = await mapInChunks(
    conv.messages as Record<string, unknown>[],
    (m) => {
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
  },
    { chunkSize: 32 },
  );
  const loaded = mapped.filter((message) => !isEmptyAssistantPlaceholder(message) && !isEmptyUserMessage(message));
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
      fastMode: convFastMode,
      preferredExecutionIsolation: convPreferredExecutionIsolation,
      effort: convEffort,
      modelProviderId: convModelProviderId,
      contextAccounting,
      automationCreateContext: conv.automationCreateContext ?? null,
    };
  }
  return {
    messages: loaded,
    tokenUsage: totalInput > 0 || totalOutput > 0 || totalCacheWrite > 0 || totalCacheRead > 0
      ? { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead }
      : null,
    mode: convMode,
    fastMode: convFastMode,
    preferredExecutionIsolation: convPreferredExecutionIsolation,
    effort: convEffort,
    modelProviderId: convModelProviderId,
    contextAccounting,
    automationCreateContext: conv.automationCreateContext ?? null,
  };
}

export function ChatSurface({
  i18n,
  providers,
  conversationId,
  conversationRevision,
  conversationTitle,
  automationOrigin = null,
  systemInstructions,
  replyLanguage,
  gitBranchPrefix,
  resumeTask,
  onResumeConsumed,
  onOpenSettings,
  onOpenTools,
  onConversationUpdated,
  onStreamingChange,
  onBranch,
  onTaskStarted,
  onRenameConversation,
  onArchiveConversation,
  onProvidersRefresh,
  workspacePath,
  workspaces = [],
  onWorkspaceChange,
  onWorkspaceUpdated,
  isPageActive,
  messageTarget,
  onOpenAutomationRun,
  onClose,
}: {
  readonly i18n: I18nRuntime;
  readonly providers: readonly LlmProviderConfigView[];
  readonly conversationId: string | null;
  readonly conversationRevision?: string | null;
  readonly conversationTitle?: string;
  readonly automationOrigin?: {
    kind: 'automation_run';
    automationId: string;
    runId: string;
    automationName?: string;
    triggerSource?: string;
    originWorkspacePath?: string;
    createdAt?: string;
  } | null;
  readonly systemInstructions?: string;
  readonly replyLanguage?: string;
  readonly gitBranchPrefix?: string;
  readonly resumeTask?: { sessionId: string; task: string; effort?: string } | null;
  readonly onResumeConsumed?: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenTools?: () => void;
  readonly onProvidersRefresh?: () => void | Promise<void>;
  readonly onConversationUpdated?: () => void;
  // 把当前会话的流式运行状态上报给上层(App),供左侧列表显示 Loading 图标。
  readonly onStreamingChange?: (conversationId: string | null, isStreaming: boolean) => void;
  readonly onBranch?: (newConversationId: string) => void;
  // 草稿态任务由 main 后台启动后，通知 App 选中任务并进入工作台。
  readonly onTaskStarted?: (conversationId: string) => void;
  readonly onRenameConversation?: (id: string, title: string) => void;
  readonly onArchiveConversation?: (id: string) => void;
  readonly onOpenAutomationRun?: (target: { automationId: string; runId: string }) => void;
  /** Drawer host close action; surfaces as a close control in ChatHeader. */
  readonly onClose?: () => void;
  // 分叉时把当前工作区透传给新建会话，使分叉会话与父会话同属一个工作区（否则会落到「无工作区」而在左侧列表被过滤隐藏）。
  readonly workspacePath?: string | null;
  readonly workspaces?: readonly { path: string; name: string; baseBranch?: string }[];
  readonly onWorkspaceChange?: (workspacePath: string) => Promise<void> | void;
  readonly onWorkspaceUpdated?: () => Promise<void> | void;
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
  const automationProposal = selectAutomationChatProposal(convState.automationCreateContext);
  const loadStatus = convState.loadStatus;
  const streamStatus = convState.streamStatus;
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
  const promoteQueuedMessageToFront = convActions.promoteQueuedMessageToFront;
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
  // 当前会话 meta 覆盖(见下方 conversationId effect)。模式真值最终经 chatSend / IPC
  // 进入 mode-source，再写入 System Context 的 L6_MODE_REMINDER 层。逻辑见 hooks/useConversationMode。
  const { mode, setMode, changeMode } = useConversationMode(conversationId);
  const fastMode = convState.fastMode;
  const [preferredWorktree, setPreferredWorktree] = useState(false);
  const { workspaceGit, workspaceIsGit, refreshWorkspaceGit } = useWorkspaceGit(workspacePath, {
    refreshWhenIdle: !isStreaming,
  });
  const [pendingBaseBranch, setPendingBaseBranch] = useState<string | null>(null);
  const [createBranchDialog, setCreateBranchDialog] = useState<{
    readonly source: string;
    readonly name: string;
    readonly push: boolean;
    readonly upstream: string;
  } | null>(null);
  const [branchPushNotice, setBranchPushNotice] = useState<{
    readonly branchName: string;
    readonly reason: string;
  } | null>(null);
  const [deliveryLine, setDeliveryLine] = useState<TaskDeliveryLine | null>(null);
  const [deliveryLineKnown, setDeliveryLineKnown] = useState(false);
  const [goalRunnerStatus, setGoalRunnerStatus] = useState<GoalRunnerStatus | null>(null);
  const persistDraftComposer = useCallback((patch: {
    draft?: string;
    queue?: ConversationRuntimeState['messageQueue'];
    fastMode?: boolean;
    preferredWorktree?: boolean;
  }) => {
    const draftComposer = conversationStore.getSnapshot(null);
    saveComposerEntry(DRAFT_CONVERSATION_ID, {
      draft: patch.draft ?? draftComposer.draft,
      queue: [...(patch.queue ?? draftComposer.messageQueue)],
      fastMode: patch.fastMode ?? fastMode,
      preferredWorktree: patch.preferredWorktree ?? preferredWorktree,
    });
  }, [fastMode, preferredWorktree]);
  const changeFastMode = useCallback((enabled: boolean) => {
    convActions.set({ fastMode: enabled });
    if (conversationId) {
      void clientApi.conversationsUpdateFastMode({ id: conversationId, fastMode: enabled }).catch(() => {
        // 本地 UI 仍保留选择；后续重新进入会按持久化值恢复。
      });
      return;
    }
    persistDraftComposer({ fastMode: enabled });
  }, [convActions, conversationId, persistDraftComposer]);
  const changePreferredWorktree = useCallback((enabled: boolean) => {
    setPreferredWorktree(enabled);
    if (conversationId) {
      void clientApi.conversationsUpdatePreferredExecutionIsolation({
        id: conversationId,
        preferredExecutionIsolation: enabled ? 'worktree' : 'none',
      }).catch(() => {
        // 本地 UI 仍保留选择；后续重新进入会按持久化值恢复。
      });
      return;
    }
    persistDraftComposer({ preferredWorktree: enabled });
  }, [conversationId, persistDraftComposer]);
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
  /** 会话级编辑态：目标用户消息进入底部输入框，而不是气泡内联编辑。 */
  const [editingMessage, setEditingMessage] = useState<{
    messageId: string;
    preview: string;
  } | null>(null);

  // 切换会话时退出编辑态，避免把 A 会话的编辑目标带到 B。
  useEffect(() => {
    setEditingMessage(null);
  }, [conversationId]);
  // 弱提示：非 vision 模型剥离本轮图片等（chat:stream:notice），不阻断发送。
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

  // 非 vision 模型剥离本轮图片等弱提示：不阻断发送，只在附件错误位短暂展示。
  useEffect(() => {
    if (typeof clientApi.onChatStreamNotice !== 'function') return undefined;
    return clientApi.onChatStreamNotice((payload) => {
      if (!payload || payload.code !== 'vision_images_stripped') return;
      const hint = i18n.t('settings.fallbackVision.strippedHint');
      setAttachmentError(hint);
      window.setTimeout(() => {
        setAttachmentError((current) => (current === hint ? null : current));
      }, 6000);
    });
  }, [i18n]);

  useEffect(() => {
    if (!registeredWorkspacePath(workspacePath, workspaces)) return;
    setAttachmentError((current) => (isWorkspaceRequiredNotice(current) ? null : current));
  }, [workspacePath, workspaces]);

  // connection retry 横幅倒计时：主进程只在进入 retrying 时推送一次 delayMs，
  // 表达层需要本地剩余秒数，才能每秒递减「约 Xs 后重试」。
  // 倒计时归零后文案切换为「正在重连…」，表达"等待本次尝试结果"而不是卡在"约 0s"。
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
  const lastThreadOpenConversationIdRef = useRef<string | null | undefined>(undefined);
  const previousMessageCountRef = useRef(messages.length);
  const messageNavigationRequestRef = useRef(0);
  const lastAppliedMessageTargetRequestId = useRef<number | null>(null);

  // 打开会话时在 render 阶段挂上贴底 pending，让同帧 layout restore 能等到列表挂载后再滚到底。
  // 不能放进 conversationId 的 useEffect：那会在首帧虚拟列表已经停在顶部之后才写入 pending。
  if (lastThreadOpenConversationIdRef.current !== conversationId) {
    lastThreadOpenConversationIdRef.current = conversationId;
    const openPlan = planThreadScrollOnConversationOpen({
      hasExplicitMessageTarget: Boolean(
        conversationId
        && messageTarget
        && messageTarget.conversationId === conversationId
        && lastAppliedMessageTargetRequestId.current !== messageTarget.requestId,
      ),
    });
    pendingThreadScrollRestoreRef.current = conversationId && openPlan.stickToBottom
      ? { conversationId, snapshot: null }
      : null;
    shouldAutoScrollRef.current = Boolean(conversationId) && openPlan.stickToBottom;
    previousMessageCountRef.current = messages.length;
  }

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

  const saveThreadScrollSnapshot = useCallback((
    id: string | null,
    container: HTMLDivElement | null,
    currentTurnId?: string | null,
  ) => {
    if (!id || !container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const turnId = currentTurnId === undefined
      ? findCurrentTurnIdForScroll(container)
      : currentTurnId;
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

  const updateCurrentTurnContext = useCallback((
    container: HTMLDivElement | null,
    currentTurnId?: string | null,
  ) => {
    const nextTurnId = currentTurnId === undefined
      ? (container ? findCurrentTurnIdForScroll(container) : null)
      : currentTurnId;
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
    // 贴底后立刻用真实 scrollTop/高度重算窗口，避免视口已回到顶部、条目还挂在底部 spacer。
    updateVirtualViewport();
  }, [saveThreadScrollSnapshot, updateCurrentTurnContext, updateVirtualViewport]);

  const threadScrollCoalescerRef = useRef(createFrameCoalescer({
    request: (callback) => requestAnimationFrame(callback),
    cancel: (frameId) => cancelAnimationFrame(frameId),
  }));
  const processThreadScrollFrame = useCallback((
    container: HTMLDivElement,
    userInitiated: boolean,
  ) => {
    updateVirtualViewport();
    updateThreadBottomState(container, { userInitiated });
    const currentTurnId = findCurrentTurnIdForScroll(container);
    updateCurrentTurnContext(container, currentTurnId);
    if (pendingThreadScrollRestoreRef.current?.conversationId !== conversationId) {
      saveThreadScrollSnapshot(conversationId, container, currentTurnId);
    }
    const nextScrolled = container.scrollTop > 4;
    setThreadScrolled((previous) => (previous === nextScrolled ? previous : nextScrolled));
  }, [conversationId, saveThreadScrollSnapshot, updateCurrentTurnContext, updateThreadBottomState, updateVirtualViewport]);
  const handleThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const userInitiated = userScrollIntentRef.current;
    // Scroll can dispatch far faster than React can commit a long thread. Keep the latest
    // container state and coalesce virtual range updates and geometry probes to one pass per frame.
    // Virtual viewport only setStates when the window indices/padding change; bottom/turn/scrolled
    // flags also apply equality gates so mid-range scrolling does not re-render the whole surface.
    threadScrollCoalescerRef.current.request(() => {
      processThreadScrollFrame(container, userInitiated);
    });
  }, [processThreadScrollFrame]);

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
    if (!container) return false;
    const turnIndex = messageTurnIndex.get(id);
    if (turnIndex == null) return false;

    const requestId = messageNavigationRequestRef.current + 1;
    messageNavigationRequestRef.current = requestId;
    const requestConversationId = conversationIdRef.current;
    shouldAutoScrollRef.current = false;
    setIsThreadAtBottom((previous) => (previous ? false : previous));
    scrollToTurn(turnIndex, { align: 'center' });
    void findMessageTargetWithRetry({
      findTarget: () => container.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`),
      scheduleFrame: (callback) => window.requestAnimationFrame(callback),
      isActive: () => (
        messageNavigationRequestRef.current === requestId
        && conversationIdRef.current === requestConversationId
      ),
    }).then((target) => {
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('chat-msg-flash');
      void target.offsetWidth;
      target.classList.add('chat-msg-flash');
      window.setTimeout(() => target.classList.remove('chat-msg-flash'), 1600);
    });
    return true;
  }, [messageTurnIndex, scrollToTurn]);

  useEffect(() => {
    if (!messageTarget || messageTarget.conversationId !== conversationId) return;
    if (lastAppliedMessageTargetRequestId.current === messageTarget.requestId) return;
    if (scrollToMessage(messageTarget.messageId)) {
      lastAppliedMessageTargetRequestId.current = messageTarget.requestId;
    }
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
  // 已有会话恢复完成前，当前 effort/provider 只是临时种子，不能把校正结果当成用户选择持久化。
  useEffect(() => {
    if (!activeProviderSupportsReasoning) return;
    if (effortLevels.includes(effort)) return;
    if (!shouldPersistEffortCorrection({ conversationId, loadStatus })) return;
    const preferred = resolvePreferredEffort(
      effortLevels,
      activeProvider?.reasoningDefaultEffort,
    );
    if (preferred !== effort) changeEffort(preferred);
  }, [
    activeProvider?.reasoningDefaultEffort,
    activeProviderSupportsReasoning,
    changeEffort,
    conversationId,
    effort,
    effortLevels,
    loadStatus,
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
  const actOnAutomationProposal = useCallback(async (action: AutomationProposalAction) => {
    if (!conversationId || !automationProposal) return;
    const result = await clientApi.automationProposalAct(
      buildAutomationProposalActionRequest(conversationId, automationProposal, action),
    );
    convActions.set({
      automationCreateContext: applyAutomationProposalActionResult(
        convState.automationCreateContext,
        result,
      ),
    });
  }, [automationProposal, convActions, convState.automationCreateContext, conversationId]);
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
  const workspaceOptions = useMemo<readonly DropdownOption[]>(
    () => workspaces.map((workspace) => ({
      value: workspace.path,
      label: workspace.name,
    })),
    [workspaces],
  );
  const hasRegisteredWorkspace = Boolean(registeredWorkspacePath(workspacePath, workspaces));
  const handleAddWorkspace = useCallback(async () => {
    const result = await clientApi.workspaceAdd();
    if (result?.path) await onWorkspaceChange?.(result.path);
  }, [onWorkspaceChange]);
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
    const restoreKey = contextAccountingRestoreKey(restoreInput);
    let cancelled = false;
    void clientApi.chatContextRestored({
      conversationId,
      modelProviderId: activeProvider?.id ?? modelProviderId,
    })
      .then((snap) => {
        if (cancelled) return;
        // 仅在请求真正结算后锁定 key：effect cleanup / 快速切会话不再把 restore 锁死。
        contextRestoreAttemptedKeysRef.current.add(restoreKey);
        if (!snap) return;
        contextRestoreAttemptedKeysRef.current.add(contextAccountingRestoreKey({
          ...restoreInput,
          snapshot: snap,
        }));
        setContextAccountingSnapshot(snap);
      })
      .catch(() => {
        if (cancelled) return;
        // 失败也锁定同一 key，避免接口异常时重投影死循环。
        contextRestoreAttemptedKeysRef.current.add(restoreKey);
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
    setGoalRunnerStatus(null);
    // streamError 按会话桶隔离：不要在切到目标会话时把它清掉。
    // 上一会话的横幅不会串过来；本会话若仍是中断态，加载后从 interrupted 还原。
    // 切换会话时恢复「该会话」输入框状态(草稿文本 + 待发送队列):
    // - 同会话二次进入：优先保留 conversationStore 桶内已有草稿/队列，避免被尚未落盘的空持久化冲掉；
    // - 冷启动 / 首次进入：回落 composerPersistence。
    // 草稿区附件不持久化(见 composerPersistence 取舍说明),故切换会话后附件区始终清空。
    const liveComposer = conversationStore.getSnapshot(conversationId);
    const composerId = conversationId ?? DRAFT_CONVERSATION_ID;
    const persisted = loadComposerEntry(composerId);
    const hydrated = resolveComposerHydration(liveComposer, persisted);
    convActions.set({
      draft: hydrated.draft,
      // live 路径直接复用桶内 QueuedMessage；persisted 路径形状兼容。
      messageQueue: hydrated.queue as typeof liveComposer.messageQueue,
      ...(conversationId ? {} : { fastMode: persisted?.fastMode === true }),
    });
    // 草稿页才用本地 draft 偏好；已有会话等 loadConversationMessages 恢复真实 meta，
    // 避免先强制 false 造成「未勾选但实际仍是 worktree」的误导窗口。
    if (!conversationId) {
      setPreferredWorktree(persisted?.preferredWorktree === true);
    }
    setDeliveryLine(null);
    setDeliveryLineKnown(false);
    // 打开会话的默认落点（贴底）在 render 阶段写入 pendingThreadScrollRestoreRef，
    // 避免等这个 useEffect 才挂 pending，导致加载占位上的空容器贴底被清掉后列表从顶部挂载。
    setIsThreadAtBottom((previous) => {
      const next = pendingThreadScrollRestoreRef.current != null;
      return previous === next ? previous : next;
    });
    // 切换会话时,先把流式表达状态按会话归零,避免上一会话的 isStreaming/streamId/toolProgress 残留:
    // 否则从"正在输出的 A"切到"未运行的 B",B 会误显示运行中(左侧列表 Loading、
    // 右下角停止按钮误亮),也会让"正在准备工具参数"残留到新会话。
    // 归零后由下方 reattach 按"新会话是否确有活跃流"重新点亮,仅以真值为准。
    // 自动出队看 streamStatus，不在这里单独 setIsStreaming(false)：已 ready 会话会走
    // beginStreamReattach，把流状态标成 unknown，避免假空闲窗口把队列发出去。
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
    } else {
      convActions.beginStreamReattach();
    }
    let cancelled = false;
    void (async () => {
      const {
        messages: loaded,
        tokenUsage: usage,
        mode: convMode,
        fastMode: convFastMode,
        preferredExecutionIsolation: convPreferredExecutionIsolation,
        effort: convEffort,
        modelProviderId: convModelProviderId,
        contextAccounting: storedContextAccountingSnapshot,
        automationCreateContext,
      } = await loadConversationMessages(conversationId);
      if (cancelled) return;
      // 消息可以先投影到 UI；硬加载时 loadStatus 仍保持 loading，直到 compaction/stream
      // reattach 全部收敛；静默刷新则保持 ready，避免闪空。
      convActions.set({
        messages: loaded,
        tokenUsage: usage,
        contextAccounting: storedContextAccountingSnapshot,
        automationCreateContext,
        streamError: restoreStreamErrorFromInterrupted(
          loaded,
          conversationStore.getSnapshot(conversationId).streamError,
          conversationStore.getSnapshot(conversationId).isStreaming,
        ),
      });
      // 对话模式随会话恢复:每会话各自独立,切换会话即切到该会话自己的模式。
      setMode(convMode);
      convActions.set({ fastMode: convFastMode });
      setPreferredWorktree(convPreferredExecutionIsolation === 'worktree');
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
            // 切换回进行中会话：优先恢复 bucket 既有锚点 / 最后用户消息时间戳，
            // 不能直接用 live.startedAt（Goal Runner 每 tick 换流，那是当前 tick 起点）。
            const existingAnchor = conversationStore.getSnapshot(conversationId).turnStartedAt;
            const restoredAnchor = resolveTurnStartedAt({
              existing: existingAnchor,
              messages: loaded,
              fallback: liveStartedAt,
            });
            if (restoredAnchor != null) {
              setTurnStartedAt(restoredAnchor);
            }
            conversationStore.routeStream(live.streamId, conversationId);
            conversationStore.setState(conversationId, {
              streamId: live.streamId,
              ...(restoredAnchor != null ? { turnStartedAt: restoredAnchor } : {}),
            });
            setIsStreaming(true);
            setStreamError(null);
          }
        }
      } catch {
        // reattach 失败不影响正常加载;降级为无续接(用户可重新发送)。
      }
      if (cancelled) return;
      // 只有 main 侧流状态已经查询完毕，才把会话标记为可发送；running=true 已在上面先恢复，
      // 因而 ready 首帧不会暴露错误的「非流式空闲」窗口。
      // reattach 可能刚补上 interrupted；按当前消息再绑一次输入框提醒。
      const loadedSnapshot = conversationStore.getSnapshot(conversationId);
      convActions.commitLoad({
        streamError: restoreStreamErrorFromInterrupted(
          loadedSnapshot.messages,
          loadedSnapshot.streamError,
          loadedSnapshot.isStreaming,
        ),
      });
    })();
    return () => { cancelled = true; };
  }, [conversationId, convActions, setTurnStartedAt]);

  useEffect(() => {
    setPendingBaseBranch(null);
  }, [workspacePath]);

  useEffect(() => {
    if (workspaceIsGit === false) setPreferredWorktree(false);
  }, [workspaceIsGit]);

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
      automationCreateContext,
    }) => {
      if (cancelled) return;
      appliedExternalRevisionRef.current = conversationRevision;
      convActions.commitLoad({
        messages: loaded,
        tokenUsage: usage,
        contextAccounting: storedContextAccountingSnapshot,
        automationCreateContext,
        streamError: restoreStreamErrorFromInterrupted(
          loaded,
          conversationStore.getSnapshot(conversationId).streamError,
          conversationStore.getSnapshot(conversationId).isStreaming,
        ),
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
      // 计时真值是「本轮用户消息发送时刻」。Goal Runner 每 tick 都会换新 stream，
      // 这里只绑定流与消息占位；仅当 bucket 尚无锚点时才补种，绝不覆盖已有起点。
      const bucket = conversationStore.getSnapshot(conversationId);
      const turnStartedAt = resolveTurnStartedAt({
        existing: bucket.turnStartedAt,
        messages: bucket.messages,
        fallback: now,
      });
      if (turnStartedAt != null) {
        setTurnStartedAt(turnStartedAt);
      }
      conversationStore.routeStream(streamId, conversationId);
      conversationStore.setState(conversationId, {
        streamId,
        ...(turnStartedAt != null && bucket.turnStartedAt == null
          ? { turnStartedAt }
          : {}),
      });
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
  }, [conversationId, onConversationUpdated, setTurnStartedAt]);

  // Workbench Goal slot：portal target 由右侧工作台 GoalView 提供。
  // 会话抽屉等渲染在 WorkbenchProvider 之外的场景也复用本组件：用可选版，
  // 无 Provider 时 goalSlot=null（GoalPlanPanel 独立渲染）、开关动作降级为
  // noop，避免抛 "useWorkbench must be used within a WorkbenchProvider"。
  const workbench = useWorkbenchOptional();
  const goalSlot = workbench?.goalSlot ?? null;
  const setHasGoalPlan = workbench?.setHasGoalPlan ?? NOOP;
  const workbenchOpen = workbench?.open ?? false;
  const workbenchActiveTab = workbench?.activeTab ?? 'plan';
  const setWorkbenchOpen = workbench?.setOpen ?? NOOP;
  const setWorkbenchTab = workbench?.setActiveTab ?? NOOP;
  // Agent 调用内置浏览器工具（browser_*）时自动展开工作台并切到 Browser Tab，
  // 复用 Goal 计划创建时的自动切 Tab 先例，避免 webview 隐藏导致用户看不到 Agent 操作。
  const handleBrowserToolActivity = useCallback(() => {
    setWorkbenchTab('browser');
    setWorkbenchOpen(true);
  }, [setWorkbenchTab, setWorkbenchOpen]);

  useEffect(() => registerBrowserToolReveal(conversationId, handleBrowserToolActivity), [
    conversationId,
    handleBrowserToolActivity,
  ]);

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

  // 流订阅已上移到 App 顶层唯一一份。这里只注册浏览器工具展开副作用，
  // 避免多个 ChatSurface 同时在世时重复订阅同一条 delta。

  useLayoutEffect(() => {
    const pending = pendingThreadScrollRestoreRef.current;
    if (!pending || pending.conversationId !== conversationId) return;
    const container = threadRef.current;
    if (!container) return;
    // 加载占位替换虚拟列表时贴底会落到空容器并清掉 pending，随后列表从顶部挂载。
    if (shouldShowConversationLoadingPlaceholder({ loadStatus, messageCount: messages.length })) {
      return;
    }

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

    const pendingMessageTarget = Boolean(
      messageTarget
      && messageTarget.conversationId === conversationId
      && lastAppliedMessageTargetRequestId.current !== messageTarget.requestId,
    );
    if (pendingMessageTarget) {
      shouldAutoScrollRef.current = false;
      pendingThreadScrollRestoreRef.current = null;
      return;
    }

    if (messages.length === 0) {
      finishRestore();
      return;
    }

    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom((previous) => (previous ? previous : true));
    scrollThreadToBottom('auto');

    let cancelled = false;
    let remaining = 2;
    let frameId = window.requestAnimationFrame(function reaffirmOpenBottom() {
      if (
        cancelled
        || pendingThreadScrollRestoreRef.current !== pending
        || conversationIdRef.current !== pending.conversationId
      ) return;
      remaining -= 1;
      scrollThreadToBottom('auto');
      if (remaining > 0) {
        frameId = window.requestAnimationFrame(reaffirmOpenBottom);
        return;
      }
      finishRestore();
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [
    conversationId,
    loadStatus,
    messageTarget,
    messages,
    saveThreadScrollSnapshot,
    scrollThreadToBottom,
    updateCurrentTurnContext,
    updateThreadBottomState,
    updateVirtualViewport,
  ]);

  // 记录上一帧消息条数：压缩/整表重写通常会减少条数，此时旧的 index 高度缓存与新时间线错位。
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

  const attachWorkspaceFile = useCallback((hit: WorkspaceFileHit) => {
    const attachment = buildWorkspaceFileAttachment(hit);
    setAttachments((prev) => {
      const filtered = prev.filter((item) => item.workspaceRelPath !== attachment.workspaceRelPath);
      return [...filtered, attachment];
    });
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

  const cancelComposerEdit = useCallback(() => {
    setEditingMessage(null);
  }, []);

  const beginComposerEdit = useCallback((
    messageId: string,
    text: string,
    messageAttachments: readonly ChatAttachment[],
  ) => {
    const preview = text.trim().replace(/\s+/g, ' ');
    setEditingMessage({
      messageId,
      preview: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
    });
    conversationStore.setDraft(conversationId, text);
    setAttachments(messageAttachments.map((item) => ({ ...item })));
    setAttachmentError(null);
    // 聚焦底部输入框，让编辑立即进入主输入流。
    window.requestAnimationFrame(() => {
      const el = document.querySelector('.chat-composer textarea') as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      try { el.setSelectionRange(end, end); } catch { /* ignore */ }
    });
  }, [conversationId]);

  const stableBeginComposerEdit = useStableCallback(beginComposerEdit);
  const stableCancelComposerEdit = useStableCallback(cancelComposerEdit);

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
    setEditingMessage(null);
    return true;
  }, [isStreaming, hasProvider, conversationId, loadStatus, messages, submitMessage]);

  const handleSend = useCallback(async () => {
    // 恢复历史尚未完成时绝不允许发送：否则空 renderer 桶会先追加新回合，
    // 随后的流收尾再以短列表 replaceMessages，覆盖仍在磁盘上的完整历史。
    if (loadStatus !== 'ready') return;
    // 草稿由输入叶子独立订阅；发送瞬间直接读取会话桶，避免父表面闭包持有旧文本。
    const text = conversationStore.getSnapshot(conversationId).draft.trim();
    if ((!text && attachments.length === 0) || !hasProvider) return;
    const sentAttachments = attachments;

    // 编辑态：复用截断历史后重发语义，不走普通发送/排队。
    if (editingMessage) {
      const ok = await handleEditMessage(editingMessage.messageId, text, sentAttachments);
      if (ok) {
        conversationStore.setDraft(conversationId, '');
        setAttachments([]);
        setAttachmentError(null);
      }
      return;
    }

    // 草稿态：由 main 原子创建会话、持久化首条消息并启动后台 turn。
    // ChatSurface 不再是执行中转页，命令返回后即可直接进入工作台。
    if (!conversationId) {
      if (!registeredWorkspacePath(workspacePath, workspaces)) {
        setAttachmentError(workspaceRequiredNotice(isZh));
        return;
      }
      if (creatingConversationRef.current) return;
      creatingConversationRef.current = true;
      conversationStore.setDraft(conversationId, '');
      setAttachments([]);
      setAttachmentError(null);
      // 发送成功后立刻清掉共享草稿文本/队列，但保留 Fast / 隔离执行偏好。
      // ComposerDraftControls 在 conversationId === null 时不落盘；勾选隔离执行时
      // saveComposerEntry 也不会删除空壳，旧句子会在下次「新建任务」被灌回来。
      persistDraftComposer({ draft: '', queue: [] });
      try {
        const title = text.slice(0, 48) || sentAttachments[0]?.name || (isZh ? '新对话' : 'New Chat');
        const started = await clientApi.chatStartTask({
          text,
          title,
          workspacePath,
          mode,
          effort,
          fastMode,
          preferredExecutionIsolation: preferredWorktree && workspaceIsGit !== false ? 'worktree' : 'none',
          modelProviderId,
          attachments: sentAttachments,
        });
        onTaskStarted?.(started.conversationId);
      } catch (error) {
        // 启动失败：恢复草稿与附件，用户可重试。
        conversationStore.setDraft(null, text);
        persistDraftComposer({ draft: text, queue: [] });
        setAttachments(sentAttachments);
        const message = error instanceof Error ? error.message : String(error);
        setAttachmentError(message === 'workspace_required'
          ? workspaceRequiredNotice(isZh)
          : message);
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
    onTaskStarted,
    workspacePath,
    workspaces,
    mode,
    fastMode,
    modelProviderId,
    preferredWorktree,
    workspaceIsGit,
    persistDraftComposer,
    isZh,
    editingMessage,
    handleEditMessage,
  ]);

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

  /**
   * 排队消息插队发送：
   * 1) 将目标消息提到队首；
   * 2) 若当前正在流式回复则 abort；
   * 3) 空闲后由既有自动出队 effect 强送队首，其余队列顺序保持相对不变。
   */
  const handleForceSendQueued = useCallback((id: string) => {
    promoteQueuedMessageToFront(id);
    if (streamIdRef.current) {
      void clientApi.chatAbort({ streamId: streamIdRef.current });
    }
  }, [promoteQueuedMessageToFront]);

  // 队列自动出队：streamStatus 只有在 reattach 收敛后才会 confirmed，避免切回运行中会话时
  // 把暂时的 isStreaming=false 当成真正空闲。Goal Runner 占用会话时同样让路。
  // 每个会话同一时间只投递一条；发送路径明确接受后才移除队首。
  useEffect(() => {
    if (!canAutoDispatchQueuedMessage({
      loadStatus,
      streamStatus,
      isStreaming,
      isCompactionActive,
      hasProvider,
      hasConversation: Boolean(conversationId),
      hasResumeTask: Boolean(resumeTask),
      queueLength: messageQueue.length,
      goalRunnerStatus: goalRunnerStatus ?? null,
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
    streamStatus,
    isStreaming,
    isCompactionActive,
    hasProvider,
    conversationId,
    resumeTask,
    messageQueue,
    goalRunnerStatus,
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
    void clientApi.chatSend({ streamId, assistantMessageId: newAssistant.id, effort, fastMode, mode, conversationId, modelProviderId, workspacePath, contextAttachments, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, effort, fastMode, mode, modelProviderId, systemInstructions, replyLanguage, gitBranchPrefix, workspacePath]);

  // 原地续写中断回复：不清空、不重建消息。复用被中断那条 assistant 消息的 id，
  // 只摘掉 interrupted 标记；主进程以该消息已落盘正文/segments 为累积种子
  // （ChatSendRequest.resumeInterruptedReply），渲染端 delta 照常追加到这条消息。
  const handleContinueStream = useCallback(async (msgIndex: number) => {
    if (isStreaming || !hasProvider || !conversationId) return;
    const target = messages[msgIndex];
    if (!target || target.role !== 'assistant') return;

    // 摘标记后立即写回 store，保证重载/切会话期间 banner 不会因 interrupted 复活；
    // 续写失败（再次中断）时主进程会重新打上 interrupted。
    const { interrupted: _removed, ...rest } = target;
    const resumedMessage: ChatMsg = { ...rest };
    const nextMessages = messages.map((message, index) => (index === msgIndex ? resumedMessage : message));
    setMessages(nextMessages);
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);

    await clientApi.conversationsReplaceMessages({
      id: conversationId,
      messages: serializeConversationMessages(nextMessages),
    });

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    // 计时锚点回拨到原消息时间戳：用户看到的是「同一条回复继续计时」，
    // 与主进程 streamRecord.startedAt 的种子语义一致。
    const turnStartedAt = resolveTurnStartedAt({
      existing: conversationStore.getSnapshot(conversationId).turnStartedAt,
      messages: nextMessages,
      fallback: Date.now(),
    }) ?? Date.now();
    setTurnStartedAt(turnStartedAt);
    conversationStore.routeStream(streamId, conversationId);
    conversationStore.setState(conversationId, { streamId, turnStartedAt });
    setIsStreaming(true);

    const contextAttachments = buildConversationAttachmentContext(nextMessages.slice(0, msgIndex));
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
      ...buildGitBranchPrefixContext(gitBranchPrefix),
    ];
    void clientApi.chatSend({
      streamId,
      assistantMessageId: resumedMessage.id,
      resumeInterruptedReply: true,
      effort,
      fastMode,
      mode,
      conversationId,
      modelProviderId,
      workspacePath,
      contextAttachments,
      configInstructions,
    });
  }, [isStreaming, hasProvider, conversationId, messages, effort, fastMode, mode, modelProviderId, systemInstructions, replyLanguage, gitBranchPrefix, workspacePath]);

  const handleResumeStream = useCallback(() => {
    if (isStreaming || !hasProvider) return;
    const target = resolveStreamResumeTarget(messages);
    if (!target) return;
    if (target.kind === 'regenerate') {
      void handleRegenerate(target.assistantIndex);
      return;
    }
    if (target.kind === 'continue') {
      void handleContinueStream(target.assistantIndex);
      return;
    }
    const userMsg = messages[target.userIndex];
    if (!userMsg || userMsg.role !== 'user') return;
    void submitMessage(
      userMsg.content,
      userMsg.attachments ?? [],
      effort,
      messages.slice(0, target.userIndex),
    );
  }, [isStreaming, hasProvider, messages, handleRegenerate, handleContinueStream, submitMessage, effort]);

  const handleDismissStreamError = useCallback(() => {
    setStreamError(null);
  }, [setStreamError]);

  const showStreamResume = canShowStreamResume(streamError, messages, isStreaming);

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
  const handleActiveDeliveryChange = useCallback((line: TaskDeliveryLine | null) => {
    setDeliveryLine(line);
    setDeliveryLineKnown(true);
  }, []);
  const handleActiveGoalRunnerStatusChange = useCallback((status: GoalRunnerStatus | null) => {
    setGoalRunnerStatus(status);
  }, []);
  const workspaceBaseBranch = useMemo(() => {
    const pending = pendingBaseBranch?.trim();
    if (pending) return pending;
    const match = workspaces.find((workspace) => workspace.path === workspacePath);
    const configured = match?.baseBranch?.trim();
    return configured ? configured : null;
  }, [pendingBaseBranch, workspacePath, workspaces]);
  const gitChrome = useMemo(
    () => planComposerGitChrome({
      delivery: deliveryLine,
      workspaceBaseBranch: workspaceBaseBranch,
      currentHead: workspaceGit?.ok ? workspaceGit.current : null,
      isDraft: isDraftConversation,
      deliveryKnown: isDraftConversation || deliveryLineKnown,
    }, { locale: isZh ? 'zh' : 'en' }),
    [deliveryLine, deliveryLineKnown, isDraftConversation, isZh, workspaceBaseBranch, workspaceGit],
  );
  const canSelectBoundBranch = canSelectComposerSourceBranch({
    isDraft: isDraftConversation,
    delivery: deliveryLine,
  }) && gitChrome.taskLine?.selectable === true;
  const envCapsule = useMemo(
    () => formatComposerEnvCapsule(gitChrome, {
      locale: isZh ? 'zh' : 'en',
      preferredIsolation: preferredWorktree,
    }),
    [gitChrome, isZh, preferredWorktree],
  );
  const boundBranchOptions = useMemo<readonly DropdownOption[]>(() => {
    const isolationGroup = isZh ? '下次任务' : 'Next task';
    const isolationOptions: DropdownOption[] = [
      {
        value: COMPOSER_ENV_ISOLATION_ON,
        label: isZh ? 'Worktree' : 'Worktree',
        group: isolationGroup,
        hint: isZh ? '下次' : 'next',
      },
      {
        value: COMPOSER_ENV_ISOLATION_OFF,
        label: isZh ? '当前工作区' : 'Current workspace',
        group: isolationGroup,
        hint: isZh ? '下次' : 'next',
      },
    ];
    if (!gitChrome.taskLine?.selectable) return isolationOptions;
    const localGroup = isZh ? '源头' : 'Source';
    const remoteGroup = isZh ? '远程源头' : 'Remote source';
    const branchOptions = buildComposerBranchOptions({
      branches: workspaceGit?.ok ? workspaceGit.branches : [],
      localBranches: workspaceGit?.ok ? workspaceGit.localBranches : [],
      remoteBranches: workspaceGit?.ok ? workspaceGit.remoteBranches : [],
      selected: gitChrome.taskLine.value,
    }).map((option) => ({
      value: option.value,
      label: formatComposerBranchOptionLabel(option.value),
      group: option.kind === 'remote' ? remoteGroup : localGroup,
      tab: option.kind,
      hint: option.kind === 'remote'
        ? (isZh ? '远程' : 'remote')
        : (isZh ? '本地' : 'local'),
    }));
    return [...isolationOptions, ...branchOptions];
  }, [gitChrome.taskLine, isZh, workspaceGit]);
  const handleSelectBoundBranch = useCallback((nextBranch: string) => {
    const next = nextBranch.trim();
    if (next === COMPOSER_ENV_ISOLATION_ON) {
      if (!isStreaming) changePreferredWorktree(true);
      return;
    }
    if (next === COMPOSER_ENV_ISOLATION_OFF) {
      if (!isStreaming) changePreferredWorktree(false);
      return;
    }
    if (!next || !workspacePath || !canSelectBoundBranch) return;
    if (next === gitChrome.taskLine?.value) return;
    const previous = gitChrome.taskLine?.value ?? null;
    setPendingBaseBranch(next);
    void clientApi.workspaceUpdate({ path: workspacePath, baseBranch: next })
      .then(async (result) => {
        if (result?.ok === false) {
          setPendingBaseBranch(previous);
          return;
        }
        await onWorkspaceUpdated?.();
        setPendingBaseBranch(null);
      })
      .catch(() => {
        setPendingBaseBranch(previous);
      });
  }, [canSelectBoundBranch, changePreferredWorktree, gitChrome.taskLine?.value, isStreaming, onWorkspaceUpdated, workspacePath]);
  const handleCreateBoundBranch = useCallback((
    rawName: string,
    sourceBranch?: string | null,
    push?: boolean,
    rawUpstream?: string | null,
  ) => {
    const name = rawName.trim();
    if (!name || !workspacePath || !canSelectBoundBranch) return;
    if (!isSafeComposerBranchName(name)) return;
    const shouldPush = push !== false;
    const upstream = shouldPush ? parseComposerUpstreamSpec(rawUpstream, name) : null;
    if (shouldPush && !upstream) return;
    const startPoint = resolveComposerCreateSourceBranch({
      highlighted: sourceBranch,
      selected: gitChrome.taskLine?.value,
      currentHead: workspaceGit?.current,
    }) ?? undefined;
    void clientApi.gitCreateBranch({
      workspaceRoot: workspacePath,
      name,
      startPoint,
      push: shouldPush,
      upstreamRemote: upstream?.remote,
      upstreamBranch: upstream?.branch,
    }).then((created) => {
      if (created?.ok !== true) return;
      if (push !== false && created.pushed === false) {
        setBranchPushNotice({
          branchName: name,
          reason: created.pushError || 'push_failed',
        });
      } else {
        setBranchPushNotice(null);
      }
      handleSelectBoundBranch(name);
      refreshWorkspaceGit();
    }).catch(() => {});
  }, [
    canSelectBoundBranch,
    gitChrome.taskLine?.value,
    handleSelectBoundBranch,
    refreshWorkspaceGit,
    workspaceGit?.current,
    workspacePath,
  ]);
  const handleOpenCreateBranchDialog = useCallback((highlightedValue?: string) => {
    if (!canSelectBoundBranch) return;
    const source = resolveComposerCreateSourceBranch({
      highlighted: highlightedValue,
      selected: gitChrome.taskLine?.value,
      currentHead: workspaceGit?.current,
    });
    if (!source) return;
    setCreateBranchDialog({ source, name: '', push: true, upstream: '' });
  }, [canSelectBoundBranch, gitChrome.taskLine?.value, workspaceGit?.current]);
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

  const showEmptyHome = shouldShowConversationEmptyHome({
    loadStatus,
    messageCount: messages.length,
  });
  const emptyHomeGreeting = conversationHomeGreeting(new Date().getHours(), isZh, workspaceLabel);
  const handleContextWindowChange = useCallback(async (
    providerId: string,
    optionId: string,
    value: string,
  ) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return;
    const nextValues = updateModelOptionSelection(
      provider.modelOptions,
      provider.modelOptionValues,
      optionId,
      value,
    );
    await clientApi.llmUpdateProvider({
      id: providerId,
      modelOptionValues: nextValues,
    });
    await onProvidersRefresh?.();
  }, [onProvidersRefresh, providers]);

  // 框内：模型 + 思考；框下右侧：上下文统计（首页与普通会话统一）。
  const homeComposerModelControls = (
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
      fastMode={fastMode}
      onFastModeChange={changeFastMode}
      modelOptions={modelOptions}
      canSwitchModel={canSwitchModel}
      onModelChange={handleModelChange}
      onContextWindowChange={handleContextWindowChange}
      selectedModelProviderId={modelProviderId}
      showContextUsage={false}
    />
  );
  const homeComposerContextControls = (
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
      fastMode={fastMode}
      onFastModeChange={changeFastMode}
      modelOptions={modelOptions}
      canSwitchModel={false}
      selectedModelProviderId={modelProviderId}
      showModelControls={false}
    />
  );

  // 草稿态（conversationId === null）也渲染完整聊天面：可输入，首条发送时再落库。
  return (
    <WorkspacePathContext.Provider value={workspacePath ?? null}>
    <InteractionActionsContext.Provider value={interactionActions}>
    <InteractionStreamingContext.Provider value={interactionStreaming}>
    <div className="chat-workspace">
    <div
      className={`chat-surface${showEmptyHome ? ' chat-surface--empty-home' : ''}`}
      onDragEnter={handleSurfaceDragEnter}
      onDragOver={handleSurfaceDragOver}
      onDragLeave={handleSurfaceDragLeave}
      onDrop={handleSurfaceDrop}
    >
      {isFileDropActive ? (
        <div className="chat-file-drop-overlay" aria-hidden="true">
          <div className="chat-file-drop-card">
            <div className="chat-file-drop-icon"><PeerIcon name="plus" size={22} /></div>
            <div className="chat-file-drop-title">{isZh ? '松手添加到当前对话' : 'Drop to attach to this chat'}</div>
            <div className="chat-file-drop-subtitle">{isZh ? '文件会复用现有附件规则加入输入区' : 'Files will be added with the existing attachment rules'}</div>
          </div>
        </div>
      ) : null}
      <ChatHeader
        title={conversationTitle || (isDraftConversation ? (isZh ? '新对话' : 'New Chat') : '')}
        automationOrigin={automationOrigin}
        onOpenAutomationRun={onOpenAutomationRun}
        isZh={isZh}
        i18n={i18n}
        isStreaming={isStreaming}
        hasScroll={threadScrolled}
        localAccessLevel={localAccessLevel}
        taskLine={gitChrome.taskLine}
        editTriggerRef={headerEditTriggerRef}
        onOpenTools={onOpenTools}
        onRename={!isDraftConversation && onRenameConversation && conversationId
          ? (newTitle) => onRenameConversation(conversationId, newTitle)
          : undefined}
        onArchive={!isDraftConversation && onArchiveConversation && conversationId
          ? () => onArchiveConversation(conversationId)
          : undefined}
        onBranch={!isDraftConversation && messages.length > 0 ? handleHeaderBranch : undefined}
        onFind={() => setFindOpen(true)}
        onClose={onClose}
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
        ) : showEmptyHome ? (
          <div className="chat-empty-state chat-empty-home">
            <div className="chat-empty-home-heading">
              <div className="chat-empty-mark" aria-hidden="true">
                <img className="chat-empty-logo light" src="./logo-light.png" alt="" />
                <img className="chat-empty-logo dark" src="./logo-dark.png" alt="" />
              </div>
              <h2>{hasProvider ? emptyHomeGreeting : (isZh ? '先连接 AI 服务，再开始任务' : 'Connect an AI service to get started')}</h2>
            </div>
            {!hasProvider ? (
              <div className="chat-empty-actions">
                <button type="button" className="chat-empty-primary-btn" onClick={onOpenSettings}>
                  {isZh ? '连接 AI 服务' : 'Connect AI service'}
                </button>
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
            onBeginEdit={stableBeginComposerEdit}
            onRegenerate={stableHandleRegenerate}
            onPreviewImage={setImagePreview}
          />
        )}
        {automationProposal ? (
          <AutomationProposalCard
            proposal={automationProposal}
            isZh={isZh}
            onAction={actOnAutomationProposal}
          />
        ) : null}
        {providerRecoveryNotice ? (
          <div className={`provider-recovery-notice${providerRecoveryNotice.kind === 'connection' ? ' provider-recovery-notice--connection' : ''}${providerRecoveryNotice.kind === 'queue' ? ' provider-recovery-notice--queue' : ''}`}>
            <div className="provider-recovery-body">
              {providerRecoveryNotice.kind === 'queue'
                ? formatQueueNoticeText(providerRecoveryNotice, isZh)
                : providerRecoveryNotice.kind === 'connection'
                ? providerRecoveryNotice.status === 'retrying'
                  ? isZh
                    ? `网络连接波动，正在重试连接（第 ${providerRecoveryNotice.attempt ?? 1}/${providerRecoveryNotice.maxRetries ?? 10} 次，${formatRetryCountdownLabel(connectionRetryRemainingSeconds ?? Math.ceil((providerRecoveryNotice.delayMs ?? 0) / 1000))}）`
                    : `Network connection interrupted; retrying (${providerRecoveryNotice.attempt ?? 1}/${providerRecoveryNotice.maxRetries ?? 10}, ${formatRetryCountdownLabelEn(connectionRetryRemainingSeconds ?? Math.ceil((providerRecoveryNotice.delayMs ?? 0) / 1000))})`
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
        {branchPushNotice ? (
          <div className="branch-push-notice" role="status">
            <div className="provider-recovery-body">
              {isZh
                ? `分支 ${branchPushNotice.branchName} 已创建，但推送到远端失败：${branchPushNotice.reason}（本地分支未受影响）`
                : `Branch ${branchPushNotice.branchName} was created, but pushing to the remote failed: ${branchPushNotice.reason} (local branch is intact)`}
            </div>
            <button
              type="button"
              className="branch-push-notice-dismiss"
              onClick={() => setBranchPushNotice(null)}
              aria-label={isZh ? '关闭提示' : 'Dismiss'}
            >
              <PeerIcon name="close" size={14} />
            </button>
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

      <div className={`chat-composer-wrap${showEmptyHome ? ' chat-composer-wrap--empty-home' : ''}`}>
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
            onForceSend={handleForceSendQueued}
          />
        ) : null}
        {streamError ? (
          <div className="chat-stream-error" role="alert">
            <span className="chat-stream-error-icon" aria-hidden="true">
              <svg
                className="peer-icon"
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                focusable="false"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
            </span>
            <span className="chat-stream-error-text">
              {formatStreamErrorLabel(streamError, isZh)}
            </span>
            <div className="chat-stream-error-actions">
              {showStreamResume ? (
                <button
                  type="button"
                  className="chat-stream-error-resume"
                  onClick={handleResumeStream}
                  disabled={!hasProvider}
                >
                  {isZh ? '继续' : 'Resume'}
                </button>
              ) : null}
              <button
                type="button"
                className="chat-stream-error-dismiss"
                onClick={handleDismissStreamError}
                aria-label={isZh ? '关闭错误提示' : 'Dismiss error'}
              >
                <PeerIcon name="close" size={14} />
              </button>
            </div>
          </div>
        ) : null}
        {/* Empty-home Composer is gated by hasProvider && showEmptyHome. */}
        {!(showEmptyHome && !hasProvider) ? (
        <>
        <div className="composer-chrome-row">
        <div className="composer-chrome-left">
        <GoalPlanPanel conversationId={conversationId} isZh={isZh} sidePanelContainer={goalSlot} onPlansCountChange={handleGoalPlansCountChange} onGoalPlanCreated={handleGoalPlanCreated} onRequestHostFocus={handleGoalRequestFocus} onActiveDeliveryChange={handleActiveDeliveryChange} onActiveGoalRunnerStatusChange={handleActiveGoalRunnerStatusChange} />
        </div>
        {workspaceIsGit === true ? (
        <div className="composer-chrome-right">
        {/* 没有 Git 时不渲染执行环境；收起态只说这次写在哪。 */}
        <div className="composer-env-capsule">
              <Dropdown
                className={`composer-dropdown composer-env-capsule-dropdown${envCapsule.isolated ? ' is-isolated' : ''}${envCapsule.kind === 'mismatch' ? ' is-mismatch' : ''}`}
                value={
                  canSelectBoundBranch && gitChrome.taskLine?.value
                    ? gitChrome.taskLine.value
                    : (preferredWorktree ? COMPOSER_ENV_ISOLATION_ON : COMPOSER_ENV_ISOLATION_OFF)
                }
                options={boundBranchOptions}
                onChange={handleSelectBoundBranch}
                triggerLabel={envCapsule.label}
                ariaLabel={envCapsule.title}
                title={
                  isStreaming
                    ? (isZh
                      ? `${envCapsule.title} 当前任务正在执行，无法更改隔离环境`
                      : `${envCapsule.title} Cannot change isolation while the current task is running`)
                    : envCapsule.title
                }
                prefix={envCapsule.isolated ? <GitWorktreeGlyph /> : <GitBranchGlyph />}
                menuPlacement="down"
                searchable={canSelectBoundBranch}
                searchPlaceholder={isZh ? '搜索源头…' : 'Search source…'}
                tabs={canSelectBoundBranch ? [
                  { id: 'local', label: isZh ? '本地' : 'Local' },
                  { id: 'remote', label: isZh ? '远程' : 'Remote' },
                ] : undefined}
                tabsAriaLabel={isZh ? '源头范围' : 'Source scope'}
                emptyLabel={isZh ? '没有匹配的源头' : 'No matching source'}
                footerAction={canSelectBoundBranch ? {
                  label: isZh ? '创建分支' : 'Create branch',
                  onSelect: (_query, highlightedValue) => {
                    handleOpenCreateBranchDialog(highlightedValue);
                  },
                } : undefined}
              />
        </div>
        </div>
        ) : null}
        </div>
        <ComposerDraftControls
          conversationId={conversationId}
          variant={showEmptyHome ? 'home' : 'conversation'}
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
          onAttachWorkspaceFile={attachWorkspaceFile}
          workspacePath={workspacePath}
          canStartTask={!isDraftConversation || hasRegisteredWorkspace}
          onPrimaryAction={stableHandlePrimaryAction}
          editingMessage={editingMessage}
          onCancelEdit={stableCancelComposerEdit}
          homeModelSlot={homeComposerModelControls}
        />
        <div className="chat-composer-toolbar">
          <div className="chat-composer-toolbar-left">
            {isDraftConversation ? (
              workspaceOptions.length > 0 ? (
                <Dropdown
                  className="composer-dropdown composer-workspace-dropdown"
                  value={workspacePath ?? ''}
                  placeholder={isZh ? '选择工作区' : 'Select workspace'}
                  options={workspaceOptions}
                  onChange={(nextWorkspacePath) => {
                    void onWorkspaceChange?.(nextWorkspacePath);
                  }}
                  ariaLabel={isZh ? '工作区' : 'Workspace'}
                  title={isZh ? '新任务必须先选择工作区' : 'Select a workspace before starting a task'}
                  menuPlacement="up"
                />
              ) : (
                <button
                  type="button"
                  className="composer-workspace-add"
                  onClick={() => void handleAddWorkspace()}
                >
                  {isZh ? '添加工作区' : 'Add workspace'}
                </button>
              )
            ) : workspacePath && workspaceOptions.length > 0 ? (
              <Dropdown
                className="composer-dropdown composer-workspace-dropdown"
                value={workspacePath}
                options={workspaceOptions}
                onChange={(nextWorkspacePath) => {
                  void onWorkspaceChange?.(nextWorkspacePath);
                }}
                disabled
                ariaLabel={isZh ? '工作区' : 'Workspace'}
                title={isZh ? '会话创建后不能切换工作区' : 'Workspace cannot be changed after the conversation is created'}
                menuPlacement="up"
              />
            ) : null}
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
          {homeComposerContextControls}
        </div>
        </>
        ) : null}
      </div>
      {createBranchDialog ? (
        <Overlay
          onClose={() => setCreateBranchDialog(null)}
          ariaLabel={isZh ? '创建分支' : 'Create Branch'}
          panelClassName="pa-confirm-dialog"
        >
          {({ requestClose }) => {
            const nameOk = isSafeComposerBranchName(createBranchDialog.name);
            const upstream = createBranchDialog.push
              ? parseComposerUpstreamSpec(createBranchDialog.upstream, createBranchDialog.name)
              : null;
            const canConfirm = nameOk && (!createBranchDialog.push || upstream != null);
            const patchDialog = (next: Partial<{ name: string; push: boolean; upstream: string }>) => {
              setCreateBranchDialog({
                source: createBranchDialog.source,
                name: createBranchDialog.name,
                push: createBranchDialog.push,
                upstream: createBranchDialog.upstream,
                ...next,
              });
            };
            const confirmCreate = () => {
              if (!canConfirm) return;
              handleCreateBoundBranch(
                createBranchDialog.name,
                createBranchDialog.source,
                createBranchDialog.push,
                createBranchDialog.upstream,
              );
              requestClose();
            };
            return (
              <div className="pa-confirm-body">
                <h2 className="pa-confirm-title">{isZh ? '创建分支' : 'Create Branch'}</h2>
                <p className="pa-confirm-message">
                  {isZh
                    ? `从 ${createBranchDialog.source} 创建分支`
                    : `Create a branch from ${createBranchDialog.source}`}
                </p>
                <input
                  className="pa-confirm-input"
                  value={createBranchDialog.name}
                  onChange={(event) => patchDialog({ name: event.target.value })}
                  placeholder={isZh ? '分支名' : 'Branch name'}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    confirmCreate();
                  }}
                />
                <label className="pa-confirm-check">
                  <input
                    type="checkbox"
                    checked={createBranchDialog.push}
                    onChange={(event) => patchDialog({ push: event.target.checked })}
                  />
                  <span>{isZh ? '创建后推送到远端（git push -u）' : 'Push to remote after creating (git push -u)'}</span>
                </label>
                {createBranchDialog.push ? (
                  <label className="pa-confirm-field">
                    <span className="pa-confirm-field-label">{isZh ? '跟踪到' : 'Track'}</span>
                    <input
                      className="pa-confirm-input"
                      value={createBranchDialog.upstream}
                      onChange={(event) => patchDialog({ upstream: event.target.value })}
                      placeholder={defaultComposerUpstreamSpec(createBranchDialog.name) || 'origin/branch'}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        confirmCreate();
                      }}
                    />
                  </label>
                ) : null}
                <div className="pa-confirm-actions is-spread">
                  <button type="button" className="pa-confirm-btn ghost" onClick={requestClose}>
                    {isZh ? '取消 Esc' : 'Cancel Esc'}
                  </button>
                  <button
                    type="button"
                    className="pa-confirm-btn primary"
                    disabled={!canConfirm}
                    onClick={confirmCreate}
                  >
                    {isZh ? '确认' : 'Confirm'}
                  </button>
                </div>
              </div>
            );
          }}
        </Overlay>
      ) : null}
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
