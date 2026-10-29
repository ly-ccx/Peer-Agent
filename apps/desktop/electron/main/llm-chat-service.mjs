
import {
  contextSnapshotPersistKey,
  finalizeDanglingToolSegments,
  hasBillableUsage,
  mergeUsageAmounts,
  terminalDanglingNote,
  usageRequestLog,
  wrapWebContentsForRuntimeEvents,
} from './chat-runtime/stream-event-projection.mjs';
import { normalizeTurnProfile, projectTurnSystemContext, textField } from "./chat-runtime/turn-context.mjs";
import { agentMessagesForContext, readWorkingContext, recordAgentContextAdmission } from '@peer-agent/runtime-node/project-agent';
export { projectTurnSystemContext } from "./chat-runtime/turn-context.mjs";
import { agentCommunicationExcludedPrefixes } from "@peer-agent/runtime-node/project-agent";
import {
  buildAnthropicTools,
  buildAnthropicToolsFromModelProjection,
  buildOpenAITools,
  buildOpenAIToolsFromModelProjection,
  buildSystemContext,
  buildSystemPrompt,
  createRuntimeToolProjection,
  renderSystemContext,
  renderStableSystemContext,
} from './llm-prompts.mjs';
import { memoryIdsFromAssembledContext, taskAcceptanceFromMessages } from '@peer-agent/system-context';
import { withSelectionRequestContext } from './selection-background-context.mjs';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import { reprojectContextAccountingWindow } from '@peer-agent/runtime-core';
import { normalizeAnthropicMessages, normalizeOpenAIMessages } from './provider-encoders/index.mjs';
import { agentLoopAnthropic } from './chat-runtime/anthropic-agent-loop.mjs';
import { agentLoopGemini } from './chat-runtime/gemini-agent-loop.mjs';
import { agentLoopOpenAI } from './chat-runtime/openai-agent-loop.mjs';
import { agentLoopQoder } from './chat-runtime/qoder-agent-loop.mjs';
import { sanitizeApiMessages } from './chat-runtime/message-sanitizer.mjs';
import { createChatPermissionGate } from './chat-runtime/permission-gate.mjs';
import { resolveActiveGoalExecutionBinding } from './chat-runtime/goal-mode-gate.mjs';
import { preparePlanExecutionWorkspace } from './goal-preferred-worktree.mjs';
import {
  createProviderAttemptStream,
  describeFetchFailure,
  describeProviderTarget,
  orderProviderCandidates,
} from './chat-runtime/provider-recovery-broker.mjs';
import { hasUnsupportedToolClaim } from './chat-runtime/response-guard.mjs';
import { createDesktopRuntimeSessionAdapter } from './chat-runtime/runtime-session-adapter.mjs';
import { createToolContext } from './chat-runtime/tool-orchestrator.mjs';
import { getProviderCredentialErrorMessage, resolveProviderCredential } from './provider-credential-resolver.mjs';
import { resolveChannel } from './provider-channels.mjs';
import {
  requireDesktopVisualReview,
  requireVisualReviewProvider,
  runDesktopVisualReview,
  cancelDesktopVisualReview,
} from './runtime-gateway/desktop-visual-review.mjs';
import { processTrailingUserImages, readFallbackVisionProviderId, recognizeImagesWithFallbackProvider } from './chat-runtime/fallback-vision.mjs';
import { resolveGeminiCodeAssistProjectId } from './subscription-quota.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { getQoderModelMetadata, resolveQoderModelOptionProjection } from './provider-adapters/qoder-model-catalog.mjs';
import { startOfLocalDayMs, sumRoleSpendUsd } from './usage-stats.mjs';
import { resolveConversationModelProviderId } from './conversation-model-binding.mjs';
import { persistContextAccounting } from './chat-runtime/persist-context-accounting.mjs';
import { afterTerminalCommit } from './chat-runtime/stream-terminal-delivery.mjs';
import { createApprovalStore } from "@peer-agent/runtime-node/storage";
import { createBotAccessPolicyAuthority, resolvePermissionPrincipal } from "@peer-agent/runtime-node/project-agent";
import { createProjectRegistry } from "@peer-agent/runtime-node/providers";
import { resolveRoleRoute } from "@peer-agent/runtime-node/models";
import { liveMemoryGate } from './project-agent/memory-gate-port.mjs';

const activeStreams = new Map();

const permissionGate = createChatPermissionGate({ activeStreams });
const durableApprovals = createApprovalStore();
let approvalRegistry = null;
const conversationToolContexts = new Map();
let activeWorkspacePath = null;

// (a) 同 provider 流读取早期中断的自动重试退避。
//
// 注意：传输层 recovering-fetch 已经对「连接阶段」的瞬态失败做了自己的有界退避
// （含 connect-timeout 兜底）。如果这里再复用传输层那一整组延迟，两层会相乘叠加，
// 首发一旦失败用户要干等很久——这正是「第一次调用卡住」的主因之一。
// 因此本层只负责「连接已建立、但流读取早期被掐断」(replay-safe) 的重试，使用独立的
// 短而有界的快速退避（首轮快速重试 + 有界总时长 ~5s），与传输层退避解耦，避免乘积。
const SAME_PROVIDER_RETRY_DELAYS_MS = [500, 1_500, 3_000];

// 流终结后保留 streamRecord 的时长。done/error/aborted 后不立即删除记录，而是标记
// terminal 并保留一段时间，使「切回已结束的后台轮次」仍能通过 reattach 回放完整终态
// 快照（正文/segments/interrupted/usage）。保留期满后才硬删除，释放内存。
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

// 可被用户 abort 打断的退避等待：abort 时以 AbortError 拒绝，沿用既有
// AbortError -> chat:stream:aborted 的结构化取消路径。
function sleepWithSignal(ms, signal) {
  const makeAbortError = () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  };
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(makeAbortError());
    }, { once: true });
  });
}

function buildRuntimeTools({
  mcpRegistry,
  skillStore,
  providerType,
  mode,
  excludeCapabilityPrefixes = null,
  readOnlyWorkSession = false,
}) {
  // mode 作为运行时事实下传到 Runtime Projection，模式隔离工具暴露（ADR 35）。
  // project_agent 回合把投影上的 accessLevel 标成 restricted_local。共享 permission-gate 不在这里改。
  const projectionOptions = {
    readOnlyWorkSession,
    mode,
    ...(mode === 'project_agent' ? { accessLevel: 'restricted_local' } : {}),
    ...(Array.isArray(excludeCapabilityPrefixes) && excludeCapabilityPrefixes.length
      ? { excludeCapabilityPrefixes }
      : {}),
  };
  const { registry, projection, modelProjection } = createRuntimeToolProjection({
    mcpRegistry,
    skillStore,
    projectionOptions,
  });
  const tools = providerType === 'anthropic'
    ? buildAnthropicToolsFromModelProjection(modelProjection)
    : buildOpenAIToolsFromModelProjection(modelProjection);
  return { registry, runtimeProjection: projection, tools };
}

export { buildAnthropicTools, buildOpenAITools, buildSystemPrompt };
// restored 重投影(21 号文档 13.3)需要按模式投影工具 schema,导出供 main 复用。
export { buildRuntimeTools };
export { normalizeAnthropicMessages, normalizeOpenAIMessages };
export { hasUnsupportedToolClaim };
export { finalizeDanglingToolSegments, terminalDanglingNote };
export { resolveResumeSeed };
export { mergeUsageAmounts };
export { sanitizeApiMessages };
export { resolveRunWorkspacePath };

/**
 * 解析「本轮运行的工作根目录」。一轮 agent 运行的 cwd / 系统上下文以「该会话绑定的
 * workspacePath」为唯一真值，不再依赖全局可变的 activeWorkspacePath，从根上消除
 * 「新用户首条消息跑错根目录」这一类全局态滞后导致的 bug。兜底链（按优先级）：
 *   B1 主真值：按 conversationId 从 conversation-store 读取会话绑定的 workspacePath；
 *   B2 兜底/校验：渲染端经 chat:send 透传的 incomingWorkspacePath（仅当会话无绑定时启用）；
 *   兜底：全局活跃工作区 activeWorkspacePath（历史会话无 workspacePath / conversationId 为空时）；
 *   最终兜底：process.cwd()。
 * 提为模块级纯函数（依赖经参数注入）以便单测，闭包内由 createLlmChatService 透传捕获的状态。
 */
function resolveRunWorkspacePath({
  conversationStore = null,
  conversationId = null,
  incomingWorkspacePath = null,
  activeWorkspacePath = null,
} = {}) {
  if (conversationId && conversationStore?.getConversation) {
    try {
      const conv = conversationStore.getConversation(conversationId);
      const bound = conv?.workspacePath;
      if (bound && typeof bound === 'string') return bound;
    } catch {
      // 读取失败时落到兜底链，不阻断本轮运行。
    }
  }
  if (incomingWorkspacePath && typeof incomingWorkspacePath === 'string') return incomingWorkspacePath;
  if (activeWorkspacePath && typeof activeWorkspacePath === 'string') return activeWorkspacePath;
  return process.cwd();
}

function resolveProjectLinkedFolders(workspacePath, getSettings) {
  if (!workspacePath || typeof getSettings !== 'function') return [];
  const workspaces = Array.isArray(getSettings()?.workspaces) ? getSettings().workspaces : [];
  const current = workspaces.find((workspace) => workspace?.path === workspacePath);
  const folders = [];
  const seen = new Set();
  for (const folder of current?.linkedFolders || []) {
    const folderPath = typeof folder?.path === 'string' ? folder.path : null;
    if (!folderPath || folderPath === workspacePath || seen.has(folderPath)) continue;
    seen.add(folderPath);
    folders.push(folderPath);
  }
  return folders;
}

function mergeReadableRoots(baseRoots, extraRoots) {
  const merged = [];
  const seen = new Set();
  for (const root of [...(baseRoots || []), ...(extraRoots || [])]) {
    if (typeof root !== 'string' || !root || seen.has(root)) continue;
    seen.add(root);
    merged.push(root);
  }
  return merged.length > 0 ? merged : null;
}

function buildGoalWorkspaceBindingExtensions(binding) {
  const origin = binding?.originWorkspacePath ?? null;
  const target = binding?.targetWorkspacePath ?? null;
  if (!origin || !target || origin === target) return [];
  return [{
    id: `goal-workspace-binding-${binding.planId || 'active'}`,
    title: 'Goal workspace binding',
    layer: 'L3_INSTRUCTIONS',
    priority: 20,
    sourceKind: 'runtime',
    trust: 'runtime',
    content: [
      `Goal origin workspace: ${origin}`,
      `Goal target workspace: ${target}`,
      'Use the origin workspace as the knowledge and intent source.',
      'Write, edit, run checks, and collect implementation evidence in the target workspace unless the Goal explicitly changes scope.',
      'Do not treat the origin workspace as the write boundary for this Goal.',
    ].join('\n'),
  }];
}

function recordPromptSnapshot(store, context, metadata) {
  try {
    store?.record?.(context, metadata);
  } catch (error) {
    console.warn('[llm-chat] failed to record prompt snapshot:', error?.message || error);
  }
}

function buildAgentRunOutcome(streamRecord = {}) {
  return {
    terminalStatus: streamRecord.terminalStatus || 'error',
    requestedUserInput: Boolean(streamRecord.requestedUserInput),
    toolCallCount: Number.isFinite(streamRecord.toolCallCount)
      ? Math.max(0, Math.trunc(streamRecord.toolCallCount))
      : 0,
    ...(hasBillableUsage(streamRecord.finalUsage) ? { usage: streamRecord.finalUsage } : {}),
    failureReason: typeof streamRecord.failureReason === 'string'
      ? streamRecord.failureReason
      : null,
    // 「未知」和「明确不可恢复」是两件事。只透出真正做过的判断；缺失时交给下游按可恢复模式
    // 分类。此前这里写 `=== true`，把没有判断的流伪造成显式 false，于是 goal-runner 在
    // 「显式否决」分支就短路返回，重试预算永远够不到，一次瞬时断流就能永久打死自驱回合。
    ...(typeof streamRecord.recoverable === 'boolean' ? { recoverable: streamRecord.recoverable } : {}),
    // 流被中断（error/aborted）且没有显式判断时，带上 interrupted 让下游识别为瞬时中断。
    ...(streamRecord.interrupted === true ? { interrupted: true } : {}),
  };
}

/**
 * 原生 reasoning 当轮自愈降级的观测点（不持久化）。
 *
 * agent loop 在某一轮拿到“空响应”(textContent 与 thinkingContent 均为空) 时,
 * 已在 loop 内将 effectiveSupportsReasoning 置 false 并重试当轮——这是合理的会话内自愈。
 *
 * 这里**刻意不再写回 provider 配置**:偶发空响应(限流/网络抖动/深度模式边界/上下文极满)
 * 不能等同于“该 provider 不支持 reasoning”。曾经在此调用 updateProvider({supportsReasoning:false})
 * 会把一次偶发事件固化成持久能力位,导致用户没动设置、深度档却被悄悄永久关闭。
 * 详见 docs/architecture 中关于 provider 能力位与会话内降级的边界说明。
 */
function noteNativeReasoningFallback(provider, details = {}) {
  if (!provider?.id) return;
  console.warn(
    `[llm-chat] native reasoning fell back to plain mode for this turn (provider ${provider.id}): ${details.reason || 'unsupported'}; capability flag left unchanged`
  );
}

/**
 * 续写中断回复的种子解析（纯函数，便于单测）。
 *
 * 「网络中断 → 继续」要求原地续写：本轮 streamRecord 的累积状态以既有（interrupted）
 * assistant 消息为初始值，delta 在其后追加；计时锚点回拨到原消息时间戳。
 *
 * 返回 null 的所有情形都退回「从零开始」的既有行为：
 * - 未开启 resumeInterruptedReply（普通发送 / regenerate 不受影响）；
 * - 缺 conversationId / assistantMessageId / store 读不到会话或消息；
 * - 目标消息不是 assistant（防御 renderer 传错 id）。
 *
 * accumulatedThinking 从 segments 里的 thinking 段按「合并规则」重建：与
 * wrapWebContentsForRuntimeEvents 的 segment join 规则一致——summary 段之间
 * 换行分隔，非 summary 段直接拼接。这样续写后 thinking 快照（reattach 用）不丢。
 */
function joinThinkingSeed(segments) {
  let acc = '';
  let lastKind = null;
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || segment.type !== 'thinking' || typeof segment.content !== 'string') continue;
    const kind = segment.kind === 'summary' ? 'summary' : null;
    if (kind === 'summary' && lastKind === 'summary' && acc) acc += '\n';
    acc += segment.content;
    lastKind = kind;
  }
  return acc;
}

function resolveResumeSeed(conversationId, assistantMessageId, { resumeInterruptedReply = false, conversationStore = null } = {}) {
  if (!resumeInterruptedReply) return null;
  if (!conversationId || !assistantMessageId) return null;
  if (!conversationStore?.getConversation) return null;
  const conversation = conversationStore.getConversation(conversationId);
  const message = Array.isArray(conversation?.messages)
    ? conversation.messages.find((m) => m && m.id === assistantMessageId)
    : null;
  if (!message || message.role !== 'assistant') return null;
  return {
    messageId: message.id,
    content: typeof message.content === 'string' ? message.content : '',
    segments: Array.isArray(message.segments) ? message.segments : [],
    accumulatedThinking: joinThinkingSeed(message.segments),
    usage: message.usage && typeof message.usage === 'object' ? { ...message.usage } : null,
    timestamp: typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp > 0
      ? message.timestamp
      : null,
  };
}

function getActiveContextEpochId(store, conversationId = null) {
  try {
    return store?.getLatestContextEpoch?.(conversationId)?.contextEpochId
      ?? store?.getLatestContextEpoch?.(null)?.contextEpochId
      ?? null;
  } catch {
    return null;
  }
}

function getConversationToolContext({ conversationId = null, workspacePath = null } = {}) {
  if (!conversationId) return createToolContext({ conversationId, workspacePath });
  const key = `${conversationId}::${workspacePath || process.cwd()}`;
  let context = conversationToolContexts.get(key);
  if (!context) {
    context = createToolContext({ conversationId, workspacePath });
    conversationToolContexts.set(key, context);
  }
  return context;
}

export function createLlmChatService({
  llmConfigStore,
  conversationStore = null,
  emitRuntimeEvent = null,
  persistCompaction = null,
  promptSnapshotStore = null,
  preferredAccessLevel = 'ask_before_local',
  accessPolicyAuthority = null,
  mcpRegistry = null,
  skillStore = null,
  automationProposalService = null,
  // main 注入的带 onChange 的 goalPlanStore 单例。AI 工具(goal_create_plan/
  // goal_update_task)必须写到它，变更才能广播到渲染端，浮条才会随流式更新。
  goalPlanStore = null,
  goalWorktreeAdapter = null,
  goalTaskBranchAdapter = null,
  // main 注入的 Browser 工作现场 reveal 桥；Agent 工具路径创建 LocalToolHost 时需要它。
  ensureBrowserReady = null,
  // 全局活跃流广播宿主(由 main 注入):向所有渲染窗口推送当前正在运行的会话列表,
  // 使左侧列表无需"点进去"即可知道哪些会话在跑。表达层订阅,真值仍在 activeStreams。
  broadcast = null,
  runtimeSessionAdapter = null,
  // 读取全局 settings.json（含 fallbackVision 兜底多模态模型配置）。
  getSettings = null,
}) {
  permissionGate.setAccessLevel(preferredAccessLevel);
  const botAccess = accessPolicyAuthority ?? createBotAccessPolicyAuthority({ conversationStore, goalPlanStore, legacyAccessLevel: preferredAccessLevel });
  permissionGate.configure({
    resolveAccessPolicy({ streamId, conversationId }) {
      const profile = activeStreams.get(streamId)?.turnProfile;
      return botAccess.resolve({ conversationId, workspaceId: profile?.workspaceId,
        planId: profile?.planId, sessionId: profile?.sessionId, role: profile?.role });
    },
    approvalStore: durableApprovals,
    resolveApprovalScope({ conversationId, workspacePath }) {
      let workspaceId = null;
      if (typeof workspacePath === 'string' && workspacePath.trim()) {
        try {
          approvalRegistry ??= createProjectRegistry();
          workspaceId = approvalRegistry.findByPath(workspacePath)?.workspaceId ?? null;
        } catch {
          workspaceId = null;
        }
      }
      let planId = null;
      try {
        planId = goalPlanStore?.getActivePlanByConversation?.(conversationId)?.planId ?? null;
      } catch {
        planId = null;
      }
      return { workspaceId, planId, conversationId: conversationId ?? null };
    },
    resolvePermissionPrincipal({ streamId, conversationId, workspacePath }) {
      const profile = activeStreams.get(streamId)?.turnProfile;
      approvalRegistry ??= createProjectRegistry();
      return resolvePermissionPrincipal({ workspaceId: profile?.workspaceId ?? approvalRegistry.findByPath(workspacePath)?.workspaceId,
        conversationId, planId: profile?.planId, sessionId: profile?.sessionId, goalPlanStore });
    },
    settleNotifier: typeof broadcast === 'function'
      ? (streamId, toolCallIds, event = {}) => {
        try {
          broadcast('chat:stream:permission-settled', { ...event, streamId, toolCallIds });
        } catch (error) {
          console.warn('[llm-chat] permission settle broadcast failed:', error?.message || error);
        }
      }
      : null,
  });
  const runtimeSessions = runtimeSessionAdapter ?? createDesktopRuntimeSessionAdapter();

  function setWorkspacePath(wsPath) { activeWorkspacePath = wsPath; }

  // 闭包薄封装：把当前捕获的 conversationStore / activeWorkspacePath 注入模块级纯函数
  // resolveRunWorkspacePath（见文件顶部，含完整兜底链说明与单测）。
  function resolveRunWorkspacePathForRun(conversationId = null, incomingWorkspacePath = null) {
    return resolveRunWorkspacePath({
      conversationStore,
      conversationId,
      incomingWorkspacePath,
      activeWorkspacePath,
    });
  }

  function setLocalAccessLevel(nextAccessLevel) {
    return permissionGate.setAccessLevel(nextAccessLevel);
  }

  // 当前正在流式运行的会话 id 去重列表(只读快照)。
  // 流终结后保留记录（供切回回放），但终结后的记录不应再被视为「运行中」。
  // 因此所有「活跃」投影/认领都以 terminalEventSent 为界：仅未终结的才算 running。
  function isRunning(record) {
    return Boolean(record) && !record.terminalEventSent;
  }

  // 流终态收口：标记保留、广播运行态变化（终态记录会从 running 投影中消失），
  // 并安排保留期满后的硬删除。重复调用安全（计时器只设一次）。
  function retireStream(streamId) {
    const record = activeStreams.get(streamId);
    if (!record) return;
    record.retainedAt = Date.now();
    emitActiveStreamsChanged();
    if (record.cleanupTimer) return;
    record.cleanupTimer = setTimeout(() => {
      activeStreams.delete(streamId);
    }, TERMINAL_RETENTION_MS);
    if (typeof record.cleanupTimer?.unref === 'function') record.cleanupTimer.unref();
  }

  /** Host-only attestation for selection capture; never accept this from renderer. */
  function getSelectionRuntimeState(conversationId) {
    const history = conversationStore?.getPersistedConversationHistory?.(conversationId);
    if (!history) return { conversationId, contentRevision: null, status: 'unknown' };
    const records = [...activeStreams.values()].filter((record) =>
      record.conversationId === conversationId && isRunning(record));
    const base = { conversationId, contentRevision: history.contentRevision };
    if (records.length > 1) return { ...base, status: 'unknown' };
    if (records.length === 1) {
      const activeMessageId = records[0].assistantMessageId;
      return typeof activeMessageId === 'string' && activeMessageId
        ? { ...base, status: 'running', activeMessageId }
        : { ...base, status: 'unknown' };
    }
    // A persisted streaming marker without a live stream may be an interrupted run.
    return { ...base, status: history.excludedFromMessageId ? 'unknown' : 'idle' };
  }

  function listActiveConversationIds() {
    const ids = new Set();
    for (const record of activeStreams.values()) {
      if (isRunning(record) && record.conversationId && !record.ephemeral) ids.add(record.conversationId);
    }
    return [...ids];
  }

  // ADR 27: 活跃流投影携带工作区维度。按 conversationId 去重(同一会话可能有多条流,
  // 取首条记录的 origin 工作区即可),供 renderer 派生"哪些工作区有运行中的流"。
  // workspacePath / originWorkspacePath 都是会话发起侧；execution 不进绿点投影。
  function listActiveStreams() {
    const byConversation = new Map();
    for (const record of activeStreams.values()) {
      if (!isRunning(record)) continue;
      if (!record.conversationId) continue;
      if (record.ephemeral) continue;
      if (!byConversation.has(record.conversationId)) {
        const originWorkspacePath = record.originWorkspacePath
          ?? record.workspacePath
          ?? null;
        byConversation.set(record.conversationId, {
          conversationId: record.conversationId,
          streamId: record.streamId,
          role: record.turnProfile?.role ?? null,
          // 绿点真值：origin（会话发起工作区）
          workspacePath: originWorkspacePath,
          originWorkspacePath,
        });
      }
    }
    return [...byConversation.values()];
  }

  // activeStreams 发生增删后广播一次,让所有窗口的左侧列表同步运行状态。
  // ADR 27: 在保留 conversationIds(既有消费者不破坏)的同时附带 streams(带工作区)。
  function emitActiveStreamsChanged() {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast('chat:stream:active-changed', {
        conversationIds: listActiveConversationIds(),
        streams: listActiveStreams(),
      });
    } catch {}
  }

  function getProviderCandidates(preferredProviderId = null, allowedProviderIds = null) {
    // 路由真值必须与设置页/聊天选择器一致：只使用用户明确保存的 provider×model 记录。
    // 目录展开只是“可导入候选”，不能替换真实记录，否则 renderer 回传的真实 id 会在
    // main 进程消失，并错误回退到目录里的另一模型。
    const providers = llmConfigStore.listProviders();
    return orderProviderCandidates(providers, preferredProviderId, allowedProviderIds);
  }

  /**
   * 主模型不支持 vision 时，仅对本轮末尾 user 消息中的新图做：
   * - 已配置兜底多模态模型：先识别，再静默注入文本
   * - 未配置：剥离 image_url，并弱提示
   * 历史图不触发。会话落盘仍保留原始附件，仅改发送给 provider 的 messages。
   */
  async function prepareMessagesForProviderVision(messagesInput, preferredProviderId, webContents, streamId) {
    const source = Array.isArray(messagesInput) ? messagesInput : [];
    const candidates = getProviderCandidates(preferredProviderId);
    const primary = candidates[0] || null;
    const supportsVision = Boolean(primary?.supportsVision);
    const probe = processTrailingUserImages(source, { supportsVision });
    if (supportsVision || !probe.imageUrls.length) {
      return source;
    }

    const settings = typeof getSettings === 'function' ? getSettings() : null;
    const fallbackId = readFallbackVisionProviderId(settings);
    const allProviders = typeof llmConfigStore?.listProviders === 'function'
      ? llmConfigStore.listProviders()
      : candidates;
    const fallbackProvider = fallbackId
      ? allProviders.find((item) => item.id === fallbackId) || null
      : null;

    let imageDescriptions = null;
    let credentialResolved = false;
    let recognitionStatus = fallbackProvider ? 'not_started' : 'provider_not_found';
    let recognitionError = null;
    let recognitionWire = null;
    if (fallbackProvider?.supportsVision) {
      try {
        recognitionStatus = 'started';
        const recognition = await recognizeImagesWithFallbackProvider({
          provider: fallbackProvider,
          imageUrls: probe.imageUrls,
          userText: probe.trailingUserText || '',
          getCredential: async (id) => {
            const target = allProviders.find((item) => item.id === id) || fallbackProvider;
            const credential = await resolveProviderCredential({ provider: target, llmConfigStore });
            credentialResolved = true;
            return credential;
          },
          resolveChannel,
          fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init, {
            webContents,
            streamId,
            provider: fallbackProvider.id,
            model: fallbackProvider.model,
          }),
        });
        recognitionWire = recognition?.wire || null;
        recognitionError = recognition?.ok ? null : (recognition?.error || 'recognition_failed');
        recognitionStatus = recognition?.ok ? 'succeeded' : 'failed';
        if (recognition?.ok && Array.isArray(recognition.descriptions) && recognition.descriptions.length) {
          imageDescriptions = recognition.descriptions;
        }
      } catch (error) {
        recognitionStatus = 'failed';
        recognitionError = error?.code || error?.message || 'recognition_failed';
      }
    } else if (fallbackProvider) {
      recognitionStatus = 'provider_without_vision';
    }

    const processed = processTrailingUserImages(source, {
      supportsVision: false,
      imageDescriptions,
    });
    console.info('[llm-chat] fallback_vision', {
      streamId,
      primaryProviderId: primary?.id || null,
      primarySupportsVision: supportsVision,
      detectedImageCount: probe.imageUrls.length,
      fallbackProviderId: fallbackId,
      fallbackProviderFound: Boolean(fallbackProvider),
      fallbackAuthMethod: fallbackProvider?.authMethod || null,
      credentialResolved,
      recognitionStatus,
      recognitionWire,
      recognitionError,
      descriptionCount: imageDescriptions?.length || 0,
      injected: processed.recognizedImageCount > 0,
      strippedImageCount: processed.strippedImageCount,
    });
    if (processed.changed && !imageDescriptions) {
      try {
        webContents?.send?.('chat:stream:notice', {
          streamId,
          code: 'vision_images_stripped',
          message: 'Images were omitted because the current model does not support vision. Configure a fallback vision model in Settings → Models.',
          imageCount: processed.strippedImageCount,
        });
      } catch {
        // notice is best-effort
      }
    }
    return processed.messages;
  }

  async function sendMessage({
    messages: rawMessages,
    webContents,
    streamId,
    effort = 'default',
    fastMode = false,
    mode = 'chat',
    conversationId = null,
    // 会话级首选 provider（会话 meta.modelProviderId 透传）。指定时排为本轮主 provider；
    // 若该 provider 已失效/被删，orderProviderCandidates 会自动回退默认（强绑定回退）。
    modelProviderId = null,
    // B2 兜底：渲染端经 chat:send 透传的工作区路径，仅在会话未绑定 workspacePath 时作为兜底/校验，
    // 不作为主真值（主真值由 resolveRunWorkspacePath 按 conversationId 从 store 解析）。
    workspacePath: incomingWorkspacePath = null,
    assistantMessageId = null,
    contextAttachments = [],
    runtimeReminders = [],
    attachmentContext = [],
    continuityContext = [],
    configInstructions = [],
    contextExtensions = [],
    explorerContext = null,
    verifierContext = null,
    visualReviewHandle = null,
    // Goal Runner 进度 sink：{ onRound, onToolCall }。onRound 经各 provider loop 透传，
    // onToolCall 经 toolContext 透传，分别用于实时轮次/工具计数。普通 chat 不传。
    agentProgress = null,
    executionBudget = null,
    // Request-scoped policy for governed background runs (for example Automation).
    // It is copied into this turn's Tool Context and never mutates the shared chat access level.
    permissionPolicy = null,
    // 内部旁路流（Explorer / Verifier）：不写会话正文、不进活跃流投影，避免验收 JSON 泄漏到聊天。
    ephemeral = false,
    // 续写中断回复：把 assistantMessageId 指向的既有（interrupted）assistant 消息
    // 作为本轮累积种子——正文/segments 从已落盘内容继续追加，计时锚点回拨到原消息
    // 时间戳，不重置。用于「网络中断 → 继续」的原地续写，而不是整条重写。
    resumeInterruptedReply = false,
    turnProfile = null,
  }) {
    // 托管回合（Goal Runner 等）没有 renderer 再次透传 modelProviderId，但只要绑定了
    // conversationId，就必须继承该会话的模型选择。否则会静默落到全局默认 provider，
    // 造成 UI 显示 ChatGPT、后台实际改跑 Grok 的跨模型漂移。
    // 角色回合把已解析的模型放在 turnProfile.modelSelection，优先于会话绑定。
    const profile = normalizeTurnProfile(turnProfile);
    const projectAgentTurn = mode === 'project_agent' || profile?.role === 'project_agent';
    const runtimeMode = projectAgentTurn ? 'project_agent' : mode;
    const effectiveModelProviderId = profile?.modelSelection?.modelProviderId
      || resolveConversationModelProviderId({
        modelProviderId,
        conversationId,
        conversationStore,
      });
    const providerCandidates = getProviderCandidates(
      effectiveModelProviderId,
      profile?.recoveryCandidateIds ?? null,
    );
    if (visualReviewHandle !== null) {
      let visualReview = null;
      try {
        visualReview = requireDesktopVisualReview(visualReviewHandle, { goalPlanStore, mode, ephemeral, conversationId });
        const provider = providerCandidates[0];
        if (effectiveModelProviderId && provider?.id !== effectiveModelProviderId) throw new Error('visual-review-selected-provider-missing');
        requireVisualReviewProvider(provider);
        providerCandidates.splice(1); // Independent review never silently changes model.
        incomingWorkspacePath = visualReview.workspacePath;
        verifierContext = visualReview.verifierContext;
        rawMessages = [];
      } catch (error) {
        if (typeof error?.message === 'string' && error.message.startsWith('visual-review-')) {
          try { visualReview?.recordFailure?.(error.message); } catch { /* best-effort */ }
        }
        cancelDesktopVisualReview(visualReviewHandle); throw error;
      }
    }
    if (!providerCandidates.length) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return { terminalStatus: 'error', requestedUserInput: false, toolCallCount: 0 };
    }
    const messages = await prepareMessagesForProviderVision(
      rawMessages,
      effectiveModelProviderId,
      webContents,
      streamId,
    );

    // 会话 workspace 是本轮的 origin：用户从哪里发起、有哪些知识上下文。Goal 模式下，
    // active Goal 可绑定 targetWorkspacePath；此时工具 cwd / 项目指令切换到 target，
    // origin 作为 runtime context extension 注入，不再把 origin 当写入边界。
    const conversationWorkspacePath = resolveRunWorkspacePathForRun(conversationId, incomingWorkspacePath);
    // Agent 默认（chat）与 legacy goal 均可绑定 active Goal 的 target workspace。
    // 项目代理回合不进入 Goal 工作区准备。
    if (!projectAgentTurn && (mode === 'goal' || mode === 'chat')) {
      try {
        const activePlan = typeof goalPlanStore?.getActivePlanByConversation === 'function'
          ? goalPlanStore.getActivePlanByConversation(conversationId)
          : null;
        if (activePlan) {
          const conversation = typeof conversationStore?.getConversation === 'function'
            ? conversationStore.getConversation(conversationId)
            : null;
          await preparePlanExecutionWorkspace({
            plan: activePlan,
            conversation,
            ensureTaskBranch: goalTaskBranchAdapter?.ensureTaskBranch,
            prepareForPlan: goalWorktreeAdapter?.prepareForPlan,
            isolatePlan: goalWorktreeAdapter?.isolatePlan,
          });
        }
      } catch (error) {
        console.warn('[goal-worktree] prepare failed; writing to bound workspace:', error?.message || error);
      }
    }
    const goalWorkspaceBinding = (!projectAgentTurn && (mode === 'goal' || mode === 'chat'))
      ? resolveActiveGoalExecutionBinding(conversationId, conversationWorkspacePath, goalPlanStore)
      : null;
    const runWorkspacePath = goalWorkspaceBinding?.executionWorkspacePath || conversationWorkspacePath;
    const projectLinkedFolders = resolveProjectLinkedFolders(conversationWorkspacePath, getSettings);
    const effectiveContextExtensions = [
      ...(Array.isArray(contextExtensions) ? contextExtensions : []),
      ...buildGoalWorkspaceBindingExtensions(goalWorkspaceBinding),
    ];

    const runtimeTurn = runtimeSessions.startStream({ streamId, conversationId });
    // 续写种子：resumeInterruptedReply 时从 store 取既有（interrupted）assistant 消息，
    // 把已落盘的正文/segments/usage 作为本轮累积的初始状态——后续 delta 在其后追加，
    // persistStreamRecord 的全量 patch 因此是「保留 + 追加」而不是覆盖清空。
    const resumeSeed = resolveResumeSeed(conversationId, assistantMessageId, {
      resumeInterruptedReply,
      conversationStore,
    });
    const streamRecord = {
      runtimeSessionId: runtimeTurn.sessionId,
      runtimeTurn,
      webContents,
      runtimeWebContents: null,
      permissionIds: new Set(),
      conversationId,
      // 正文持久化主键：主进程据此把累积正文/segments patch 回 store 的 assistant 消息。
      assistantMessageId,
      // 内部旁路流：true 时不落盘、不投影为用户可见活跃会话流。
      ephemeral: Boolean(ephemeral),
      // ADR 27: 活跃流指示用「会话发起工作区」(origin)，不是 Goal target / execution。
      // 用户从 peer-knowledge 发起、工具写到 peer_agent 时，绿点应留在 peer-knowledge。
      // runWorkspacePath 仍用于 tool cwd / 项目指令 / 写入边界，不混入 UI 运行指示。
      workspacePath: conversationWorkspacePath,
      originWorkspacePath: conversationWorkspacePath,
      // 可选诊断字段：本轮实际执行根（Goal target 或 origin）。
      executionWorkspacePath: runWorkspacePath,
      // 整轮 wall-clock 起点属于运行时事实。renderer 切走/重开后通过 reattach 恢复该锚点，
      // 避免重新进入会话时计时停住或从 0 重新开始。续写中断回复时回拨到原消息时间戳，
      // 用户看到的是「同一条回复继续计时」，而不是从 0 重新开始。
      startedAt: resumeSeed?.timestamp ?? Date.now(),
      // 复读兜底：命中尾部周期检测时需在 send 收口点自行构造 error payload，故留存 streamId。
      streamId,
      turnProfile: profile,
      // CollectingSink 没有审批人。包裹后的 send 代理不再带这个标记，询问前从流记录读取。
      ...(webContents?.approver === 'none' ? { approver: 'none' } : {}),
      // 发送入口透传的首选 provider；真正命中的实际 provider 在 attempt 循环里覆盖到 actual*。
      modelProviderId: effectiveModelProviderId ?? null,
      // ADR 22: 累积进行中的流式正文/思考/工具段,供 HMR 重载后 reattach 取快照续接。
      // 续写中断回复时以既有消息为种子（见 resolveResumeSeed），追加不清空。
      accumulatedText: resumeSeed?.content ?? '',
      accumulatedThinking: resumeSeed?.accumulatedThinking ?? '',
      segments: resumeSeed?.segments ? [...resumeSeed.segments] : [],
      resumedFromMessageId: resumeSeed?.messageId ?? null,
      // 续写流终态时与新 usage 合并的旧账（中断前已累积的 token）。
      resumeSeedUsage: resumeSeed?.usage ?? null,
      usageRecorded: false,
      toolCallCount: 0,
      requestedUserInput: false,
      // 多 provider fallback / 同 provider 重试共享一次 Runtime Pipeline session 事件状态。
      runtimeEventState: { sessionStarted: true },
      // 终态事件去重:保证 done/error/aborted 三选一恰好发一次,防止压缩等中间阶段抛错后界面悬挂。
      terminalEventSent: false,
      // Goal handoff 必须等待 sendMessage finally 真正释放 Runtime turn，不能把 UI done
      // 当成 session 已空闲。Promise 暴露给 forceCompleteConversationStreams 聚合等待。
      released: null,
      resolveReleased: null,
    };
    streamRecord.released = new Promise((resolve) => { streamRecord.resolveReleased = resolve; });
    let accumulatingWebContents = webContents;
    let visualReviewReport = null; // Host-only return value, never a stream/persistence field.
    try {
      activeStreams.set(streamId, streamRecord);
      emitActiveStreamsChanged();
      if (typeof emitRuntimeEvent === 'function') {
        emitRuntimeEvent({
          type: 'session.started',
          sessionId: conversationId || streamId,
          streamId,
          conversationId: conversationId || undefined,
          mode,
        });
      }
      // 观测即持久化(ADR 56 补丁):provider_usage 级 context.accounting 快照在观测
      // 发生时立即写入 conversation sidecar,不再只依赖 chat:stream:done。这样被
      // 中断(aborted)或崩溃的 turn 不丢 lastObserved,restore 后圆环能恢复百分比。
      // 只拦截 provider_usage:estimated/unknown 快照不落盘,避免噪声覆盖观测事实。
      //
      // 落盘节流（必需）：该事件是 per-chunk 的（实测 thinking 阶段 142–280/s），而
      // store 的 updateContextSnapshot 每次都做「读整份 index + normalize 全部行 +
      // 全量重写 index + rename」——全是同步 I/O。trace 实测这条链占主进程同步 I/O 的
      // 大头（writeFileSync 2436ms / readFileSync 1368ms / normalizeMeta 792ms /
      // rename 885ms，合计约 5.5s per 16.7s 墙钟 ≈ 33%），主进程被占满时 Electron
      // 所有窗口一起卡住（用户反馈的「整个界面卡住」）。
      // 占用率百分比用 2s 粒度对人眼完全够；窗口内的中间快照只保留最新值，由尾部
      // 定时器或终态收口保证最终一致（终态分支已按 persistKey 去重，不会双写）。
      const ACCOUNTING_PERSIST_MIN_INTERVAL_MS = 2000;
      let lastAccountingPersistAtMs = 0;
      let pendingAccountingSnapshot = null;
      let accountingFlushTimer = null;
      const persistAccountingNow = (snapshot) => {
        try {
          persistContextAccounting({
            store: conversationStore,
            conversationId: streamRecord.conversationId,
            streamId,
            snapshot,
            emit: emitRuntimeEvent,
          });
          streamRecord.persistedContextSnapshotKey = contextSnapshotPersistKey(snapshot);
        } catch (error) {
          console.warn('[llm-chat] failed to persist observed context snapshot:', error?.message || error);
        }
        lastAccountingPersistAtMs = Date.now();
      };
      const flushPendingAccounting = () => {
        if (accountingFlushTimer != null) {
          clearTimeout(accountingFlushTimer);
          accountingFlushTimer = null;
        }
        const snapshot = pendingAccountingSnapshot;
        pendingAccountingSnapshot = null;
        if (snapshot) persistAccountingNow(snapshot);
      };
      // 终态需要把窗口内最后一次观测值补写出去，所以挂到 streamRecord 上供收口点调用。
      streamRecord.flushPendingAccounting = flushPendingAccounting;
      let latestAccountingCompactionEpoch = 0;
      const emitRuntimeEventPersistingAccounting = (event) => {
        const advancedCompaction = event?.type === 'context.accounting'
          && event.snapshot?.version === 1
          && event.snapshot.compactionEpoch > latestAccountingCompactionEpoch;
        if (advancedCompaction) {
          latestAccountingCompactionEpoch = event.snapshot.compactionEpoch;
          // A pre-compaction observation must never be flushed into the new
          // history. Publish even an unknown post-compaction snapshot so the
          // renderer can invalidate its old epoch without inventing a percent.
          pendingAccountingSnapshot = null;
          if (accountingFlushTimer != null) {
            clearTimeout(accountingFlushTimer);
            accountingFlushTimer = null;
          }
        }
        if (
          event?.type === 'context.accounting'
          && event.snapshot?.version === 1
          && (event.snapshot.pressureSource === 'provider_usage' || advancedCompaction)
          && streamRecord.conversationId
          && !streamRecord.ephemeral
          && typeof conversationStore?.updateContextSnapshot === 'function'
        ) {
          const now = Date.now();
          if (advancedCompaction || now - lastAccountingPersistAtMs >= ACCOUNTING_PERSIST_MIN_INTERVAL_MS) {
            pendingAccountingSnapshot = null;
            persistAccountingNow(event.snapshot);
          } else {
            // 节流窗口内：只保留最新值，避免每个 chunk 都触发一次全量索引读写。
            pendingAccountingSnapshot = event.snapshot;
            if (accountingFlushTimer == null) {
              accountingFlushTimer = setTimeout(
                flushPendingAccounting,
                ACCOUNTING_PERSIST_MIN_INTERVAL_MS - (now - lastAccountingPersistAtMs),
              );
              // 别让待写定时器拖住进程退出。
              if (typeof accountingFlushTimer?.unref === 'function') accountingFlushTimer.unref();
            }
          }
        }
        if (typeof emitRuntimeEvent === 'function') return emitRuntimeEvent(event);
        return null;
      };
      // 累积代理:拦截 delta/thinking 追加到记录,其余事件透传给真实 webContents。
      accumulatingWebContents = wrapWebContentsForRuntimeEvents(webContents, streamRecord, {
        conversationStore,
        llmConfigStore,
        emitRuntimeEvent,
        failRuntimeTurn: (reason) => runtimeSessions.failStream(streamId, reason),
      });
      streamRecord.runtimeWebContents = accumulatingWebContents;

      const toolContext = { ...getConversationToolContext({ conversationId, workspacePath: runWorkspacePath }) };
      // 会话只共享工具缓存；身份、权限、目标路径与回调在每个回合独立，避免并发串写。
      toolContext.mode = runtimeMode;
      toolContext.turnRole = profile?.role ?? null;
      toolContext.turnProfile = profile;
      toolContext.resolveAccessPolicy = () => botAccess.resolve({ conversationId, workspaceId: profile?.workspaceId,
        planId: profile?.planId, sessionId: profile?.sessionId, role: profile?.role });
      toolContext.checkAccessPolicy = () => {
        const access = toolContext.resolveAccessPolicy();
        return access && !access.ok ? 'access_identity_invalid' : null;
      };
      toolContext.planId = profile?.planId ?? null;
      toolContext.currentInputAnchors = projectAgentTurn && Array.isArray(profile?.context?.inputAnchors)
        ? profile.context.inputAnchors.map(anchor => anchor.messageId).filter(id => typeof id === 'string') : [];
      toolContext.turnId = streamId;
      toolContext.toolCallOrdinal = 0;
      toolContext.workspaceId = typeof profile?.workspaceId === 'string' && profile.workspaceId.trim()
        ? profile.workspaceId.trim()
        : null;
      toolContext.conversationId = typeof conversationId === 'string' && conversationId.trim()
        ? conversationId.trim()
        : null;
      // 项目代理固定只读，范围外图片走正式授权；其他回合使用访问策略。
      toolContext.accessLevel = projectAgentTurn ? 'restricted_local' : null;
      toolContext.workspacePath = runWorkspacePath;
      toolContext.originWorkspacePath = goalWorkspaceBinding?.originWorkspacePath ?? conversationWorkspacePath;
      toolContext.targetWorkspacePath = goalWorkspaceBinding?.targetWorkspacePath ?? null;
      toolContext.readableRoots = mergeReadableRoots(
        goalWorkspaceBinding?.readableRoots ?? [runWorkspacePath].filter(Boolean),
        projectLinkedFolders,
      );
      toolContext.writableRoots = goalWorkspaceBinding?.writableRoots ?? null;
      toolContext.permissionPolicy = permissionPolicy;
      // 把本回合的工具计数 sink 写入会话级 toolContext，供工具派发处实时回调。
      // 仅本回合有效，回合结束后由下一次 sendMessage 覆盖（无 sink 时复位为 null）。
      toolContext.onToolCall = agentProgress?.onToolCall ?? null;
      toolContext.onToolExecution = agentProgress?.onToolExecution ?? null;
      toolContext.objectiveWakeIds = projectAgentTurn ? [...new Set((profile?.context?.events || []).filter(event=>event.kind==='objective_signal'&&event.workspaceId===profile.workspaceId).map(event=>event.objectiveId).filter(id=>typeof id==='string'))] : [];
      toolContext.objectiveWakeEvents = projectAgentTurn ? (profile?.context?.events || []).filter(event=>event.kind==='objective_signal'&&event.workspaceId===profile.workspaceId).map(event=>structuredClone(event)) : [];
      toolContext.sessionWakeIds = projectAgentTurn ? [...new Set((profile?.context?.events || [])
        .filter(event => event.workspaceId === profile.workspaceId && ['result_ready', 'session_verified'].includes(event.kind))
        .map(event => event.sessionId).filter(id => typeof id === 'string'))] : [];
      // 引用范围只看本回合对话里的 quoteRefs。复用的 toolContext 按回合覆写。
      toolContext.messages = null;
      if (projectAgentTurn) {
        toolContext.turnToolCalls = [];
        toolContext.turnMemoryIds = [];
        try {
          const history = typeof conversationStore?.readInteractionContext === 'function'
            ? await conversationStore.readInteractionContext(conversationId)
            : conversationStore?.getPersistedConversationHistory?.(conversationId);
          toolContext.messages = Array.isArray(history?.messages) ? history.messages : [];
        } catch {
          toolContext.messages = [];
        }
      }

      for (let attemptIndex = 0; attemptIndex < providerCandidates.length; attemptIndex += 1) {
        let provider = providerCandidates[attemptIndex];
        // 记录本轮实际命中的 provider 快照，供 usage 落盘归因。
        streamRecord.actualModelProviderId = provider?.id || null;
        streamRecord.actualModel = provider?.model || null;
        streamRecord.actualProviderName = provider?.name || null;
        streamRecord.actualPricing = {
          inputPrice: provider?.inputPrice,
          outputPrice: provider?.outputPrice,
          cacheReadPrice: provider?.cacheReadPrice,
          cacheWritePrice: provider?.cacheWritePrice,
        };
        streamRecord.actualPricingSource = provider?.pricingSource || null;
        let credential;
        try {
          credential = await resolveProviderCredential({ provider, llmConfigStore });
        } catch (credentialError) {
          accumulatingWebContents.send('chat:stream:error', {
            streamId,
            // Prefer readable message; previous code-only payload made bubbles show qoder_auth_*.
            error: getProviderCredentialErrorMessage(credentialError),
          });
          return;
        }
        if (!credential || streamRecord.terminalEventSent) return;
        // Gemini OAuth 需要 Code Assist projectId；缺失时通过 loadCodeAssist/onboardUser 解析并落盘。
        if (provider.authMethod === 'oauth_google' && credential.apiKey) {
          const existingProjectId = provider.oauthProjectId || credential.oauthProjectId || null;
          if (!existingProjectId) {
            try {
              const projectId = await resolveGeminiCodeAssistProjectId({
                accessToken: credential.apiKey,
                projectId: null,
                pollIntervalMs: 1000,
                maxPolls: 45,
                // 走 Electron net.fetch + 重试，避免 Node undici 在代理环境下超时后被误判为“缺少 project”。
                fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init),
              });
              if (projectId && typeof llmConfigStore?.updateProvider === 'function') {
                llmConfigStore.updateProvider(provider.id, { oauthProjectId: projectId });
                provider = { ...provider, oauthProjectId: projectId };
              } else if (!projectId) {
                throw new Error(
                  'Gemini OAuth 尚未完成 Code Assist 项目初始化（缺少 cloudaicompanionProject）。请重新登录 Google，或确认账号已开通 Gemini Code Assist。',
                );
              }
            } catch (error) {
              // 项目解析失败时直接中断，避免无 project 打 streamGenerateContent 只得到含糊 500。
              throw error;
            }
          } else {
            provider = { ...provider, oauthProjectId: existingProjectId };
          }
        }
        const resolvedChannel = resolveChannel({
          ...provider,
          apiKey: credential.apiKey,
          accountId: credential.accountId,
          oauthProjectId: provider.oauthProjectId || credential.oauthProjectId || null,
          sessionId: conversationId || streamId || undefined,
        });
        const storedConversation = conversationId
          ? conversationStore?.getConversation?.(conversationId)
          : null;
        const taskAcceptance = taskAcceptanceFromMessages(messages)
          || taskAcceptanceFromMessages(storedConversation?.messages);
        const accountingIdentity = {
          conversationId: conversationId || streamId,
          contentRevision:
            Number.isSafeInteger(storedConversation?.contentRevision)
            && storedConversation.contentRevision >= 0
              ? storedConversation.contentRevision
              : 0,
          modelKey: contextAccountingModelKey(provider.id, provider.model),
        };
        // Prefer current provider window (already tier-projected for Qoder) so
        // restored snapshots do not keep a stale capacity like 180k after 1M tier.
        const initialContextAccounting = reprojectContextAccountingWindow(
          storedConversation?.contextSnapshot?.version === 1
          && storedConversation.contextSnapshot.modelKey === accountingIdentity.modelKey
            ? storedConversation.contextSnapshot
            : null,
          provider.contextWindow,
        );

        const systemContext = buildSystemContext(runWorkspacePath, {
          contextAttachments,
          ...(profile?.role === 'project_agent' ? { agentMessages: agentMessagesForContext((profile.context?.events || []).filter(event => event.kind === 'agent_message').map(event => ({ kind: 'agent_message', agentMessage: event.payload?.agentMessage })), conversationId, profile.workspaceId) } : {}),
          workingContext: readWorkingContext({ workspaceId: profile?.workspaceId, workId: profile?.workId, conversationId }),
          runtimeReminders,
          attachmentContext,
          configInstructions,
          contextExtensions: effectiveContextExtensions,
          explorerContext,
          verifierContext,
          continuityContext,
          conversationId,
          automationCreateContext: storedConversation?.automationCreateContext ?? null,
          effort,
          mode,
          linkedFolders: projectLinkedFolders,
          // goal-plan 事实上下文 Source（0006）：goal 模式下注入活动计划权威 taskId。
          goalPlanStore,
          // mcp-host 自我认知 Source：注入「我自己是 MCP host + 注册表路径 + 已装清单」。
          mcpRegistry,
          provider: resolvedChannel.legacyProvider,
          model: provider.model,
          ...(taskAcceptance ? { taskAcceptance } : {}),
          ...projectTurnSystemContext(profile, {
            conversationId,
            goalPlanStore,
            conversationStore,
            memoryEnabled: liveMemoryGate().enabled(textField(profile?.workspaceId)),
          }),
        });
        if (projectAgentTurn) {
          const ids = memoryIdsFromAssembledContext(systemContext);
          toolContext.turnMemoryIds = ids;
          streamRecord.turnMemoryIds = ids;
        }
        recordAgentContextAdmission(profile?.workspaceId, conversationId, systemContext);
        const systemPrompt = renderSystemContext(systemContext);
        const stableSystemPrompt = renderStableSystemContext(systemContext);
        if (visualReviewHandle !== null) {
          visualReviewReport = await runDesktopVisualReview({ handle: visualReviewHandle, provider,
            resolvedChannel, apiKey: credential.apiKey, systemPrompt, streamId, signal: runtimeTurn.signal });
          accumulatingWebContents.send('chat:stream:done', { streamId });
          return { terminalStatus: 'done', requestedUserInput: false, toolCallCount: 0, visualReviewReport };
        }
        recordPromptSnapshot(promptSnapshotStore, systemContext, {
          streamId,
          conversationId,
          contextEpochId: getActiveContextEpochId(promptSnapshotStore, conversationId),
          effort,
          provider: resolvedChannel.legacyProvider,
          providerId: provider.id,
          model: provider.model,
          mode,
          recoveryAttempt: attemptIndex + 1,
        });

        // 压缩后通过既有 Context Source 重建 system prompt（goal/mode/continuity 等）。
        // 只重建可权威回读的工作状态，不把 tool output 抬升为 system 指令。
        const rebuildSystemPrompt = async ({
          continuityContext: nextContinuityContext = continuityContext,
          reason = 'post-compact',
        } = {}) => {
          const rebuiltAutomationCreateContext = conversationId
            ? conversationStore?.getConversation?.(conversationId)?.automationCreateContext ?? null
            : null;
          const rebuiltContext = buildSystemContext(runWorkspacePath, {
            contextAttachments,
            ...(profile?.role === 'project_agent' ? { agentMessages: agentMessagesForContext((profile.context?.events || []).filter(event => event.kind === 'agent_message').map(event => ({ kind: 'agent_message', agentMessage: event.payload?.agentMessage })), conversationId, profile.workspaceId) } : {}),
            workingContext: readWorkingContext({ workspaceId: profile?.workspaceId, workId: profile?.workId, conversationId }),
            runtimeReminders,
            attachmentContext,
            configInstructions,
            contextExtensions: effectiveContextExtensions,
            explorerContext,
            verifierContext,
            continuityContext: nextContinuityContext,
            conversationId,
            automationCreateContext: rebuiltAutomationCreateContext,
            effort,
            mode,
            linkedFolders: projectLinkedFolders,
            goalPlanStore,
            mcpRegistry,
            provider: resolvedChannel.legacyProvider,
            model: provider.model,
            ...(taskAcceptance ? { taskAcceptance } : {}),
            ...projectTurnSystemContext(profile, {
              conversationId,
              goalPlanStore,
              conversationStore,
              memoryEnabled: liveMemoryGate().enabled(textField(profile?.workspaceId)),
            }),
          });
          recordAgentContextAdmission(profile?.workspaceId, conversationId, rebuiltContext);
          if (projectAgentTurn) {
            const ids = memoryIdsFromAssembledContext(rebuiltContext);
            toolContext.turnMemoryIds = ids;
            streamRecord.turnMemoryIds = ids;
          }
          const rebuiltPrompt = renderSystemContext(rebuiltContext);
          recordPromptSnapshot(promptSnapshotStore, rebuiltContext, {
            streamId,
            conversationId,
            contextEpochId: getActiveContextEpochId(promptSnapshotStore, conversationId),
            effort,
            provider: resolvedChannel.legacyProvider,
            providerId: provider.id,
            model: provider.model,
            mode,
            recoveryAttempt: attemptIndex + 1,
            rehydrateReason: reason,
          });
          return rebuiltPrompt;
        };

        // (a) 同 provider 流读取早期中断的自动重试：把单次尝试封装为闭包，便于在
        // replay-safe 且为可恢复传输失败时，从头重发同一请求（覆盖全部 wire）。
        const runProviderAttempt = async () => {
        toolContext.supportsVision = Boolean(provider.supportsVision);
        const attemptStream = createProviderAttemptStream({
          webContents: accumulatingWebContents,
          streamId,
          provider,
          // Prior completed tools are not re-emitted during checkpoint restore.
          // A quiet current stream therefore cannot authorize changing their provider identity.
          protectedNativeRecovery: Boolean(turnProfile?.providerCheckpoint || executionBudget?.providerCheckpoint),
        });
        const qoderCatalogMetadata = resolvedChannel.wire === 'qoder-private'
          ? getQoderModelMetadata(provider.model)
          : null;
        const qoderMetadata = qoderCatalogMetadata || provider.modelOptions?.length
          ? { ...qoderCatalogMetadata, modelOptions: provider.modelOptions ?? qoderCatalogMetadata?.modelOptions }
          : null;
        const qoderOptionProjection = resolvedChannel.wire === 'qoder-private'
          ? resolveQoderModelOptionProjection(qoderMetadata, provider.modelOptionValues)
          : null;
        const contextWindow = qoderOptionProjection?.inputTokenLimit || provider.contextWindow || 0;
        const maxOutputTokens = provider.maxOutputTokens || 0;
        const onNativeReasoningFallback = (details) => noteNativeReasoningFallback(provider, details);
        const runtimeTools = buildRuntimeTools({
          mcpRegistry,
          skillStore,
          providerType: resolvedChannel.legacyProvider,
          mode: runtimeMode,
          excludeCapabilityPrefixes: [...(profile?.excludeCapabilityPrefixes ?? []), ...agentCommunicationExcludedPrefixes(profile)],
          readOnlyWorkSession: goalPlanStore?.getPlan?.(profile?.planId)?.delegationOrigin?.readOnly === true,
        });

        try {
          if (resolvedChannel.wire === 'qoder-private') {
            await agentLoopQoder({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              contextWindow,
              modelOptions: provider.modelOptions,
              modelOptionValues: provider.modelOptionValues,
              effort,
              maxOutputTokens,
              conversationId,
              toolContext,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              skillStore,
              goalPlanStore,
              automationProposalService,
              ensureBrowserReady,
              agentProgress,
              executionBudget,
              resolvedChannel,
              // qoder 与其他 loop 同权:压缩必须持久化、携带连续性上下文、支持压缩后 system 重建。
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          } else if (resolvedChannel.wire === 'anthropic-messages') {
            await agentLoopAnthropic({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              stableSystemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              supportsPromptCaching: Boolean(provider.supportsPromptCaching),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              toolContext,
              agentProgress,
              executionBudget,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              skillStore,
              goalPlanStore,
              automationProposalService,
              ensureBrowserReady,
              onNativeReasoningFallback,
              resolvedChannel,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          } else if (resolvedChannel.wire === 'gemini') {
            await agentLoopGemini({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              toolContext,
              agentProgress,
              executionBudget,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              skillStore,
              goalPlanStore,
              automationProposalService,
              ensureBrowserReady,
              resolvedChannel,
              authMethod: credential.authMethod,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          } else {
            await agentLoopOpenAI({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              supportsPromptCaching: Boolean(provider.supportsPromptCaching),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              toolContext,
              agentProgress,
              executionBudget,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              skillStore,
              goalPlanStore,
              automationProposalService,
              ensureBrowserReady,
              onNativeReasoningFallback,
              authMethod: credential.authMethod,
              accountId: credential.accountId,
              fastMode: fastMode === true,
              resolvedChannel,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              channelId: resolvedChannel?.channelId,
              accountingIdentity,
              initialContextAccounting,
            });
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          attemptStream.webContents.send('chat:stream:error', {
            streamId,
            error: describeFetchFailure(err),
            ...(err?.providerRecovery ? { providerRecovery: err.providerRecovery } : {}),
          });
        }
          return attemptStream;
        };

        // (a) 同 provider 自动重试：仅在 replay-safe（未发出任何 delta/thinking/
        // tool-call/usage 等）且为可恢复传输失败（ECONNRESET/terminated 等）时，从头
        // 重发同一请求；复用既有连接退避与 chat:stream:connection-recovery 事件。
        // 用户 abort（AbortError）与已产出内容的长流中断不在此自动重试范围内。
        const sameProviderMax = SAME_PROVIDER_RETRY_DELAYS_MS.length;
        let attemptStream;
        let attemptResult;
        for (let retry = 0; ; retry += 1) {
          attemptStream = await runProviderAttempt();
          attemptResult = attemptStream.getResult();
          const canRetrySameProvider =
            attemptResult.terminalError &&
            !attemptResult.terminalSent &&
            attemptResult.sameProviderRetryable &&
            retry < sameProviderMax;
          if (!canRetrySameProvider) {
            if (retry > 0 && !attemptResult.terminalError) {
              accumulatingWebContents.send('chat:stream:connection-recovery', {
                streamId,
                conversationId,
                provider: describeProviderTarget(provider),
                model: provider.model,
                status: 'recovered',
                attempt: retry,
                maxRetries: sameProviderMax,
              });
            }
            break;
          }
          const delayMs = SAME_PROVIDER_RETRY_DELAYS_MS[retry];
          accumulatingWebContents.send('chat:stream:connection-recovery', {
            streamId,
            conversationId,
            provider: describeProviderTarget(provider),
            model: provider.model,
            status: 'retrying',
            attempt: retry + 1,
            maxRetries: sameProviderMax,
            delayMs,
            reason: attemptResult.errorText,
          });
          console.warn(
            `[llm-chat] same-provider stream retry ${retry + 1}/${sameProviderMax}: ${describeProviderTarget(provider)} (${attemptResult.errorText})`
          );
          await sleepWithSignal(delayMs, runtimeTurn.signal);
        }

        if (!attemptResult.terminalError || attemptResult.terminalSent) return;

        const nextProvider = providerCandidates[attemptIndex + 1] ?? null;
        if (nextProvider && attemptResult.replayable) {
          accumulatingWebContents.send('chat:stream:provider-recovery', {
            streamId,
            conversationId,
            fromProviderId: provider.id,
            fromProvider: describeProviderTarget(provider),
            toProviderId: nextProvider.id,
            toProvider: describeProviderTarget(nextProvider),
            reason: attemptResult.errorText,
            attempt: attemptIndex + 1,
          });
          console.warn(
            `[llm-chat] provider recovery: ${describeProviderTarget(provider)} -> ${describeProviderTarget(nextProvider)} (${attemptResult.errorText})`
          );
          continue;
        }

        attemptStream.flushError();
        return;
      }
    } catch (err) {
      console.error('[llm-chat] error:', err);
      if (err?.name === 'AbortError') {
        // 用户主动中断:补发 aborted 终态(若 abort() 已发则被去重保护跳过)。
        if (!streamRecord.terminalEventSent) {
          accumulatingWebContents.send('chat:stream:aborted', { streamId });
        }
      } else {
        const failureReason = describeFetchFailure(err);
        streamRecord.failureReason = failureReason;
        streamRecord.recoverable = true;
        accumulatingWebContents.send('chat:stream:error', {
          streamId,
          error: failureReason,
        });
      }
    } finally {
      if (visualReviewHandle !== null) cancelDesktopVisualReview(visualReviewHandle);
      permissionGate.settleStreamPermissionRequests(streamId, {
        granted: false,
        reason: 'stream_finished',
      });
      // 终态兜底:任何路径(含压缩等中间阶段提前 return / 静默吞错)都必须解锁渲染端,
      // 否则停止按钮会一直悬挂。恰好发一次,依赖 terminalEventSent 去重。
      if (!streamRecord.terminalEventSent) {
        accumulatingWebContents.send('chat:stream:error', {
          streamId,
          error: 'stream_terminated_without_result',
        });
        streamRecord.terminalEventSent = true;
        streamRecord.terminalStatus = 'error';
        streamRecord.interrupted = true;
        streamRecord.persist?.({ final: true, interrupted: true });
      }
      // Runtime SDK 持有 session/turn 终态真值；Desktop Adapter 只映射既有 UI 终态。
      await streamRecord.terminalCommit;
      runtimeSessions.settleStream(
        streamId,
        streamRecord.terminalStatus || 'error',
        streamRecord.terminalStatus || 'stream_error',
      );
      streamRecord.resolveReleased?.();
      streamRecord.resolveReleased = null;
      // 方案 3：不立即删除，保留终态记录一段时间，使切回已结束的后台轮次可经
      // reattach 回放完整终态快照；保留期满后由 retireStream 内的计时器硬删除。
      retireStream(streamId);
      return {
        ...buildAgentRunOutcome(streamRecord),
        ...(Array.isArray(streamRecord.turnMemoryIds) ? { memoryIds: streamRecord.turnMemoryIds } : {}),
        ...(visualReviewReport ? { visualReviewReport } : {}),
      };
    }
  }

  /**
   * Goal handoff 专用：等待 intake 流自行完成 terminal tool 收尾；只有超时才强制兜底。
   *
   * goal_create_plan 会同步触发 plan change，而此时 tools.execute 尚未返回，tool result 也尚未
   * 写回 Runtime 消息。若这里立即发裸 done + cancel，会抢在 agent loop 的正常 sendDone 前面，
   * terminalEventSent 随即阻断携带 nextRequestInputTokens 的正确 done，导致 contextSnapshot 永久 null。
   *
   * 因此先给 pipeline 一个短暂自然收尾窗口：applyToolResults → onStopped → sendDone → 持久化
   * contextSnapshot。仅在该路径真的卡住时，才沿用旧的强制 done/cancel 兜底以解锁 UI。
   */
  function forceCompleteConversationStreams(
    conversationId,
    { reason = 'goal_handoff', graceMs = 250 } = {},
  ) {
    const normalized = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!normalized) return { completed: 0, streamIds: [], released: Promise.resolve([]) };
    const completedIds = [];
    const releasePromises = [];
    const normalizedGraceMs = Number.isFinite(Number(graceMs))
      ? Math.max(0, Number(graceMs))
      : 250;

    for (const [streamId, record] of activeStreams.entries()) {
      if (record?.conversationId !== normalized) continue;
      if (!isRunning(record)) continue;
      if (record.released) releasePromises.push(record.released);
      completedIds.push(streamId);

      setTimeout(() => {
        // 正常 terminal tool 路径已经发送权威 done 或释放 turn：不再干预。
        if (!isRunning(record) || record.terminalEventSent) return;

        const payload = {
          streamId,
          conversationId: normalized,
          reason,
        };
        try {
          (record.runtimeWebContents || record.webContents)?.send?.('chat:stream:done', payload);
        } catch (error) {
          console.warn('[llm-chat] force-complete done send failed:', error?.message || error);
        }
        // runtimeWebContents owns terminal persistence and maps this reason to goal_handoff.
        // Keep the fallback assignment for records created before that wrapper is available.
        if (!record.terminalEventSent) {
          record.terminalEventSent = true;
          record.terminalStatus = reason === 'goal_handoff' ? 'goal_handoff' : 'done';
          record.interrupted = false;
        }
        // UI done is not persistence. Sending through raw webContents skips the
        // wrapWebContents persist-on-done path, so sidecar can outlive the stream
        // and leave JSONL empty. Always flush here (idempotent if the wrapper
        // already wrote the same final patch).
        record.persist?.({ final: true, interrupted: false });

        try {
          runtimeSessions.cancelStream(streamId, reason);
        } catch (error) {
          console.warn('[llm-chat] force-complete cancel failed:', error?.message || error);
        }
        permissionGate.settleStreamPermissionRequests(streamId, {
          granted: false,
          reason,
        });
        afterTerminalCommit(record, () => {
          try { runtimeSessions.settleStream(streamId, record.terminalStatus === 'error' ? 'error' : 'completed', reason); } catch {}
          record.resolveReleased?.(); record.resolveReleased = null;
          retireStream(streamId);
        });
      }, normalizedGraceMs);
    }

    return {
      completed: completedIds.length,
      streamIds: completedIds,
      released: Promise.allSettled(releasePromises),
    };
  }

  function abort(streamId) {
    const active = activeStreams.get(streamId);
    if (!active) return { aborted: false };
    runtimeSessions.cancelStream(streamId, 'user_aborted');
    permissionGate.settleStreamPermissionRequests(streamId, {
      granted: false,
      reason: 'stream_aborted',
    });
    (active.runtimeWebContents || active.webContents).send('chat:stream:aborted', {
      streamId,
      ...(active.conversationId ? { conversationId: active.conversationId } : {}),
    });
    // 取消停止执行，但仍等待已累积正文提交，再释放并进入终态保留期。
    active.terminalEventSent = true;
    active.terminalStatus = 'aborted';
    active.interrupted = true;
    active.persist?.({ final: true, interrupted: true });
    // Ensure handoff / waiters do not hang if sendMessage finally is delayed.
    afterTerminalCommit(active, () => {
      active.resolveReleased?.(); active.resolveReleased = null;
      retireStream(streamId);
    });
    return { aborted: true };
  }

  function resolvePermissionGrant(toolCallId, grant) {
    return permissionGate.settlePermissionRequest(toolCallId, grant);
  }

  /**
   * ADR 22: 重载后认领进行中的流。只读,不改变流状态。
   * 匹配优先级:
   * - 传 streamId:返回该流快照(不存在返回 null)。
   * - 传 conversationId:返回该会话的活跃流(避免跨会话误认领)。
   * - 都不传:存在唯一活跃流时返回它;无/多条时返回 null。
   */
  function reattach({ streamId, conversationId } = {}) {
    let record = null;
    let id = streamId ?? null;
    if (id != null) {
      record = activeStreams.get(id) ?? null;
    } else if (conversationId != null) {
      // 方案 3：同一会话可能同时存在「正在运行的新流」与「已终结保留的旧流」。
      // 切回时优先认领运行中的流；没有运行中的，再回退到最近一条保留的终态记录，
      // 使切回已结束的后台轮次也能回放完整终态快照。
      let runningMatch = null;
      let retainedMatch = null;
      for (const [activeId, activeRecord] of activeStreams.entries()) {
        if (activeRecord?.conversationId !== conversationId) continue;
        if (isRunning(activeRecord)) {
          runningMatch = [activeId, activeRecord];
          break;
        }
        if (!retainedMatch || (activeRecord.retainedAt ?? 0) > (retainedMatch[1].retainedAt ?? 0)) {
          retainedMatch = [activeId, activeRecord];
        }
      }
      const chosen = runningMatch ?? retainedMatch;
      if (chosen) {
        id = chosen[0];
        record = chosen[1];
      }
    } else if (activeStreams.size === 1) {
      const only = activeStreams.entries().next().value;
      id = only?.[0] ?? null;
      record = only?.[1] ?? null;
    }
    if (!record || id == null) return null;
    const running = isRunning(record);
    return {
      streamId: id,
      conversationId: record.conversationId ?? null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      accumulatedText: record.accumulatedText ?? '',
      accumulatedThinking: record.accumulatedThinking ?? '',
      segments: Array.isArray(record.segments) ? record.segments.map((segment) => ({ ...segment })) : [],
      isStreaming: running,
      // 终态快照：切回已结束轮次时，表达层据此补齐完整正文/工具段并标注中断态，
      // 而非重新挂一个「进行中」的假象。running=true 时这些字段为中性默认值。
      terminalStatus: running ? null : (record.terminalStatus ?? null),
      interrupted: running ? false : Boolean(record.interrupted),
      usage: record.finalUsage ?? null,
      lifetimeUsage: record.lifetimeUsage ?? null,
      pendingPermissions: permissionGate.listPendingPermissions({ streamId: id }),
    };
  }

  function resolveGoalRole({
    role,
    workerModelProviderId = null,
    projectPolicy = null,
    taskOverride = null,
    requestPreference = null,
    taskRequiresVision = false,
    requiredContextTokens = 0,
    spentUsd = null,
  } = {}) {
    const providers = typeof llmConfigStore?.listProviders === 'function'
      ? llmConfigStore.listProviders()
      : [];
    const settings = typeof getSettings === 'function' ? getSettings() : null;
    const spent = Number.isFinite(Number(spentUsd))
      ? Number(spentUsd)
      : sumRoleSpendUsd(usageRequestLog.readAll({ limit: 20_000 }), {
          role,
          sinceMs: startOfLocalDayMs(),
        });
    return resolveRoleRoute({
      role,
      providers,
      routing: settings?.modelRouting,
      projectPolicy,
      taskOverride,
      requestPreference,
      workerModelProviderId,
      taskRequiresVision,
      requiredContextTokens,
      spentUsd: spent,
    });
  }

  return {
    sendMessage: (params) => withSelectionRequestContext(conversationStore, params?.conversationId, () => sendMessage(params)),
    abort,
    forceCompleteConversationStreams,
    setWorkspacePath,
    setLocalAccessLevel,
    setApprovalStore: approvalStore => permissionGate.configure({ approvalStore }),
    resolvePermissionGrant,
    reattach,
    listActiveConversationIds,
    listActiveStreams,
    getSelectionRuntimeState,
    resolveGoalRole,
    readDelegationCapabilities({ readOnly = false } = {}) {
      const { runtimeProjection } = buildRuntimeTools({ mcpRegistry, skillStore, providerType: 'openai', mode: 'goal',
        readOnlyWorkSession: readOnly, excludeCapabilityPrefixes: ['local.web.control.'] });
      return runtimeProjection.capabilities.filter(capability => ['available', 'needs_permission'].includes(capability.health))
        .map(capability => capability.capabilityId);
    },
  };
}
