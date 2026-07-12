import { spawn } from 'node:child_process';

import { mostRestrictiveHookDecision, type RuntimeDecision } from '@peer-agent/runtime-core';
import type {
  RuntimeSdkHookPayload,
  RuntimeSdkHookRecord,
  RuntimeSdkHookRunner,
} from '@peer-agent/runtime-sdk';

const DEFAULT_TIMEOUT_MS = 3_000;

export type NodeHookEvent = 'PreToolUse' | 'PostToolUse';
export type NodeHookFailureMode = 'open' | 'closed';

export interface NodeHookDefinition {
  readonly id?: string;
  readonly command: string;
  readonly match?: {
    readonly capabilityId?: string;
    readonly argumentsPattern?: string;
  };
  readonly timeoutMs?: number;
  readonly onFailure?: NodeHookFailureMode;
  readonly onError?: 'fail-open' | 'fail-closed';
}

export interface NodeHookConfig {
  readonly PreToolUse?: readonly NodeHookDefinition[];
  readonly PostToolUse?: readonly NodeHookDefinition[];
}

export interface CreateNodeHookRunnerOptions {
  readonly hooks?: NodeHookConfig;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(value: unknown, pattern?: string): boolean {
  if (!pattern || pattern === '*') return true;
  return globToRegExp(pattern).test(String(value ?? ''));
}

function argumentsString(args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    for (const key of ['command', 'query', 'path']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return JSON.stringify(args ?? {});
}

export function matchesNodeHook(hook: NodeHookDefinition, payload: RuntimeSdkHookPayload): boolean {
  const match = hook.match ?? {};
  if (!matchesPattern(payload.call.capabilityId, match.capabilityId ?? '*')) return false;
  return !match.argumentsPattern || matchesPattern(argumentsString(payload.call.arguments), match.argumentsPattern);
}

function failureDecision(event: NodeHookEvent, hook: NodeHookDefinition): RuntimeDecision {
  if (hook.onFailure === 'open' || hook.onError === 'fail-open') return 'allow';
  return event === 'PreToolUse' ? 'deny' : 'allow';
}

function parseDecision(stdout: string): { decision: RuntimeDecision; reason?: string } | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown };
    if (parsed.decision !== 'allow' && parsed.decision !== 'ask' && parsed.decision !== 'deny') return null;
    return {
      decision: parsed.decision,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

interface SpawnOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut?: boolean;
  readonly error?: string;
}

function spawnCommand(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (outcome: Omit<SpawnOutcome, 'stdout' | 'stderr' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, stdout, stderr, durationMs: Date.now() - startedAt });
    };

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ timedOut: true, exitCode: null });
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => finish({ error: error.message, exitCode: null }));
    child.on('close', (exitCode) => finish({ exitCode }));
    child.stdin.end(options.input);
  });
}

async function runNodeHookCommand(options: {
  event: NodeHookEvent;
  hook: NodeHookDefinition;
  payload: RuntimeSdkHookPayload;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<RuntimeSdkHookRecord> {
  const spawned = await spawnCommand(options.hook.command, {
    cwd: options.cwd,
    env: options.env,
    input: JSON.stringify({ ...options.payload, event: options.event }),
    timeoutMs: options.hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const base = {
    id: options.hook.id ?? options.hook.command,
    hookId: options.hook.id ?? options.hook.command,
    event: options.event,
    command: options.hook.command,
    durationMs: spawned.durationMs,
    exitCode: spawned.exitCode,
  };
  const failure = (reason: string): RuntimeSdkHookRecord => ({
    ...base,
    decision: failureDecision(options.event, options.hook),
    reason,
    outcome: reason,
  });

  if (spawned.timedOut) return failure('timeout');
  if (spawned.error) return failure('spawn_error');
  const parsed = parseDecision(spawned.stdout);
  if (parsed) return { ...base, ...parsed, outcome: 'ok' };
  if (spawned.exitCode !== 0) return failure('non_zero_exit');
  return { ...base, decision: 'allow', outcome: 'ok' };
}

export function createNodeHookRunner(options: CreateNodeHookRunnerOptions = {}): RuntimeSdkHookRunner {
  const hooks = options.hooks ?? {};
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  async function run(event: NodeHookEvent, payload: RuntimeSdkHookPayload): Promise<readonly RuntimeSdkHookRecord[]> {
    const definitions = hooks[event] ?? [];
    const records: RuntimeSdkHookRecord[] = [];
    for (const hook of definitions) {
      if (!hook.command || !matchesNodeHook(hook, payload)) continue;
      const record = await runNodeHookCommand({ event, hook, payload, cwd, env });
      records.push(record);
      if (event === 'PreToolUse' && record.decision === 'deny') break;
    }
    return records;
  }

  return {
    runPreToolUse: (payload) => run('PreToolUse', payload),
    runPostToolUse: (payload) => run('PostToolUse', payload),
  };
}

export function mostRestrictiveNodeHookDecision(records: readonly RuntimeSdkHookRecord[] = []): RuntimeDecision {
  return mostRestrictiveHookDecision(records);
}
