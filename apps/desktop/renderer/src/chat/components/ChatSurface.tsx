import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  ClientToolCall,
  ConfigInstructionContextItem,
  ContextAttachmentItem,
  ContinuityContextItem,
  GoalPlan,
  LlmProviderConfigView,
  LocalAccessLevel,
} from '@peer-agent/protocol';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import { clientApi } from '../../clientApi';
import { formatHistoricalLocalRecordForApi, sanitizeAssistantHistoryTextForApi } from '../state/historicalLocalRecord';
import {
  BASE_EFFORT_LEVELS,
  OPENAI_EFFORT_LEVELS,
  CHAT_MODES,
  isEffortLevel,
  isLocalAccessLevel,
  isChatMode,
  type EffortLevel,
  type ChatMode,
} from '../state/preferences';
import { useEffortPreference } from '../hooks/useEffortPreference';
import { useLocalAccessPreference } from '../hooks/useLocalAccessPreference';
import { useConversationMode } from '../hooks/useConversationMode';
import { useMessageQueue, type QueuedMessage } from '../hooks/useMessageQueue';
import { loadComposerEntry, saveComposerEntry } from '../state/composerPersistence';
import { formatTime, formatDuration, formatTokenCount } from '../state/format';
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
} from '../state/contextSources';
import type {
  ChatAttachment,
  ChatApiContentPart,
  ChatApiMessage,
  ContentSegment,
  ToolCallLegacy,
  CompactionMeta,
  ChatMsg,
  TextGroup,
  ThinkingGroup,
  ToolCallGroup,
  SegmentGroup,
  ToolProgress,
} from '../state/types';
import { MarkdownMessage } from './markdown/MarkdownMessage';
import { AssistantContent, CompactionSummaryCard } from './thread/AssistantContent';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';
import { AttachmentStrip, ImagePreviewOverlay } from './thread/AttachmentStrip';
import { InteractionContext } from './thread/interactionContext';
import { ChatFindBar } from './thread/ChatFindBar';
import { GoalPlanPanel } from './GoalPlanPanel';
import { PermissionGateStrip } from './thread/PermissionGateStrip';
import { MessageActionBar, type MessageActionId } from './thread/MessageActionBar';
import { MessageRail, type MessageRailItem } from './thread/MessageRail';
import { useTypewriterStream } from '../hooks/useTypewriterStream';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
import { useStreamingReport } from '../hooks/useStreamingReport';
import { useChatStreamSubscription } from '../hooks/useChatStreamSubscription';

const SCROLL_BOTTOM_THRESHOLD_PX = 64;

const ACCESS_LEVELS: readonly LocalAccessLevel[] = ['ask_before_local', 'session_local', 'full_local'];

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
  if (mode === 'goal') return isZh ? '目标模式' : 'Goal mode';
  return isZh ? '对话模式' : 'Chat mode';
}

function modeTitle(mode: ChatMode, isZh: boolean): string {
  if (mode === 'goal') {
    return isZh
      ? '先规划后执行：先与你共同产出结构化实现计划，批准后再执行'
      : 'Plan before execute: co-author a structured plan, then execute after approval';
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
}> {
  const conv = await clientApi.conversationsGet({ id: conversationId });
  if (!conv?.messages) return { messages: [], tokenUsage: null, mode: 'chat' };
  // 对话模式按会话持久化在会话 meta 上;老会话无该字段时回退 'chat'。
  const convMode: ChatMode = isChatMode(conv.mode) ? conv.mode : 'chat';
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
    };
  }
  return {
    messages: loaded,
    tokenUsage: totalInput > 0 || totalOutput > 0 || totalCacheWrite > 0 || totalCacheRead > 0
      ? { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead }
      : null,
    mode: convMode,
  };
}

export function ChatSurface({
  i18n,
  providers,
  conversationId,
  systemInstructions,
  replyLanguage,
  resumeTask,
  onResumeConsumed,
  onOpenSettings,
  onConversationUpdated,
  onStreamingChange,
  onBranch,
}: {
  readonly i18n: I18nRuntime;
  readonly providers: readonly LlmProviderConfigView[];
  readonly conversationId: string | null;
  readonly systemInstructions?: string;
  readonly replyLanguage?: string;
  readonly resumeTask?: { sessionId: string; task: string; effort?: string } | null;
  readonly onResumeConsumed?: () => void;
  readonly onOpenSettings: () => void;
  readonly onConversationUpdated?: () => void;
  // 把当前会话的流式运行状态上报给上层(App),供左侧列表显示 Loading 图标。
  readonly onStreamingChange?: (conversationId: string | null, isStreaming: boolean) => void;
  readonly onBranch?: (newConversationId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  // 压缩进度（0-100）：流式收摘要时按已收字符/预期字符估算；null = 尚无进度。
  const [compactionPercent, setCompactionPercent] = useState<number | null>(null);
  // 整轮 wall-clock 计时下沉到 useElapsedTimer：对外暴露 elapsedMs（实时跳秒）、
  // turnStartedAtRef（供流事件计算 turnDurationMs）、setTurnStartedAt（发送时设起点）。
  const { elapsedMs, turnStartedAtRef, setTurnStartedAt } = useElapsedTimer(isStreaming);
  // 待发送消息队列:当前轮(流式或压缩)进行中时用户继续提交的消息排队等候,
  // 由下方 dequeue effect 在空闲且 provider 就绪时自动取队首发送。状态/增删见 hooks/useMessageQueue;
  // 自动出队 effect 因依赖更晚声明的 submitMessage,仍内联在本组件(见下文)。
  const { messageQueue, setMessageQueue, enqueue: enqueueMessage, removeQueuedMessage } = useMessageQueue();
  // 把流式运行状态(含会话坐标)上报给上层,供左侧列表显示 Loading 图标。
  // 表达层只反映 isStreaming 真值,不引入新的执行真值。下沉到 useStreamingReport。
  useStreamingReport(conversationId, isStreaming, onStreamingChange);
  const [streamError, setStreamError] = useState<string | null>(null);
  // 计划批准的「执行意图」暂存：当用户在本轮助手会话仍 streaming 时点「批准并执行」，
  // 此时运行时被占用、直接发起执行轮会被丢弃（旧 bug）。改为把待执行 plan 暂存于此 ref，
  // 由下方 effect 监听 isStreaming 由 true→false（本轮会话结束）后自动发起执行轮并清空。
  // 用 ref 而非 state：避免额外渲染，且执行意图是「一次性副作用触发器」而非渲染数据。
  const pendingGoalExecutionRef = useRef<GoalPlan | null>(null);
  // 思考强度全局偏好(读取/回写 settings-store,五档),逻辑见 hooks/useEffortPreference。
  const { effort, setEffort, changeEffort } = useEffortPreference();
  // 对话模式按会话持久化在会话 meta 上(非全局设置):模式是「每会话状态」,切换会话
  // 各自独立、互不影响,与计划数据同口径。初值给 'chat',真实值由会话加载 effect 按
  // 当前会话 meta 覆盖(见下方 conversationId effect)。模式真值最终经 chatSend → IPC →
  // mode-source 进入 System Context 的 L6_MODE_REMINDER 层。逻辑见 hooks/useConversationMode。
  const { mode, setMode, changeMode } = useConversationMode(conversationId);
  // 本地访问授权级别全局偏好(读取/回写 settings-store,服务端归一化回执二次校正),
  // 逻辑见 hooks/useLocalAccessPreference。注意:权限真值仍在主进程 PermissionGate,此处仅表达选择。
  const { localAccessLevel, changeLocalAccessLevel } = useLocalAccessPreference();
  const [tokenUsage, setTokenUsage] = useState<TokenUsageState | null>(null);
  const [activeUsage, setActiveUsage] = useState<TokenUsageState | null>(null);
  const [providerRecoveryNotice, setProviderRecoveryNotice] = useState<{
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
  } | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);
  const [pendingPermissionCalls, setPendingPermissionCalls] = useState<ClientToolCall[]>([]);
  const [isThreadAtBottom, setIsThreadAtBottom] = useState(true);
  // 流式工具参数进度(Codex 式实时体感):工具调用参数(如 edit_file 的整文件内容)
  // 在落地为正式 tool-call 段之前会先以增量形式抵达,这里保存最近一次进度用于展示。
  // 仅为过程提示,不替代 Tool Result / Evidence。
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);
  // 会话内查找(cmd/ctrl+F):仅在表达层对已渲染消息做高亮跳转,不触碰会话真值。
  const [findOpen, setFindOpen] = useState(false);

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

  // 任务续传(ADR 21):防止同一 resumeTask 被自动发送多次的一次性闸门。
  const resumeFiredRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  // 输入框持久化的「上次落盘会话」标记。初值用 undefined 哨兵(区别于真实 id 与 null),
  // 使每次切到新会话的首遍只同步本 ref 并跳过保存,避免把旧会话草稿写到新会话名下。
  const composerPersistConvRef = useRef<string | null | undefined>(undefined);

  // 把流式文本追加到最后一条 assistant 消息的尾部文本段。
  const appendStreamText = useCallback((chunk: string) => {
    if (!chunk) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const segments = [...(last.segments || [])];
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.type === 'text') {
        segments[segments.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + chunk };
      } else {
        segments.push({ type: 'text', content: chunk });
      }
      return [...prev.slice(0, -1), { ...last, content: getTextContent(segments), segments }];
    });
  }, []);

  const appendStreamThinking = useCallback((chunk: string) => {
    if (!chunk) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const segments = [...(last.segments || [])];
      const lastSeg = segments[segments.length - 1];
      // Thinking must remain ordered with tool-call/text segments. Only merge with
      // the active trailing thinking segment; after a tool call/result, start a
      // new thinking segment instead of rewriting an earlier one.
      if (lastSeg && lastSeg.type === 'thinking') {
        segments[segments.length - 1] = { type: 'thinking', content: (lastSeg.content || '') + chunk };
      } else {
        segments.push({ type: 'thinking', content: chunk });
      }
      return [...prev.slice(0, -1), { ...last, segments }];
    });
  }, []);

  // 平滑打字机：网络 delta 进 buffer，rAF 泵匀速吐字，告别"一坨一坨"的生硬感。
  // 正文和深度思考使用独立 buffer，但跨类型切换时必须先 flush 另一侧，
  // 否则两个独立 rAF 泵会打乱网络事件顺序，把正文/思考切成交错小段。
  const textTypewriter = useTypewriterStream(appendStreamText);
  const thinkingTypewriter = useTypewriterStream(appendStreamThinking);
  const threadRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateThreadBottomState = useCallback((container: HTMLDivElement | null) => {
    if (!container) return true;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
    shouldAutoScrollRef.current = atBottom;
    setIsThreadAtBottom(atBottom);
    return atBottom;
  }, []);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = threadRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom(true);
  }, []);

  const handleThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    updateThreadBottomState(event.currentTarget);
  }, [updateThreadBottomState]);

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
  const activeProvider = providers.find((p) => p.isDefault && p.apiKeyConfigured)
    || providers.find((p) => p.apiKeyConfigured)
    || null;
  const activeProviderSupportsReasoning = Boolean(activeProvider?.supportsReasoning);
  const effortLevels = activeProvider?.provider === 'openai' ? OPENAI_EFFORT_LEVELS : BASE_EFFORT_LEVELS;
  const isZh = i18n.locale === 'zh-CN';
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
  const estimatedContextTokens = estimateConversationTokens(messages, draft, attachments);
  // 当前轮进行中(流式/压缩)。此时主操作按钮含义:有草稿则"排队",无草稿则"停止"。
  const isBusy = isStreaming || isCompacting;
  const hasComposerContent = draft.trim().length > 0 || attachments.length > 0;

  useEffect(() => {
    setAttachments([]);
    setAttachmentError(null);
    setPendingPermissionCalls([]);
    setProviderRecoveryNotice(null);
    // 切换会话时恢复「该会话」已持久化的输入框状态(草稿文本 + 待发送队列):
    // 草稿与队列都以 conversationId 为坐标,二次打开应原样保留;无会话(新建未落库)则清空。
    // 草稿区附件不持久化(见 composerPersistence 取舍说明),故切换会话后附件区始终清空。
    const persisted = conversationId ? loadComposerEntry(conversationId) : null;
    setDraft(persisted?.draft ?? '');
    setMessageQueue(persisted?.queue ?? []);
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom(true);
    // 切换会话时,先把流式表达状态按会话归零,避免上一会话的 isStreaming/streamId 残留:
    // 否则从"正在输出的 A"切到"未运行的 B",B 会误显示运行中(左侧列表 Loading、
    // 右下角停止按钮误亮),且旧会话的 delta 仍匹配旧 streamIdRef 污染新会话消息。
    // 归零后由下方 reattach 按"新会话是否确有活跃流"重新点亮,仅以真值为准。
    setIsStreaming(false);
    streamIdRef.current = null;
    // 切换会话时一并清掉本轮计时锚点,避免上一会话的实时跳秒残留到新会话。
    setTurnStartedAt(null);
    textTypewriter.reset();
    thinkingTypewriter.reset();
    if (!conversationId) { setMessages([]); setTokenUsage(null); return; }
    setTokenUsage(null);
    let cancelled = false;
    void (async () => {
      const { messages: loaded, tokenUsage: usage, mode: convMode } = await loadConversationMessages(conversationId);
      if (cancelled) return;
      setMessages(loaded);
      if (usage) setTokenUsage(usage);
      // 对话模式随会话恢复:每会话各自独立,切换会话即切到该会话自己的模式。
      setMode(convMode);

      // ADR 22: HMR 重载/重新打开后,main 进程的流式推理可能仍在进行。
      // 询问后端是否有本会话的活跃流;若有,把已累积的思考/正文接回 UI,
      // 并恢复 streamIdRef,使现有 delta 监听重新匹配、无缝续上(不重发、不打断)。
      try {
        const live = await clientApi.chatStreamReattach({ conversationId });
        if (cancelled || !live || !live.isStreaming || !live.streamId) return;
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
          };
          if (persistedAssistant) {
            return [...base.slice(0, -1), liveMsg];
          }
          return [...base, liveMsg];
        });
        streamIdRef.current = live.streamId;
        setTurnStartedAt(liveStartedAt);
        setIsStreaming(true);
      } catch {
        // reattach 失败不影响正常加载;降级为无续接(用户可重新发送)。
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  // 输入框(草稿 + 待发送队列)按会话持久化。
  // 时序坑:conversationId 变更的那一次提交里,上面的恢复 effect 才刚调用 setDraft/
  // setMessageQueue,本 effect 同批运行时 draft/queue 仍是「上一个会话」的旧值。若此时
  // 直接落盘,会把旧会话的草稿错写到新会话名下。用 ref 记录上次落盘的会话,切换发生的
  // 那一遍只更新 ref 并跳过保存;待恢复完成后(及后续真实编辑)才以当前会话为坐标落盘。
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

  useChatStreamSubscription({
    conversationId,
    onConversationUpdated,
    streamIdRef,
    turnStartedAtRef,
    setTurnStartedAt,
    textTypewriter,
    thinkingTypewriter,
    appendStreamThinking,
    setMessages,
    setIsStreaming,
    setIsCompacting,
    setCompactionPercent,
    setActiveUsage,
    setTokenUsage,
    setStreamError,
    setPendingPermissionCalls,
    setToolProgress,
    setProviderRecoveryNotice,
    usageFromLifetime,
    loadConversationMessages,
  });

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollThreadToBottom('auto');
      return;
    }
    updateThreadBottomState(threadRef.current);
  }, [messages, scrollThreadToBottom, updateThreadBottomState]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashQuery]);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    setDraft(command.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(command.value.length, command.value.length);
    });
  }, []);

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

  // 核心发送路径:给定文本(+ 可选附件)就执行一次 agent turn。
  // handleSend(用户输入)与 pending-task 续传(跨重启)都复用它,避免另造发送路径。
  const submitMessage = useCallback(async (text: string, sentAttachments: ChatAttachment[], submitEffort?: string) => {
    if ((!text && sentAttachments.length === 0) || isStreaming || !hasProvider || !conversationId) return;
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);
    const turnEffort = submitEffort ?? effort;

    // /compact: run compaction in-place without an agent turn
    if (text === '/compact' && sentAttachments.length === 0) {
      const streamId = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      streamIdRef.current = streamId;
      const compactStartedAt = Date.now();
      setIsCompacting(true);
      try {
        const result = await clientApi.chatCompact({ conversationId, streamId });
        if (result.compacted) {
          const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(conversationId);
          setMessages(loaded);
          if (usage) setTokenUsage(usage);
          onConversationUpdated?.();
          // 直接用 invoke 返回的 notification 落地"已压缩"标记,不依赖 chat:compaction
          // 的 done 事件(它与 invoke 响应之间存在到达顺序竞态:finally 会清空
          // streamIdRef,导致 done 事件被 streamId 门控丢弃,标记永远不显示)。
          // 压缩点以时间线内的 CompactionSummaryCard 呈现(已由上方 setMessages 重载),
          // 不再使用底部横幅通知。
        }
      } finally {
        // 保证 spinner 至少可见 ~600ms,避免小会话瞬时完成导致"点了没任何反馈"。
        const elapsed = Date.now() - compactStartedAt;
        const minVisibleMs = 600;
        if (elapsed < minVisibleMs) {
          await new Promise((resolve) => setTimeout(resolve, minVisibleMs - elapsed));
        }
        streamIdRef.current = null;
        setIsCompacting(false);
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
    streamIdRef.current = streamId;
    setTurnStartedAt(Date.now());
    setIsStreaming(true);

    const contextMessages = [...messages, userMsg];
    const apiMessages = toApiMessages(contextMessages);
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const continuityContext = buildConversationContinuityContext(contextMessages);
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
    ];
    void clientApi.chatSend({ messages: apiMessages, streamId, effort: turnEffort, mode, conversationId, contextAttachments, continuityContext, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, onConversationUpdated, effort, mode, systemInstructions, replyLanguage]);

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
  }, [draft, attachments, isStreaming, isCompacting, hasProvider, conversationId, submitMessage, effort]);

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
    const [head, ...rest] = messageQueue;
    setMessageQueue(rest);
    void submitMessage(head.text, head.attachments, head.effort);
  }, [isStreaming, isCompacting, hasProvider, conversationId, resumeTask, messageQueue, submitMessage]);

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
    streamIdRef.current = streamId;
    setTurnStartedAt(Date.now());
    setIsStreaming(true);

    const apiMessages = toApiMessages(contextMessages);
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const continuityContext = buildConversationContinuityContext(contextMessages);
    const configInstructions = [
      ...buildConfigInstructionContext(systemInstructions),
      ...buildReplyLanguageContext(replyLanguage),
    ];
    void clientApi.chatSend({ messages: apiMessages, streamId, effort, mode, conversationId, contextAttachments, continuityContext, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, effort, mode, systemInstructions, replyLanguage]);

  const handleBranch = useCallback(async (msgIndex: number) => {
    if (!conversationId || isStreaming) return;
    const contextMessages = messages.slice(0, msgIndex + 1);
    const branchTitle = contextMessages.find((m) => m.role === 'user')?.content.slice(0, 50) || 'Branch';
    const conv = await clientApi.conversationsCreate({ title: branchTitle }) as { id: string };
    for (const m of contextMessages) {
      await clientApi.conversationsAppendMessage({ id: conv.id, message: { id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, durationMs: m.durationMs, timestamp: m.timestamp, _compaction: m.compaction, attachments: m.attachments, interrupted: m.interrupted } });
    }
    onConversationUpdated?.();
    onBranch?.(conv.id);
  }, [conversationId, isStreaming, messages, onConversationUpdated, onBranch]);

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

  const showScrollToBottom = messages.length > 0 && !isThreadAtBottom;

  // 选择 request_user_input 的选项 = 把该选项作为用户消息，复用既有 submitMessage 发送路径。
  // 见 Goal 模式运行时闸门设计。
  const selectInteractionOption = useCallback((text: string) => {
    if (!text || isStreaming || !hasProvider || !conversationId) return;
    void submitMessage(text, [], effort);
  }, [isStreaming, hasProvider, conversationId, submitMessage, effort]);

  // 计划获批后唤起「执行轮」：把"开始执行"作为一条用户消息，复用既有 submitMessage 发送路径
  // （不另造旁路），让模型在 goal 闸门放行下按计划开始执行子任务。
  // store 侧已落 GoalApproval Evidence（治理事实），此处只负责驱动执行。
  // 见 Goal 模式设计 时序图阶段二（批准）→阶段三（执行）。
  // 真正发起执行轮：把"开始执行"作为一条用户消息复用 submitMessage 路径。
  // 该函数假设调用时已空闲（isStreaming=false）；空闲判定由调用方/effect 负责。
  const dispatchGoalExecution = useCallback((plan: GoalPlan) => {
    if (!hasProvider || !conversationId) return;
    const planLabel = plan.title || plan.goal || '';
    const text = isZh
      ? `我已批准计划「${planLabel}」（planId=${plan.planId}）。请按计划开始执行：依据 dependsOn 拓扑序与先序遍历逐个执行叶子子任务，有副作用的步骤先申请权限，每个子任务完成后用 goal_update_task 以 Evidence 回写状态。`
      : `I have approved the plan "${planLabel}" (planId=${plan.planId}). Please start executing it now: run leaf subtasks in dependsOn topological + pre-order, request permission before any side-effecting step, and write each subtask's status back via goal_update_task with Evidence.`;
    void submitMessage(text, [], effort);
  }, [hasProvider, conversationId, submitMessage, effort, isZh]);

  // 计划获批的入口（GoalPlanPanel onApproved 回调）。
  // 关键修复：若点击批准时本轮助手会话仍在 streaming（AI 还在输出 / 运行时被占用），
  // 不再直接 return 丢弃执行意图（旧 bug：用户"点批准没反应"），而是把 plan 暂存到
  // pendingGoalExecutionRef，待下方 effect 在 isStreaming 转 false（本轮结束）后自动发起执行轮。
  // 即「计划创建后不抢，会话结束后批准才真正生效执行」。
  const startGoalExecution = useCallback((plan: GoalPlan) => {
    if (!hasProvider || !conversationId) return;
    if (isStreaming) {
      pendingGoalExecutionRef.current = plan;
      return;
    }
    dispatchGoalExecution(plan);
  }, [isStreaming, hasProvider, conversationId, dispatchGoalExecution]);

  // 监听本轮会话结束：当 isStreaming 由 true→false 且存在暂存的执行意图时，
  // 自动发起执行轮并清空暂存。这样在 streaming 中点的批准会"延后到会话结束"生效。
  useEffect(() => {
    if (isStreaming) return;
    const pending = pendingGoalExecutionRef.current;
    if (!pending) return;
    if (!hasProvider || !conversationId) return;
    pendingGoalExecutionRef.current = null;
    dispatchGoalExecution(pending);
  }, [isStreaming, hasProvider, conversationId, dispatchGoalExecution]);

  // 方案 B：右侧常驻分栏的 portal 宿主。GoalPlanPanel 展开态 body 投影到此 <aside>。
  // 用回调 ref 存 DOM，挂载后触发重渲染，确保首次展开就能拿到容器。
  const [goalSideEl, setGoalSideEl] = useState<HTMLElement | null>(null);

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
    <InteractionContext.Provider value={{ onSelectOption: selectInteractionOption, isStreaming }}>
    <div className="chat-workspace">
    <div className="chat-surface">
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
        ) : messages.map((msg, idx) => (
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
                <AssistantContent
                  segments={msg.segments}
                  content={msg.content}
                  isStreaming={isStreaming && msg === messages[messages.length - 1]}
                  toolProgress={isStreaming && msg === messages[messages.length - 1] ? toolProgress : null}
                  isZh={isZh}
                />
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
          <div className="chat-stream-error"><span>⚠ {streamError}</span></div>
        ) : null}
      </div>

      <MessageRail items={railItems} onSelect={scrollToMessage} i18n={i18n} />

      {showScrollToBottom ? (
        <button
          type="button"
          className="chat-scroll-bottom-btn"
          onClick={() => scrollThreadToBottom('smooth')}
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
        {mode === 'goal' ? <GoalPlanPanel conversationId={conversationId} isZh={isZh} onApproved={startGoalExecution} sidePanelContainer={goalSideEl} /> : null}
        <PermissionGateStrip
          pendingCalls={pendingPermissionCalls}
          onApprove={approvePendingPermissionCall}
          onApproveAlways={approveAlwaysPendingPermissionCall}
          onReject={denyPendingPermissionCall}
          i18n={i18n}
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
                tone: m === 'goal' ? 'danger' : undefined,
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
            isStreaming={isStreaming}
            isZh={isZh}
            effort={effort}
            effortLevels={activeProviderSupportsReasoning ? effortLevels : []}
            onEffortChange={changeEffort}
          />
        </div>
      </div>
      {imagePreview?.kind === 'image' && imagePreview.dataUrl ? (
        <ImagePreviewOverlay attachment={imagePreview} isZh={isZh} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
    {/* 方案 B：右侧常驻分栏。GoalPlanPanel 展开态 body 经 portal 投影到此。
        无 portal 内容时由 :empty 规则收为零宽，会话区自动占满。 */}
    <aside className="chat-side-panel" ref={setGoalSideEl} />
    </div>
    </InteractionContext.Provider>
  );
}
