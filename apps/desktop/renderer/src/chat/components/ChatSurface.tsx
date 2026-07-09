import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  ClientToolCall,
  ConfigInstructionContextItem,
  ContextAttachmentItem,
  ContinuityContextItem,
  LlmProviderConfigView,
  LocalAccessLevel,
} from '@peer-agent/protocol';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import { clientApi } from '../../clientApi';
import { formatHistoricalLocalRecordForApi, sanitizeAssistantHistoryTextForApi } from '../state/historicalLocalRecord';
import {
  normalizeEffortLevels,
  CHAT_MODES,
  isEffortLevel,
  isLocalAccessLevel,
  isChatMode,
  normalizeChatMode,
  type EffortLevel,
  type ChatMode,
} from '../state/preferences';
import { useConversationModelEffort } from '../hooks/useConversationModelEffort';
import { useLocalAccessPreference } from '../hooks/useLocalAccessPreference';
import { useConversationMode } from '../hooks/useConversationMode';
import { loadComposerEntry, saveComposerEntry } from '../state/composerPersistence';
import { formatTime, formatDuration, formatTokenCount } from '../state/format';
import { getProviderModelDisplayLabel } from '../state/providerDisplay';
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateAttachmentTokens,
  estimateConversationTokens,
} from '../state/tokenEstimate';
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_FILE_BYTES,
  isTextLikeFile,
  readAsDataUrl,
  readAsText,
} from '../state/attachmentIntake';
import {
  normalizeStreamSegment,
  segmentsSignature,
  mergeReattachedSegments,
  contentFromSegments,
  isEmptyAssistantPlaceholder,
  groupSegments,
  getTextContent,
  migrateToSegments,
  findNextSerializedToolCall,
  parseSerializedToolSegments,
} from '../state/streamSegments';
import { toApiMessages } from '../state/apiMessageMapping';
import {
  buildConversationAttachmentContext,
  buildConversationContinuityContext,
  buildConfigInstructionContext,
  buildReplyLanguageContext,
  buildGitBranchPrefixContext,
} from '../state/contextSources';
import type {
  ChatAttachment,
  ChatApiContentPart,
  ChatApiMessage,
  ContentSegment,
  ToolCallLegacy,
  CompactionMeta,
  ChatMsg,
  QueuedMessage,
  TextGroup,
  ThinkingGroup,
  ToolCallGroup,
  SegmentGroup,
  ToolProgress,
} from '../state/types';
import { MarkdownMessage } from './markdown/MarkdownMessage';
import { WorkspacePathContext } from './markdown/InlineMarkdown';
import { AssistantContent, CompactionSummaryCard } from './thread/AssistantContent';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';
import { AttachmentStrip, ImagePreviewOverlay } from './thread/AttachmentStrip';
import { InteractionAnsweredContext, InteractionContext } from './thread/interactionContext';
import { ChatFindBar } from './thread/ChatFindBar';
import { ChatHeader } from './thread/ChatHeader';
import { GoalPlanPanel } from './GoalPlanPanel';
import { ChatGoalApprovalCard } from './goal/ChatGoalApprovalCard';
import { PermissionGateStrip } from './thread/PermissionGateStrip';
import { MessageActionBar, type MessageActionId } from './thread/MessageActionBar';
import { MessageRail, type MessageRailItem } from './thread/MessageRail';
import { useConversationState } from '../hooks/useConversationState';
import { conversationStore, type ConversationRuntimeState } from '../state/conversationStore';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
import { useStreamingReport } from '../hooks/useStreamingReport';
import { useConversationStreamRouter } from '../hooks/useConversationStreamRouter';
import { useWorkbench } from '../../workbench/WorkbenchContext';

const SCROLL_BOTTOM_THRESHOLD_PX = 64;
const CURRENT_TURN_CONTEXT_PROBE_PX = 96;

const ACCESS_LEVELS: readonly LocalAccessLevel[] = ['ask_before_local', 'session_local', 'full_local'];

interface ChatTurnMessage {
  readonly msg: ChatMsg;
  readonly index: number;
}

interface ChatTurn {
  readonly id: string;
  readonly messages: ChatTurnMessage[];
}

function groupMessagesIntoTurns(messages: readonly ChatMsg[]): ChatTurn[] {
  const turns: ChatTurn[] = [];

  messages.forEach((msg, index) => {
    if (msg.role === 'user' || turns.length === 0) {
      turns.push({ id: msg.id, messages: [] });
    }

    turns[turns.length - 1]?.messages.push({ msg, index });
  });

  return turns;
}

function getTurnUserMessage(turn: ChatTurn): ChatMsg | null {
  return turn.messages.find(({ msg }) => msg.role === 'user')?.msg ?? null;
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

function accessLevelLabel(level: LocalAccessLevel, isZh: boolean): string {
  if (level === 'full_local') return isZh ? '完全访问' : 'Full access';
  if (level === 'session_local') return isZh ? '帮我批准' : 'Approve for me';
  if (level === 'restricted_local') return isZh ? '受限' : 'Restricted';
  return isZh ? '每次询问' : 'Ask';
}

function accessLevelTitle(level: LocalAccessLevel, isZh: boolean): string {
  if (level === 'full_local') {
    return isZh ? '自动批准所有本地工具调用；请只在信任当前任务时使用' : 'Auto-approve all local tool calls; use only when you trust the current task';
  }
  if (level === 'session_local') {
    return isZh ? '自动批准低/中风险命令；高风险动作仍会询问' : 'Auto-approve low/medium-risk commands; high-risk actions still ask';
  }
  if (level === 'restricted_local') {
    return isZh ? '使用受限本地访问' : 'Use restricted local access';
  }
  return isZh ? '所有本地动作都先询问' : 'Ask before local actions';
}

function modeLabel(mode: ChatMode, isZh: boolean): string {
  if (mode === 'plan') return isZh ? '计划模式' : 'Plan mode';
  if (mode === 'goal') return isZh ? '目标模式' : 'Goal mode';
  return isZh ? '对话模式' : 'Chat mode';
}

function modeTitle(mode: ChatMode, isZh: boolean): string {
  if (mode === 'plan') {
    return isZh
      ? '先规划后执行：先与你共同产出结构化实现计划，批准后再执行'
      : 'Plan before execute: co-author a structured plan, then execute after approval';
  }
  if (mode === 'goal') {
    return isZh
      ? '自驱目标模式：你给目标和边界，Agent 自主推进到可验证完成，只在高风险或需决策时打扰你'
      : 'Self-driven goal mode: give a goal and boundaries; the agent drives to a verifiable done state, interrupting only for high-risk or decision points';
  }
  return isZh ? '直接对话并按需调用工具' : 'Answer directly and call tools as needed';
}

interface TokenUsageState {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

interface SlashCommand {
  id: string;
  value: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
}

interface ThreadScrollSnapshot {
  top: number;
  atBottom: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'compact',
    value: '/compact',
    labelZh: '/compact',
    labelEn: '/compact',
    descriptionZh: '压缩当前对话历史',
    descriptionEn: 'Compact conversation history',
  },
];

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
}> {
  const conv = await clientApi.conversationsGet({ id: conversationId });
  if (!conv?.messages) return { messages: [], tokenUsage: null, mode: 'chat', effort: 'default', modelProviderId: null };
  // 对话模式按会话持久化在会话 meta 上;老会话无该字段时回退 'chat'，历史 'goal' 归一化为 'plan'。
  const convMode: ChatMode = normalizeChatMode(conv.mode);
  // 思考强度 + 模型 provider 也按会话持久化在会话 meta 上（与 mode 同口径，每会话独立）。
  // 老会话无字段时：effort 回退 'default'，modelProviderId 回退 null（用全局默认 provider）。
  const convEffort: EffortLevel = isEffortLevel(conv.effort) ? conv.effort : 'default';
  const convModelProviderId: string | null =
    typeof conv.modelProviderId === 'string' && conv.modelProviderId ? conv.modelProviderId : null;
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
  }).filter((message) => !isEmptyAssistantPlaceholder(message));
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
  };
}

export function ChatSurface({
  i18n,
  providers,
  conversationId,
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
  onRenameConversation,
  onArchiveConversation,
  onDeleteConversation,
  workspacePath,
}: {
  readonly i18n: I18nRuntime;
  readonly providers: readonly LlmProviderConfigView[];
  readonly conversationId: string | null;
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
  readonly onRenameConversation?: (id: string, title: string) => void;
  readonly onArchiveConversation?: (id: string) => void;
  readonly onDeleteConversation?: (id: string) => void;
  // 分叉时把当前工作区透传给新建会话，使分叉会话与父会话同属一个工作区（否则会落到「无工作区」而在左侧列表被过滤隐藏）。
  readonly workspacePath?: string | null;
}) {
  // 会话运行时状态的真值已上移到 conversationStore（按 conversationId 分桶的外部 store）。
  // 本组件不再持有 messages/isStreaming/... 的 useState 槽位，改为订阅当前会话切片；
  // 切会话 = 换订阅 key，物理上不存在「被复用的共享 messages 槽位」，跨会话串内容在架构层不可能发生。
  const { state: convState, actions: convActions } = useConversationState(conversationId);
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
  const chatTurns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);
  const setMessages = useMemo(() => makeSetter('messages'), [makeSetter]) as Dispatch<SetStateAction<ChatMsg[]>>;
  const isStreaming = convState.isStreaming;
  const setIsStreaming = useMemo(() => makeSetter('isStreaming'), [makeSetter]);
  const isCompacting = convState.isCompacting;
  const setIsCompacting = useMemo(() => makeSetter('isCompacting'), [makeSetter]);
  // 压缩进度（0-100）：流式收摘要时按已收字符/预期字符估算；null = 尚无进度。
  const compactionPercent = convState.compactionPercent;
  const setCompactionPercent = useMemo(() => makeSetter('compactionPercent'), [makeSetter]);
  // 输入草稿 + 待发送队列随 conversationStore 会话桶存放，避免切会话时复用上一会话 composer 状态。
  const draft = convState.draft;
  const setDraft = convActions.setDraft;
  const messageQueue = convState.messageQueue;
  const enqueueMessage = convActions.enqueueMessage;
  const removeQueuedMessage = convActions.removeQueuedMessage;
  const shiftQueuedMessage = convActions.shiftQueuedMessage;
  // 整轮 wall-clock 计时下沉到 useElapsedTimer：对外暴露 elapsedMs（实时跳秒）、
  // setTurnStartedAt（发送时设起点，驱动右下角实时跳秒）。回合时长（turnDurationMs）的真值
  // 已上移到会话桶的 turnStartedAt，由 useConversationStreamRouter 在 done/aborted/error 时读取。
  const { elapsedMs, setTurnStartedAt } = useElapsedTimer(isStreaming);
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
  // 口径统一：主进程随回合结束（done）下发的权威上下文用量快照（与压缩触发同口径）。
  // 进度条优先用它，回退到本地估算；null = 本会话尚无权威快照（如刚切入未跑过回合）。
  const authoritativeContext = convState.authoritativeContext;
  const setAuthoritativeContext = useMemo(() => makeSetter('authoritativeContext'), [makeSetter]) as Dispatch<
    SetStateAction<{ contextTokens: number; contextWindow: number | null } | null>
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
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);
  const pendingPermissionCalls = convState.pendingPermissionCalls as ClientToolCall[];
  const setPendingPermissionCalls = useMemo(() => makeSetter('pendingPermissionCalls'), [makeSetter]) as Dispatch<
    SetStateAction<ClientToolCall[]>
  >;
  const [isThreadAtBottom, setIsThreadAtBottom] = useState(true);
  // 流式工具参数进度(Codex 式实时体感):工具调用参数(如 edit_file 的整文件内容)
  // 在落地为正式 tool-call 段之前会先以增量形式抵达,这里保存最近一次进度用于展示。
  // 仅为过程提示,不替代 Tool Result / Evidence。
  const toolProgress = convState.toolProgress as ToolProgress | null;
  const setToolProgress = useMemo(() => makeSetter('toolProgress'), [makeSetter]) as Dispatch<
    SetStateAction<ToolProgress | null>
  >;
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

  useEffect(() => {
    if (!imagePreview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImagePreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imagePreview]);

  // cmd/ctrl+F 打开会话内查找。常驻监听,与图片预览的 Escape 监听相互独立。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 顶部 header 快捷键:⌥⌘R 重命名、⌥⇧A 归档。
  useEffect(() => {
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
  }, [conversationId, onRenameConversation, onArchiveConversation, isStreaming]);

  // 任务续传(ADR 21):防止同一 resumeTask 被自动发送多次的一次性闸门。
  const resumeFiredRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  // 当前显示的会话 id（实时镜像）。用于异步回调里判断"完成时是否仍停在发起会话",
  // 避免手动 /compact 完成后把结果/横幅误作用到已切走的当前会话。
  const conversationIdRef = useRef<string | null>(conversationId);
  conversationIdRef.current = conversationId;
  // 回合结束自动压缩的防重入闸：压缩进行中置 true，避免 done 抖动/多 loop 收尾重复触发，
  // 也避免与手动 /compact、下一次发送前检查叠加。压缩 settle 后复位。
  const autoCompactingRef = useRef(false);
  // 输入框持久化的「上次落盘会话」标记。初值用 undefined 哨兵(区别于真实 id 与 null),
  // 使每次切到新会话的首遍只同步本 ref 并跳过保存,避免把旧会话草稿写到新会话名下。
  const composerPersistConvRef = useRef<string | null | undefined>(undefined);

  // 正文/思考 delta 的追加逻辑已上移到 useConversationStreamRouter（应用级单例流路由器），
  // 由它按 streamId→conversationId 路由到对应会话桶。本组件不再持有本地 append 逻辑与打字机。

  const threadRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const threadScrollSnapshotsRef = useRef(new Map<string, ThreadScrollSnapshot>());
  const pendingThreadScrollRestoreRef = useRef<{
    conversationId: string;
    snapshot: ThreadScrollSnapshot | null;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // textarea 自适应高度:随内容从单行增高,到 CSS max-height(120px) 后内部滚动。
  // 监听 draft 而非只在 onChange 处理,可同时覆盖恢复草稿/slash 命令/清空等编程式赋值路径。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const updateThreadBottomState = useCallback((container: HTMLDivElement | null) => {
    if (!container) return true;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
    shouldAutoScrollRef.current = atBottom;
    setIsThreadAtBottom(atBottom);
    return atBottom;
  }, []);

  const saveThreadScrollSnapshot = useCallback((id: string | null, container: HTMLDivElement | null) => {
    if (!id || !container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    threadScrollSnapshotsRef.current.set(id, {
      top: container.scrollTop,
      atBottom: distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX,
    });
  }, []);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = threadRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom(true);
    saveThreadScrollSnapshot(conversationIdRef.current, container);
  }, [saveThreadScrollSnapshot]);

  const handleThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    updateThreadBottomState(container);
    if (pendingThreadScrollRestoreRef.current?.conversationId !== conversationId) {
      saveThreadScrollSnapshot(conversationId, container);
    }
    setThreadScrolled(container.scrollTop > 4);
  }, [conversationId, saveThreadScrollSnapshot, updateThreadBottomState]);

  // 表达层导航:点击右侧消息轨时,把对应用户消息滚动到视口并短暂高亮。
  // 仅操作已渲染的 DOM 锚点(data-msg-id),不触碰会话真值。
  const scrollToMessage = useCallback((id: string) => {
    const container = threadRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('chat-msg-flash');
    // 强制重排以便重复点击同一条时动画可再次触发。
    void target.offsetWidth;
    target.classList.add('chat-msg-flash');
    window.setTimeout(() => target.classList.remove('chat-msg-flash'), 1600);
  }, []);

  const hasProvider = providers.some((p) => p.apiKeyConfigured);
  // 当前激活 provider(默认且已配置 Key,否则取首个已配置)是否勾选了原生推理(reasoning/thinking)。
  // 只有勾选时才显示思考强度选择器；OpenAI 暴露额外 xhigh 档。
  // 优先取会话绑定的模型（modelProviderId 复合 id），使推理档位/思考强度随会话选中的模型走；
  // 会话未绑定或绑定失效时回退全局默认 → 首个已配置 Key 的 provider（与后端强绑定回退同口径）。
  const activeProvider = (modelProviderId
    ? providers.find((p) => p.id === modelProviderId && p.apiKeyConfigured)
    : null)
    || providers.find((p) => p.isDefault && p.apiKeyConfigured)
    || providers.find((p) => p.apiKeyConfigured)
    || null;
  const activeProviderSupportsReasoning = Boolean(activeProvider?.supportsReasoning);
  // 档位列表以后端透传的 provider 原生能力（reasoningEffortLevels）为准，经归一化后渲染；
  // 后端未提供时回退到通用四档。不再按 provider 名硬编码（旧逻辑只认 openai，导致 Anthropic 等被降级到四档）。
  const effortLevels = normalizeEffortLevels(activeProvider?.reasoningEffortLevels);
  const isZh = i18n.locale === 'zh-CN';
  // 模型下拉选项：以打平后的 provider×model（复合 id=groupId::modelId）为单位，仅列已配置 Key 的
  // 可用模型。value=复合 id（会话据此绑定模型），label 优先取 modelLabel，回退分组名+模型名。
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
  const slashQuery = draft.startsWith('/') && !/\s/.test(draft) ? draft.toLowerCase() : null;
  const slashCommands = slashQuery
    ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery))
    : [];

  // 右侧消息轨条目:仅取用户消息(排除压缩摘要),文本截断用于 hover 预览。
  const railItems: MessageRailItem[] = messages
    .filter((msg) => msg.role === 'user' && !msg.compaction)
    .map((msg) => {
      const raw = (msg.content ?? '').trim();
      const text = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      return { id: msg.id, text };
    });
  const showSlashCommands = !isStreaming && !isCompacting && slashCommands.length > 0;
  // 口径分离（ADR 42：显示口径 ≠ 压缩触发口径）：进度条分子取「权威快照口径」与「实时本地估算」的较大值。
  // - 权威快照口径 = 主进程回合结束下发的 contextTokens，现已改为「显示口径」= 实际发送给模型的上下文
  //   （优先 provider 真实 usage 的 input+cacheRead，回退为对最后一轮实际发送切片的估算），
  //   叠加当前草稿/附件的实时增量；无快照时记 0。注意它不再等于压缩触发口径（后者仍按完整会话量判定）。
  // - 实时本地估算 = 对「按 _compaction 边界切片后的活跃 messages」+ 草稿 + 附件的本地估算
  //   （tokenEstimate 已按最后一条 _compaction 切片），压缩后随之回落。
  // 两者现已同为「实际发送量」口径，取 max 仅用于消除「流式→结束」瞬时抖动，保证数值连续、不无故突降。
  // 压缩发生时：onChatCompaction 完成分支已清空 authoritativeContext（置 null）、messages 也替换为压缩后
  // 集合，故 max 自然回落到压缩后的本地估算，不会把已压缩的用量错误地锁在压缩前高位（本次 bug 的修复点）。
  const liveContextTokens = estimateConversationTokens(messages, draft, attachments);
  const authoritativeContextTokens = authoritativeContext
    ? authoritativeContext.contextTokens + estimateTextTokens(draft) + estimateAttachmentTokens(attachments)
    : 0;
  const estimatedContextTokens = Math.max(authoritativeContextTokens, liveContextTokens);
  // 进度条分母优先用权威 contextWindow（与触发判定同窗口），消除 provider 配置窗口与
  // 主进程实际所用窗口不一致时的百分比偏差；权威窗口未知时回退到 provider 配置窗口。
  const authoritativeContextWindow = authoritativeContext?.contextWindow ?? undefined;
  // 当前轮进行中(流式/压缩)。此时主操作按钮含义:有草稿则"排队",无草稿则"停止"。
  const isBusy = isStreaming || isCompacting;
  const hasComposerContent = draft.trim().length > 0 || attachments.length > 0;

  useEffect(() => {
    setAttachments([]);
    setAttachmentError(null);
    setPendingPermissionCalls([]);
    setProviderRecoveryNotice(null);
    // 切换会话时清掉上一会话的流式错误横幅，避免错误提示跨会话残留。
    setStreamError(null);
    // 切换会话时恢复「该会话」已持久化的输入框状态(草稿文本 + 待发送队列):
    // 草稿与队列都以 conversationId 为坐标,二次打开应原样保留;无会话(新建未落库)则清空。
    // 草稿区附件不持久化(见 composerPersistence 取舍说明),故切换会话后附件区始终清空。
    const persisted = conversationId ? loadComposerEntry(conversationId) : null;
    convActions.set({
      draft: persisted?.draft ?? '',
      messageQueue: persisted?.queue ?? [],
    });
    const threadScrollSnapshot = conversationId
      ? threadScrollSnapshotsRef.current.get(conversationId) ?? null
      : null;
    pendingThreadScrollRestoreRef.current = conversationId
      ? { conversationId, snapshot: threadScrollSnapshot }
      : null;
    shouldAutoScrollRef.current = threadScrollSnapshot?.atBottom ?? true;
    setIsThreadAtBottom(threadScrollSnapshot?.atBottom ?? true);
    // 切换会话时,先把流式表达状态按会话归零,避免上一会话的 isStreaming/streamId/toolProgress 残留:
    // 否则从"正在输出的 A"切到"未运行的 B",B 会误显示运行中(左侧列表 Loading、
    // 右下角停止按钮误亮),也会让"正在准备工具参数"残留到新会话。
    // 归零后由下方 reattach 按"新会话是否确有活跃流"重新点亮,仅以真值为准。
    setIsStreaming(false);
    streamIdRef.current = null;
    setToolProgress(null);
    // 压缩横幅真值在主进程登记表（按会话），切会话时先归零本地表达，避免上一会话的
    // 压缩横幅/进度残留到新会话；随后由下方查询按"新会话是否确在压缩"重新点亮。
    setIsCompacting(false);
    setCompactionPercent(null);
    // 切换会话时清掉权威上下文用量快照，避免上一会话的进度条分子/分母残留到新会话；
    // 新会话由其首个回合结束的 done 重新下发权威快照，在此之前回退到本地估算。
    setAuthoritativeContext(null);
    // 切会话即放弃上一会话尚未发起的自动压缩意图，避免闸门长期占用导致新会话压缩被吞。
    autoCompactingRef.current = false;
    // 切换会话时一并清掉本轮计时锚点,避免上一会话的实时跳秒残留到新会话。
    // 打字机缓冲的清空已上移到 useConversationStreamRouter（随前台会话切换自动 reset）。
    setTurnStartedAt(null);
    if (!conversationId) { setMessages([]); setTokenUsage(null); return; }
    setTokenUsage(null);
    let cancelled = false;
    void (async () => {
      const { messages: loaded, tokenUsage: usage, mode: convMode, effort: convEffort, modelProviderId: convModelProviderId } = await loadConversationMessages(conversationId);
      if (cancelled) return;
      setMessages(loaded);
      if (usage) setTokenUsage(usage);
      // 对话模式随会话恢复:每会话各自独立,切换会话即切到该会话自己的模式。
      setMode(convMode);
      // 思考强度 + 模型 provider 随会话恢复:与 mode 同口径,切换会话即切到该会话自己的绑定值。
      // 直接 setState(不触发回写),避免恢复动作被当成用户切换而反写 meta。
      setEffort(convEffort);
      setModelProviderId(convModelProviderId);

      // 压缩横幅按会话恢复:压缩态真值在主进程登记表,切回正在压缩的会话时恢复横幅与进度,
      // 并把 streamIdRef 指向压缩流,使后续 progress/done 事件(按 streamId 门控)能继续匹配收尾。
      try {
        const comp = await clientApi.chatCompactionGet({ conversationId });
        if (cancelled) return;
        if (comp && comp.compacting && comp.streamId) {
          streamIdRef.current = comp.streamId;
          conversationStore.routeStream(comp.streamId, conversationId);
          conversationStore.setState(conversationId, { streamId: comp.streamId });
          setIsCompacting(true);
          setCompactionPercent(typeof comp.percent === 'number' ? comp.percent : null);
        }
      } catch {
        // 查询失败不影响正常加载;降级为无横幅(压缩仍会在后台完成)。
      }

      // ADR 22: HMR 重载/重新打开后,main 进程的流式推理可能仍在进行。
      // 询问后端是否有本会话的活跃流;若有,把已累积的思考/正文接回 UI,
      // 并恢复 streamIdRef,使现有 delta 监听重新匹配、无缝续上(不重发、不打断)。
      try {
        const live = await clientApi.chatStreamReattach({ conversationId });
        if (cancelled || !live || !live.streamId) return;
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
      } catch {
        // reattach 失败不影响正常加载;降级为无续接(用户可重新发送)。
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, convActions]);

  // 输入框(草稿 + 待发送队列)按会话持久化。
  // draft/queue 的运行态已经下沉到 conversationStore 会话桶,切会话时组件订阅的是目标会话桶,
  // 不再存在「新 conversationId + 旧队列」的共享状态组合。这里保留切换首帧跳过保存的保护,
  // 避免恢复落盘与用户真实编辑互相覆盖。
  useEffect(() => {
    if (composerPersistConvRef.current !== conversationId) {
      composerPersistConvRef.current = conversationId;
      return;
    }
    if (!conversationId) return;
    saveComposerEntry(conversationId, {
      draft,
      queue: messageQueue.map((item) => ({
        id: item.id,
        text: item.text,
        attachments: item.attachments,
        effort: item.effort,
      })),
    });
  }, [conversationId, draft, messageQueue]);

  useEffect(() => {
    return clientApi.onGoalRunnerChanged((payload) => {
      if (payload?.type !== 'goalRunner:streamStarted') return;
      if (!conversationId || payload.conversationId !== conversationId) return;
      const streamId = typeof payload.streamId === 'string' ? payload.streamId : '';
      if (!streamId) return;
      const now = typeof payload.startedAt === 'number' ? payload.startedAt : Date.now();
      const assistantMsg: ChatMsg = {
        id: nextId(),
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
        const tail = prev[prev.length - 1];
        if (tail && isEmptyAssistantPlaceholder(tail)) {
          return [...prev.slice(0, -1), assistantMsg];
        }
        return [...prev, assistantMsg];
      });
      void clientApi.conversationsAppendMessage({
        id: conversationId,
        message: { id: assistantMsg.id, role: 'assistant', content: '', timestamp: now },
      });
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

  // 压缩执行核心：手动 /compact 与回合结束自动压缩共用同一条安全链路。
  // 复用主进程 chatCompact（按 shouldCompact 自门控），完成后仅当仍停留发起会话时
  // 回灌视图（messages/tokenUsage），切走则只刷新列表，避免把结果灌进已切换的当前会话。
  // 返回是否真的发生了压缩，供调用方决定后续（如清空权威用量快照）。
  const runCompaction = useCallback(async (compactConversationId: string): Promise<boolean> => {
    const streamId = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    const compactStartedAt = Date.now();
    conversationStore.routeStream(streamId, compactConversationId);
    conversationStore.setState(compactConversationId, { streamId, turnStartedAt: compactStartedAt });
    setIsCompacting(true);
    try {
      const result = await clientApi.chatCompact({ conversationId: compactConversationId, streamId });
      const stillHere = conversationIdRef.current === compactConversationId;
      if (result.compacted && stillHere) {
        const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(compactConversationId);
        if (conversationIdRef.current === compactConversationId) {
          setMessages(loaded);
          if (usage) setTokenUsage(usage);
        }
        onConversationUpdated?.();
        // 直接用 invoke 返回的 notification 落地"已压缩"标记,不依赖 chat:compaction
        // 的 done 事件(它与 invoke 响应之间存在到达顺序竞态:finally 会清空
        // streamIdRef,导致 done 事件被 streamId 门控丢弃,标记永远不显示)。
        // 压缩点以时间线内的 CompactionSummaryCard 呈现(已由上方 setMessages 重载)。
      } else if (result.compacted) {
        // 已切走:仅刷新会话列表,不触碰当前视图。
        onConversationUpdated?.();
      }
      return result.compacted;
    } finally {
      // 保证 spinner 至少可见 ~600ms,避免小会话瞬时完成导致"点了没任何反馈"。
      const elapsed = Date.now() - compactStartedAt;
      const minVisibleMs = 600;
      if (elapsed < minVisibleMs) {
        await new Promise((resolve) => setTimeout(resolve, minVisibleMs - elapsed));
      }
      // 仅当仍停在发起会话时才清理当前视图的横幅/streamId;已切走则交由目标会话自身
      // 的切会话 effect 管理,避免误清当前显示会话(可能正自有压缩)的横幅。
      if (conversationIdRef.current === compactConversationId) {
        streamIdRef.current = null;
        setIsCompacting(false);
      }
    }
  }, [onConversationUpdated, setIsCompacting, setMessages, setTokenUsage, streamIdRef]);

  // 回合结束自动压缩：主进程在 done 里判定 compactionSuggested 后请求触发。
  // 三道护栏：① autoCompactingRef 防重入（多 loop 收尾/done 抖动只压一次）；
  // ② 捕获发起会话并要求完成时仍停留，避免灌进已切走的会话；
  // ③ macrotask defer(setTimeout 0)——排到渲染端 done 收尾的落库
  //    （conversations:replace-messages）之后再压缩，避免迟到的整段覆盖把压缩结果冲掉。
  const handleCompactionSuggested = useCallback(() => {
    if (autoCompactingRef.current) return;
    const compactConversationId = conversationIdRef.current;
    if (!compactConversationId) return;
    autoCompactingRef.current = true;
    setTimeout(() => {
      void (async () => {
        try {
          const compacted = await runCompaction(compactConversationId);
          // 压缩完成后清空权威用量快照，让进度条回落到（已变小的）本地估算，避免停在高位。
          if (compacted && conversationIdRef.current === compactConversationId) {
            setAuthoritativeContext(null);
          }
        } finally {
          autoCompactingRef.current = false;
        }
      })();
    }, 0);
  }, [runCompaction, setAuthoritativeContext]);

  // 应用级单例流路由器（方案 C / 甲-1）：订阅全部 chatStream 事件，按 streamId→conversationId
  // 路由到对应会话桶。前台会话（=当前 conversationId）的 delta 走打字机平滑吐字，后台会话的
  // delta 直接整段写入其桶。因 App 只渲染单个稳定的 ChatSurface 实例（切会话只改 conversationId
  // 这个 prop、不重挂载），此处挂载即「全应用唯一一份」订阅，终结了旧的 streamIdRef 单流过滤。
  useConversationStreamRouter({
    activeConversationId: conversationId,
    onConversationUpdated,
    onBrowserToolActivity: handleBrowserToolActivity,
    onCompactionSuggested: handleCompactionSuggested,
  });

  useLayoutEffect(() => {
    const pending = pendingThreadScrollRestoreRef.current;
    if (!pending || pending.conversationId !== conversationId) return;
    const container = threadRef.current;
    if (!container) return;
    if (messages.length === 0 && pending.snapshot && pending.snapshot.top > 0) return;

    if (pending.snapshot) {
      if (pending.snapshot.atBottom) {
        container.scrollTop = container.scrollHeight;
      } else {
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = Math.min(pending.snapshot.top, maxTop);
      }
      updateThreadBottomState(container);
    } else {
      container.scrollTop = container.scrollHeight;
      shouldAutoScrollRef.current = true;
      setIsThreadAtBottom(true);
    }
    setThreadScrolled(container.scrollTop > 4);
    saveThreadScrollSnapshot(conversationId, container);
    pendingThreadScrollRestoreRef.current = null;
  }, [conversationId, messages, saveThreadScrollSnapshot, updateThreadBottomState]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollThreadToBottom('auto');
      return;
    }
    updateThreadBottomState(threadRef.current);
  }, [messages, scrollThreadToBottom, updateThreadBottomState]);

  // 手动 /compact 不改 messages，上面的自动滚动 effect 不会重跑；而压缩进度横幅
  // 渲染在滚动容器最底部。若用户此时已向上滚，横幅会落在视口外，造成"点了没反应"
  // 的错觉。压缩一开始就强制滚到底，让进度横幅立即进入视口。
  useEffect(() => {
    if (isCompacting) {
      shouldAutoScrollRef.current = true;
      scrollThreadToBottom();
    }
  }, [isCompacting, scrollThreadToBottom]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashQuery]);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    setDraft(command.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(command.value.length, command.value.length);
    });
  }, [setDraft]);

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
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;

    setAttachmentError(null);
    const next: ChatAttachment[] = [];
    for (const file of incoming) {
      if (attachments.length + next.length >= MAX_ATTACHMENTS) {
        setAttachmentError(isZh ? `最多只能添加 ${MAX_ATTACHMENTS} 个附件` : `You can attach up to ${MAX_ATTACHMENTS} files`);
        break;
      }

      try {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_BYTES) {
            setAttachmentError(isZh ? `${file.name} 超过 8MB，未添加` : `${file.name} is larger than 8MB and was not attached`);
            continue;
          }
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'image',
            mimeType: file.type || 'image/png',
            size: file.size,
            kind: 'image',
            dataUrl: await readAsDataUrl(file),
          });
        } else if (isTextLikeFile(file)) {
          if (file.size > MAX_TEXT_FILE_BYTES) {
            setAttachmentError(isZh ? `${file.name} 超过 512KB，未添加` : `${file.name} is larger than 512KB and was not attached`);
            continue;
          }
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'file.txt',
            mimeType: file.type || 'text/plain',
            size: file.size,
            kind: 'text',
            text: await readAsText(file),
          });
        } else {
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'file',
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            kind: 'unsupported',
          });
          setAttachmentError(isZh ? `${file.name || '文件'} 暂不支持读取内容，仅附带文件信息` : `${file.name || 'File'} content is not supported yet; only file metadata was attached`);
        }
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : (isZh ? '读取附件失败' : 'Failed to read attachment'));
      }
    }

    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }, [attachments.length, isZh]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }, []);

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
  const canAcceptFileDrop = Boolean(conversationId) && hasProvider && !isStreaming;
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
  const submitMessage = useCallback(async (text: string, sentAttachments: ChatAttachment[], submitEffort?: string) => {
    if ((!text && sentAttachments.length === 0) || isStreaming || !hasProvider || !conversationId) return;
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);
    const turnEffort = submitEffort ?? effort;

    // /compact: run compaction in-place without an agent turn。
    // 捕获发起会话并复用共享的 runCompaction 安全链路（完成时校验仍停留发起会话、
    // 否则只刷新列表，与回合结束自动压缩同一条路径）。手动压缩后同样清空权威用量快照，
    // 让进度条回落到压缩后的本地估算。
    if (text === '/compact' && sentAttachments.length === 0) {
      const compactConversationId = conversationId;
      const compacted = await runCompaction(compactConversationId);
      if (compacted && conversationIdRef.current === compactConversationId) {
        setAuthoritativeContext(null);
      }
      return;
    }

    const now = Date.now();
    const userMsg: ChatMsg = { id: nextId(), role: 'user', content: text, timestamp: now, attachments: sentAttachments.length ? sentAttachments : undefined };
    const assistantMsg: ChatMsg = { id: nextId(), role: 'assistant', content: '', segments: [], timestamp: now };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

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

    const contextMessages = [...messages, userMsg];
    const apiMessages = toApiMessages(contextMessages);
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const continuityContext = buildConversationContinuityContext(contextMessages);
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
      ...buildGitBranchPrefixContext(gitBranchPrefix),
    ];
    void clientApi.chatSend({ messages: apiMessages, streamId, assistantMessageId: assistantMsg.id, effort: turnEffort, mode, conversationId, modelProviderId, workspacePath, contextAttachments, continuityContext, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, onConversationUpdated, effort, mode, modelProviderId, systemInstructions, replyLanguage, gitBranchPrefix, workspacePath]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || !hasProvider || !conversationId) return;
    const sentAttachments = attachments;
    setDraft('');
    setAttachments([]);
    setAttachmentError(null);
    // 当前轮(流式或压缩)进行中时,不丢弃也不阻塞输入:把消息排队,
    // 由 dequeue effect 在空闲后复用 submitMessage 自动发出下一条(类似 Codex 队列)。
    if (isStreaming || isCompacting) {
      enqueueMessage({ id: nextId(), text, attachments: sentAttachments, effort });
      return;
    }
    await submitMessage(text, sentAttachments);
  }, [draft, attachments, isStreaming, isCompacting, hasProvider, conversationId, submitMessage, effort, setDraft, enqueueMessage]);

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

  // 队列自动出队:当前轮结束(非流式、非压缩)且 provider/会话就绪时,取队首自动发送。
  // 复用 submitMessage 同一发送路径;resumeTask 优先(避免与续传抢同一空闲窗口)。
  useEffect(() => {
    if (isStreaming || isCompacting || !hasProvider || !conversationId) return;
    if (resumeTask) return;
    if (messageQueue.length === 0) return;
    const head = shiftQueuedMessage();
    if (!head) return;
    void submitMessage(head.text, head.attachments, head.effort);
  }, [isStreaming, isCompacting, hasProvider, conversationId, resumeTask, messageQueue.length, shiftQueuedMessage, submitMessage]);

  // 主操作按钮/回车键的统一入口:
  // - 有草稿内容时:发送或排队(由 handleSend 内部判断是否当前轮进行中)。
  // - 无草稿且当前轮进行中时:停止当前轮。
  const handlePrimaryAction = useCallback(() => {
    if (draft.trim() || attachments.length > 0) {
      void handleSend();
      return;
    }
    if (isStreaming) handleStop();
  }, [draft, attachments, isStreaming, handleSend, handleStop]);

  const handleRegenerate = useCallback(async (msgIndex: number) => {
    if (isStreaming || !hasProvider || !conversationId) return;
    const target = messages[msgIndex];
    if (!target || target.role !== 'assistant') return;

    const contextMessages = messages.slice(0, msgIndex);
    const newAssistant: ChatMsg = { id: nextId(), role: 'assistant', content: '', segments: [] };
    setMessages([...contextMessages, newAssistant]);
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);

    await clientApi.conversationsUpdateLastMessage({ id: conversationId, content: '' });

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnStartedAt = Date.now();
    streamIdRef.current = streamId;
    setTurnStartedAt(turnStartedAt);
    conversationStore.routeStream(streamId, conversationId);
    conversationStore.setState(conversationId, { streamId, turnStartedAt });
    setIsStreaming(true);

    const apiMessages = toApiMessages(contextMessages);
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const continuityContext = buildConversationContinuityContext(contextMessages);
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
      ...buildGitBranchPrefixContext(gitBranchPrefix),
    ];
    void clientApi.chatSend({ messages: apiMessages, streamId, assistantMessageId: newAssistant.id, effort, mode, conversationId, modelProviderId, workspacePath, contextAttachments, continuityContext, configInstructions });
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
    const updated = messages.filter((_, i) => i !== msgIndex);
    setMessages(updated);
    await clientApi.conversationsReplaceMessages({
      id: conversationId,
      messages: updated.map((m) => ({ id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, durationMs: m.durationMs, timestamp: m.timestamp, _compaction: m.compaction, attachments: m.attachments, interrupted: m.interrupted })),
    });
    onConversationUpdated?.();
  }, [conversationId, isStreaming, messages, onConversationUpdated]);

  const handleMessageAction = useCallback((msgIndex: number, action: MessageActionId) => {
    if (action === 'regenerate') void handleRegenerate(msgIndex);
    else if (action === 'branch') void handleBranch(msgIndex);
    else if (action === 'delete') void handleDeleteMessage(msgIndex);
  }, [handleRegenerate, handleBranch, handleDeleteMessage]);

  // 顶部 header 级别的分叉:从当前最后一条消息分叉(复用已有 handleBranch)。
  const handleHeaderBranch = useCallback(() => {
    if (messages.length > 0) {
      void handleBranch(messages.length - 1);
    }
  }, [messages, handleBranch]);

  const showScrollToBottom = messages.length > 0 && !isThreadAtBottom;

  // 选择 request_user_input 的选项 = 把该选项作为用户消息，复用既有 submitMessage 发送路径。
  // 见 Goal 模式运行时闸门设计。
  const selectInteractionOption = useCallback((text: string) => {
    if (!text || isStreaming || !hasProvider || !conversationId) return;
    void submitMessage(text, [], effort);
  }, [isStreaming, hasProvider, conversationId, submitMessage, effort]);

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
  useEffect(() => {
    if (mode !== 'plan') setHasGoalPlan(false);
  }, [mode, setHasGoalPlan]);

  if (!conversationId) {
    return (
      <div className="chat-surface">
        <div className="chat-thread" ref={threadRef} onScroll={handleThreadScroll}>
          <div className="chat-empty-state">
            <h2>{isZh ? '有什么可以帮你的？' : 'How can I help you?'}</h2>
            {!hasProvider ? (
              <p>
                {isZh ? '请先' : 'Please '}
                <button type="button" className="chat-link-btn" onClick={onOpenSettings}>
                  {isZh ? '配置模型' : 'configure a model'}
                </button>
                {isZh ? '后开始对话' : ' to start chatting'}
              </p>
            ) : (
              <p>{isZh ? '点击左侧「新对话」开始' : 'Click "New Chat" to start'}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <WorkspacePathContext.Provider value={workspacePath ?? null}>
    <InteractionContext.Provider value={{ onSelectOption: selectInteractionOption, isStreaming }}>
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
        title={conversationTitle ?? ''}
        isZh={isZh}
        i18n={i18n}
        isStreaming={isStreaming}
        hasScroll={threadScrolled}
        localAccessLevel={localAccessLevel}
        editTriggerRef={headerEditTriggerRef}
        onOpenSettings={onOpenSettings}
        onRename={onRenameConversation && conversationId
          ? (newTitle) => onRenameConversation(conversationId, newTitle)
          : undefined}
        onArchive={onArchiveConversation && conversationId
          ? () => onArchiveConversation(conversationId)
          : undefined}
        onBranch={messages.length > 0 ? handleHeaderBranch : undefined}
        onFind={() => setFindOpen(true)}
        onDelete={onDeleteConversation && conversationId
          ? () => onDeleteConversation(conversationId)
          : undefined}
      />
      {findOpen ? (
        <ChatFindBar
          containerRef={threadRef}
          isZh={isZh}
          onClose={() => setFindOpen(false)}
          recomputeKey={messages.length}
        />
      ) : null}
      <div className="chat-thread" ref={threadRef} onScroll={handleThreadScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <p>{isZh ? '输入消息开始对话' : 'Type a message to start'}</p>
          </div>
        ) : chatTurns.map((turn) => (
          <section key={turn.id} className="chat-turn">
            {turn.messages.map(({ msg, index: idx }) => (
              <div key={msg.id} data-msg-id={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
            {msg.compaction ? (
              <CompactionSummaryCard compaction={msg.compaction} isZh={isZh} />
            ) : (
              <>
            {msg.timestamp ? <time className="chat-msg-time">{formatTime(msg.timestamp)}</time> : null}
            <span className="chat-msg-role-label">{msg.role === 'user' ? (isZh ? '你' : 'You') : 'Peer Agent'}</span>
            <div className="chat-msg-body">
              {msg.role === 'user' ? (
                <>
                  {msg.content ? <p>{msg.content}</p> : null}
                  {msg.attachments?.length ? (
                    <AttachmentStrip attachments={msg.attachments} readOnly isZh={isZh} onPreviewImage={setImagePreview} />
                  ) : null}
                </>
              ) : (
                <InteractionAnsweredContext.Provider
                  value={
                    // 这张交互卡是否已被回复：取紧邻其后的 user 消息文本（点选项或
                    // 输入框自由输入都会成为这条 user 消息）。没有后续回复则为 null，
                    // 卡片据此判断锁定与「已选」高亮，不再依赖卡片本地一次性 state。
                    messages[idx + 1]?.role === 'user'
                      ? (messages[idx + 1]?.content ?? null)
                      : null
                  }
                >
                  <AssistantContent
                    segments={msg.segments}
                    content={msg.content}
                    isStreaming={isStreaming && msg === messages[messages.length - 1]}
                    toolProgress={isStreaming && msg === messages[messages.length - 1] ? toolProgress : null}
                    isZh={isZh}
                  />
                </InteractionAnsweredContext.Provider>
              )}
            </div>
            <div className="chat-msg-footer">
              <MessageActionBar
                role={msg.role}
                content={msg.content}
                canEdit={true}
                isStreaming={isStreaming}
                onAction={(action) => handleMessageAction(idx, action)}
                i18n={i18n}
              />
              {msg.role === 'assistant' && (() => {
                const isLiveTurn = isStreaming && msg === messages[messages.length - 1];
                const shownMs = isLiveTurn ? elapsedMs : msg.durationMs;
                if (shownMs == null) return null;
                return (
                  <span
                    className={`chat-msg-duration${isLiveTurn ? ' chat-msg-duration-live' : ''}`}
                    title={isLiveTurn ? (isZh ? '本轮已工作时长' : 'Elapsed this turn') : (isZh ? '本轮工作时长' : 'Turn duration')}
                  >
                    {formatDuration(shownMs)}
                  </span>
                );
              })()}
              {msg.role === 'assistant' && msg.interrupted && !isStreaming && (
                <span className="chat-msg-interrupted">
                  <span
                    className="chat-msg-interrupted-mark"
                    title={isZh ? '连接中断，本轮未自然结束' : 'Connection interrupted; this turn did not finish'}
                  >
                    {isZh ? '已中断' : 'Interrupted'}
                  </span>
                  {hasProvider && (
                    <button
                      type="button"
                      className="chat-msg-continue-btn"
                      onClick={() => void handleRegenerate(idx)}
                    >
                      {isZh ? '继续生成' : 'Continue'}
                    </button>
                  )}
                </span>
              )}
            </div>
              </>
            )}
              </div>
            ))}
          </section>
        ))}
        {providerRecoveryNotice ? (
          <div className={`provider-recovery-notice${providerRecoveryNotice.kind === 'connection' ? ' provider-recovery-notice--connection' : ''}`}>
            <div className="provider-recovery-body">
              {providerRecoveryNotice.kind === 'connection'
                ? providerRecoveryNotice.status === 'retrying'
                  ? isZh
                    ? `网络连接波动，正在重试连接（第 ${providerRecoveryNotice.attempt ?? 1}/${providerRecoveryNotice.maxRetries ?? 10} 次，约 ${Math.round((providerRecoveryNotice.delayMs ?? 0) / 1000)}s 后重试）`
                    : `Network connection interrupted; retrying (${providerRecoveryNotice.attempt ?? 1}/${providerRecoveryNotice.maxRetries ?? 10}, in about ${Math.round((providerRecoveryNotice.delayMs ?? 0) / 1000)}s)`
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
        {isCompacting ? (
          <div
            className={`compaction-notice${compactionPercent === null ? ' compaction-notice--indeterminate' : ''}`}
            role="progressbar"
            aria-label={isZh ? '压缩上下文进度' : 'Compaction progress'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={compactionPercent ?? undefined}
            style={
              compactionPercent !== null
                ? ({ '--compaction-fill': `${compactionPercent}%` } as React.CSSProperties)
                : undefined
            }
          >
            {/* 底层：未填充全貌（灰波浪 + 灰字），全宽铺满 */}
            <span className="compaction-track compaction-track--base" aria-hidden="true">
              <span className="compaction-wave" />
              <span className="compaction-notice-label">
                {isZh ? '压缩上下文中' : 'Compacting context'}
                {compactionPercent !== null ? (
                  <span className="compaction-notice-percent">{compactionPercent}%</span>
                ) : null}
              </span>
              <span className="compaction-wave" />
            </span>
            {/* 顶层：azure 全貌，按 --compaction-fill 从左裁剪露出（与底层逐像素对齐） */}
            <span className="compaction-track compaction-track--fill" aria-hidden="true">
              <span className="compaction-track__inner">
                <span className="compaction-wave" />
                <span className="compaction-notice-label">
                  {isZh ? '压缩上下文中' : 'Compacting context'}
                  {compactionPercent !== null ? (
                    <span className="compaction-notice-percent">{compactionPercent}%</span>
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
          enabled={mode === 'plan' || mode === 'goal'}
        />
        {messageQueue.length > 0 ? (
          <div className="message-queue" role="list" aria-label={isZh ? '待发送队列' : 'Queued messages'}>
            <span className="message-queue-label">
              {isZh ? `已排队 ${messageQueue.length} 条` : `${messageQueue.length} queued`}
            </span>
            {messageQueue.map((item, index) => {
              const preview = item.text.trim() || (item.attachments.length ? (isZh ? '（附件）' : '(attachments)') : '');
              return (
                <div key={item.id} className="message-queue-item" role="listitem" title={item.text}>
                  <span className="message-queue-index">{index + 1}</span>
                  <span className="message-queue-text">{preview}</span>
                  <button
                    type="button"
                    className="message-queue-remove"
                    onClick={() => removeQueuedMessage(item.id)}
                    aria-label={isZh ? '移除' : 'Remove'}
                    title={isZh ? '移除' : 'Remove'}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <form
          className="chat-composer"
          onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
        >
          {showSlashCommands ? (
            <div className="slash-command-menu" role="listbox" aria-label={isZh ? '命令' : 'Commands'}>
              {slashCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  className={`slash-command-item ${index === activeSlashIndex ? 'active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applySlashCommand(command);
                  }}
                >
                  <span className="slash-command-badge">/</span>
                  <span className="slash-command-main">
                    <span className="slash-command-label">{isZh ? command.labelZh : command.labelEn}</span>
                    <span className="slash-command-desc">{isZh ? command.descriptionZh : command.descriptionEn}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {attachments.length ? (
            <AttachmentStrip
              attachments={attachments}
              onRemove={removeAttachment}
              onPreviewImage={setImagePreview}
              isZh={isZh}
            />
          ) : null}
          {attachmentError ? <div className="attachment-error">{attachmentError}</div> : null}
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={!hasProvider}
            placeholder={hasProvider ? (isBusy ? (isZh ? '输入消息将在完成后自动发送...' : 'Message will auto-send when done...') : (isZh ? '输入消息...' : 'Type a message...')) : (isZh ? '请先配置模型' : 'Configure a model first')}
            rows={1}
            onPaste={handlePaste}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (showSlashCommands) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveSlashIndex((index) => (index + 1) % slashCommands.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveSlashIndex((index) => (index - 1 + slashCommands.length) % slashCommands.length);
                  return;
                }
                if ((e.key === 'Tab' || e.key === 'Enter') && draft !== slashCommands[activeSlashIndex]?.value) {
                  e.preventDefault();
                  applySlashCommand(slashCommands[activeSlashIndex]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft('');
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handlePrimaryAction();
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-file-input"
            onChange={(event) => {
              void addFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="composer-attach-btn"
            disabled={!hasProvider || isStreaming}
            title={isZh ? '添加附件' : 'Attach files'}
            aria-label={isZh ? '添加附件' : 'Attach files'}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            type="submit"
            className={isBusy && !hasComposerContent ? 'streaming' : undefined}
            disabled={!hasProvider || (!isBusy && !hasComposerContent)}
            title={
              isBusy && !hasComposerContent
                ? (isZh ? '停止' : 'Stop')
                : isBusy
                  ? (isZh ? '加入队列' : 'Add to queue')
                  : (isZh ? '发送' : 'Send')
            }
            aria-label={
              isBusy && !hasComposerContent
                ? (isZh ? '停止' : 'Stop')
                : isBusy
                  ? (isZh ? '加入队列' : 'Add to queue')
                  : (isZh ? '发送' : 'Send')
            }
          >
            {isBusy && !hasComposerContent ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
              </svg>
            )}
          </button>
        </form>
        <div className="chat-composer-toolbar">
          <div className="chat-composer-toolbar-left">
            <Dropdown
              className="composer-dropdown composer-mode-dropdown"
              value={mode}
              options={CHAT_MODES.map((m) => ({
                value: m,
                label: modeLabel(m, isZh),
                // plan(审批门)与 goal(自驱)均为非默认的强模式,用 danger 色标注以示区别。
                tone: m === 'plan' || m === 'goal' ? 'danger' : undefined,
              }))}
              onChange={(next) => {
                if (isChatMode(next)) changeMode(next);
              }}
              ariaLabel={isZh ? '对话模式' : 'Chat mode'}
              title={modeTitle(mode, isZh)}
              menuPlacement="up"
            />
            <Dropdown
              className="composer-dropdown composer-access-dropdown"
              value={localAccessLevel}
              options={ACCESS_LEVELS.map((level) => ({
                value: level,
                label: accessLevelLabel(level, isZh),
                tone: level === 'full_local' ? 'danger' : undefined,
              }))}
              onChange={(next) => {
                if (isLocalAccessLevel(next)) changeLocalAccessLevel(next);
              }}
              ariaLabel={isZh ? '本地访问模式' : 'Local access mode'}
              title={accessLevelTitle(localAccessLevel, isZh)}
              menuPlacement="up"
            />
          </div>
          <TokenUsageDisplay
            providers={providers}
            tokenUsage={tokenUsage}
            activeUsage={activeUsage}
            contextTokens={estimatedContextTokens}
            contextWindow={authoritativeContextWindow}
            isStreaming={isStreaming}
            isZh={isZh}
            effort={effort}
            effortLevels={activeProviderSupportsReasoning ? effortLevels : []}
            onEffortChange={changeEffort}
            modelOptions={modelOptions}
            canSwitchModel={canSwitchModel}
            onModelChange={changeModelProviderId}
            selectedModelProviderId={modelProviderId}
          />
        </div>
      </div>
      {imagePreview?.kind === 'image' && imagePreview.dataUrl ? (
        <ImagePreviewOverlay attachment={imagePreview} isZh={isZh} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
    </div>
    </InteractionContext.Provider>
    </WorkspacePathContext.Provider>
  );
}
