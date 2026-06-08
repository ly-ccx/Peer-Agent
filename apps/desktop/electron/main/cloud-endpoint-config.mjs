export const DEFAULT_PRE_CLOUD_GATEWAY_URL = 'https://pre-cbu-xiaoer-service.alibaba-inc.com';
const DEVELOPER_MODE_VALUES = new Set(['1', 'true', 'yes', 'on', 'dev', 'pre', 'prepub', 'staging']);
const CLOUD_MODES = new Set(['prod', 'pre', 'custom']);
const LOCAL_ENDPOINT_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function envValue(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeUrl(value) {
  return value ? value.replace(/\/+$/, '') : undefined;
}

function normalizeCloudMode(value, fallback = 'prod') {
  return CLOUD_MODES.has(value) ? value : fallback;
}

export function normalizeEndpointUrl(value) {
  return normalizeUrl(typeof value === 'string' ? value.trim() : undefined);
}

export function isAllowedEndpointUrl(value) {
  const normalized = normalizeEndpointUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:' && LOCAL_ENDPOINT_HOSTS.has(url.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function isAllowedRuntimeGatewayUrl(value) {
  const normalized = normalizeEndpointUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
    if ((url.protocol === 'http:' || url.protocol === 'ws:') && LOCAL_ENDPOINT_HOSTS.has(url.hostname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function validateEndpointUrl(value, fieldName) {
  const normalized = normalizeEndpointUrl(value);
  if (!normalized) return undefined;
  if (!isAllowedEndpointUrl(normalized)) {
    throw new Error(`${fieldName} must be https, localhost, or 127.0.0.1.`);
  }
  return normalized;
}

export function validateRuntimeGatewayUrl(value, fieldName) {
  const normalized = normalizeEndpointUrl(value);
  if (!normalized) return undefined;
  if (!isAllowedRuntimeGatewayUrl(normalized)) {
    throw new Error(`${fieldName} must be https, wss, localhost, or 127.0.0.1.`);
  }
  return normalized;
}

export function sanitizeDeveloperSettings(raw = {}, now = new Date().toISOString()) {
  const cloudMode = normalizeCloudMode(raw.cloudMode, raw.developerMode ? 'pre' : 'prod');
  const developerMode = Boolean(raw.developerMode);
  const gatewayUrl = validateEndpointUrl(raw.gatewayUrl, 'gatewayUrl');
  const streamUrl = validateEndpointUrl(raw.streamUrl, 'streamUrl');
  const runtimeGatewayUrl = validateRuntimeGatewayUrl(raw.runtimeGatewayUrl, 'runtimeGatewayUrl');

  if (developerMode && cloudMode === 'custom' && !gatewayUrl) {
    throw new Error('gatewayUrl is required for custom developer mode.');
  }

  return {
    developerMode,
    cloudMode,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(streamUrl ? { streamUrl } : {}),
    ...(runtimeGatewayUrl ? { runtimeGatewayUrl } : {}),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
  };
}

export function isCloudDeveloperMode(env = process.env) {
  const raw = envValue(env, 'ZEUS_ATLAS_DEVELOPER_MODE') ?? envValue(env, 'ZEUS_ATLAS_DEV_MODE');
  return raw ? DEVELOPER_MODE_VALUES.has(raw.toLowerCase()) : false;
}

function resolveEnvironmentRuntimeGatewayUrl(env = process.env, developerMode = isCloudDeveloperMode(env)) {
  return normalizeEndpointUrl(
    developerMode
      ? envValue(env, 'ZEUS_ATLAS_PRE_RUNTIME_GATEWAY_URL') ??
          envValue(env, 'ZEUS_ATLAS_PRE_RUNTIME_GATEWAY_WS_URL') ??
          envValue(env, 'ZEUS_ATLAS_RUNTIME_GATEWAY_URL') ??
          envValue(env, 'ZEUS_ATLAS_RUNTIME_GATEWAY_WS_URL')
      : envValue(env, 'ZEUS_ATLAS_RUNTIME_GATEWAY_URL') ??
          envValue(env, 'ZEUS_ATLAS_RUNTIME_GATEWAY_WS_URL'),
  );
}

function resolveEnvironmentEndpointConfig(env = process.env) {
  const developerMode = isCloudDeveloperMode(env);
  const gatewayUrl = developerMode
    ? normalizeEndpointUrl(
        envValue(env, 'ZEUS_ATLAS_PRE_CLOUD_GATEWAY_URL') ??
          envValue(env, 'ZEUS_ATLAS_CLOUD_PRE_GATEWAY_URL') ??
          DEFAULT_PRE_CLOUD_GATEWAY_URL,
      )
    : normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_CLOUD_GATEWAY_URL'));
  const streamUrl = developerMode
    ? normalizeEndpointUrl(
        envValue(env, 'ZEUS_ATLAS_PRE_CLOUD_STREAM_URL') ??
          envValue(env, 'ZEUS_ATLAS_PRE_CLOUD_DIRECT_URL') ??
          envValue(env, 'ZEUS_ATLAS_CLOUD_PRE_STREAM_URL') ??
          envValue(env, 'ZEUS_ATLAS_CLOUD_PRE_DIRECT_URL') ??
          gatewayUrl,
      )
    : normalizeEndpointUrl(
        envValue(env, 'ZEUS_ATLAS_CLOUD_STREAM_URL') ??
          envValue(env, 'ZEUS_ATLAS_CLOUD_DIRECT_URL') ??
          gatewayUrl,
      );
  const runtimeGatewayUrl = resolveEnvironmentRuntimeGatewayUrl(env, developerMode);

  return {
    mode: developerMode ? 'pre' : 'prod',
    developerMode,
    gatewayUrl,
    streamUrl,
    runtimeGatewayUrl: runtimeGatewayUrl ?? gatewayUrl,
    source: 'environment',
  };
}

function resolveDeveloperSettingsEndpointConfig(settings, env = process.env) {
  if (!settings) return null;
  const cloudMode = normalizeCloudMode(settings.cloudMode, settings.developerMode ? 'pre' : 'prod');
  if (!settings.developerMode) {
    const gatewayUrl = normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_CLOUD_GATEWAY_URL'));
    const streamUrl = normalizeEndpointUrl(
      envValue(env, 'ZEUS_ATLAS_CLOUD_STREAM_URL') ??
        envValue(env, 'ZEUS_ATLAS_CLOUD_DIRECT_URL') ??
        gatewayUrl,
    );
    return {
      mode: 'prod',
      developerMode: false,
      gatewayUrl,
      streamUrl,
      runtimeGatewayUrl: resolveEnvironmentRuntimeGatewayUrl(env, false) ?? gatewayUrl,
      source: 'developer-settings',
    };
  }

  if (cloudMode === 'pre') {
    const gatewayUrl = normalizeEndpointUrl(settings.gatewayUrl) ??
      normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_PRE_CLOUD_GATEWAY_URL')) ??
      normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_CLOUD_PRE_GATEWAY_URL')) ??
      DEFAULT_PRE_CLOUD_GATEWAY_URL;
    const streamUrl = normalizeEndpointUrl(settings.streamUrl) ??
      normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_PRE_CLOUD_STREAM_URL')) ??
      normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_PRE_CLOUD_DIRECT_URL')) ??
      normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_CLOUD_PRE_STREAM_URL')) ??
      normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_CLOUD_PRE_DIRECT_URL')) ??
      gatewayUrl;
    const runtimeGatewayUrl = normalizeEndpointUrl(settings.runtimeGatewayUrl) ??
      resolveEnvironmentRuntimeGatewayUrl(env, true) ??
      gatewayUrl;
    return {
      mode: 'pre',
      developerMode: true,
      gatewayUrl,
      streamUrl,
      runtimeGatewayUrl,
      source: 'developer-settings',
    };
  }

  if (cloudMode === 'custom') {
    const gatewayUrl = normalizeEndpointUrl(settings.gatewayUrl);
    const streamUrl = normalizeEndpointUrl(settings.streamUrl) ?? gatewayUrl;
    const runtimeGatewayUrl = normalizeEndpointUrl(settings.runtimeGatewayUrl) ?? gatewayUrl;
    return {
      mode: 'custom',
      developerMode: true,
      gatewayUrl,
      streamUrl,
      runtimeGatewayUrl,
      source: 'developer-settings',
    };
  }

  const gatewayUrl = normalizeEndpointUrl(envValue(env, 'ZEUS_ATLAS_CLOUD_GATEWAY_URL'));
  const streamUrl = normalizeEndpointUrl(
    envValue(env, 'ZEUS_ATLAS_CLOUD_STREAM_URL') ??
      envValue(env, 'ZEUS_ATLAS_CLOUD_DIRECT_URL') ??
      gatewayUrl,
  );
  return {
    mode: 'prod',
    developerMode: true,
    gatewayUrl,
    streamUrl,
    runtimeGatewayUrl: resolveEnvironmentRuntimeGatewayUrl(env, false) ?? gatewayUrl,
    source: 'developer-settings',
  };
}

export function resolveCloudEndpointConfig(env = process.env, developerSettings = undefined) {
  return resolveDeveloperSettingsEndpointConfig(developerSettings, env) ??
    resolveEnvironmentEndpointConfig(env);
}

export function requireCloudGatewayUrl(env = process.env, developerSettings = undefined) {
  const config = resolveCloudEndpointConfig(env, developerSettings);
  if (!config.gatewayUrl) {
    throw new Error(
      config.developerMode
        ? 'ZEUS_ATLAS_PRE_CLOUD_GATEWAY_URL is not configured.'
        : 'ZEUS_ATLAS_CLOUD_GATEWAY_URL is not configured.',
    );
  }
  return config.gatewayUrl;
}

export function requireCloudStreamUrl(env = process.env, developerSettings = undefined) {
  const config = resolveCloudEndpointConfig(env, developerSettings);
  if (!config.streamUrl) {
    throw new Error(
      config.developerMode
        ? 'ZEUS_ATLAS_PRE_CLOUD_STREAM_URL is not configured.'
        : 'ZEUS_ATLAS_CLOUD_STREAM_URL is not configured.',
    );
  }
  return config.streamUrl;
}
