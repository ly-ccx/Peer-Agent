import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeveloperSettingsStore } from './developer-settings-store.mjs';

function tempUserData() {
  return mkdtempSync(path.join(os.tmpdir(), 'zeus-atlas-developer-settings-'));
}

test('developer settings store falls back to environment until persisted', () => {
  const userDataPath = tempUserData();
  try {
    const store = createDeveloperSettingsStore({
      userDataPath,
      env: {
        ZEUS_ATLAS_DEVELOPER_MODE: 'pre',
        ZEUS_ATLAS_CLOUD_GATEWAY_URL: 'https://cbu-xiaoer-service.alibaba-inc.com',
        ZEUS_ATLAS_PRE_RUNTIME_GATEWAY_URL: 'wss://pre-runtime-gateway.example.com',
      },
    });

    const state = store.getState();
    assert.equal(state.persisted, false);
    assert.equal(state.effectiveConfig.mode, 'pre');
    assert.equal(state.effectiveConfig.source, 'environment');
    assert.equal(state.effectiveConfig.gatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
    assert.equal(state.effectiveConfig.runtimeGatewayUrl, 'wss://pre-runtime-gateway.example.com');
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('developer settings store overrides environment with pre mode', () => {
  const userDataPath = tempUserData();
  try {
    const store = createDeveloperSettingsStore({
      userDataPath,
      env: {
        ZEUS_ATLAS_CLOUD_GATEWAY_URL: 'https://cbu-xiaoer-service.alibaba-inc.com',
      },
    });

    const state = store.updateSettings({ developerMode: true, cloudMode: 'pre' });
    assert.equal(state.persisted, true);
    assert.equal(state.effectiveConfig.mode, 'pre');
    assert.equal(state.effectiveConfig.source, 'developer-settings');
    assert.equal(state.effectiveConfig.gatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
    assert.equal(state.effectiveConfig.runtimeGatewayUrl, 'https://pre-cbu-xiaoer-service.alibaba-inc.com');
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('developer settings store validates custom endpoints', () => {
  const userDataPath = tempUserData();
  try {
    const store = createDeveloperSettingsStore({
      userDataPath,
      env: {},
    });

    assert.throws(
      () => store.updateSettings({
        developerMode: true,
        cloudMode: 'custom',
        gatewayUrl: 'http://example.com',
      }),
      /gatewayUrl must be https/,
    );

    const state = store.updateSettings({
      developerMode: true,
      cloudMode: 'custom',
      gatewayUrl: 'http://127.0.0.1:7001/',
      streamUrl: 'https://stream.example.com/',
      runtimeGatewayUrl: 'ws://127.0.0.1:7002/',
    });
    assert.equal(state.effectiveConfig.mode, 'custom');
    assert.equal(state.effectiveConfig.gatewayUrl, 'http://127.0.0.1:7001');
    assert.equal(state.effectiveConfig.streamUrl, 'https://stream.example.com');
    assert.equal(state.effectiveConfig.runtimeGatewayUrl, 'ws://127.0.0.1:7002');
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('developer settings reset returns to environment behavior', () => {
  const userDataPath = tempUserData();
  try {
    const store = createDeveloperSettingsStore({
      userDataPath,
      env: {
        ZEUS_ATLAS_CLOUD_GATEWAY_URL: 'https://cbu-xiaoer-service.alibaba-inc.com',
      },
    });

    store.updateSettings({ developerMode: true, cloudMode: 'pre' });
    const state = store.resetSettings();
    assert.equal(state.persisted, false);
    assert.equal(state.effectiveConfig.mode, 'prod');
    assert.equal(state.effectiveConfig.gatewayUrl, 'https://cbu-xiaoer-service.alibaba-inc.com');
    assert.equal(state.effectiveConfig.runtimeGatewayUrl, 'https://cbu-xiaoer-service.alibaba-inc.com');
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
