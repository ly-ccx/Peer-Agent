import {
  buildAnthropicTools,
  buildAnthropicToolsFromRuntimeProjection,
  buildOpenAITools,
  buildOpenAIToolsFromRuntimeProjection,
  buildSystemContext,
  buildSystemPrompt,
  createRuntimeToolProjection,
  renderSystemContext,
} from './llm-prompts.mjs';
import {
  normalizeAnthropicMessages,
  normalizeOpenAIMessages,
} from './provider-encoders/index.mjs';
import { agentLoopAnthropic } from './chat-runtime/anthropic-agent-loop.mjs';
import { agentLoopGemini } from './chat-runtime/gemini-agent-loop.mjs';
import { agentLoopOpenAI } from './chat-runtime/openai-agent-loop.mjs';
import { sanitizeApiMessages } from './chat-runtime/message-sanitizer.mjs';
import { createChatPermissionGate } from './chat-runtime/permission-gate.mjs';
import { resolveActiveGoalExecutionBinding } from './chat-runtime/goal-mode-gate.mjs';
import {
  createProviderAttemptStream,
  describeFetchFailure,
  describeProviderTarget,
  orderProviderCandidates,
} from './chat-runtime/provider-recovery-broker.mjs';
import { hasDanglingToolIntent, hasUnsupportedToolClaim } from './chat-runtime/response-guard.mjs';
import { createToolContext } from './chat-runtime/tool-orchestrator.mjs';
import {
  getProviderCredentialErrorCode,
  resolveProviderCredential,
} from './provider-credential-resolver.mjs';
import { resolveChannel } from './provider-channels.mjs';
import { detectTailRepetition } from './repetition-detector.mjs';

const activeStreams = new Map();
const permissionGate = createChatPermissionGate({ activeStreams });
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

function buildRuntimeTools({ mcpRegistry, providerType, mode }) {
  // mode 作为运行时事实下传到 Runtime Projection，模式隔离工具暴露（ADR 35）。
  const { registry, projection } = createRuntimeToolProjection({
    mcpRegistry,
    projectionOptions: { mode },
  });
  const tools = providerType === 'anthropic'
    ? buildAnthropicToolsFromRuntimeProjection(projection, registry)
    : buildOpenAIToolsFromRuntimeProjection(projection, registry);
  return { registry, runtimeProjection: projection, tools };
}

export { buildAnthropicTools, buildOpenAITools, buildSystemPrompt };
export { normalizeAnthropicMessages, normalizeOpenAIMessages };
export { hasDanglingToolIntent, hasUnsupportedToolClaim };
export { finalizeDanglingToolSegments, terminalDanglingNote };
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

function hasBillableUsage(usage) {
  return Boolean(
    (usage?.inputTokens || 0) ||
    (usage?.outputTokens || 0) ||
    (usage?.cacheWriteTokens || 0) ||
    (usage?.cacheReadTokens || 0)
  );
}

function isRequestUserInputToolName(toolName) {
  return toolName === 'request_user_input'
    || (typeof toolName === 'string' && toolName.endsWith('.request_user_input'));
}

function buildAgentRunOutcome(streamRecord = {}) {
  return {
    terminalStatus: streamRecord.terminalStatus || 'error',
    requestedUserInput: Boolean(streamRecord.requestedUserInput),
    toolCallCount: Number.isFinite(streamRecord.toolCallCount)
      ? Math.max(0, Math.trunc(streamRecord.toolCallCount))
      : 0,
    ...(hasBillableUsage(streamRecord.finalUsage) ? { usage: streamRecord.finalUsage } : {}),
  };
}

function recordConversationUsage({ conversationStore, streamRecord, usage }) {
  if (!conversationStore?.addUsage || !streamRecord?.conversationId || !hasBillableUsage(usage)) return null;
  if (streamRecord.usageRecorded) return null;
  try {
    const lifetimeUsage = conversationStore.addUsage(streamRecord.conversationId, usage);
    streamRecord.usageRecorded = Boolean(lifetimeUsage);
    return lifetimeUsage;
  } catch (error) {
    console.warn('[llm-chat] failed to record conversation usage:', error?.message || error);
    return null;
  }
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

// 终态落盘兜底：把「已发出但未回填结果」的 tool-call 段补写一个明确的中断 result，
// 使其在持久化后脱离「执行中（永久转圈）」态。背景：渲染层三个终态 handler 已对 live
// segments 做过同样收尾，但仅当终态事件 streamId 与当前会话匹配时才生效；后台会话（已
// 切走）或事件 streamId 不匹配时，真值来源是这里的落盘 + 切回时的会话重载。因此必须在
// 主进程的终态落盘汇聚点再兜一次，否则切回会话仍会看到永久转圈的工具段。
// 与渲染层口径一致：result === undefined 且 synthetic !== true 视为悬空段。
// 纯函数：无悬空段时返回原数组引用，调用方据此可跳过无谓写入。
function terminalDanglingNote(terminalStatus) {
  if (terminalStatus === 'aborted') return '工具调用已中断（生成停止）';
  if (terminalStatus === 'error') return '工具调用已中断（连接出错）';
  return '工具结果未返回（本轮已结束）';
}

function finalizeDanglingToolSegments(segments, terminalStatus) {
  if (!Array.isArray(segments)) return segments;
  const note = terminalDanglingNote(terminalStatus);
  let changed = false;
  const next = segments.map((segment) => {
    if (segment?.type === 'tool-call' && segment.result === undefined && segment.synthetic !== true) {
      changed = true;
      return { ...segment, result: note };
    }
    return segment;
  });
  return changed ? next : segments;
}

/**
 * ADR 22: 累积代理。包裹真实 webContents,拦截流式正文/思考事件追加到 streamRecord,
 * 其余事件原样透传。这样两个 provider adapter / agent loop 都无需改动,
 * 累积逻辑集中在单一 seam。返回的对象只需实现 send()(adapter/loop 只用到 send)。
 */
function wrapWebContentsForRuntimeEvents(realWebContents, streamRecord, { conversationStore = null } = {}) {
  const appendTextSegment = (type, content) => {
    if (!content) return;
    const segments = streamRecord.segments;
    const last = segments[segments.length - 1];
    if (last?.type === type) {
      last.content = `${last.content || ''}${content}`;
    } else {
      segments.push({ type, content });
    }
  };

  // 「正文持久化真值下沉主进程」：把累积的 content/segments 直接 patch 到 store 里
  // 对应的 assistant 消息，不再依赖 renderer 在终态事件回写。后台会话（主界面已切走、
  // 该会话的 ChatSurface 不再消费事件）也能落盘完整正文，根治「切走即丢 → 看似自我中断」。
  // 流式期间按时间节流写盘（默认 500ms），终结态强制 flush；写盘失败不影响事件透传。
  const PERSIST_THROTTLE_MS = 500;
  let lastPersistAt = 0;
  const persistStreamRecord = ({ final = false, interrupted = false } = {}) => {
    if (!conversationStore?.updateMessageById) return;
    if (!streamRecord?.conversationId) return;
    const now = Date.now();
    if (!final && now - lastPersistAt < PERSIST_THROTTLE_MS) return;
    lastPersistAt = now;
    // 终态落盘时，把已发出但未回填结果的 tool-call 段补成中断态，避免切回会话后永久转圈。
    const sourceSegments = final
      ? finalizeDanglingToolSegments(streamRecord.segments, streamRecord.terminalStatus)
      : streamRecord.segments;
    const patch = {
      content: streamRecord.accumulatedText || '',
      segments: Array.isArray(sourceSegments)
        ? sourceSegments.map((segment) => ({ ...segment }))
        : [],
    };
    if (final && interrupted) patch.interrupted = true;
    try {
      conversationStore.updateMessageById(
        streamRecord.conversationId,
        streamRecord.assistantMessageId ?? null,
        patch,
      );
    } catch (err) {
      console.warn('[llm-chat] persist stream record failed:', err?.message || err);
    }
  };
  streamRecord.persist = persistStreamRecord;

  return {
    send(channel, payload) {
      // 终态守卫：一旦本轮已发出终态（done/error/aborted，含复读兜底自动 error），
      // 丢弃所有后续在途的正文/思考 delta，避免「已收口却仍继续转发残留」导致刷屏。
      if (
        streamRecord.terminalEventSent &&
        (channel === 'chat:stream:delta' || channel === 'chat:stream:thinking')
      ) {
        return false;
      }
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        streamRecord.accumulatedText += payload.content;
        appendTextSegment('text', payload.content);
        persistStreamRecord();
        // 复读兜底：命中尾部周期检测即视为模型卡死，主动 abort 并以 error 收口本轮。
        // delta 属于 REPLAY_UNSAFE 通道，terminalEventSent 置位后不会触发重试/切 provider。
        const repetition = detectTailRepetition(streamRecord.accumulatedText);
        if (repetition) {
          console.warn(
            `[llm-chat] repetition detected (period=${repetition.period}, repeats=${repetition.repeats}, reason=${repetition.reason}, substantiveChars=${repetition.substantiveChars}, unit=${JSON.stringify(repetition.unitPreview)}); aborting stream ${streamRecord.streamId}`,
          );
          const lifetimeUsage = recordConversationUsage({
            conversationStore,
            streamRecord,
            usage: undefined,
          });
          const errorPayload = { streamId: streamRecord.streamId, error: 'repetition_detected' };
          if (lifetimeUsage) errorPayload.lifetimeUsage = lifetimeUsage;
          streamRecord.terminalEventSent = true;
          streamRecord.terminalStatus = 'error';
          streamRecord.interrupted = true;
          if (lifetimeUsage) streamRecord.lifetimeUsage = lifetimeUsage;
          persistStreamRecord({ final: true, interrupted: true });
          try {
            streamRecord.controller?.abort();
          } catch {
            /* 已中断时忽略 */
          }
          realWebContents.send('chat:stream:delta', payload);
          return realWebContents.send('chat:stream:error', errorPayload);
        }
      } else if (channel === 'chat:stream:thinking' && typeof payload?.content === 'string') {
        streamRecord.accumulatedThinking += payload.content;
        appendTextSegment('thinking', payload.content);
        persistStreamRecord();
      } else if (channel === 'chat:stream:tool-call') {
        const toolName = typeof payload?.tool === 'string' ? payload.tool : undefined;
        streamRecord.toolCallCount = Math.max(0, Math.trunc(streamRecord.toolCallCount || 0)) + 1;
        if (isRequestUserInputToolName(toolName)) streamRecord.requestedUserInput = true;
        streamRecord.segments.push({
          type: 'tool-call',
          tool: toolName,
          args: payload?.args && typeof payload.args === 'object' ? payload.args : {},
          toolCallId: typeof payload?.toolCallId === 'string' ? payload.toolCallId : undefined,
          result: undefined,
        });
        persistStreamRecord();
      } else if (channel === 'chat:stream:tool-result') {
        const toolCallId = typeof payload?.toolCallId === 'string' ? payload.toolCallId : null;
        for (let index = streamRecord.segments.length - 1; index >= 0; index -= 1) {
          const segment = streamRecord.segments[index];
          if (segment?.type !== 'tool-call') continue;
          if (toolCallId && segment.toolCallId && segment.toolCallId !== toolCallId) continue;
          if (segment.result !== undefined) continue;
          segment.result = typeof payload?.result === 'string' ? payload.result : '';
          break;
        }
        persistStreamRecord();
      } else if (channel === 'chat:stream:done' || channel === 'chat:stream:error') {
        const lifetimeUsage = recordConversationUsage({
          conversationStore,
          streamRecord,
          usage: payload?.usage,
        });
        if (lifetimeUsage) {
          payload = { ...payload, lifetimeUsage };
        }
        streamRecord.terminalEventSent = true;
        // 终结态强制落盘：done 视为正常完成；error 标记 interrupted=true，
        // 让切回时表达层能区分「完成」与「中断」。
        const erroredTerminal = channel === 'chat:stream:error';
        streamRecord.terminalStatus = erroredTerminal ? 'error' : 'done';
        streamRecord.interrupted = erroredTerminal;
        if (payload?.usage) streamRecord.finalUsage = payload.usage;
        if (payload?.lifetimeUsage) streamRecord.lifetimeUsage = payload.lifetimeUsage;
        persistStreamRecord({ final: true, interrupted: erroredTerminal });
      } else if (channel === 'chat:stream:aborted') {
        streamRecord.terminalEventSent = true;
        streamRecord.terminalStatus = 'aborted';
        streamRecord.interrupted = true;
        persistStreamRecord({ final: true, interrupted: true });
      }
      return realWebContents.send(channel, payload);
    },
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
  persistCompaction = null,
  promptSnapshotStore = null,
  preferredAccessLevel = 'ask_before_local',
  mcpRegistry = null,
  // main 注入的带 onChange 的 goalPlanStore 单例。AI 工具(goal_create_plan/
  // goal_update_task)必须写到它，变更才能广播到渲染端，浮条才会随流式更新。
  goalPlanStore = null,
  // 全局活跃流广播宿主(由 main 注入):向所有渲染窗口推送当前正在运行的会话列表,
  // 使左侧列表无需"点进去"即可知道哪些会话在跑。表达层订阅,真值仍在 activeStreams。
  broadcast = null,
}) {
  permissionGate.setAccessLevel(preferredAccessLevel);

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

  function listActiveConversationIds() {
    const ids = new Set();
    for (const record of activeStreams.values()) {
      if (isRunning(record) && record.conversationId) ids.add(record.conversationId);
    }
    return [...ids];
  }

  // ADR 27: 活跃流投影携带工作区维度。按 conversationId 去重(同一会话可能有多条流,
  // 取首条记录的工作区即可),供 renderer 派生"哪些工作区有运行中的流"。
  function listActiveStreams() {
    const byConversation = new Map();
    for (const record of activeStreams.values()) {
      if (!isRunning(record)) continue;
      if (!record.conversationId) continue;
      if (!byConversation.has(record.conversationId)) {
        byConversation.set(record.conversationId, {
          conversationId: record.conversationId,
          workspacePath: record.workspacePath ?? null,
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

  function getProviderCandidates() {
    const providers = llmConfigStore.listProviders();
    return orderProviderCandidates(providers);
  }

  async function sendMessage({
    messages,
    webContents,
    streamId,
    effort = 'default',
    mode = 'chat',
    conversationId = null,
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
    // Goal Runner 进度 sink：{ onRound, onToolCall }。onRound 经各 provider loop 透传，
    // onToolCall 经 toolContext 透传，分别用于实时轮次/工具计数。普通 chat 不传。
    agentProgress = null,
  }) {
    const providerCandidates = getProviderCandidates();
    if (!providerCandidates.length) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return { terminalStatus: 'error', requestedUserInput: false, toolCallCount: 0 };
    }

    // 会话 workspace 是本轮的 origin：用户从哪里发起、有哪些知识上下文。Goal 模式下，
    // active Goal 可绑定 targetWorkspacePath；此时工具 cwd / 项目指令切换到 target，
    // origin 作为 runtime context extension 注入，不再把 origin 当写入边界。
    const conversationWorkspacePath = resolveRunWorkspacePathForRun(conversationId, incomingWorkspacePath);
    const goalWorkspaceBinding = mode === 'goal'
      ? resolveActiveGoalExecutionBinding(conversationId, conversationWorkspacePath, goalPlanStore)
      : null;
    const runWorkspacePath = goalWorkspaceBinding?.executionWorkspacePath || conversationWorkspacePath;
    const effectiveContextExtensions = [
      ...(Array.isArray(contextExtensions) ? contextExtensions : []),
      ...buildGoalWorkspaceBindingExtensions(goalWorkspaceBinding),
    ];

    const controller = new AbortController();
    const streamRecord = {
      controller,
      webContents,
      permissionIds: new Set(),
      conversationId,
      // 正文持久化主键：主进程据此把累积正文/segments patch 回 store 的 assistant 消息。
      assistantMessageId,
      // ADR 27: 快照发起时的工作区。流的工作区归属在发起时固定(与 sendMessage
      // 入口快照 activeWorkspacePath 的语义一致),后续切换工作区不改变已在跑的流。
      // 供活跃流投影携带工作区维度,让"任务在其它工作区仍在跑"成为可见事实。
      workspacePath: runWorkspacePath,
      // 整轮 wall-clock 起点属于运行时事实。renderer 切走/重开后通过 reattach 恢复该锚点，
      // 避免重新进入会话时计时停住或从 0 重新开始。
      startedAt: Date.now(),
      // 复读兜底：命中尾部周期检测时需在 send 收口点自行构造 error payload，故留存 streamId。
      streamId,
      // ADR 22: 累积进行中的流式正文/思考/工具段,供 HMR 重载后 reattach 取快照续接。
      accumulatedText: '',
      accumulatedThinking: '',
      segments: [],
      usageRecorded: false,
      toolCallCount: 0,
      requestedUserInput: false,
      // 终态事件去重:保证 done/error/aborted 三选一恰好发一次,防止压缩等中间阶段抛错后界面悬挂。
      terminalEventSent: false,
    };
    activeStreams.set(streamId, streamRecord);
    emitActiveStreamsChanged();
    // 累积代理:拦截 delta/thinking 追加到记录,其余事件透传给真实 webContents。
    const accumulatingWebContents = wrapWebContentsForRuntimeEvents(webContents, streamRecord, { conversationStore });

    const toolContext = getConversationToolContext({ conversationId, workspacePath: runWorkspacePath });
    // 把本回合的交互模式写入（复用的）会话级 toolContext，供 goal 模式运行时闸门在工具
    // 执行层判定准入。见 Goal 模式运行时闸门设计。
    toolContext.mode = mode;
    toolContext.workspacePath = runWorkspacePath;
    toolContext.originWorkspacePath = goalWorkspaceBinding?.originWorkspacePath ?? conversationWorkspacePath;
    toolContext.targetWorkspacePath = goalWorkspaceBinding?.targetWorkspacePath ?? null;
    toolContext.readableRoots = goalWorkspaceBinding?.readableRoots ?? null;
    toolContext.writableRoots = goalWorkspaceBinding?.writableRoots ?? null;
    // 把本回合的工具计数 sink 写入会话级 toolContext，供工具派发处实时回调。
    // 仅本回合有效，回合结束后由下一次 sendMessage 覆盖（无 sink 时复位为 null）。
    toolContext.onToolCall = agentProgress?.onToolCall ?? null;

    try {
      for (let attemptIndex = 0; attemptIndex < providerCandidates.length; attemptIndex += 1) {
        const provider = providerCandidates[attemptIndex];
        let credential;
        try {
          credential = await resolveProviderCredential({ provider, llmConfigStore });
        } catch (credentialError) {
          accumulatingWebContents.send('chat:stream:error', {
            streamId,
            error: getProviderCredentialErrorCode(credentialError),
          });
          return;
        }
        if (!credential || streamRecord.terminalEventSent) return;
        const resolvedChannel = resolveChannel({
          ...provider,
          apiKey: credential.apiKey,
          accountId: credential.accountId,
        });

        const systemContext = buildSystemContext(runWorkspacePath, {
          contextAttachments,
          runtimeReminders,
          attachmentContext,
          configInstructions,
          contextExtensions: effectiveContextExtensions,
          explorerContext,
          verifierContext,
          continuityContext,
          conversationId,
          effort,
          mode,
          // goal-plan 事实上下文 Source（0006）：goal 模式下注入活动计划权威 taskId。
          goalPlanStore,
          provider: resolvedChannel.legacyProvider,
          model: provider.model,
        });
        const systemPrompt = renderSystemContext(systemContext);
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

        // (a) 同 provider 流读取早期中断的自动重试：把单次尝试封装为闭包，便于在
        // replay-safe 且为可恢复传输失败时，从头重发同一请求（覆盖全部 wire）。
        const runProviderAttempt = async () => {
        const attemptStream = createProviderAttemptStream({
          webContents: accumulatingWebContents,
          streamId,
          provider,
        });
        const contextWindow = provider.contextWindow || 0;
        const maxOutputTokens = provider.maxOutputTokens || 0;
        const onNativeReasoningFallback = (details) => noteNativeReasoningFallback(provider, details);
        const runtimeTools = buildRuntimeTools({
          mcpRegistry,
          providerType: resolvedChannel.legacyProvider,
          mode,
        });

        try {
          if (resolvedChannel.wire === 'anthropic-messages') {
            await agentLoopAnthropic({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: controller.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              supportsPromptCaching: Boolean(provider.supportsPromptCaching),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              toolContext,
              agentProgress,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              onNativeReasoningFallback,
              resolvedChannel,
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
              signal: controller.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              toolContext,
              agentProgress,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              resolvedChannel,
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
              signal: controller.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              supportsPromptCaching: Boolean(provider.supportsPromptCaching),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              toolContext,
              agentProgress,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              onNativeReasoningFallback,
              authMethod: credential.authMethod,
              accountId: credential.accountId,
              resolvedChannel,
            });
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          attemptStream.webContents.send('chat:stream:error', {
            streamId,
            error: describeFetchFailure(err),
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
          await sleepWithSignal(delayMs, controller.signal);
        }

        if (!attemptResult.terminalError || attemptResult.terminalSent) return;

        const nextProvider = providerCandidates[attemptIndex + 1] ?? null;
        if (nextProvider && attemptResult.replayable) {
          accumulatingWebContents.send('chat:stream:provider-recovery', {
            streamId,
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
        accumulatingWebContents.send('chat:stream:error', {
          streamId,
          error: describeFetchFailure(err),
        });
      }
    } finally {
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
      // 方案 3：不立即删除，保留终态记录一段时间，使切回已结束的后台轮次可经
      // reattach 回放完整终态快照；保留期满后由 retireStream 内的计时器硬删除。
      retireStream(streamId);
      return buildAgentRunOutcome(streamRecord);
    }
  }

  function abort(streamId) {
    const active = activeStreams.get(streamId);
    if (!active) return { aborted: false };
    active.controller.abort();
    permissionGate.settleStreamPermissionRequests(streamId, {
      granted: false,
      reason: 'stream_aborted',
    });
    active.webContents.send('chat:stream:aborted', { streamId });
    // abort 直接走真实 webContents，绕过累积代理；故在此显式收口终态并落盘，
    // 再走保留期（不立即删除），让切回被中断的后台轮次也能回放已累积正文。
    active.terminalEventSent = true;
    active.terminalStatus = 'aborted';
    active.interrupted = true;
    active.persist?.({ final: true, interrupted: true });
    retireStream(streamId);
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
    };
  }

  return {
    sendMessage,
    abort,
    setWorkspacePath,
    setLocalAccessLevel,
    resolvePermissionGrant,
    reattach,
    listActiveConversationIds,
    listActiveStreams,
  };
}
