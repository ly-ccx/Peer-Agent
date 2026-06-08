import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCloudDeveloperMode,
  requireCloudGatewayUrl,
  requireCloudStreamUrl,
  resolveCloudEndpointConfig,
  sanitizeDeveloperSettings,
} from './cloud-endpoint-config.mjs';

test('resolveCloudEndpointConfig uses production gateway by default', () => {
  const config = resolveCloudEndpointConfig({
    ZEUS_ATLAS_CLOUD_GATEWAY_URL: 'https://cbu-xiaoer-service.alibaba-inc.com/',
    ZEUS_ATLAS_RUNTIME_GATEWAY_URL: 'wss://runtime-gateway.example.alibaba-inc.com/',
  });

  assert.equal(config.mode, 'prod');
  assert.equal(config.developerMode, false);
  assert.equal(config.source, 'environment');
  assert.equal(config.gatewayUrl, 'https://cbu-xiaoer-service.alibaba-inc.com');
  assert.equal(config.streamUrl, 'https://cbu-xiaoer-service.alibaba-inc.com');
  assert.equal(config.runtimeGatewayUrl, 'wss://runtime-gateway.example.alibaba-inc.com');
});

test('resolveCloudEndpointConfig routes developer mode to the pre gateway', () => {
  const config = resolveCloudEndpointConfig({
    ZEUS_ATLAS_DEVELOPER_MODE: 'pre',
    ZEUS_ATLAS_CLOUD_GATEWAY_URL: 'https://cbu-xiaoer-service.alibaba-inc.com',
  });

  assert.equal(config.mode, 'pre');
  assert.equal(config.developerMode, true);
  assert.equal(config.source, 'environment');
  assert.equal(config.gatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
  assert.equal(config.streamUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
  assert.equal(config.runtimeGatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
});

test('resolveCloudEndpointConfig allows explicit pre gateway, stream, and runtime overrides', () => {
  const config = resolveCloudEndpointConfig({
    ZEUS_ATLAS_DEVELOPER_MODE: 'true',
    ZEUS_ATLAS_PRE_CLOUD_GATEWAY_URL: 'https://pre-gateway.example.com/',
    ZEUS_ATLAS_PRE_CLOUD_STREAM_URL: 'https://pre-stream.example.com/',
    ZEUS_ATLAS_PRE_RUNTIME_GATEWAY_URL: 'wss://pre-runtime-gateway.example.com/',
  });

  assert.equal(config.gatewayUrl, 'https://pre-gateway.example.com');
  assert.equal(config.streamUrl, 'https://pre-stream.example.com');
  assert.equal(config.runtimeGatewayUrl, 'wss://pre-runtime-gateway.example.com');
});

test('resolveCloudEndpointConfig lets developer settings override environment', () => {
  const config = resolveCloudEndpointConfig({
    ZEUS_ATLAS_CLOUD_GATEWAY_URL: 'https://cbu-xiaoer-service.alibaba-inc.com',
  }, {
    developerMode: true,
    cloudMode: 'pre',
  });

  assert.equal(config.mode, 'pre');
  assert.equal(config.developerMode, true);
  assert.equal(config.source, 'developer-settings');
  assert.equal(config.gatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
  assert.equal(config.runtimeGatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
});

test('resolveCloudEndpointConfig supports custom developer endpoint split', () => {
  const config = resolveCloudEndpointConfig({}, {
    developerMode: true,
    cloudMode: 'custom',
    gatewayUrl: 'http://127.0.0.1:7001/',
    streamUrl: 'https://stream.example.com/',
    runtimeGatewayUrl: 'ws://127.0.0.1:7002/',
  });

  assert.equal(config.mode, 'custom');
  assert.equal(config.developerMode, true);
  assert.equal(config.source, 'developer-settings');
  assert.equal(config.gatewayUrl, 'http://127.0.0.1:7001');
  assert.equal(config.streamUrl, 'https://stream.example.com');
  assert.equal(config.runtimeGatewayUrl, 'ws://127.0.0.1:7002');
});

test('resolveCloudEndpointConfig uses the cloud gateway as runtime gateway when no split endpoint is configured', () => {
  const config = resolveCloudEndpointConfig({}, {
    developerMode: true,
    cloudMode: 'custom',
    gatewayUrl: 'https://custom-gateway.example.com/',
  });

  assert.equal(config.mode, 'custom');
  assert.equal(config.gatewayUrl, 'https://custom-gateway.example.com');
  assert.equal(config.runtimeGatewayUrl, 'https://custom-gateway.example.com');
});

test('sanitizeDeveloperSettings rejects unsafe custom endpoint', () => {
  assert.throws(
    () => sanitizeDeveloperSettings({
      developerMode: true,
      cloudMode: 'custom',
      gatewayUrl: 'http://example.com',
    }),
    /gatewayUrl must be https/,
  );
});

test('sanitizeDeveloperSettings rejects unsafe runtime gateway endpoint', () => {
  assert.throws(
    () => sanitizeDeveloperSettings({
      developerMode: true,
      cloudMode: 'custom',
      gatewayUrl: 'http://127.0.0.1:7001',
      runtimeGatewayUrl: 'ws://example.com',
    }),
    /runtimeGatewayUrl must be https, wss/,
  );
});

test('legacy ZEUS_ATLAS_DEV_MODE also enables developer mode', () => {
  assert.equal(isCloudDeveloperMode({ ZEUS_ATLAS_DEV_MODE: '1' }), true);
  assert.equal(requireCloudGatewayUrl({ ZEUS_ATLAS_DEV_MODE: '1' }), 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
  assert.equal(requireCloudStreamUrl({ ZEUS_ATLAS_DEV_MODE: '1' }), 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
});

test('production mode still requires an explicit production gateway', () => {
  assert.throws(
    () => requireCloudGatewayUrl({}),
    /ZEUS_ATLAS_CLOUD_GATEWAY_URL is not configured/,
  );
});
