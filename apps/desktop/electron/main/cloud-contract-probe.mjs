import { resolveCloudEndpointConfig } from './cloud-endpoint-config.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
export const CLOUD_CONTRACT_BLOCKER_CLASSES = new Set([
  'missing',
  'not_implemented',
  'server_error',
  'unreachable',
  'unexpected',
]);

function envValue(env, name) {
  return env[name]?.trim() ?? '';
}

function jsonBody(value) {
  return JSON.stringify(value);
}

export function createCloudContractProbes(env = process.env, checkedAt = new Date().toISOString()) {
  return [
    {
      id: 'clientRuntimeTasksPoll',
      method: 'POST',
      path: envValue(env, 'ZEUS_ATLAS_CLIENT_TOOL_POLL_PATH') || '/api/client/runtime/tasks/poll',
      body: jsonBody({
        sessionId: 'prod-contract-probe',
        limit: 1,
        polledAt: checkedAt,
      }),
    },
    {
      id: 'clientToolResultReport',
      method: 'POST',
      path: envValue(env, 'ZEUS_ATLAS_CLIENT_TOOL_RESULT_PATH') || '/api/chat/client-tool/result',
      body: jsonBody({
        conversationId: 0,
        reportedAt: checkedAt,
      }),
    },
    {
      id: 'runtimeProjectionPublish',
      method: 'POST',
      path: envValue(env, 'ZEUS_ATLAS_RUNTIME_PROJECTION_PATH') || '/api/client/runtime/projection',
      body: jsonBody({
        publishedAt: checkedAt,
        projection: {
          projectionId: 'prod-contract-probe',
          sessionId: 'prod-contract-probe',
          accessLevel: 'cloud_only',
          capabilities: [],
          createdAt: checkedAt,
        },
        session: {
          sessionId: 'prod-contract-probe',
          status: 'cloud_only',
          accessLevel: 'cloud_only',
          capabilityCount: 0,
          pendingReviewCount: 0,
          locale: 'zh-CN',
        },
      }),
    },
    {
      id: 'runtimeGatewayWs',
      method: 'GET',
      path: envValue(env, 'ZEUS_ATLAS_RUNTIME_GATEWAY_WS_PATH') || '/api/client/runtime/ws',
      target: 'runtimeGateway',
    },
    {
      id: 'chatStatisticsExport',
      method: 'POST',
      path: '/api/chat/statistics/export',
      body: jsonBody({
        source: 'desktop-contract-probe',
        format: 'json',
        startDate: '2026-05-01',
        endDate: '2026-05-14',
      }),
    },
    {
      id: 'openClawGovernanceCatalog',
      method: 'GET',
      path: '/api/openclaw-governance/catalog',
    },
    {
      id: 'openClawConversationEffectiveConfig',
      method: 'GET',
      path: '/api/openclaw-governance/effective-agent-config/resolve-conversation?conversationId=0',
    },
    {
      id: 'openClawStudioCurrentScene',
      method: 'GET',
      path: '/api/openclaw-studio/scene/current',
    },
  ];
}

export function createExpectedCloudContractProbeContracts(env = {}) {
  return createCloudContractProbes(env, 'prod-contract-probe').map((probe) => ({
    id: probe.id,
    method: probe.method,
    path: probe.path,
  }));
}

export function classifyCloudContractStatus(status) {
  if (status === 404) return 'missing';
  if (status === 501) return 'not_implemented';
  if (status >= 500) return 'server_error';
  if ([400, 401, 403, 405, 422, 426].includes(status)) return 'route_exists';
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  return 'unexpected';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function httpOriginFromRuntimeGatewayUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  return url.origin;
}

async function runProbe(origin, probe, timeoutMs) {
  const url = new URL(probe.path, origin);
  const headers = probe.body
    ? { 'Content-Type': 'application/json', Accept: 'application/json' }
    : { Accept: 'application/json' };
  try {
    const started = Date.now();
    const response = await fetchWithTimeout(url, {
      method: probe.method,
      headers,
      body: probe.body,
    }, timeoutMs);
    return {
      id: probe.id,
      method: probe.method,
      path: probe.path,
      origin,
      status: response.status,
      class: classifyCloudContractStatus(response.status),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      id: probe.id,
      method: probe.method,
      path: probe.path,
      origin,
      class: 'unreachable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeCloudContracts({
  gatewayUrl,
  env = process.env,
  getEndpointConfig,
  endpointConfig,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const checkedAt = new Date().toISOString();
  const resolvedEndpointConfig = endpointConfig ?? (getEndpointConfig ? getEndpointConfig() : resolveCloudEndpointConfig(env));
  const selectedGatewayUrl = gatewayUrl ?? resolvedEndpointConfig.gatewayUrl;
  const probes = createCloudContractProbes(env, checkedAt);
  const cloudProbes = probes.filter((probe) => probe.target !== 'runtimeGateway');
  const runtimeGatewayProbes = probes.filter((probe) => probe.target === 'runtimeGateway');
  let origin;
  try {
    origin = selectedGatewayUrl ? new URL(selectedGatewayUrl).origin : undefined;
  } catch {
    origin = undefined;
  }
  if (!origin) {
    return {
      checkedAt,
      mode: resolvedEndpointConfig.mode,
      developerMode: resolvedEndpointConfig.developerMode,
      source: resolvedEndpointConfig.source,
      results: [],
      blockerCount: 1,
      error: 'ZEUS_ATLAS_CLOUD_GATEWAY_URL is not configured',
    };
  }

  const cloudResults = await Promise.all(cloudProbes.map((probe) => runProbe(origin, probe, timeoutMs)));
  let runtimeGatewayOrigin;
  try {
    runtimeGatewayOrigin = httpOriginFromRuntimeGatewayUrl(resolvedEndpointConfig.runtimeGatewayUrl);
  } catch {
    runtimeGatewayOrigin = undefined;
  }
  const runtimeGatewayResults = runtimeGatewayOrigin
    ? await Promise.all(runtimeGatewayProbes.map((probe) => runProbe(runtimeGatewayOrigin, probe, timeoutMs)))
    : runtimeGatewayProbes.map((probe) => ({
        id: probe.id,
        method: probe.method,
        path: probe.path,
        class: 'missing',
        error: 'ZEUS_ATLAS_RUNTIME_GATEWAY_URL is not configured',
      }));
  const results = [...cloudResults, ...runtimeGatewayResults];
  const blockerCount = results.filter((result) =>
    ['missing', 'not_implemented', 'server_error', 'unreachable', 'unexpected'].includes(result.class),
  ).length;

  return {
    origin,
    runtimeGatewayOrigin,
    mode: resolvedEndpointConfig.mode,
    developerMode: resolvedEndpointConfig.developerMode,
    source: resolvedEndpointConfig.source,
    checkedAt,
    results,
    blockerCount,
  };
}
