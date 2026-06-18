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
import { agentLoopOpenAI } from './chat-runtime/openai-agent-loop.mjs';
import { sanitizeApiMessages } from './chat-runtime/message-sanitizer.mjs';
import { createChatPermissionGate } from './chat-runtime/permission-gate.mjs';
import {
  createProviderAttemptStream,
  describeFetchFailure,
  describeProviderTarget,
  orderProviderCandidates,
} from './chat-runtime/provider-recovery-broker.mjs';
import { hasDanglingToolIntent, hasUnsupportedToolClaim } from './chat-runtime/response-guard.mjs';
import { createToolContext } from './chat-runtime/tool-orchestrator.mjs';
import { ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';

const activeStreams = new Map();
const permissionGate = createChatPermissionGate({ activeStreams });
const conversationToolContexts = new Map();
let activeWorkspacePath = null;

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
export { sanitizeApiMessages };

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

  return {
    send(channel, payload) {
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        streamRecord.accumulatedText += payload.content;
        appendTextSegment('text', payload.content);
      } else if (channel === 'chat:stream:thinking' && typeof payload?.content === 'string') {
        streamRecord.accumulatedThinking += payload.content;
        appendTextSegment('thinking', payload.content);
      } else if (channel === 'chat:stream:tool-call') {
        streamRecord.segments.push({
          type: 'tool-call',
          tool: typeof payload?.tool === 'string' ? payload.tool : undefined,
          args: payload?.args && typeof payload.args === 'object' ? payload.args : {},
          toolCallId: typeof payload?.toolCallId === 'string' ? payload.toolCallId : undefined,
          result: undefined,
        });
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
      } else if (channel === 'chat:stream:aborted') {
        streamRecord.terminalEventSent = true;
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

  function setLocalAccessLevel(nextAccessLevel) {
    return permissionGate.setAccessLevel(nextAccessLevel);
  }

  // 当前正在流式运行的会话 id 去重列表(只读快照)。
  function listActiveConversationIds() {
    const ids = new Set();
    for (const record of activeStreams.values()) {
      if (record.conversationId) ids.add(record.conversationId);
    }
    return [...ids];
  }

  // ADR 27: 活跃流投影携带工作区维度。按 conversationId 去重(同一会话可能有多条流,
  // 取首条记录的工作区即可),供 renderer 派生"哪些工作区有运行中的流"。
  function listActiveStreams() {
    const byConversation = new Map();
    for (const record of activeStreams.values()) {
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

  async function resolveProviderCredential(provider, webContents, streamId) {
    const authMethod = provider.authMethod || 'api_key';
    if (authMethod === 'oauth_chatgpt') {
      const credential = llmConfigStore.getCredential(provider.id);
      const tokens = credential?.tokens || null;
      if (!tokens?.access) {
        webContents.send('chat:stream:error', { streamId, error: 'oauth_not_logged_in' });
        return null;
      }
      try {
        const { tokens: fresh, refreshed } = await ensureFreshTokens(tokens);
        if (refreshed) llmConfigStore.setOAuthTokens(provider.id, fresh);
        return {
          authMethod,
          apiKey: fresh.access,
          accountId: fresh.accountId || null,
        };
      } catch {
        webContents.send('chat:stream:error', { streamId, error: 'oauth_token_refresh_failed' });
        return null;
      }
    }

    const apiKey = llmConfigStore.getDecryptedApiKey(provider.id);
    if (!apiKey) {
      webContents.send('chat:stream:error', { streamId, error: 'api_key_not_found' });
      return null;
    }
    return { authMethod, apiKey, accountId: null };
  }

  async function sendMessage({
    messages,
    webContents,
    streamId,
    effort = 'default',
    mode = 'chat',
    conversationId = null,
    contextAttachments = [],
    runtimeReminders = [],
    attachmentContext = [],
    continuityContext = [],
    configInstructions = [],
    contextExtensions = [],
  }) {
    const providerCandidates = getProviderCandidates();
    if (!providerCandidates.length) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return;
    }

    const controller = new AbortController();
    const streamRecord = {
      controller,
      webContents,
      permissionIds: new Set(),
      conversationId,
      // ADR 27: 快照发起时的工作区。流的工作区归属在发起时固定(与 sendMessage
      // 入口快照 activeWorkspacePath 的语义一致),后续切换工作区不改变已在跑的流。
      // 供活跃流投影携带工作区维度,让"任务在其它工作区仍在跑"成为可见事实。
      workspacePath: activeWorkspacePath,
      // 整轮 wall-clock 起点属于运行时事实。renderer 切走/重开后通过 reattach 恢复该锚点，
      // 避免重新进入会话时计时停住或从 0 重新开始。
      startedAt: Date.now(),
      // ADR 22: 累积进行中的流式正文/思考/工具段,供 HMR 重载后 reattach 取快照续接。
      accumulatedText: '',
      accumulatedThinking: '',
      segments: [],
      usageRecorded: false,
      // 终态事件去重:保证 done/error/aborted 三选一恰好发一次,防止压缩等中间阶段抛错后界面悬挂。
      terminalEventSent: false,
    };
    activeStreams.set(streamId, streamRecord);
    emitActiveStreamsChanged();
    // 累积代理:拦截 delta/thinking 追加到记录,其余事件透传给真实 webContents。
    const accumulatingWebContents = wrapWebContentsForRuntimeEvents(webContents, streamRecord, { conversationStore });

    const toolContext = getConversationToolContext({ conversationId, workspacePath: activeWorkspacePath });
    // 把本回合的交互模式写入（复用的）会话级 toolContext，供 goal 模式运行时闸门在工具
    // 执行层判定准入。见 Goal 模式运行时闸门设计。
    toolContext.mode = mode;

    try {
      for (let attemptIndex = 0; attemptIndex < providerCandidates.length; attemptIndex += 1) {
        const provider = providerCandidates[attemptIndex];
        const credential = await resolveProviderCredential(provider, accumulatingWebContents, streamId);
        if (!credential || streamRecord.terminalEventSent) return;

        const systemContext = buildSystemContext(activeWorkspacePath, {
          contextAttachments,
          runtimeReminders,
          attachmentContext,
          configInstructions,
          contextExtensions,
          continuityContext,
          conversationId,
          effort,
          mode,
          // goal-plan 事实上下文 Source（0006）：goal 模式下注入活动计划权威 taskId。
          goalPlanStore,
          provider: provider.provider,
          model: provider.model,
        });
        const systemPrompt = renderSystemContext(systemContext);
        recordPromptSnapshot(promptSnapshotStore, systemContext, {
          streamId,
          conversationId,
          contextEpochId: getActiveContextEpochId(promptSnapshotStore, conversationId),
          effort,
          provider: provider.provider,
          providerId: provider.id,
          model: provider.model,
          mode,
          recoveryAttempt: attemptIndex + 1,
        });

        const attemptStream = createProviderAttemptStream({
          webContents: accumulatingWebContents,
          streamId,
          provider,
        });
        const contextWindow = provider.contextWindow || 0;
        const onNativeReasoningFallback = (details) => noteNativeReasoningFallback(provider, details);
        const runtimeTools = buildRuntimeTools({
          mcpRegistry,
          providerType: provider.provider,
          mode,
        });

        try {
          if (provider.provider === 'anthropic') {
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
              conversationId,
              persistCompaction,
              continuityContext,
              toolContext,
              workspacePath: activeWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              onNativeReasoningFallback,
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
              contextWindow,
              conversationId,
              persistCompaction,
              continuityContext,
              toolContext,
              workspacePath: activeWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              onNativeReasoningFallback,
              authMethod: credential.authMethod,
              accountId: credential.accountId,
            });
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          attemptStream.webContents.send('chat:stream:error', {
            streamId,
            error: describeFetchFailure(err),
          });
        }

        const attemptResult = attemptStream.getResult();
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
      }
      activeStreams.delete(streamId);
      emitActiveStreamsChanged();
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
    activeStreams.delete(streamId);
    emitActiveStreamsChanged();
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
      for (const [activeId, activeRecord] of activeStreams.entries()) {
        if (activeRecord?.conversationId === conversationId) {
          id = activeId;
          record = activeRecord;
          break;
        }
      }
    } else if (activeStreams.size === 1) {
      const only = activeStreams.entries().next().value;
      id = only?.[0] ?? null;
      record = only?.[1] ?? null;
    }
    if (!record || id == null) return null;
    return {
      streamId: id,
      conversationId: record.conversationId ?? null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      accumulatedText: record.accumulatedText ?? '',
      accumulatedThinking: record.accumulatedThinking ?? '',
      segments: Array.isArray(record.segments) ? record.segments.map((segment) => ({ ...segment })) : [],
      isStreaming: true,
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
