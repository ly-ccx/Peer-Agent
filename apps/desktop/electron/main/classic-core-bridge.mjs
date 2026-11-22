import { randomUUID } from 'node:crypto';
import {
  createRuntimeProjectionFromToolRegistry,
  createRuntimeToolRegistry,
} from './tools/index.mjs';

/**
 * Capability prefixes that remain owned by Desktop (Electron WebView / UI / Preview /
 * Image decoder / Automation scheduler) and are exposed to Rust Peer Core as reverse
 * `ExternalCapabilityManifest` descriptors (`host.capability.execute`).
 *
 * `local.search.aggregate` is intentionally excluded because Rust Core already embeds
 * `BatchSearchProvider`.
 */
export const DESKTOP_EXTERNAL_CAPABILITY_PREFIXES = Object.freeze([
  'local.web.control.',
  'local.web.external.',
  'local.desktop_preview.',
  'local.image.',
  'local.automation.propose',
]);

function matchesDesktopExternalPrefix(capabilityId) {
  return typeof capabilityId === 'string'
    && DESKTOP_EXTERNAL_CAPABILITY_PREFIXES.some((prefix) => capabilityId.startsWith(prefix));
}

export function collectDesktopExternalCapabilities({
  createRegistry = createRuntimeToolRegistry,
  projectRegistry = createRuntimeProjectionFromToolRegistry,
} = {}) {
  const registry = createRegistry();
  const projection = projectRegistry(registry, { mode: 'chat' });
  const toolsByName = new Map(registry.listTools().map((tool) => [tool.name, tool]));
  const collected = [];
  const seenAliases = new Set();

  for (const manifest of projection.capabilities ?? []) {
    const capabilityId = manifest?.capabilityId;
    const alias = manifest?.name;
    if (!matchesDesktopExternalPrefix(capabilityId) || !alias || seenAliases.has(alias)) {
      continue;
    }
    seenAliases.add(alias);
    const tool = toolsByName.get(alias);
    const modeScopes = Array.isArray(tool?.availableInModes) && tool.availableInModes.length > 0
      ? [...tool.availableInModes]
      : ['chat', 'plan', 'goal'];
    collected.push({
      alias,
      capabilityId,
      manifest: {
        ...manifest,
        modeScopes,
      },
    });
  }

  return collected;
}

const STREAM_FORWARD_CHANNELS = new Set([
  'chat:stream:delta',
  'chat:stream:thinking',
  'chat:stream:tool-call',
  'chat:stream:tool-progress',
  'chat:stream:tool-result',
  'chat:stream:permission-request',
  'chat:stream:permission-settled',
  'chat:stream:usage',
  'chat:stream:done',
  'chat:stream:error',
  'chat:stream:aborted',
]);

function normalizeHostToolOutcome(executionResult) {
  const rawResult = executionResult?.execution?.result ?? executionResult?.result ?? executionResult ?? {};
  let status = 'success';
  if (typeof rawResult?.status === 'string') {
    status = rawResult.status;
  } else if (executionResult?.ok === false || executionResult?.success === false) {
    status = 'failed';
  }

  let output = rawResult?.output ?? rawResult?.modelContext ?? rawResult;
  if (output === undefined) output = {};

  const error = rawResult?.error ?? executionResult?.error ?? null;
  const artifacts = Array.isArray(rawResult?.evidence?.artifactRefs)
    ? rawResult.evidence.artifactRefs
    : Array.isArray(rawResult?.artifacts)
      ? rawResult.artifacts
      : [];

  return { status, output, error, artifacts };
}

export function createClassicCoreBridge({
  getClient,
  getLocalToolHost = () => null,
  broadcast = null,
  onGoalPlanChanged = null,
  onProjectBotConversationChanged = null,
  onProjectBotHostStateChanged = null,
  prepareGoalWorkspace = null,
  runVisualVerification = null,
  compactionRegistry = null,
  logger = console,
} = {}) {
  const activeStreams = new Map();
  const pendingPermissions = new Map();
  const activeGoals = new Set();
  const activeCompactions = new Map();
  let projectBotHostActive = false;
  let projectBotHostDesiredEnabled = false;
  let botHostConfigureSeq = 0;
  let botHostConfigureQueue = Promise.resolve();
  let hostStatusRefreshTimer = null;
  const botOwnedWorkspaces = new Set();
  const botActivities = new Map();
  const botAgentStatuses = new Map();
  const botRecoveryStatus = new Map();
  const botRecoveryAttention = new Map();

  function activeClient() {
    const client = typeof getClient === 'function' ? getClient() : null;
    if (!client) return null;
    if (typeof client.isReady === 'function') {
      return client.isReady() ? client : null;
    }
    return client.status?.().state === 'ready' ? client : null;
  }

  function isAvailable() {
    return activeClient() !== null;
  }

  function clearBotHostCaches() {
    botOwnedWorkspaces.clear();
    botActivities.clear();
    botAgentStatuses.clear();
    botRecoveryStatus.clear();
    botRecoveryAttention.clear();
  }

  function applyMapSnapshot(target, sourceObj, scopedWorkspaceId) {
    const obj = sourceObj && typeof sourceObj === 'object' ? sourceObj : null;
    if (scopedWorkspaceId) {
      if (obj && Object.hasOwn(obj, scopedWorkspaceId)) {
        target.set(scopedWorkspaceId, obj[scopedWorkspaceId]);
      } else {
        target.delete(scopedWorkspaceId);
      }
      return;
    }
    target.clear();
    if (!obj) return;
    for (const [key, value] of Object.entries(obj)) {
      if (key) target.set(key, value);
    }
  }

  function applyProjectBotHostStatus(snapshot, scopedWorkspaceId = null) {
    if (!snapshot || typeof snapshot !== 'object') return;
    projectBotHostActive = snapshot.enabled === true;
    if (Array.isArray(snapshot.ownedWorkspaces)) {
      botOwnedWorkspaces.clear();
      for (const id of snapshot.ownedWorkspaces) {
        if (typeof id === 'string' && id) botOwnedWorkspaces.add(id);
      }
    }
    applyMapSnapshot(botActivities, snapshot.activities, scopedWorkspaceId);
    applyMapSnapshot(botAgentStatuses, snapshot.agentStatuses, scopedWorkspaceId);
    applyMapSnapshot(botRecoveryStatus, snapshot.recoveryStatus, scopedWorkspaceId);
    applyMapSnapshot(botRecoveryAttention, snapshot.recoveryAttention, scopedWorkspaceId);
  }

  function clearProjectBotHostState(reason = 'reset') {
    if (hostStatusRefreshTimer) {
      clearTimeout(hostStatusRefreshTimer);
      hostStatusRefreshTimer = null;
    }
    const wasActive = projectBotHostActive || projectBotHostDesiredEnabled;
    projectBotHostActive = false;
    projectBotHostDesiredEnabled = false;
    clearBotHostCaches();
    if (wasActive) {
      onProjectBotHostStateChanged?.({ active: false, reason });
    }
  }

  function scheduleProjectBotHostStatusRefresh() {
    if (!projectBotHostActive || !isAvailable() || hostStatusRefreshTimer) return;
    hostStatusRefreshTimer = setTimeout(() => {
      hostStatusRefreshTimer = null;
      if (projectBotHostActive && isAvailable()) {
        void projectBotHostStatus().catch(() => {});
      }
    }, 150);
    hostStatusRefreshTimer.unref?.();
  }

  function isProjectBotHostActive() {
    return Boolean(isAvailable() && projectBotHostActive);
  }

  function isProjectBotHostOwnedOrPending() {
    return Boolean(isAvailable() && (projectBotHostActive || projectBotHostDesiredEnabled));
  }

  function isProjectBotWorkspaceOnline(workspaceId) {
    return Boolean(isProjectBotHostActive() && typeof workspaceId === 'string' && botOwnedWorkspaces.has(workspaceId));
  }

  function readProjectBotActivity(workspaceId) {
    return typeof workspaceId === 'string' ? (botActivities.get(workspaceId) ?? null) : null;
  }

  function readProjectBotAgentStatus(workspaceId) {
    return typeof workspaceId === 'string' ? botAgentStatuses.get(workspaceId) : undefined;
  }

  function readProjectBotRecovery(workspaceId) {
    return typeof workspaceId === 'string' ? (botRecoveryStatus.get(workspaceId) ?? null) : null;
  }

  function needsProjectBotRecoveryAttention(workspaceId) {
    return typeof workspaceId === 'string' && botRecoveryAttention.get(workspaceId) === true;
  }

  function canHandleChatSend({ mode = 'chat', hasResourceFeedback = false } = {}) {
    if (!isAvailable() || hasResourceFeedback) return false;
    const normalized = mode || 'chat';
    return normalized === 'chat' || normalized === 'plan' || normalized === 'goal';
  }

  function canHandleGoalPlan(plan) {
    return Boolean(
      isAvailable()
      && plan
      && !plan.delegationOrigin
      && !plan.parentPlanId,
    );
  }

  function ownsGoalPlan(planId) {
    return typeof planId === 'string' && activeGoals.has(planId);
  }

  function ownsStream(streamId) {
    return typeof streamId === 'string' && activeStreams.has(streamId);
  }

  function ownsPermission(toolCallId) {
    return typeof toolCallId === 'string' && pendingPermissions.has(toolCallId);
  }

  function sendToStreamSurface(record, method, params) {
    const wc = record?.webContents;
    if (wc && typeof wc.send === 'function' && !wc.isDestroyed?.()) {
      wc.send(method, params);
      return;
    }
    broadcast?.(method, params);
  }

  function clearStreamPermissions(streamId) {
    for (const [toolCallId, ownerStreamId] of pendingPermissions.entries()) {
      if (ownerStreamId === streamId) {
        pendingPermissions.delete(toolCallId);
      }
    }
  }

  function settleStream(streamId, outcome) {
    const record = activeStreams.get(streamId);
    if (!record) return;
    activeStreams.delete(streamId);
    clearStreamPermissions(streamId);
    record.resolve?.(outcome);
  }

  function handleNotification(method, params) {
    if (method === 'project.bot.changed') {
      const workspaceIds = Array.isArray(params?.workspaceIds)
        ? params.workspaceIds.filter((id) => typeof id === 'string' && id)
        : [];
      if (workspaceIds.length > 0) {
        broadcast?.('project-agent:changed', { workspaceIds });
      }
      scheduleProjectBotHostStatusRefresh();
      return;
    }

    if (method === 'project.bot.conversationChanged') {
      const workspaceIds = Array.isArray(params?.workspaceIds)
        ? params.workspaceIds.filter((id) => typeof id === 'string' && id)
        : (typeof params?.workspaceId === 'string' && params.workspaceId ? [params.workspaceId] : []);
      if (workspaceIds.length > 0) {
        broadcast?.('project-agent:conversation-changed', { workspaceIds });
      }
      onProjectBotConversationChanged?.({
        workspaceId: typeof params?.workspaceId === 'string' ? params.workspaceId : (workspaceIds[0] ?? ''),
        conversationId: typeof params?.conversationId === 'string' ? params.conversationId : null,
      });
      return;
    }

    if (method === 'project.bot.activity') {
      const activity = params?.activity && typeof params.activity === 'object'
        ? params.activity
        : (params && typeof params === 'object' && typeof params.workspaceId === 'string' ? params : null);
      const workspaceId = typeof params?.workspaceId === 'string'
        ? params.workspaceId
        : (typeof activity?.workspaceId === 'string' ? activity.workspaceId : '');
      if (workspaceId && activity) {
        botActivities.set(workspaceId, activity);
      }
      if (workspaceId && typeof params?.status === 'string') {
        botAgentStatuses.set(workspaceId, params.status);
      }
      if (activity) {
        broadcast?.('project-agent:activity', activity);
      }
      return;
    }

    if (method === 'project.bot.obligationGrants') {
      broadcast?.('project-agent:obligation-grants', params ?? {});
      return;
    }

    if (method === 'goalPlans:changed') {
      if (typeof onGoalPlanChanged === 'function') {
        onGoalPlanChanged(params);
      } else {
        broadcast?.(method, params);
      }
      return;
    }

    if (method === 'goalRunner:changed') {
      const planId = typeof params?.planId === 'string' ? params.planId : '';
      const eventType = params?.type;
      if (eventType === 'goalRunner:streamStarted' && typeof params?.streamId === 'string' && params.streamId) {
        if (planId) activeGoals.add(planId);
        if (!activeStreams.has(params.streamId)) {
          let resolveTick;
          const tickPromise = new Promise((resolve) => {
            resolveTick = resolve;
          });
          activeStreams.set(params.streamId, {
            streamId: params.streamId,
            conversationId: params?.conversationId ?? null,
            webContents: null,
            startedAt: typeof params?.startedAt === 'number' ? params.startedAt : Date.now(),
            accumulatedText: '',
            isGoalTick: true,
            promise: tickPromise,
            resolve: resolveTick,
          });
        }
      } else if (planId) {
        if (eventType === 'goalRunner:started' || eventType === 'goalRunner:resumed') {
          activeGoals.add(planId);
        } else if (
          eventType === 'goalRunner:completed'
          || eventType === 'goalRunner:paused'
          || eventType === 'goalRunner:cleared'
          || eventType === 'goalRunner:failed'
          || eventType === 'goalRunner:blocked'
        ) {
          activeGoals.delete(planId);
        }
      }
      broadcast?.(method, params);
      return;
    }

    if (method === 'chat:stream:active-changed') {
      broadcast?.(method, params);
      return;
    }

    if (method === 'chat:stream:compaction' || method === 'chat:compaction') {
      const conversationId = typeof params?.conversationId === 'string' ? params.conversationId : '';
      const streamId = typeof params?.streamId === 'string' ? params.streamId : '';
      const manual = params?.manual ?? true;
      const normalizedPayload = {
        ...(params && typeof params === 'object' ? params : {}),
        manual,
      };
      if (conversationId && streamId) {
        if (params?.stage === 'start') {
          activeCompactions.set(conversationId, streamId);
          compactionRegistry?.beginCompaction?.({ conversationId, streamId, manual });
        } else if (params?.stage === 'progress') {
          compactionRegistry?.updateCompactionProgress?.({
            conversationId,
            streamId,
            percent: params?.percent ?? null,
          });
        } else if (params?.stage === 'failed') {
          activeCompactions.delete(conversationId);
          compactionRegistry?.failCompaction?.({
            conversationId,
            streamId,
            errorCode: params?.errorCode,
            message: params?.message,
            budget: params?.budget ?? null,
          });
        } else if (params?.stage === 'done' || params?.stage === 'idle') {
          activeCompactions.delete(conversationId);
          compactionRegistry?.endCompaction?.({ conversationId, streamId });
        }
      }
      broadcast?.('chat:compaction', normalizedPayload);
      return;
    }

    if (!STREAM_FORWARD_CHANNELS.has(method)) return;

    const streamId = params?.streamId;
    const record = typeof streamId === 'string' ? activeStreams.get(streamId) : null;

    if (method === 'chat:stream:delta' && record && typeof params?.content === 'string') {
      record.accumulatedText += params.content;
    } else if (method === 'chat:stream:tool-result' && record && Array.isArray(params?.evidenceRefs)) {
      for (const ref of params.evidenceRefs) {
        if (typeof ref === 'string' && ref && !record.evidenceRefs.includes(ref)) {
          record.evidenceRefs.push(ref);
        }
      }
    } else if (method === 'chat:stream:permission-request') {
      const toolCallId = params?.call?.toolCallId;
      if (typeof toolCallId === 'string' && typeof streamId === 'string') {
        pendingPermissions.set(toolCallId, streamId);
      }
    } else if (method === 'chat:stream:permission-settled') {
      const toolCallIds = Array.isArray(params?.toolCallIds) ? params.toolCallIds : [];
      for (const toolCallId of toolCallIds) {
        pendingPermissions.delete(toolCallId);
      }
    }

    if (record) {
      sendToStreamSurface(record, method, params);
    } else {
      broadcast?.(method, params);
    }

    if (method === 'chat:stream:done') {
      settleStream(streamId, {
        ok: true,
        status: params?.reason === 'requested_user_input' ? 'requested_user_input' : 'completed',
        terminalStatus: 'done',
        streamId,
        conversationId: params?.conversationId ?? record?.conversationId ?? null,
        text: record?.accumulatedText ?? '',
        evidenceRefs: [...(record?.evidenceRefs ?? [])],
        usage: params?.usage ?? null,
        lifetimeUsage: params?.lifetimeUsage ?? null,
        contextAccounting: params?.contextAccounting ?? null,
        reason: params?.reason ?? null,
        requestedUserInput: params?.reason === 'requested_user_input',
        aborted: false,
      });
    } else if (method === 'chat:stream:error') {
      settleStream(streamId, {
        ok: false,
        status: 'error',
        terminalStatus: 'error',
        streamId,
        conversationId: params?.conversationId ?? record?.conversationId ?? null,
        text: record?.accumulatedText ?? '',
        evidenceRefs: [...(record?.evidenceRefs ?? [])],
        usage: params?.usage ?? null,
        lifetimeUsage: params?.lifetimeUsage ?? null,
        error: params?.error ?? 'peer_core_stream_error',
        streamFailure: params?.streamFailure ?? null,
        aborted: false,
      });
    } else if (method === 'chat:stream:aborted') {
      settleStream(streamId, {
        ok: false,
        status: 'aborted',
        terminalStatus: 'aborted',
        streamId,
        conversationId: params?.conversationId ?? record?.conversationId ?? null,
        text: record?.accumulatedText ?? '',
        evidenceRefs: [...(record?.evidenceRefs ?? [])],
        aborted: true,
      });
    }
  }

  function handleUnexpectedExit() {
    clearProjectBotHostState('unexpected_exit');
    activeGoals.clear();
    for (const [conversationId, streamId] of activeCompactions.entries()) {
      compactionRegistry?.endCompaction?.({ conversationId, streamId });
    }
    activeCompactions.clear();
    if (activeStreams.size === 0) return;
    const entries = [...activeStreams.entries()];
    activeStreams.clear();
    pendingPermissions.clear();

    for (const [streamId, record] of entries) {
      const payload = {
        streamId,
        conversationId: record.conversationId,
        error: 'peer_core_exited_unexpectedly',
        streamFailure: { code: 'peer_core_exited_unexpectedly' },
      };
      sendToStreamSurface(record, 'chat:stream:error', payload);
      record.resolve?.({
        ok: false,
        status: 'error',
        terminalStatus: 'error',
        streamId,
        conversationId: record.conversationId,
        text: record.accumulatedText,
        error: 'peer_core_exited_unexpectedly',
        streamFailure: payload.streamFailure,
        aborted: false,
      });
    }

    broadcast?.('chat:stream:active-changed', {
      conversationIds: [],
      streams: [],
    });
  }

  function createHostHandlers() {
    return {
      'host.capability.execute': async (params = {}) => {
        const toolHost = typeof getLocalToolHost === 'function'
          ? getLocalToolHost(params.workspacePath)
          : null;
        if (!toolHost || typeof toolHost.execute !== 'function') {
          return {
            status: 'failed',
            output: { error: 'local_tool_host_not_ready' },
            error: { code: 'local_tool_host_not_ready', message: 'Local tool host is not ready' },
            artifacts: [],
          };
        }
        const toolCallId = params.toolCallId || `ext-${randomUUID()}`;
        const localApproval = {
          grantId: `peer-core-${randomUUID()}`,
          toolCallId,
          granted: true,
          duration: 'once',
          scope: params.capabilityId || params.alias || 'external',
          reason: 'peer_core_authorized',
          decidedAt: new Date().toISOString(),
        };
        const executionResult = await toolHost.execute(
          {
            call: {
              id: toolCallId,
              toolCallId,
              name: params.alias || params.capabilityId,
              capabilityId: params.capabilityId,
              arguments: params.arguments ?? {},
            },
          },
          {
            conversationId: params.conversationId,
            workspaceRoot: params.workspacePath,
            toolContext: {
              conversationId: params.conversationId,
              workspacePath: params.workspacePath,
            },
            localApproval,
            requestPermission: async () => ({
              granted: true,
              grant: localApproval,
              reason: 'peer_core_authorized',
            }),
            source: 'peer_core_external_provider',
          },
        );
        return normalizeHostToolOutcome(executionResult);
      },
      'host.goal.prepareWorkspace': async (params = {}) => (
        typeof prepareGoalWorkspace === 'function'
          ? await prepareGoalWorkspace(params)
          : { workspacePath: null }
      ),
      'host.goal.runVisualVerification': async (params = {}) => (
        typeof runVisualVerification === 'function'
          ? await runVisualVerification(params)
          : { required: false, passed: true, report: null }
      ),
    };
  }

  async function send(params = {}, webContents = null) {
    const client = activeClient();
    if (!client) {
      throw new Error('peer_core_not_ready');
    }
    const streamId = params.streamId;
    const conversationId = params.conversationId;
    if (!streamId || !conversationId || !params.assistantMessageId) {
      throw new Error('classic_core_bridge_invalid_send_params');
    }

    let resolveOutcome;
    const outcomePromise = new Promise((resolve) => {
      resolveOutcome = resolve;
    });

    const record = {
      streamId,
      conversationId,
      assistantMessageId: params.assistantMessageId ?? null,
      webContents,
      startedAt: Date.now(),
      accumulatedText: '',
      evidenceRefs: [],
      promise: outcomePromise,
      resolve: resolveOutcome,
    };
    activeStreams.set(streamId, record);

    try {
      const reminders = Array.isArray(params.runtimeReminders)
        ? params.runtimeReminders
            .map((r, index) => {
              if (typeof r === 'string' && r.trim()) {
                return { id: `runtime-reminder-${index + 1}`, content: r.trim() };
              }
              if (typeof r?.id === 'string' && typeof r?.content === 'string') {
                return { id: r.id, content: r.content };
              }
              return null;
            })
            .filter(Boolean)
        : [];
      await client.request('classic.chat.send', {
        conversationId,
        streamId,
        assistantMessageId: params.assistantMessageId,
        workspacePath: params.workspacePath,
        mode: params.mode || 'chat',
        ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        fastMode: Boolean(params.fastMode),
        persistModelSelection: Boolean(params.persistModelSelection),
        resumeInterruptedReply: Boolean(params.resumeInterruptedReply),
        ...(reminders.length > 0 ? { runtimeReminders: reminders } : {}),
        ...(params.permissionPolicy && typeof params.permissionPolicy === 'object'
          ? { permissionPolicy: params.permissionPolicy }
          : {}),
        ...(Array.isArray(params.configInstructions) ? { configInstructions: params.configInstructions } : {}),
        ...(Array.isArray(params.contextAttachments) && params.contextAttachments.length > 0
          ? { contextAttachments: params.contextAttachments }
          : {}),
        ...(Array.isArray(params.attachmentContext) && params.attachmentContext.length > 0
          ? { attachmentContext: params.attachmentContext }
          : {}),
        ...(Array.isArray(params.contextExtensions) && params.contextExtensions.length > 0
          ? { contextExtensions: params.contextExtensions }
          : {}),
        ...(Array.isArray(params.allowlist) ? { allowlist: params.allowlist } : {}),
        ...(Number.isInteger(params.maxTurns) ? { maxTurns: params.maxTurns } : {}),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (activeStreams.has(streamId)) {
        const errPayload = {
          streamId,
          conversationId,
          error: errorMessage,
          streamFailure: { code: errorMessage },
        };
        sendToStreamSurface(record, 'chat:stream:error', errPayload);
        settleStream(streamId, {
          ok: false,
          status: 'error',
          terminalStatus: 'error',
          streamId,
          conversationId,
          text: '',
          error: errorMessage,
          streamFailure: errPayload.streamFailure,
          aborted: false,
        });
      }
    }

    return outcomePromise;
  }

  async function abort(streamId) {
    const client = activeClient();
    if (!client) return { aborted: false };
    try {
      return await client.request('classic.chat.abort', { streamId });
    } catch (error) {
      logger?.warn?.('[peer-core] abort failed:', error?.message || error);
      return { aborted: false };
    }
  }

  async function reattach(input = {}) {
    const client = activeClient();
    if (!client) return null;
    try {
      return await client.request('classic.chat.reattach', {
        ...(input.streamId ? { streamId: input.streamId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      });
    } catch (error) {
      logger?.warn?.('[peer-core] reattach failed:', error?.message || error);
      return null;
    }
  }

  function listActiveSync() {
    const conversationIds = [];
    const seen = new Set();
    const streams = [];
    for (const [streamId, record] of activeStreams.entries()) {
      if (record.conversationId && !seen.has(record.conversationId)) {
        seen.add(record.conversationId);
        conversationIds.push(record.conversationId);
      }
      streams.push({
        streamId,
        conversationId: record.conversationId,
        startedAt: record.startedAt,
      });
    }
    return { conversationIds, streams };
  }

  function getActiveStreamsForConversation(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId) return [];
    const matching = [];
    for (const [streamId, record] of activeStreams.entries()) {
      if (record.conversationId === conversationId) {
        matching.push({
          streamId,
          conversationId: record.conversationId,
          assistantMessageId: record.assistantMessageId ?? null,
          startedAt: record.startedAt,
        });
      }
    }
    return matching;
  }

  async function compact(params = {}) {
    const client = activeClient();
    if (!client) {
      throw new Error('peer_core_not_ready');
    }
    return client.request('classic.chat.compact', {
      conversationId: params.conversationId,
      ...(params.streamId ? { streamId: params.streamId } : {}),
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
    }, { timeoutMs: 120_000 });
  }

  function resolvePermissionGrant(toolCallId, grant) {
    if (!ownsPermission(toolCallId)) return false;
    const client = activeClient();
    if (!client) return false;
    const decision = grant?.granted
      ? (grant?.duration === 'session' ? 'approve_session' : 'approve')
      : 'deny';
    pendingPermissions.delete(toolCallId);
    void client.request('classic.permission.decide', {
      toolCallId,
      decision,
    }).catch((error) => {
      logger?.warn?.('[peer-core] permission decide failed:', error?.message || error);
    });
    return true;
  }

  async function setLocalAccessLevel(accessLevel) {
    const client = activeClient();
    if (!client) return null;
    try {
      return await client.request('classic.access.set', { accessLevel });
    } catch (error) {
      logger?.warn?.('[peer-core] access sync failed:', error?.message || error);
      return null;
    }
  }

  function forceCompleteConversationStreams(conversationId) {
    if (!conversationId) return { released: Promise.resolve() };
    const waiters = [];
    for (const [streamId, record] of activeStreams.entries()) {
      if (record.conversationId === conversationId) {
        if (record.promise) waiters.push(record.promise);
        void abort(streamId);
      }
    }
    return {
      released: Promise.all(waiters.map((promise) => promise.catch(() => null))),
    };
  }

  async function startGoalRunner(planId, options = {}) {
    const client = activeClient();
    if (!client) throw new Error('peer_core_not_ready');
    const timeoutMs = options?.awaitIdle ? 600_000 : 60_000;
    return client.request('classic.goal.start', {
      planId,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    }, { timeoutMs });
  }

  async function resumeGoalRunner(planId, options = {}) {
    const client = activeClient();
    if (!client) throw new Error('peer_core_not_ready');
    const timeoutMs = options?.awaitIdle ? 600_000 : 60_000;
    return client.request('classic.goal.resume', {
      planId,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    }, { timeoutMs });
  }

  async function pauseGoalRunner(planId, reason) {
    const client = activeClient();
    if (!client) throw new Error('peer_core_not_ready');
    return client.request('classic.goal.pause', {
      planId,
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  }

  async function clearGoalRunner(planId, reason) {
    const client = activeClient();
    if (!client) throw new Error('peer_core_not_ready');
    return client.request('classic.goal.clear', {
      planId,
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  }

  async function getGoalRunnerState(planId) {
    const client = activeClient();
    if (!client) throw new Error('peer_core_not_ready');
    return client.request('classic.goal.getState', { planId });
  }

  function requireClient() {
    const client = activeClient();
    if (!client) throw new Error('peer_core_not_ready');
    return client;
  }

  async function listConversations(params = {}) {
    const wantsPage = params?.paginated === true || params?.limit != null || params?.cursor != null;
    return requireClient().request('classic.conversations.list', {
      ...(params?.workspacePath !== undefined ? { workspacePath: params.workspacePath } : {}),
      ...(params?.status !== undefined ? { status: params.status } : {}),
      ...(Array.isArray(params?.roles) ? { roles: params.roles } : {}),
      ...(params?.includeMessageCount !== undefined ? { includeMessageCount: params.includeMessageCount } : {}),
      ...(params?.limit != null ? { limit: params.limit } : {}),
      ...(params?.cursor != null ? { cursor: params.cursor } : {}),
      paginated: wantsPage,
    });
  }

  async function searchConversations(params = {}) {
    return requireClient().request('classic.conversations.search', {
      ...(params?.query !== undefined ? { query: params.query } : {}),
      ...(params?.workspacePath !== undefined ? { workspacePath: params.workspacePath } : {}),
      ...(params?.status !== undefined ? { status: params.status } : {}),
      ...(Array.isArray(params?.roles) ? { roles: params.roles } : {}),
      ...(params?.limit != null ? { limit: params.limit } : {}),
      includeWorkspaceNameMatch: Boolean(params?.includeWorkspaceNameMatch),
    });
  }

  async function createConversation(params = {}) {
    return requireClient().request('classic.conversations.create', params || {});
  }

  async function getConversation({ id, limit, before, full } = {}) {
    return requireClient().request('classic.conversations.get', {
      id,
      ...(limit != null ? { limit } : {}),
      ...(typeof before === 'string' && before ? { before } : {}),
      ...(full === true ? { full: true } : {}),
    });
  }

  async function updateConversationTitle({ id, title, source } = {}) {
    return requireClient().request('classic.conversations.updateTitle', {
      id,
      title,
      ...(typeof source === 'string' ? { source } : {}),
    });
  }

  async function updateConversationMode({ id, mode } = {}) {
    return requireClient().request('classic.conversations.updateMode', { id, mode });
  }

  async function updateConversationFastMode({ id, fastMode } = {}) {
    return requireClient().request('classic.conversations.updateFastMode', {
      id,
      fastMode: Boolean(fastMode),
    });
  }

  async function updateConversationPreferredExecutionIsolation({ id, preferredExecutionIsolation } = {}) {
    return requireClient().request('classic.conversations.updatePreferredExecutionIsolation', {
      id,
      preferredExecutionIsolation,
    });
  }

  async function updateConversationModelEffort({ id, effort, modelProviderId, model } = {}) {
    return requireClient().request('classic.conversations.updateModelEffort', {
      id,
      ...(effort !== undefined ? { effort } : {}),
      ...(modelProviderId !== undefined ? { modelProviderId } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  async function appendConversationMessage({ id, message } = {}) {
    return requireClient().request('classic.conversations.appendMessage', { id, message });
  }

  async function updateConversationLastMessage({ id, content } = {}) {
    return requireClient().request('classic.conversations.updateLastMessage', { id, content });
  }

  async function replaceConversationMessages({ id, messages, allowEmpty = false } = {}) {
    return requireClient().request('classic.conversations.replaceMessages', {
      id,
      messages,
      allowEmpty: Boolean(allowEmpty),
    });
  }

  async function archiveConversation({ id } = {}) {
    return requireClient().request('classic.conversations.archive', { id });
  }

  async function restoreConversation({ id } = {}) {
    return requireClient().request('classic.conversations.restore', { id });
  }

  async function pinConversation({ id } = {}) {
    return requireClient().request('classic.conversations.pin', { id });
  }

  async function unpinConversation({ id } = {}) {
    return requireClient().request('classic.conversations.unpin', { id });
  }

  async function reorderPinnedConversations({ ids } = {}) {
    return requireClient().request('classic.conversations.reorderPinned', { ids: ids || [] });
  }

  async function autoArchiveConversations({ before, excludeIds = [] } = {}) {
    return requireClient().request('classic.conversations.autoArchive', {
      before: before || '',
      excludeIds: Array.isArray(excludeIds) ? excludeIds : [],
    });
  }

  async function deleteConversation(payload) {
    const id = typeof payload === 'string' ? payload : payload?.id;
    return requireClient().request('classic.conversations.delete', { id });
  }

  async function addConversationUsage({ id, usage } = {}) {
    return requireClient().request('classic.conversations.addUsage', { id, usage: usage || {} });
  }

  async function getUsageStats(params = {}) {
    return requireClient().request('classic.usage.stats', params || {});
  }

  async function getUsageDaily(params = {}) {
    return requireClient().request('classic.usage.daily', {
      ...(params?.range ? { range: params.range } : {}),
      ...(params?.now ? { now: params.now } : {}),
      localOffsetMinutes: params?.localOffsetMinutes ?? -new Date().getTimezoneOffset(),
    });
  }

  async function getUsageDay(params = {}) {
    return requireClient().request('classic.usage.day', {
      ...(params?.date ? { date: params.date } : {}),
      ...(params?.now ? { now: params.now } : {}),
      localOffsetMinutes: params?.localOffsetMinutes ?? -new Date().getTimezoneOffset(),
    });
  }

  async function getUsageCacheHitRate() {
    return requireClient().request('classic.usage.cacheHitRate', {});
  }

  async function listSkills(workspacePaths, { activeWorkspace = null } = {}) {
    return requireClient().request('classic.skills.list', {
      ...(Array.isArray(workspacePaths) ? { workspacePaths } : {}),
      ...(activeWorkspace ? { activeWorkspace } : {}),
    });
  }

  async function getSkillDetail(skillId, workspacePath, { activeWorkspace = null } = {}) {
    return requireClient().request('classic.skills.getDetail', {
      skillId,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(activeWorkspace ? { activeWorkspace } : {}),
    });
  }

  async function enableSkill(skillId, workspacePath, { activeWorkspace = null } = {}) {
    return requireClient().request('classic.skills.enable', {
      skillId,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(activeWorkspace ? { activeWorkspace } : {}),
    });
  }

  async function disableSkill(skillId, workspacePath, { activeWorkspace = null } = {}) {
    return requireClient().request('classic.skills.disable', {
      skillId,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(activeWorkspace ? { activeWorkspace } : {}),
    });
  }

  async function listAvailableSkills({ sourceRoots = [] } = {}) {
    return requireClient().request('classic.skills.listAvailable', { sourceRoots });
  }

  async function linkSkill(skillId, { sourceRoots = [] } = {}) {
    return requireClient().request('classic.skills.link', { skillId, sourceRoots });
  }

  async function unlinkSkill(skillId) {
    return requireClient().request('classic.skills.unlink', { skillId });
  }

  async function uninstallSkill(skillId, workspacePath, { activeWorkspace = null } = {}) {
    return requireClient().request('classic.skills.uninstall', {
      skillId,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(activeWorkspace ? { activeWorkspace } : {}),
    });
  }

  async function listInstalledMcp() {
    return requireClient().request('classic.mcp.listInstalled', {});
  }

  async function listMcpCapabilities() {
    return requireClient().request('classic.mcp.listCapabilities', {});
  }

  async function listMcpCredentials() {
    return requireClient().request('classic.mcp.listCredentials', {});
  }

  async function upsertMcpServer(item) {
    return requireClient().request('classic.mcp.upsertServer', item || {});
  }

  async function installMcpServer(item) {
    return requireClient().request('classic.mcp.install', item || {});
  }

  async function uninstallMcpServer(serverId) {
    return requireClient().request('classic.mcp.uninstall', { serverId });
  }

  async function setMcpEnabled(serverId, enabled) {
    return requireClient().request('classic.mcp.setEnabled', {
      serverId,
      enabled: Boolean(enabled),
    });
  }

  async function setMcpToolVisibility(serverId, toolName, visible) {
    return requireClient().request('classic.mcp.setToolVisibility', {
      serverId,
      toolName,
      visible: Boolean(visible),
    });
  }

  async function listLlmCatalog() {
    return requireClient().request('classic.llm.catalog', {});
  }

  async function completeLlmPrompt(params = {}) {
    return requireClient().request('classic.llm.complete', params || {}, { timeoutMs: 60_000 });
  }

  async function fetchLlmQuota(id) {
    return requireClient().request('classic.llm.quota', { id }, { timeoutMs: 25_000 });
  }

  async function projectMemoryList(params = {}) {
    return requireClient().request('project.memory.list', params || {});
  }

  async function projectMemoryPin(params = {}) {
    return requireClient().request('project.memory.pin', params || {});
  }

  async function projectMemoryForget(params = {}) {
    return requireClient().request('project.memory.forget', params || {});
  }

  async function projectMemoryRestore(params = {}) {
    return requireClient().request('project.memory.restore', params || {});
  }

  async function projectMemoryEdit(params = {}) {
    return requireClient().request('project.memory.edit', params || {});
  }

  async function projectMemorySetSwitches(params = {}) {
    return requireClient().request('project.memory.setSwitches', params || {});
  }

  async function projectObjectivesList(params = {}) {
    return requireClient().request('project.objectives.list', params || {});
  }

  async function projectObjectivesUpdate(params = {}) {
    return requireClient().request('project.objectives.update', params || {});
  }

  async function projectObjectivesPause(params = {}) {
    return requireClient().request('project.objectives.pause', params || {});
  }

  async function projectObjectivesResume(params = {}) {
    return requireClient().request('project.objectives.resume', params || {});
  }

  async function projectObjectivesDelete(params = {}) {
    return requireClient().request('project.objectives.delete', params || {});
  }

  async function projectProfileReadUnknownOutcomePolicy(params = {}) {
    return requireClient().request('project.profile.readUnknownOutcomePolicy', params || {});
  }

  async function projectProfileSetUnknownOutcomePolicy(params = {}) {
    return requireClient().request('project.profile.setUnknownOutcomePolicy', params || {});
  }

  async function projectProfileReadAvatar(params = {}) {
    return requireClient().request('project.profile.readAvatar', params || {});
  }

  async function projectProfileUpdate(params = {}) {
    return requireClient().request('project.profile.update', params || {});
  }

  async function projectAccessRead(params = {}) {
    return requireClient().request('project.access.read', params || {});
  }

  async function projectAccessUpdate(params = {}) {
    return requireClient().request('project.access.update', params || {});
  }

  async function projectBotMarkRead(params = {}) {
    return requireClient().request('project.bot.markRead', params || {});
  }

  async function projectBotListApprovals(params = {}) {
    return requireClient().request('project.bot.listApprovals', params || {});
  }

  async function projectBotListHistory(params = {}) {
    return requireClient().request('project.bot.listHistory', params || {});
  }

  async function projectBotSearch(params = {}) {
    return requireClient().request('project.bot.search', params || {});
  }

  async function projectBotDiagnostics(params = {}) {
    return requireClient().request('project.bot.diagnostics', params || {});
  }

  async function projectBotContinueHistory(params = {}) {
    return requireClient().request('project.bot.continueHistory', params || {});
  }

  async function projectBotReadInputDraft(params = {}) {
    return requireClient().request('project.bot.readInputDraft', params || {});
  }

  async function projectBotWriteInputDraft(params = {}) {
    return requireClient().request('project.bot.writeInputDraft', params || {});
  }

  async function projectBotReadEvidence(params = {}) {
    return requireClient().request('project.bot.readEvidence', params || {});
  }

  async function projectBotList(params = {}) {
    return requireClient().request('project.bot.list', params || {});
  }

  async function projectBotListAttention(params = {}) {
    return requireClient().request('project.bot.listAttention', params || {});
  }

  async function projectBotGet(params = {}) {
    return requireClient().request('project.bot.get', params || {});
  }

  async function projectBotListObligationGrants(params = {}) {
    return requireClient().request('project.bot.listObligationGrants', params || {});
  }

  async function projectBotReadConversation(params = {}) {
    return requireClient().request('project.bot.readConversation', params || {});
  }

  async function projectBotListSessions(params = {}) {
    return requireClient().request('project.bot.listSessions', params || {});
  }

  async function projectBotGetSession(params = {}) {
    return requireClient().request('project.bot.getSession', params || {});
  }

  function configureProjectBotHost(params = {}) {
    const mySeq = ++botHostConfigureSeq;
    projectBotHostDesiredEnabled = params?.enabled === true;
    const run = async () => {
      try {
        const res = await requireClient().request('project.bot.hostConfigure', params || {}, { timeoutMs: 60_000 });
        applyProjectBotHostStatus(res, null);
        if (res?.enabled !== true) {
          if (mySeq === botHostConfigureSeq) {
            projectBotHostDesiredEnabled = false;
          }
          clearBotHostCaches();
        }
        onProjectBotHostStateChanged?.({ active: projectBotHostActive, reason: 'configure' });
        return res;
      } catch (err) {
        if (mySeq === botHostConfigureSeq) {
          projectBotHostDesiredEnabled = projectBotHostActive;
        }
        throw err;
      }
    };
    const next = botHostConfigureQueue.then(run, run);
    botHostConfigureQueue = next.catch(() => {});
    return next;
  }

  async function projectBotHostStatus(params = {}) {
    const res = await requireClient().request('project.bot.hostStatus', params || {});
    applyProjectBotHostStatus(res, typeof params?.workspaceId === 'string' ? params.workspaceId : null);
    return res;
  }

  async function projectBotCreate(params = {}) {
    const res = await requireClient().request('project.bot.create', params || {}, { timeoutMs: 60_000 });
    if (res?.ok && res?.workspaceId && projectBotHostActive) {
      botOwnedWorkspaces.add(res.workspaceId);
      botRecoveryStatus.set(res.workspaceId, { status: 'ready' });
      void projectBotHostStatus({ workspaceId: res.workspaceId }).catch(() => {});
    }
    return res;
  }

  async function projectBotDelete(params = {}) {
    const res = await requireClient().request('project.bot.delete', params || {}, { timeoutMs: 60_000 });
    if ((res?.ok || res?.archived) && typeof params?.workspaceId === 'string') {
      botOwnedWorkspaces.delete(params.workspaceId);
      botActivities.delete(params.workspaceId);
      botAgentStatuses.delete(params.workspaceId);
      botRecoveryStatus.delete(params.workspaceId);
      botRecoveryAttention.delete(params.workspaceId);
    }
    return res;
  }

  async function projectBotSubmitInput(params = {}) {
    return requireClient().request('project.bot.submitInput', params || {});
  }

  async function projectBotStopResponse(params = {}) {
    return requireClient().request('project.bot.stopResponse', params || {});
  }

  async function projectBotCancelSession(params = {}) {
    return requireClient().request('project.bot.cancelSession', params || {});
  }

  async function projectBotResumeSession(params = {}) {
    return requireClient().request('project.bot.resumeSession', params || {});
  }

  async function projectBotDecideObligation(params = {}) {
    return requireClient().request('project.bot.decideObligation', params || {}, { timeoutMs: 60_000 });
  }

  async function projectBotRequestClaimClosure(params = {}) {
    return requireClient().request('project.bot.requestClaimClosure', params || {}, { timeoutMs: 60_000 });
  }

  async function projectBotDecideApproval(params = {}) {
    return requireClient().request('project.bot.decideApproval', params || {}, { timeoutMs: 60_000 });
  }

  async function projectBotStartFamiliarize(params = {}) {
    return requireClient().request('project.bot.startFamiliarize', params || {}, { timeoutMs: 60_000 });
  }

  async function projectBotConfirmResult(params = {}) {
    return requireClient().request('project.bot.confirmResult', params || {});
  }

  async function projectBotAcceptReadme(params = {}) {
    return requireClient().request('project.bot.acceptReadme', params || {}, { timeoutMs: 60_000 });
  }

  async function projectBotRetry(params = {}) {
    return requireClient().request('project.bot.retry', params || {}, { timeoutMs: 60_000 });
  }

  async function projectBotTakeoverHost(params = {}) {
    const res = await requireClient().request('project.bot.takeoverHost', params || {});
    if (res?.ok && typeof params?.workspaceId === 'string') {
      if (res.acquired || res.alreadyHost) {
        botOwnedWorkspaces.add(params.workspaceId);
      }
      scheduleProjectBotHostStatusRefresh();
    }
    return res;
  }

  async function projectBotRecovery(params = {}) {
    const res = await requireClient().request('project.bot.recovery', params || {}, { timeoutMs: 60_000 });
    if (res?.ok && typeof params?.workspaceId === 'string' && params?.action !== 'inspect') {
      botRecoveryStatus.set(params.workspaceId, { status: 'ready' });
      botRecoveryAttention.set(params.workspaceId, false);
    }
    return res;
  }

  async function projectBotWake(workspaceId) {
    return requireClient().request('project.bot.wake', { workspaceId });
  }

  async function getDaemonStatus() {
    return requireClient().request('core.daemon.status', {});
  }

  return Object.freeze({
    isAvailable,
    isProjectBotHostActive,
    isProjectBotHostOwnedOrPending,
    isProjectBotWorkspaceOnline,
    readProjectBotActivity,
    readProjectBotAgentStatus,
    readProjectBotRecovery,
    needsProjectBotRecoveryAttention,
    canHandleChatSend,
    canHandleGoalPlan,
    ownsGoalPlan,
    ownsStream,
    ownsPermission,
    send,
    abort,
    reattach,
    listActiveSync,
    getActiveStreamsForConversation,
    forceCompleteConversationStreams,
    compact,
    resolvePermissionGrant,
    setLocalAccessLevel,
    startGoalRunner,
    resumeGoalRunner,
    pauseGoalRunner,
    clearGoalRunner,
    getGoalRunnerState,
    listConversations,
    searchConversations,
    createConversation,
    getConversation,
    updateConversationTitle,
    updateConversationMode,
    updateConversationFastMode,
    updateConversationPreferredExecutionIsolation,
    updateConversationModelEffort,
    appendConversationMessage,
    updateConversationLastMessage,
    replaceConversationMessages,
    archiveConversation,
    restoreConversation,
    pinConversation,
    unpinConversation,
    reorderPinnedConversations,
    autoArchiveConversations,
    deleteConversation,
    addConversationUsage,
    getUsageStats,
    getUsageDaily,
    getUsageDay,
    getUsageCacheHitRate,
    listSkills,
    getSkillDetail,
    enableSkill,
    disableSkill,
    listAvailableSkills,
    linkSkill,
    unlinkSkill,
    uninstallSkill,
    listInstalledMcp,
    listMcpCapabilities,
    listMcpCredentials,
    upsertMcpServer,
    installMcpServer,
    uninstallMcpServer,
    setMcpEnabled,
    setMcpToolVisibility,
    listLlmCatalog,
    completeLlmPrompt,
    fetchLlmQuota,
    projectMemoryList,
    projectMemoryPin,
    projectMemoryForget,
    projectMemoryRestore,
    projectMemoryEdit,
    projectMemorySetSwitches,
    projectObjectivesList,
    projectObjectivesUpdate,
    projectObjectivesPause,
    projectObjectivesResume,
    projectObjectivesDelete,
    projectProfileReadUnknownOutcomePolicy,
    projectProfileSetUnknownOutcomePolicy,
    projectProfileReadAvatar,
    projectProfileUpdate,
    projectAccessRead,
    projectAccessUpdate,
    projectBotMarkRead,
    projectBotListApprovals,
    projectBotListHistory,
    projectBotSearch,
    projectBotDiagnostics,
    projectBotContinueHistory,
    projectBotReadInputDraft,
    projectBotWriteInputDraft,
    projectBotReadEvidence,
    projectBotList,
    projectBotListAttention,
    projectBotGet,
    projectBotListObligationGrants,
    projectBotReadConversation,
    projectBotListSessions,
    projectBotGetSession,
    configureProjectBotHost,
    projectBotHostStatus,
    projectBotCreate,
    projectBotDelete,
    projectBotSubmitInput,
    projectBotStopResponse,
    projectBotCancelSession,
    projectBotResumeSession,
    projectBotDecideObligation,
    projectBotRequestClaimClosure,
    projectBotDecideApproval,
    projectBotStartFamiliarize,
    projectBotConfirmResult,
    projectBotAcceptReadme,
    projectBotRetry,
    projectBotTakeoverHost,
    projectBotRecovery,
    projectBotWake,
    getDaemonStatus,
    handleNotification,
    handleUnexpectedExit,
    createHostHandlers,
  });
}
