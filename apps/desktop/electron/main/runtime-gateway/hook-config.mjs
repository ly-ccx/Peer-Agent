import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHookRunner } from './hook-runner.mjs';

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      __invalid: true,
      __error: error,
      hooks: {},
    };
  }
}

function normalizeHookList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((hook) => hook && typeof hook === 'object' && typeof hook.command === 'string')
    .map((hook) => ({
      id: typeof hook.id === 'string' ? hook.id : hook.command,
      match: hook.match && typeof hook.match === 'object' ? hook.match : { capabilityId: '*' },
      command: hook.command,
      timeoutMs: Number.isFinite(hook.timeoutMs) ? hook.timeoutMs : undefined,
      onError: hook.onError === 'fail-open' ? 'fail-open' : 'fail-closed',
    }));
}

export function mergeHookConfigs(configs = []) {
  const merged = {};
  for (const config of configs) {
    const hooks = config?.hooks && typeof config.hooks === 'object' ? config.hooks : {};
    for (const [event, list] of Object.entries(hooks)) {
      merged[event] = [
        ...(merged[event] ?? []),
        ...normalizeHookList(list),
      ];
    }
  }
  return { hooks: merged };
}

export function getHookConfigPaths({ userDataPath, workspaceRoot } = {}) {
  return {
    globalPath: userDataPath ? join(userDataPath, 'hooks', 'hooks.json') : null,
    workspacePath: workspaceRoot ? join(workspaceRoot, '.peer', 'hooks.json') : null,
  };
}

export function loadHookConfig({ userDataPath, workspaceRoot } = {}) {
  const { globalPath, workspacePath } = getHookConfigPaths({ userDataPath, workspaceRoot });
  return mergeHookConfigs([
    readJsonIfExists(globalPath),
    readJsonIfExists(workspacePath),
  ]);
}

export function createConfiguredHookRunner({ userDataPath, workspaceRoot, env } = {}) {
  const config = loadHookConfig({ userDataPath, workspaceRoot });
  return createHookRunner({
    hooks: config.hooks,
    cwd: workspaceRoot ?? process.cwd(),
    env,
  });
}
