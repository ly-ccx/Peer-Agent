import {
  buildAnthropicTools,
  buildOpenAITools,
  buildSystemContext,
  buildSystemPrompt,
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
import { hasDanglingToolIntent, hasUnsupportedToolClaim } from './chat-runtime/response-guard.mjs';
import { createToolContext } from './chat-runtime/tool-orchestrator.mjs';

const activeStreams = new Map();
const permissionGate = createChatPermissionGate({ activeStreams });
const conversationToolContexts = new Map();
let activeWorkspacePath = null;

const TOOLS_OPENAI = buildOpenAITools();
const TOOLS_ANTHROPIC = buildAnthropicTools();

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
  persistCompaction = null,
  promptSnapshotStore = null,
}) {
  function setWorkspacePath(wsPath) { activeWorkspacePath = wsPath; }

  function getDefaultProvider() {
    const providers = llmConfigStore.listProviders();
    return providers.find((p) => p.isDefault && p.apiKeyConfigured) || providers.find((p) => p.apiKeyConfigured) || null;
  }

  async function sendMessage({
    messages,
    webContents,
    streamId,
    effort = 'default',
    conversationId = null,
    attachmentContext = [],
    continuityContext = [],
    configInstructions = [],
    contextExtensions = [],
  }) {
    const provider = getDefaultProvider();
    if (!provider) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return;
    }

    const apiKey = llmConfigStore.getDecryptedApiKey(provider.id);
    if (!apiKey) {
      webContents.send('chat:stream:error', { streamId, error: 'api_key_not_found' });
      return;
    }

    const controller = new AbortController();
    activeStreams.set(streamId, { controller, webContents, permissionIds: new Set() });

    const systemContext = buildSystemContext(activeWorkspacePath, {
      attachmentContext,
      configInstructions,
      contextExtensions,
      continuityContext,
      conversationId,
      effort,
      mode: 'chat',
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
      mode: 'chat',
    });
    const toolContext = getConversationToolContext({ conversationId, workspacePath: activeWorkspacePath });

    const contextWindow = provider.contextWindow || 0;

    try {
      if (provider.provider === 'anthropic') {
        await agentLoopAnthropic({
          baseUrl: provider.baseUrl,
          apiKey,
          model: provider.model,
          systemPrompt,
          messages,
          tools: TOOLS_ANTHROPIC,
          webContents,
          streamId,
          signal: controller.signal,
          effort,
          contextWindow,
          conversationId,
          persistCompaction,
          continuityContext,
          toolContext,
          workspacePath: activeWorkspacePath,
          permissionGate,
        });
      } else {
        await agentLoopOpenAI({
          baseUrl: provider.baseUrl,
          apiKey,
          model: provider.model,
          systemPrompt,
          messages,
          tools: TOOLS_OPENAI,
          webContents,
          streamId,
          signal: controller.signal,
          effort,
          contextWindow,
          conversationId,
          persistCompaction,
          continuityContext,
          toolContext,
          workspacePath: activeWorkspacePath,
          permissionGate,
        });
      }
    } catch (err) {
      console.error('[llm-chat] error:', err);
      if (err?.name !== 'AbortError') {
        webContents.send('chat:stream:error', { streamId, error: err?.message || 'stream_failed' });
      }
    } finally {
      permissionGate.settleStreamPermissionRequests(streamId, {
        granted: false,
        reason: 'stream_finished',
      });
      activeStreams.delete(streamId);
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
    return { aborted: true };
  }

  function resolvePermissionGrant(toolCallId, grant) {
    return permissionGate.settlePermissionRequest(toolCallId, grant);
  }

  return { sendMessage, abort, setWorkspacePath, resolvePermissionGrant };
}
