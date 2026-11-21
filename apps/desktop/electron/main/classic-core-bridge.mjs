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
  logger = console,
} = {}) {
  const activeStreams = new Map();
  const pendingPermissions = new Map();

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

  function canHandleChatSend({ mode = 'chat', hasActiveGoal = false } = {}) {
    if (!isAvailable()) return false;
    if (hasActiveGoal) return false;
    const normalized = mode || 'chat';
    return normalized === 'chat' || normalized === 'plan';
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
    if (method === 'chat:stream:active-changed' || method === 'chat:stream:compaction') {
      broadcast?.(method, params);
      return;
    }

    if (!STREAM_FORWARD_CHANNELS.has(method)) return;

    const streamId = params?.streamId;
    const record = typeof streamId === 'string' ? activeStreams.get(streamId) : null;

    if (method === 'chat:stream:delta' && record && typeof params?.content === 'string') {
      record.accumulatedText += params.content;
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
        aborted: true,
      });
    }
  }

  function handleUnexpectedExit() {
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
      webContents,
      startedAt: Date.now(),
      accumulatedText: '',
      resolve: resolveOutcome,
    };
    activeStreams.set(streamId, record);

    try {
      const reminders = Array.isArray(params.runtimeReminders)
        ? params.runtimeReminders
            .filter((r) => typeof r?.id === 'string' && typeof r?.content === 'string')
            .map((r) => ({ id: r.id, content: r.content }))
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

  return Object.freeze({
    isAvailable,
    canHandleChatSend,
    ownsStream,
    ownsPermission,
    send,
    abort,
    reattach,
    listActiveSync,
    compact,
    resolvePermissionGrant,
    setLocalAccessLevel,
    handleNotification,
    handleUnexpectedExit,
    createHostHandlers,
  });
}
