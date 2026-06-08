import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveCloudEndpointConfig,
  sanitizeDeveloperSettings,
} from './cloud-endpoint-config.mjs';

function settingsPath(userDataPath) {
  return path.join(userDataPath, 'developer-settings.json');
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function deriveSettingsFromEffectiveConfig(config) {
  return {
    developerMode: config.developerMode,
    cloudMode: config.mode,
    ...(config.developerMode && config.gatewayUrl ? { gatewayUrl: config.gatewayUrl } : {}),
    ...(config.developerMode && config.streamUrl ? { streamUrl: config.streamUrl } : {}),
    ...(config.developerMode && config.runtimeGatewayUrl ? { runtimeGatewayUrl: config.runtimeGatewayUrl } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function createDeveloperSettingsStore({ userDataPath, env = process.env }) {
  const filePath = settingsPath(userDataPath);
  let cached = undefined;

  function readPersistedSettings() {
    if (cached !== undefined) return cached;
    const raw = readJsonFile(filePath);
    if (!raw) {
      cached = null;
      return cached;
    }
    try {
      cached = sanitizeDeveloperSettings(raw, raw.updatedAt);
    } catch {
      cached = null;
    }
    return cached;
  }

  function writePersistedSettings(settings) {
    const sanitized = sanitizeDeveloperSettings(settings);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf8');
    cached = sanitized;
    return sanitized;
  }

  function getEffectiveCloudEndpointConfig() {
    return resolveCloudEndpointConfig(env, readPersistedSettings());
  }

  function getState() {
    const persistedSettings = readPersistedSettings();
    const effectiveConfig = getEffectiveCloudEndpointConfig();
    return {
      settings: persistedSettings ?? deriveSettingsFromEffectiveConfig(effectiveConfig),
      effectiveConfig,
      persisted: Boolean(persistedSettings),
    };
  }

  function updateSettings(patch = {}) {
    const current = getState().settings;
    writePersistedSettings({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return getState();
  }

  function resetSettings() {
    cached = null;
    rmSync(filePath, { force: true });
    return getState();
  }

  return {
    getEffectiveCloudEndpointConfig,
    getState,
    resetSettings,
    updateSettings,
  };
}
