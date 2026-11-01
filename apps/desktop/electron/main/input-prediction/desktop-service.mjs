import { createHmac, randomBytes } from 'node:crypto';
import { assembleSystemContext, createPromptSourceRegistry, createInputPredictionPromptSource,
  createProjectInstructionsPromptSource } from '@peer-agent/system-context';
import { createInputPredictionService, createProviderTextInference, resolveRoleRoute } from '@peer-agent/runtime-node/models';
import { createUsageRequestLog } from '../usage-request-log.mjs';
import { resolveProviderCredential } from '../provider-credential-resolver.mjs';
import { resolveChannel } from '../provider-channels.mjs';
import { createInputPredictionBudget } from './usage-budget.mjs';
import { normalizeInputPredictionSettings } from '@peer-agent/protocol';

function publicHistory(history) {
  const messages = (history?.messages ?? []).flatMap(message => {
    const kind = message.kind;
    if (kind && kind !== 'user_input' && kind !== 'agent_reply') return [];
    if (!['user', 'assistant'].includes(message.role) && !['user_input', 'agent_reply'].includes(kind)) return [];
    if (message.toolCalls?.length || message.tool_calls?.length || message.meta?.surfacing === 'silent') return [];
    const content = typeof message.content === 'string' ? message.content : message.text;
    if (typeof content !== 'string' || !content.trim()) return [];
    return [{ id: message.id, role: kind === 'user_input' || message.role === 'user' ? 'user' : 'assistant', content,
      incomplete: Boolean(message.error || message.aborted || ['error', 'aborted', 'stopped'].includes(message.status)) }];
  });
  const recent = messages.slice(-8), first = messages.find(message => message.role === 'user');
  if (first && recent.length === 8 && !recent.includes(first)) recent.splice(0, 1, first);
  return { messages: recent, quoteSources: recent.map(row => ({ id: row.id, content: row.content })) };
}

/** Desktop ports supply identity, public history and credentials; no renderer facts grant access. */
export function createDesktopInputPrediction({ getSettings, listModels, conversationStore, getProjectAgent,
  isBusy = () => false, trustedWindows, fetchImpl, llmConfigStore, usageLog = createUsageRequestLog(), now = Date.now }) {
  const secret = randomBytes(32), senders = new Map(), failures = new Map();
  const budget = createInputPredictionBudget({ log: usageLog, now });
  const registry = createPromptSourceRegistry({ sources: [createInputPredictionPromptSource(), createProjectInstructionsPromptSource()] });
  const readHistory = conversationStore.createHistoryProjection?.(publicHistory, {
    immutableInput: true, immutableOutput: true, maxEntries: 64, maxBytes: 256 * 1024,
  }) ?? (id => publicHistory(conversationStore.getPersistedConversationHistory(id)));
  function readSnapshot(request) {
    const settings = getSettings();
    const meta = conversationStore.listConversations({ roles: ['default', 'project_agent', 'work_session'], includeMessageCount: false })
      .find(row => row.id === request.conversationId);
    if (!meta || meta.status === 'archived' || meta.role === 'work_session') return null;
    const bot = getProjectAgent()?.projectAccess?.directory?.get(request.workspaceId);
    let workspacePath, policy;
    if (request.surface === 'desktop_bot') {
      if (!bot?.ok || bot.profile.agentConversationId !== request.conversationId) return null;
      workspacePath = bot.path; policy = bot.profile.modelPolicy;
      const activity = getProjectAgent()?.host?.runnerFor?.(request.workspaceId)?.activity?.();
      if (bot.item?.state?.needsYou > 0 || activity && !['done', 'error', 'stopped', 'disposed'].includes(activity.phase)) return { blocked: true, reason: 'decision_or_reply' };
    } else {
      if (meta.role && meta.role !== 'default') return null;
      const workspace = settings.workspaces?.find(row => row.id === request.workspaceId && row.path === meta.workspacePath);
      if (!workspace) return null;
      workspacePath = workspace.path;
      policy = bot?.ok ? bot.profile.modelPolicy : undefined;
      if (bot?.ok && bot.item?.state?.needsYou > 0) return { blocked: true, reason: 'decision' };
    }
    if (!workspacePath || isBusy(request.conversationId)) return { blocked: true, reason: 'replying' };
    const history = readHistory(request.conversationId);
    if (!history?.messages?.length || history.messages.at(-1)?.incomplete) return null;
    const explicit = policy?.overrides?.input_predictor ?? settings.modelRouting?.roles?.input_predictor;
    if (!explicit) return { blocked: true, reason: 'model_unconfigured' };
    const routing = settings.modelRouting ?? {};
    const resolved = resolveRoleRoute({ role: 'input_predictor', providers: listModels(), routing,
      projectPolicy: policy, requiredContextTokens: 4096 });
    const provider = resolved.ok ? listModels().find(row => row.id === resolved.selection.modelProviderId) : null;
    const route = resolved.ok && provider ? { ...resolved, provider, routing } : resolved;
    const quote = request.quoteMessageId ? history.quoteSources.find(row => row.id === request.quoteMessageId) : null;
    if (request.quoteMessageId && !quote) return null;
    const context = assembleSystemContext({ workspacePath, conversationId: request.conversationId,
      mode: 'input_prediction', configInstructions: [settings.systemInstructions, bot?.profile?.customInstructions].filter(Boolean) }, { registry });
    const token = createHmac('sha256', secret).update(JSON.stringify([meta.contentRevision, history.messages,
      quote, policy, settings.inputPrediction, routing, provider, context.snapshot.renderedHash])).digest('hex');
    return { settings, route, messages: history.messages, quote, token, context };
  }
  const service = createInputPredictionService({ readSnapshot, now,
    assemble: snapshot => snapshot.context,
    budget,
    infer: createProviderTextInference({ resolveCredential: (provider, signal) => llmConfigStore.resolveCredentialAsync
      ? llmConfigStore.resolveCredentialAsync(provider, signal) : resolveProviderCredential({ provider, llmConfigStore }),
      resolveChannel, fetchImpl }),
  });
  function owner(sender) {
    if (!sender || sender.isDestroyed?.() || trustedWindows.getRole(sender) !== 'main') throw new Error('UNTRUSTED_PREDICTION_SENDER');
    if (!senders.has(sender.id)) {
      const dispose = () => { service.cancelOwner(sender.id); senders.delete(sender.id); };
      sender.once?.('destroyed', dispose); senders.set(sender.id, { sender, dispose });
    }
    return sender.id;
  }
  const stop = conversationStore.subscribeChanges?.(event => { if (event.changeType === 'messages-updated') service.preempt(); });
  return {
    async request(request, sender) {
      const id = owner(sender), result = await service.request(id, request);
      failures.set(id, result.kind === 'error'); return result;
    },
    cancel: (reference, sender) => service.cancel(owner(sender), reference ?? {}),
    validate: (reference, sender) => service.validate(owner(sender), reference ?? {}),
    status(sender) {
      const id = owner(sender), settings = getSettings(), config = normalizeInputPredictionSettings(settings.inputPrediction);
      const day = budget.summary();
      const configured = settings.modelRouting?.roles?.input_predictor && resolveRoleRoute({ role: 'input_predictor',
        providers: listModels(), routing: settings.modelRouting, requiredContextTokens: 4096 }).ok;
      const reason = !config.enabled ? 'disabled' : !configured ? 'model_unconfigured'
        : !day.complete ? 'usage_unavailable' : day.requests >= config.dailyRequestLimit || day.tokens + 4224 > config.dailyTokenLimit
          ? 'budget' : failures.get(id) ? 'provider_error' : 'ready';
      return { reason, requests: day.requests, tokens: day.tokens, estimated: day.estimated };
    },
    preempt: service.preempt,
    dispose() { stop?.(); service.dispose(); for (const { sender, dispose } of senders.values()) sender.removeListener?.('destroyed', dispose); senders.clear(); failures.clear(); },
  };
}
