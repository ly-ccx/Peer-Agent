import { resolveCloudEndpointConfig } from './cloud-endpoint-config.mjs';

export function readCloudRuntimeState({ getEndpointConfig } = {}) {
  const config = getEndpointConfig ? getEndpointConfig() : resolveCloudEndpointConfig();

  return {
    status: config.gatewayUrl ? 'configured' : 'not_configured',
    endpoint: config.gatewayUrl,
    streamEndpoint: config.streamUrl,
    runtimeGatewayEndpoint: config.runtimeGatewayUrl,
    mode: config.mode,
    developerMode: config.developerMode,
    source: config.source,
    lastCheckedAt: new Date().toISOString(),
  };
}
