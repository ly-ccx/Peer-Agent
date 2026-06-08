import { randomUUID } from 'node:crypto';
import { resolveCloudEndpointConfig } from './cloud-endpoint-config.mjs';
import {
  buildClientRuntimeChatContext,
  mergeClientRuntimeSourceMetadata,
} from './client-runtime-chat-context.mjs';

const DEFAULT_CHAT_TIMEOUT_MS = 30000;
const LEGACY_IDENTITY_KEYS = new Set([
  'accountId',
  'empId',
  'employeeId',
  'loginId',
  'operatorWorkId',
  'ownerWorkId',
  'updatedBy',
  'userId',
  'workId',
  'work_id',
]);

function requireEndpointUrl(config, kind) {
  const url = kind === 'stream' ? config.streamUrl : config.gatewayUrl;
  if (url) return url;
  throw new Error(
    config.developerMode
      ? `Developer ${kind} endpoint is not configured.`
      : `Cloud ${kind} endpoint is not configured.`,
  );
}

function buildUrlFromBase(base, pathname) {
  return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function formAccessMode(accessMode) {
  return accessMode === 'share' || accessMode === 'superpower' ? accessMode : undefined;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function createTimeoutSignal(timeoutMs = DEFAULT_CHAT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Cloud chat request timed out.')), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function readJsonResponse(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.error || json?.errorCode) {
    const message = json?.error_description ?? json?.errorMsg ?? json?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json;
}

function stripLegacyIdentity(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !LEGACY_IDENTITY_KEYS.has(key)),
  );
}

function normalizeDeleteMessageParams(params = {}) {
  const stripped = stripLegacyIdentity(params);
  if (!stripped.uuid && stripped.messageUuid) {
    return {
      ...stripped,
      uuid: stripped.messageUuid,
    };
  }
  return stripped;
}

function unwrapCloudData(envelope, fallbackMessage) {
  if ((envelope?.code === 0 || envelope?.success === true) && envelope.data !== undefined) {
    return envelope.data;
  }
  const message = envelope?.errorMsg ?? envelope?.error ?? envelope?.message ?? fallbackMessage;
  throw new Error(message);
}

function createSseState() {
  return {
    buffer: '',
    eventName: '',
    eventId: undefined,
    retry: undefined,
    dataLines: [],
  };
}

function parseEventData(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === '[DONE]') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function dispatchSseEvent(state) {
  if (state.dataLines.length === 0) return null;
  return {
    event: state.eventName || 'message',
    data: parseEventData(state.dataLines.join('\n')),
    ...(state.eventId ? { id: state.eventId } : {}),
    ...(typeof state.retry === 'number' ? { retry: state.retry } : {}),
  };
}

function resetSseFrame(state) {
  return {
    ...state,
    eventName: '',
    dataLines: [],
  };
}

function applySseLine(state, line) {
  if (line === '') {
    return {
      state: resetSseFrame(state),
      event: dispatchSseEvent(state),
    };
  }

  if (line.startsWith(':')) {
    return { state, event: null };
  }

  const separator = line.indexOf(':');
  const field = separator >= 0 ? line.slice(0, separator) : line;
  const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

  if (field === 'event') return { state: { ...state, eventName: value }, event: null };
  if (field === 'id') return { state: { ...state, eventId: value }, event: null };
  if (field === 'retry') {
    const retry = Number(value);
    return {
      state: Number.isFinite(retry) ? { ...state, retry } : state,
      event: null,
    };
  }
  if (field === 'data') {
    return { state: { ...state, dataLines: [...state.dataLines, value] }, event: null };
  }

  return { state, event: null };
}

function parseSseChunk(state, chunk) {
  const text = state.buffer + chunk;
  const lines = text.split(/\r?\n/);
  const buffer = lines.pop() ?? '';
  let nextState = { ...state, buffer };
  const events = [];

  for (const line of lines) {
    const result = applySseLine(nextState, line);
    nextState = result.state;
    if (result.event) events.push(result.event);
  }

  return { state: nextState, events };
}

function flushSseState(state) {
  let nextState = state;
  const events = [];
  if (nextState.buffer) {
    const result = applySseLine({ ...nextState, buffer: '' }, nextState.buffer);
    nextState = result.state;
    if (result.event) events.push(result.event);
  }
  const pending = dispatchSseEvent(nextState);
  if (pending) events.push(pending);
  return events;
}

function normalizeStreamEvent(event) {
  if (event.data === null) {
    return { ...event, event: 'complete', data: {} };
  }

  if (event.event === 'message' && event.data && typeof event.data === 'object') {
    if (typeof event.data.type === 'string' && 'payload' in event.data) {
      return {
        ...event,
        event: event.data.type,
        data: event.data.payload,
      };
    }

    if (typeof event.data.event === 'string' && 'data' in event.data) {
      return {
        ...event,
        event: event.data.event,
        data: event.data.data,
      };
    }
  }

  return event;
}

export function createCloudChatService({
  getAccessToken,
  getEndpointConfig = () => resolveCloudEndpointConfig(),
  getSession = () => null,
  buildRuntimeProjection = () => null,
}) {
  const activeStreams = new Map();
  let lastRequestDiagnostic = null;

  function resolveEndpointConfig() {
    return getEndpointConfig();
  }

  function buildUrl(pathname) {
    return buildUrlFromBase(requireEndpointUrl(resolveEndpointConfig(), 'gateway'), pathname);
  }

  function buildStreamUrl(pathname) {
    return buildUrlFromBase(requireEndpointUrl(resolveEndpointConfig(), 'stream'), pathname);
  }

  function recordRequest(diagnostic) {
    lastRequestDiagnostic = {
      ...diagnostic,
      checkedAt: new Date().toISOString(),
    };
  }

  function requestDiagnostic() {
    return lastRequestDiagnostic;
  }

  async function buildHeaders(options = {}) {
    const token = await getAccessToken();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-zeus-atlas-client': 'desktop',
    };
    const accessMode = formAccessMode(options.accessMode);
    if (accessMode) headers['x-xiaoer-access-mode'] = accessMode;
    return headers;
  }

  async function requestJson(pathname, body, options = {}) {
    const timeout = createTimeoutSignal(options.timeoutMs);
    const urlBuilder = options.urlBuilder ?? buildUrl;
    const endpointConfig = resolveEndpointConfig();
    const method = options.method ?? 'POST';
    const url = urlBuilder(pathname);
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers: await buildHeaders(options),
        body: method === 'GET' ? undefined : JSON.stringify(stripLegacyIdentity(body ?? {})),
        signal: timeout.signal,
      });
      try {
        const result = await readJsonResponse(response);
        recordRequest({
          method,
          path: pathname,
          origin: new URL(url).origin,
          url,
          status: response.status,
          durationMs: Date.now() - started,
          mode: endpointConfig.mode,
          developerMode: endpointConfig.developerMode,
          source: endpointConfig.source,
        });
        return result;
      } catch (error) {
        recordRequest({
          method,
          path: pathname,
          origin: new URL(url).origin,
          url,
          status: response.status,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          mode: endpointConfig.mode,
          developerMode: endpointConfig.developerMode,
          source: endpointConfig.source,
        });
        throw error;
      }
    } catch (error) {
      if (error?.name !== 'AbortError' && lastRequestDiagnostic?.url === url) {
        throw error;
      }
      recordRequest({
        method,
        path: pathname,
        origin: (() => {
          try {
            return new URL(url).origin;
          } catch {
            return undefined;
          }
        })(),
        url,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        mode: endpointConfig.mode,
        developerMode: endpointConfig.developerMode,
        source: endpointConfig.source,
      });
      throw error;
    } finally {
      timeout.clear();
    }
  }

  function buildQuery(params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) {
        value.forEach((item) => searchParams.append(key, String(item)));
        return;
      }
      searchParams.set(key, String(value));
    });
    const query = searchParams.toString();
    return query ? `?${query}` : '';
  }

  async function requestGet(pathname, params) {
    return requestJson(`${pathname}${buildQuery(stripLegacyIdentity(params))}`, undefined, { method: 'GET' });
  }

  async function listConversations(params) {
    return requestJson('/api/chat/conversations/list/authenticated', stripLegacyIdentity(params));
  }

  async function createConversation(params) {
    return requestJson('/api/chat/conversations/create/authenticated', stripLegacyIdentity(params));
  }

  async function getConversationDetail(params) {
    return requestJson('/api/chat/conversations/detail/authenticated', stripLegacyIdentity(params));
  }

  async function deleteConversation(params) {
    return requestJson('/api/chat/conversations/delete/authenticated', stripLegacyIdentity(params));
  }

  async function branchFromMessage(params) {
    return requestJson('/api/chat/conversations/branch-from-message/authenticated', stripLegacyIdentity(params));
  }

  async function getMessages(params) {
    return requestJson('/api/chat/messages/list/authenticated', stripLegacyIdentity(params));
  }

  async function getMessageDetail(params) {
    return requestJson('/api/chat/messages/detail/authenticated', stripLegacyIdentity(params));
  }

  async function buildMessageContext(params) {
    return requestJson('/api/chat/messages/context/authenticated', stripLegacyIdentity(params));
  }

  async function getLastMessage(params) {
    return requestJson('/api/chat/messages/last/authenticated', stripLegacyIdentity(params));
  }

  async function deleteMessage(params) {
    return requestJson('/api/chat/messages/delete/authenticated', normalizeDeleteMessageParams(params));
  }

  async function truncateAfterMessage(params) {
    return requestJson('/api/chat/messages/truncate-after/authenticated', stripLegacyIdentity(params));
  }

  async function cancelStream(params) {
    return requestJson('/api/chat/messages/cancel/authenticated', stripLegacyIdentity(params));
  }

  async function confirmExecution(params) {
    return requestJson('/api/react-agent/execution/confirm/authenticated', stripLegacyIdentity(params));
  }

  async function getExecutionStatus(params) {
    return requestJson('/api/react-agent/execution/status/authenticated', stripLegacyIdentity(params));
  }

  async function getExecutionDetail(params) {
    return requestJson('/api/react-agent/execution/detail/authenticated', stripLegacyIdentity(params));
  }

  async function getExecutionResult(params) {
    return requestJson('/api/react-agent/execution/result/authenticated', stripLegacyIdentity(params));
  }

  async function getExecutionCot(params) {
    return requestJson('/api/react-agent/execution/cot/authenticated', stripLegacyIdentity({
      includeDebug: false,
      maxTextChars: 50000,
      maxArgsChars: 4000,
      maxResultChars: 50000,
      maxToolCalls: 20,
      ...params,
    }));
  }

  async function traceExecutionSource(params) {
    return requestJson('/api/react-agent/execution/source-trace/authenticated', stripLegacyIdentity(params));
  }

  async function listExecutions(params) {
    return requestJson('/api/react-agent/execution/list/authenticated', stripLegacyIdentity(params));
  }

  async function listRelatedShadowExecutions(params) {
    return requestJson('/api/react-agent/execution/shadow-related/authenticated', stripLegacyIdentity(params));
  }

  async function cancelExecution(params) {
    return requestJson('/api/react-agent/execution/cancel/authenticated', stripLegacyIdentity(params));
  }

  async function getPendingDispatch(params) {
    const searchParams = new URLSearchParams();
    if (params?.conversationId !== undefined) {
      searchParams.set('conversationId', String(params.conversationId));
    }
    return requestJson(`/api/react-agent/dispatch/pending/authenticated?${searchParams.toString()}`, undefined, { method: 'GET' });
  }

  async function confirmDispatch(params) {
    return requestJson('/api/react-agent/dispatch/confirm/authenticated', stripLegacyIdentity(params));
  }

  async function pollExecutionEvents(params) {
    return requestJson('/api/react-agent/execution/poll/authenticated', stripLegacyIdentity(params));
  }

  async function getThinkingDetail(params) {
    return requestJson('/api/chat/messages/thinking/detail/authenticated', stripLegacyIdentity(params));
  }

  async function updateThinkingUiState(params) {
    return requestJson('/api/chat/messages/thinking/ui-state/update/authenticated', stripLegacyIdentity(params));
  }

  async function getAssistantSuggestions(params) {
    return requestJson('/api/chat/assistant/suggestions/authenticated', stripLegacyIdentity(params));
  }

  async function getInlineCompletion(params) {
    return requestJson('/api/chat/assistant/inline-completion/authenticated', stripLegacyIdentity(params));
  }

  async function getAgentById(params) {
    return requestJson('/api/xiaoerAiApi/agents/getAgentById/authenticated', stripLegacyIdentity(params));
  }

  async function listAgents(params) {
    return requestJson('/api/xiaoerAiApi/agents/getAgents/authenticated', stripLegacyIdentity(params));
  }

  async function getWorkingMemory(params) {
    return requestJson('/api/chat/messages/working-memory/authenticated', stripLegacyIdentity(params));
  }

  async function initializeWorkingMemory(params) {
    return requestJson('/api/chat/messages/working-memory/initialize/authenticated', stripLegacyIdentity(params));
  }

  async function getMemoryWikiStatus(params) {
    return requestJson('/api/chat/messages/memory/wiki/status/authenticated', stripLegacyIdentity(params));
  }

  async function listMemoryWikiPages(params) {
    return requestJson('/api/chat/messages/memory/wiki/list/authenticated', stripLegacyIdentity(params));
  }

  async function readMemoryWikiPage(params) {
    return requestJson('/api/chat/messages/memory/wiki/read/authenticated', stripLegacyIdentity(params));
  }

  async function initializeMemoryWiki(params) {
    return requestJson('/api/chat/messages/memory/wiki/initialize/authenticated', stripLegacyIdentity(params));
  }

  async function getBillingSummary(params) {
    return requestJson('/api/chat/messages/billing/summary/authenticated', stripLegacyIdentity(params));
  }

  async function getAgentDailyBilling(params) {
    return requestJson('/api/chat/messages/billing/agent-daily/authenticated', stripLegacyIdentity(params));
  }

  async function getMemoryCompileStatus(params) {
    return requestJson('/api/chat/messages/memory/compile/status/authenticated', stripLegacyIdentity(params));
  }

  async function retryMemoryCompile(params) {
    return requestJson('/api/chat/messages/memory/compile/retry/authenticated', stripLegacyIdentity(params));
  }

  async function listThinkingProcesses(params) {
    return requestJson('/api/chat/messages/thinking/list/authenticated', stripLegacyIdentity(params));
  }

  async function getThinkingByMessage(params) {
    return requestJson('/api/chat/messages/thinking/by-message/authenticated', stripLegacyIdentity(params));
  }

  async function createShare(params) {
    return requestJson('/api/chat/share/create/authenticated', stripLegacyIdentity(params));
  }

  async function listShares(params) {
    return requestJson('/api/chat/share/list/authenticated', stripLegacyIdentity(params));
  }

  async function getShareDetail(params) {
    return requestJson('/api/chat/share/detail/authenticated', stripLegacyIdentity(params));
  }

  async function continueShare(params) {
    return requestJson('/api/chat/share/continue/authenticated', stripLegacyIdentity(params));
  }

  async function revokeShare(params) {
    return requestJson('/api/chat/share/revoke/authenticated', stripLegacyIdentity(params));
  }

  async function checkAccess(params) {
    return requestJson('/api/chat/access/check/authenticated', stripLegacyIdentity(params));
  }

  async function updateSpectatorConfig(params) {
    return requestJson('/api/chat/access/conversation/updateSpectatorConfig/authenticated', stripLegacyIdentity(params));
  }

  async function createConversationAuth(params) {
    return requestJson('/api/chat/access/conversation/createAuth/authenticated', stripLegacyIdentity(params));
  }

  async function getConversationAuthDetail(params) {
    return requestJson('/api/chat/access/conversation/authDetail/authenticated', stripLegacyIdentity(params));
  }

  async function updateConversationAuthMembers(params) {
    return requestJson('/api/chat/access/conversation/updateAuthMembers/authenticated', stripLegacyIdentity(params));
  }

  async function listAuthBase(params) {
    return requestJson('/api/chat/access/authBase/list/authenticated', stripLegacyIdentity(params));
  }

  async function updateShareAccess(params) {
    return requestJson('/api/chat/access/share/updateAccess/authenticated', stripLegacyIdentity(params));
  }

  async function createShareAuth(params) {
    return requestJson('/api/chat/access/share/createAuth/authenticated', stripLegacyIdentity(params));
  }

  async function getShareAuthDetail(params) {
    return requestJson('/api/chat/access/share/authDetail/authenticated', stripLegacyIdentity(params));
  }

  async function updateShareAuthMembers(params) {
    return requestJson('/api/chat/access/share/updateAuthMembers/authenticated', stripLegacyIdentity(params));
  }

  async function listAgentCronSessions(params) {
    return requestJson('/api/agent-cron/sessions/list/authenticated', stripLegacyIdentity(params));
  }

  async function getAgentCronSessionDetail(params) {
    return requestJson('/api/agent-cron/sessions/detail/authenticated', stripLegacyIdentity(params));
  }

  async function pauseAgentCronSession(params) {
    return requestJson('/api/agent-cron/sessions/pause/authenticated', stripLegacyIdentity(params));
  }

  async function resumeAgentCronSession(params) {
    return requestJson('/api/agent-cron/sessions/resume/authenticated', stripLegacyIdentity(params));
  }

  async function completeAgentCronSession(params) {
    return requestJson('/api/agent-cron/sessions/complete/authenticated', stripLegacyIdentity(params));
  }

  async function recoverAgentCronSessionOpenRuns(params) {
    return requestJson('/api/agent-cron/sessions/recover-open-runs/authenticated', stripLegacyIdentity(params));
  }

  async function createAgentCronSession(params) {
    return requestJson('/api/agent-cron/sessions/create/authenticated', stripLegacyIdentity(params));
  }

  async function updateAgentCronSession(params) {
    return requestJson('/api/agent-cron/sessions/update/authenticated', stripLegacyIdentity(params));
  }

  async function listAgentCronRuns(params) {
    return requestJson('/api/agent-cron/runs/list/authenticated', stripLegacyIdentity(params));
  }

  async function injectRoundTableTurn(params) {
    return requestJson('/api/roundtable/inject/authenticated', stripLegacyIdentity(params));
  }

  async function abortRoundTableTurn(params) {
    return requestJson('/api/roundtable/abort/authenticated', stripLegacyIdentity(params));
  }

  async function getRoundTableTranscript(params) {
    return requestJson('/api/roundtable/turn/transcript/authenticated', stripLegacyIdentity(params));
  }

  async function updateAgentMemoryPatchStatus(params) {
    return requestJson('/api/agent-memory/patch/updateStatus/authenticated', stripLegacyIdentity(params));
  }

  async function getMessageTrace(params) {
    return requestJson('/api/ai-chat/message-trace/detail/authenticated', stripLegacyIdentity(params));
  }

  async function getConversationTrace(params) {
    return requestJson('/api/ai-chat/conversation-trace/detail/authenticated', stripLegacyIdentity(params));
  }

  async function getToolCallDetail(params) {
    return requestJson('/api/chat/tool-calls/detail/authenticated', stripLegacyIdentity(params));
  }

  async function listToolCalls(params) {
    return requestJson('/api/chat/tool-calls/list/authenticated', stripLegacyIdentity(params));
  }

  async function getConversationToolCallStatistics(params) {
    return requestJson('/api/chat/tool-calls/statistics/conversation/authenticated', stripLegacyIdentity(params));
  }

  async function getRecentToolCalls(params) {
    return requestJson('/api/chat/tool-calls/recent/authenticated', stripLegacyIdentity(params));
  }

  async function getMessageToolCalls(params) {
    return requestJson('/api/chat/tool-calls/message/authenticated', stripLegacyIdentity(params));
  }

  async function getChatStatisticsOverview(params) {
    return requestJson('/api/chat/statistics/overview/authenticated', stripLegacyIdentity(params));
  }

  async function getChatStatisticsTrends(params) {
    return requestJson('/api/chat/statistics/trends/authenticated', stripLegacyIdentity(params));
  }

  async function getChatStatisticsToolRanking(params) {
    return requestJson('/api/chat/statistics/tools/ranking/authenticated', stripLegacyIdentity(params));
  }

  async function getChatStatisticsUserRanking(params) {
    return requestJson('/api/chat/statistics/users/ranking/authenticated', stripLegacyIdentity(params));
  }

  async function getChatStatisticsRealtime(params) {
    return requestJson('/api/chat/statistics/realtime/authenticated', stripLegacyIdentity(params));
  }

  async function exportChatStatistics(params) {
    return requestJson('/api/chat/statistics/export/authenticated', stripLegacyIdentity(params));
  }

  async function getOpenClawCurrentScene() {
    return requestGet('/api/openclaw-studio/scene/current/authenticated');
  }

  async function getOpenClawSceneEvents(params = {}) {
    return requestGet('/api/openclaw-studio/scene/events/authenticated', params);
  }

  async function listOpenClawAgentChannels(params) {
    return requestGet(`/api/openclaw-studio/agents/${encodePathSegment(params.agentId)}/channels/authenticated`);
  }

  async function listOpenClawAgentChannelSessions(params) {
    return requestGet(
      `/api/openclaw-studio/agents/${encodePathSegment(params.agentId)}/channels/${encodePathSegment(params.channelType)}/sessions/authenticated`,
    );
  }

  async function enterOpenClawAgentChat(params) {
    const { agentId, ...body } = params;
    return requestJson(
      `/api/openclaw-studio/agents/${encodePathSegment(agentId)}/chat/enter/authenticated`,
      stripLegacyIdentity(body),
    );
  }

  async function enterOpenClawAgentChannelSession(params) {
    return requestJson(
      `/api/openclaw-studio/agents/${encodePathSegment(params.agentId)}/channels/${encodePathSegment(params.channelType)}/sessions/${encodePathSegment(params.sessionId)}/enter/authenticated`,
      {},
    );
  }

  async function getOpenClawGovernanceCatalog() {
    return requestGet('/api/openclaw-governance/catalog/authenticated');
  }

  async function listOpenClawIdentityProfiles() {
    return requestGet('/api/openclaw-governance/identity-profiles/authenticated');
  }

  async function listOpenClawRolePostures() {
    return requestGet('/api/openclaw-governance/role-postures/authenticated');
  }

  async function listOpenClawUnifiedServiceRefs() {
    return requestGet('/api/openclaw-governance/unified-service-refs/authenticated');
  }

  async function listOpenClawCapabilityProfiles() {
    return requestGet('/api/openclaw-governance/capability-profiles/authenticated');
  }

  async function listOpenClawMemoryPacks() {
    return requestGet('/api/openclaw-governance/memory-packs/authenticated');
  }

  async function listOpenClawSeedMemoryPacks() {
    return requestGet('/api/openclaw-governance/seed-memory-packs/authenticated');
  }

  async function listOpenClawMemoryBindingPolicies() {
    return requestGet('/api/openclaw-governance/memory-binding-policies/authenticated');
  }

  async function listOpenClawMemoryWorkspaces() {
    return requestGet('/api/openclaw-governance/memory-workspaces/authenticated');
  }

  async function listOpenClawMemorySnapshots() {
    return requestGet('/api/openclaw-governance/memory-snapshots/authenticated');
  }

  async function listOpenClawMemoryTrainingRuns() {
    return requestGet('/api/openclaw-governance/memory-training-runs/authenticated');
  }

  async function listOpenClawTrainingScorecards() {
    return requestGet('/api/openclaw-governance/training-scorecards/authenticated');
  }

  async function listOpenClawLearningSamples() {
    return requestGet('/api/openclaw-governance/learning-samples/authenticated');
  }

  async function listOpenClawMemoryCandidates() {
    return requestGet('/api/openclaw-governance/memory-candidates/authenticated');
  }

  async function listOpenClawZeusBackflowExports() {
    return requestGet('/api/openclaw-governance/zeus-backflow-exports/authenticated');
  }

  async function listOpenClawModelPolicies() {
    return requestGet('/api/openclaw-governance/model-policies/authenticated');
  }

  async function listOpenClawCredentialProfiles() {
    return requestGet('/api/openclaw-governance/credential-profiles/authenticated');
  }

  async function listOpenClawEvalSuites() {
    return requestGet('/api/openclaw-governance/eval-suites/authenticated');
  }

  async function listOpenClawSimulationEvals() {
    return requestGet('/api/openclaw-governance/simulation-evals/authenticated');
  }

  async function listOpenClawCertifications() {
    return requestGet('/api/openclaw-governance/certifications/authenticated');
  }

  async function listOpenClawAgentReleases() {
    return requestGet('/api/openclaw-governance/agent-releases/authenticated');
  }

  async function listOpenClawReleaseChannels() {
    return requestGet('/api/openclaw-governance/release-channels/authenticated');
  }

  async function listOpenClawOnDutyPolicies() {
    return requestGet('/api/openclaw-governance/on-duty-policies/authenticated');
  }

  async function listOpenClawSchedulePolicies() {
    return requestGet('/api/openclaw-governance/schedule-policies/authenticated');
  }

  async function listOpenClawAlertPolicies() {
    return requestGet('/api/openclaw-governance/alert-policies/authenticated');
  }

  async function listOpenClawAlertIncidents() {
    return requestGet('/api/openclaw-governance/alert-incidents/authenticated');
  }

  async function listOpenClawRemediationPolicies() {
    return requestGet('/api/openclaw-governance/remediation-policies/authenticated');
  }

  async function listOpenClawRemediationActions() {
    return requestGet('/api/openclaw-governance/remediation-actions/authenticated');
  }

  async function listOpenClawHumanTakeovers() {
    return requestGet('/api/openclaw-governance/human-takeovers/authenticated');
  }

  async function listOpenClawUpgradeJobs() {
    return requestGet('/api/openclaw-governance/upgrade-jobs/authenticated');
  }

  async function resolveOpenClawEffectiveAgentConfig(params) {
    return requestGet('/api/openclaw-governance/effective-agent-config/resolve/authenticated', params);
  }

  async function resolveOpenClawConversationEffectiveConfig(params) {
    return requestGet('/api/openclaw-governance/effective-agent-config/resolve-conversation/authenticated', params);
  }

  async function reportClientToolResult(params) {
    const path = process.env.ZEUS_ATLAS_CLIENT_TOOL_RESULT_PATH ?? '/api/chat/client-tool/result';
    // console.log('[Step6 cloud-chat ---> 云端] POST toolCallId:', params?.call?.toolCallId);
    try {
      const resp = await requestJson(path, params);
      // console.log('[Step6 cloud-chat <--- 云端] 回传响应 toolCallId:', params?.call?.toolCallId, JSON.stringify(resp ?? {}));
      return resp;
    } catch (err) {
      console.error('[Step6 cloud-chat ✕ 云端] 回传异常 toolCallId:', params?.call?.toolCallId, err?.message || err);
      throw err;
    }
  }

  async function pollClientToolCalls(params) {
    return requestJson(
      process.env.ZEUS_ATLAS_CLIENT_TOOL_POLL_PATH ?? '/api/client/runtime/tasks/poll',
      params,
    );
  }

  async function publishRuntimeProjection(params) {
    return requestJson(
      process.env.ZEUS_ATLAS_RUNTIME_PROJECTION_PATH ?? '/api/client/runtime/projection',
      params,
    );
  }

  async function issueStreamTicket(params = {}) {
    const ticketEnvelope = await requestJson('/api/auth/sse-ticket', {
      scene: 'chat_message_stream',
      conversationId: params.conversationId,
      messageId: params.messageId,
    }, {
      urlBuilder: buildStreamUrl,
    });
    const ticketData = unwrapCloudData(ticketEnvelope, '获取 SSE 登录票据失败');
    if (!ticketData?.sseTicket) {
      throw new Error('获取 SSE 登录票据失败');
    }
    return ticketData.sseTicket;
  }

  async function issueRunStreamTicket({ runId, requestParams }) {
    // 重要：chat_run_stream scene 的 bindings 只绑 messageId（= userMessageUuid，
    // 即 runId 的字符串形态），controller (chatAgentRuns.streamRun) 只用
    // { messageId: runId } 校验。
    //
    // 如果这里多塞 conversationId，SseAuthTicketService.matchBindings 会把
    // payload 多出的 conversationId 跟 expected 的 undefined 对比为不等，
    // 直接返回 binding_mismatch (HTTP 401)，第二阶段 run-relay 永远开不起来。
    const ticketEnvelope = await requestJson('/api/auth/sse-ticket', {
      scene: 'chat_run_stream',
      messageId: runId,
    }, {
      urlBuilder: buildStreamUrl,
      ...(requestParams ? { ...requestParams } : {}),
    });
    const ticketData = unwrapCloudData(ticketEnvelope, '获取 run 流 SSE 票据失败');
    if (!ticketData?.sseTicket) {
      throw new Error('获取 run 流 SSE 票据失败');
    }
    return ticketData.sseTicket;
  }

  async function fetchRunSnapshot(runId, requestParams) {
    const envelope = await requestJson(
      `/api/chat/agent-runs/${encodeURIComponent(runId)}`,
      undefined,
      {
        method: 'GET',
        urlBuilder: buildStreamUrl,
        ...(requestParams ? { ...requestParams } : {}),
      },
    );
    if (envelope?.code === 0 || envelope?.success === true) {
      return envelope.data ?? null;
    }
    return null;
  }

  /**
   * 单条 SSE 流的"读 → 分发"循环。共享给 startMessageStream 的主流和 run-scoped
   * 续聊流复用：两者都把事件按相同 streamId emit 给 renderer，对 renderer 透明。
   *
   * 同时拦截 `run_started` 事件提取 runId（= userMessageUuid），让主流结束后能
   * 按 runId 自动重订阅 `/api/chat/agent-runs/:runId/stream` 接力后端 forwardByRun
   * 推送的所有 pause-resume 续聊事件。
   */
  async function pipeSseToRenderer({
    response,
    state,
    abortSignal,
    streamId,
    webContents,
    onRunStarted,
    onAnyEvent,
  }) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let nextState = state;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseSseChunk(nextState, decoder.decode(value, { stream: true }));
        nextState = parsed.state;
        for (const event of parsed.events) {
          const normalized = normalizeStreamEvent(event);
          if (normalized.event === 'run_started' && normalized.data && typeof normalized.data === 'object') {
            const incoming = String(
              normalized.data.runId ?? normalized.data.userMessageUuid ?? '',
            ).trim();
            if (incoming) onRunStarted?.(incoming);
          }
          webContents.send('chat:stream:event', {
            streamId,
            event: normalized,
            receivedAt: new Date().toISOString(),
          });
          onAnyEvent?.(normalized);
          if (abortSignal.aborted) return nextState;
        }
      }
    } catch (err) {
      if (abortSignal.aborted) return nextState;
      throw err;
    }
    return nextState;
  }

  async function uploadImage({ buffer, fileName, mimeType }) {
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType || 'image/png' });
    const formData = new FormData();
    formData.append('file', blob, fileName || 'image.png');
    const config = resolveEndpointConfig();
    const proxyBase = config.developerMode
      ? 'https://pre-cbu-xiaoer.alibaba-inc.com'
      : 'https://cbu-xiaoer.alibaba-inc.com';
    const url = `${proxyBase}/api/proxy/globalApi/upload/upload`;
    const token = await getAccessToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-zeus-atlas-client': 'desktop',
      },
      body: formData,
    });
    const data = await response.json();
    if (!data?.success) throw new Error(data?.message || data?.errorMsg || '图片上传失败');
    return data?.data?.url || data?.data;
  }

  async function startMessageStream({ webContents, params }) {
    const streamId = randomUUID();
    const mainController = new AbortController();
    let runStreamController = null;
    let runId = null;

    const session = {
      abort: () => {
        try {
          mainController.abort();
        } catch {
          /* ignore */
        }
        try {
          runStreamController?.abort();
        } catch {
          /* ignore */
        }
      },
    };
    activeStreams.set(streamId, session);

    void (async () => {
      let state = createSseState();
      try {
        // 第一阶段：原 send stream（POST /api/chat/messages/stream/authenticated）
        const sseTicket = await issueStreamTicket(params);
        const streamParams = stripLegacyIdentity(params ?? {});
        const runtimeContext = buildClientRuntimeChatContext({
          getSession,
          buildRuntimeProjection,
        });
        const sourceMetadata = mergeClientRuntimeSourceMetadata(
          streamParams,
          runtimeContext,
        );
        const requestBody = {
          ...streamParams,
          ...(runtimeContext.sessionId && !streamParams.sessionId
            ? { sessionId: runtimeContext.sessionId }
            : {}),
          ...(sourceMetadata ? { sourceMetadata } : {}),
          sseTicket,
        };
        // console.log('[cloud-chat --->] stream request body:', JSON.stringify(requestBody, null, 2));
        const response = await fetch(buildStreamUrl('/api/chat/messages/stream/authenticated'), {
          method: 'POST',
          headers: await buildHeaders(params),
          body: JSON.stringify(requestBody),
          signal: mainController.signal,
        });

        if (!response.ok || !response.body) {
          const message = response.body ? await response.text().catch(() => '') : '';
          throw new Error(message || `HTTP ${response.status}`);
        }

        state = await pipeSseToRenderer({
          response,
          state,
          abortSignal: mainController.signal,
          streamId,
          webContents,
          onRunStarted: (incoming) => {
            runId = incoming;
            console.log('[cloud-chat][run-relay] run_started captured', {
              streamId,
              runId: incoming,
            });
          },
        });
        console.log('[cloud-chat][run-relay] primary send-stream closed', {
          streamId,
          runId,
        });

        for (const event of flushSseState(state)) {
          const normalized = normalizeStreamEvent(event);
          console.log('[Step1 cloud-chat <--- flush] 收尾 SSE 事件:', normalized?.event, JSON.stringify(normalized?.data ?? {}).slice(0, 500));
          webContents.send('chat:stream:event', {
            streamId,
            event: normalized,
            receivedAt: new Date().toISOString(),
          });
        }

        // 第二阶段：runId-scoped 自动重订阅。后端 forwardByRun 内部会跨多轮
        // pause-resume 接力转发；理论上一次 GET /:runId/stream 就能撑到 run 终态，
        // 但 SLB idle / 网络中断时本条流可能断开，外层 loop 用 snapshot 探活，
        // 还没 terminal 就再开一条流，直到 runStatus 进入终态。
        let runRelayIteration = 0;
        const syntheticDispatchedToolCallIds = new Set();
        while (runId && !mainController.signal.aborted) {
          runRelayIteration += 1;
          let snapshot;
          try {
            snapshot = await fetchRunSnapshot(runId, params);
          } catch (err) {
            console.warn('[cloud-chat][run-relay] snapshot fetch failed, stop resubscribe', {
              streamId,
              runId,
              iteration: runRelayIteration,
              err: err instanceof Error ? err.message : String(err),
            });
            break;
          }
          const runStatus = String(snapshot?.runStatus || '');
          console.log('[cloud-chat][run-relay] snapshot fetched', {
            streamId,
            runId,
            iteration: runRelayIteration,
            runStatus: runStatus || '<empty>',
            assistantMessageIds: snapshot?.assistantMessageIds,
            activeSuspensions: snapshot?.activeSuspensions?.length ?? 0,
          });
          // B 方案兜底：从 snapshot.activeSuspensions 合成 client_tool_dispatching
          // 事件给 renderer，覆盖续聊场景后端 SinkSSE 丢事件的边界。
          // 客户端 useClientToolRegistry 按 toolCallId key 自动 dedup，不会重复弹 UI。
          if (Array.isArray(snapshot?.activeSuspensions)) {
            for (const sus of snapshot.activeSuspensions) {
              if (!sus || sus.status !== 'dispatched') continue;
              const toolCallId = sus.toolCallId;
              if (!toolCallId || syntheticDispatchedToolCallIds.has(toolCallId)) continue;
              syntheticDispatchedToolCallIds.add(toolCallId);
              const syntheticEvent = {
                event: 'client_tool_dispatching',
                data: {
                  toolCallId,
                  suspensionUuid: sus.suspensionUuid,
                  capabilityId: sus.capabilityId,
                  toolName: sus.toolName,
                  displayName: sus.toolName,
                  argumentsPreview: sus.argumentsPreview,
                  policyContext: sus.policyContext,
                  occurredAt: sus.dispatchedAt || new Date().toISOString(),
                  expiresAt: sus.timeoutAt,
                },
              };
              console.log('[cloud-chat][run-relay] synthesized dispatching from snapshot', {
                streamId,
                runId,
                toolCallId,
                capabilityId: sus.capabilityId,
              });
              webContents.send('chat:stream:event', {
                streamId,
                event: syntheticEvent,
                receivedAt: new Date().toISOString(),
              });
            }
          }

          if (!runStatus || runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
            console.log('[cloud-chat][run-relay] runStatus terminal, exit outer loop', {
              streamId,
              runId,
              iteration: runRelayIteration,
              runStatus: runStatus || '<empty>',
            });
            break;
          }
          let runTicket;
          try {
            runTicket = await issueRunStreamTicket({
              runId,
              requestParams: params,
            });
          } catch (err) {
            console.warn('[cloud-chat][run-relay] ticket request failed, stop resubscribe', {
              streamId,
              runId,
              iteration: runRelayIteration,
              err: err instanceof Error ? err.message : String(err),
            });
            break;
          }

          runStreamController = new AbortController();
          let runStreamEventCount = 0;
          let runStreamHadRunComplete = false;
          try {
            const runUrl = buildStreamUrl(
              `/api/chat/agent-runs/${encodeURIComponent(runId)}/stream?sseTicket=${encodeURIComponent(runTicket)}`,
            );
            console.log('[cloud-chat][run-relay] opening run-stream', {
              streamId,
              runId,
              iteration: runRelayIteration,
            });
            const runResponse = await fetch(runUrl, {
              method: 'GET',
              headers: await buildHeaders(params),
              signal: runStreamController.signal,
            });
            if (!runResponse.ok || !runResponse.body) {
              const body = runResponse.body ? await runResponse.text().catch(() => '') : '';
              console.warn('[cloud-chat][run-relay] run-stream open failed', {
                streamId,
                runId,
                iteration: runRelayIteration,
                status: runResponse.status,
                body,
              });
              break;
            }
            // 复用同一 streamId，对 renderer 透明（run-stream 内不会再来 run_started，
            // onRunStarted 留空即可）。
            // 用 onAnyEvent 计数 + 标记 run_complete，stream 自然结束后能区分
            // "后端干净 emit run_complete" vs "SLB/网络切断"。
            let runState = createSseState();
            runState = await pipeSseToRenderer({
              response: runResponse,
              state: runState,
              abortSignal: runStreamController.signal,
              streamId,
              webContents,
              onAnyEvent: (normalized) => {
                runStreamEventCount += 1;
                if (normalized.event === 'run_complete') runStreamHadRunComplete = true;
              },
            });
            for (const event of flushSseState(runState)) {
              const normalized = normalizeStreamEvent(event);
              runStreamEventCount += 1;
              if (normalized.event === 'run_complete') runStreamHadRunComplete = true;
              webContents.send('chat:stream:event', {
                streamId,
                event: normalized,
                receivedAt: new Date().toISOString(),
              });
            }
            console.log('[cloud-chat][run-relay] run-stream closed', {
              streamId,
              runId,
              iteration: runRelayIteration,
              eventCount: runStreamEventCount,
              hadRunComplete: runStreamHadRunComplete,
            });
          } catch (err) {
            if (runStreamController?.signal.aborted) {
              // 上层 abort 触发，跳到 finally 走 done 分支
              console.log('[cloud-chat][run-relay] run-stream aborted by upstream', {
                streamId,
                runId,
                iteration: runRelayIteration,
              });
              break;
            }
            console.warn('[cloud-chat][run-relay] run-stream read failed', {
              streamId,
              runId,
              iteration: runRelayIteration,
              eventCount: runStreamEventCount,
              err: err instanceof Error ? err.message : String(err),
            });
            break;
          } finally {
            runStreamController = null;
          }
          // 一轮 run-stream 结束。下一次 outer loop 重新探 snapshot 决定是否再订阅。
        }
        console.log('[cloud-chat][run-relay] outer loop exited', {
          streamId,
          runId,
          totalIterations: runRelayIteration,
          aborted: mainController.signal.aborted,
        });

        webContents.send('chat:stream:done', {
          streamId,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (mainController.signal.aborted) {
          webContents.send('chat:stream:done', {
            streamId,
            completedAt: new Date().toISOString(),
          });
          return;
        }
        webContents.send('chat:stream:error', {
          streamId,
          error: error instanceof Error ? error.message : 'Unknown cloud chat stream error',
          failedAt: new Date().toISOString(),
        });
      } finally {
        activeStreams.delete(streamId);
      }
    })();

    return { streamId };
  }

  function abortMessageStream({ streamId }) {
    const session = activeStreams.get(streamId);
    if (!session) {
      return { ok: false, code: 'stream_not_found' };
    }
    try {
      session.abort?.();
    } catch {
      /* ignore */
    }
    activeStreams.delete(streamId);
    return { ok: true, code: 'aborted' };
  }

  async function searchStaff(params) {
    const query = String(params?.query || '').trim();
    if (!query) return { success: true, data: [] };
    console.log('[staff:search] query:', query);
    try {
      const url = 'https://pre-cbu-xiaoer.alibaba-inc.com/api/proxy/globalApi/users/queryUsers';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await buildHeaders({})) },
        body: JSON.stringify({ args: [query] }),
      });
      const result = await response.json();
      console.log('[staff:search] result count:', Array.isArray(result?.data) ? result.data.length : 'non-array');
      return result;
    } catch (err) {
      console.error('[staff:search] failed:', err);
      return { success: false, data: [] };
    }
  }

  async function getStaffByIds(params) {
    const workIds = String(params?.workIds || '').trim();
    if (!workIds) return { success: true, data: [] };
    try {
      const url = 'https://pre-cbu-xiaoer.alibaba-inc.com/api/proxy/globalApi/users/queryUsersByIds';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await buildHeaders({})) },
        body: JSON.stringify({ args: [workIds] }),
      });
      return await response.json();
    } catch {
      return { success: false, data: [] };
    }
  }

  return {
    abortMessageStream,
    abortRoundTableTurn,
    branchFromMessage,
    cancelExecution,
    cancelStream,
    buildMessageContext,
    checkAccess,
    confirmDispatch,
    confirmExecution,
    completeAgentCronSession,
    createAgentCronSession,
    createConversation,
    createConversationAuth,
    createShare,
    createShareAuth,
    continueShare,
    deleteConversation,
    deleteMessage,
    enterOpenClawAgentChannelSession,
    enterOpenClawAgentChat,
    getAgentCronSessionDetail,
    getAgentDailyBilling,
    getBillingSummary,
    getAgentById,
    getAssistantSuggestions,
    getConversationDetail,
    getConversationAuthDetail,
    getConversationTrace,
    getConversationToolCallStatistics,
    getChatStatisticsOverview,
    getChatStatisticsRealtime,
    getChatStatisticsToolRanking,
    getChatStatisticsTrends,
    getChatStatisticsUserRanking,
    exportChatStatistics,
    getExecutionCot,
    getExecutionDetail,
    getExecutionResult,
    getExecutionStatus,
    getInlineCompletion,
    getLastMessage,
    getMemoryCompileStatus,
    getMemoryWikiStatus,
    getMessageDetail,
    getMessageToolCalls,
    getMessageTrace,
    getMessages,
    getOpenClawCurrentScene,
    getOpenClawGovernanceCatalog,
    getOpenClawSceneEvents,
    listOpenClawAgentReleases,
    listOpenClawAlertPolicies,
    listOpenClawAlertIncidents,
    listOpenClawCapabilityProfiles,
    listOpenClawCertifications,
    listOpenClawCredentialProfiles,
    listOpenClawEvalSuites,
    listOpenClawHumanTakeovers,
    listOpenClawIdentityProfiles,
    listOpenClawLearningSamples,
    listOpenClawMemoryBindingPolicies,
    listOpenClawMemoryCandidates,
    listOpenClawMemoryPacks,
    listOpenClawMemorySnapshots,
    listOpenClawMemoryTrainingRuns,
    listOpenClawMemoryWorkspaces,
    listOpenClawModelPolicies,
    listOpenClawOnDutyPolicies,
    listOpenClawReleaseChannels,
    listOpenClawRemediationActions,
    listOpenClawRemediationPolicies,
    listOpenClawRolePostures,
    listOpenClawSchedulePolicies,
    listOpenClawSeedMemoryPacks,
    listOpenClawSimulationEvals,
    listOpenClawTrainingScorecards,
    listOpenClawUnifiedServiceRefs,
    listOpenClawUpgradeJobs,
    listOpenClawZeusBackflowExports,
    getPendingDispatch,
    getRecentToolCalls,
    getRoundTableTranscript,
    getShareDetail,
    getShareAuthDetail,
    getThinkingByMessage,
    getThinkingDetail,
    getToolCallDetail,
    getWorkingMemory,
    initializeMemoryWiki,
    initializeWorkingMemory,
    injectRoundTableTurn,
    listAgentCronRuns,
    listAgentCronSessions,
    listAuthBase,
    listMemoryWikiPages,
    listAgents,
    listConversations,
    listExecutions,
    listOpenClawAgentChannels,
    listOpenClawAgentChannelSessions,
    listRelatedShadowExecutions,
    listShares,
    listThinkingProcesses,
    listToolCalls,
    pollClientToolCalls,
    pollExecutionEvents,
    publishRuntimeProjection,
    readMemoryWikiPage,
    requestDiagnostic,
    reportClientToolResult,
    recoverAgentCronSessionOpenRuns,
    resolveOpenClawConversationEffectiveConfig,
    resolveOpenClawEffectiveAgentConfig,
    retryMemoryCompile,
    revokeShare,
    searchStaff,
    getStaffByIds,
    pauseAgentCronSession,
    resumeAgentCronSession,
    startMessageStream,
    uploadImage,
    truncateAfterMessage,
    traceExecutionSource,
    updateAgentCronSession,
    updateAgentMemoryPatchStatus,
    updateConversationAuthMembers,
    updateShareAccess,
    updateShareAuthMembers,
    updateSpectatorConfig,
    updateThinkingUiState,
  };
}
