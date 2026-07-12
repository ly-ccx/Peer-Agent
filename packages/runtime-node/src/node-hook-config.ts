import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createNodeHookRunner,
  type CreateNodeHookRunnerOptions,
  type NodeHookConfig,
  type NodeHookDefinition,
} from './node-hook-runner.ts';

export interface LoadNodeHookConfigOptions {
  readonly userDataPath?: string;
  readonly workspaceRoot?: string;
}

export interface CreateConfiguredNodeHookRunnerOptions extends LoadNodeHookConfigOptions {
  readonly env?: CreateNodeHookRunnerOptions['env'];
}

function readJsonIfExists(path: string | undefined): unknown {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeHookList(value: unknown): readonly NodeHookDefinition[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((hook): hook is NodeHookDefinition => Boolean(
      hook
      && typeof hook === 'object'
      && typeof (hook as { command?: unknown }).command === 'string',
    ))
    .map((hook) => ({
      ...hook,
      id: typeof hook.id === 'string' ? hook.id : hook.command,
      match: hook.match && typeof hook.match === 'object' ? hook.match : { capabilityId: '*' },
      timeoutMs: Number.isFinite(hook.timeoutMs) ? hook.timeoutMs : undefined,
      onError: hook.onError === 'fail-open' || hook.onFailure === 'open' ? 'fail-open' : 'fail-closed',
    }));
}

export function mergeNodeHookConfigs(configs: readonly unknown[]): { readonly hooks: NodeHookConfig } {
  const merged: Record<'PreToolUse' | 'PostToolUse', NodeHookDefinition[]> = {
    PreToolUse: [],
    PostToolUse: [],
  };
  for (const config of configs) {
    if (!config || typeof config !== 'object') continue;
    const hooks = (config as { hooks?: unknown }).hooks;
    if (!hooks || typeof hooks !== 'object') continue;
    const record = hooks as Record<string, unknown>;
    merged.PreToolUse.push(...normalizeHookList(record.PreToolUse));
    merged.PostToolUse.push(...normalizeHookList(record.PostToolUse));
  }
  return { hooks: merged };
}

export function getNodeHookConfigPaths(options: LoadNodeHookConfigOptions = {}) {
  return {
    globalPath: options.userDataPath ? join(options.userDataPath, 'hooks', 'hooks.json') : null,
    workspacePath: options.workspaceRoot ? join(options.workspaceRoot, '.peer', 'hooks.json') : null,
  };
}

export function loadNodeHookConfig(options: LoadNodeHookConfigOptions = {}): { readonly hooks: NodeHookConfig } {
  const { globalPath, workspacePath } = getNodeHookConfigPaths(options);
  return mergeNodeHookConfigs([readJsonIfExists(globalPath ?? undefined), readJsonIfExists(workspacePath ?? undefined)]);
}

export function createConfiguredNodeHookRunner(options: CreateConfiguredNodeHookRunnerOptions = {}) {
  const config = loadNodeHookConfig(options);
  return createNodeHookRunner({
    hooks: config.hooks,
    cwd: options.workspaceRoot ?? process.cwd(),
    env: options.env,
  });
}
