import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 3000;

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(value, pattern) {
  if (!pattern || pattern === '*') return true;
  return globToRegExp(pattern).test(String(value ?? ''));
}

function shellArgumentsString(args = {}) {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.query === 'string') return args.query;
  if (typeof args.path === 'string') return args.path;
  return JSON.stringify(args);
}

export function matchesHook(hook, payload) {
  const match = hook?.match ?? {};
  const capabilityId = payload?.call?.capabilityId;
  if (!matchesPattern(capabilityId, match.capabilityId ?? '*')) return false;

  if (match.argumentsPattern) {
    return matchesPattern(shellArgumentsString(payload?.call?.arguments), match.argumentsPattern);
  }

  return true;
}

function parseStdoutDecision(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!['allow', 'ask', 'deny'].includes(parsed?.decision)) return null;
    return {
      decision: parsed.decision,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function spawnCommand(command, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, stdout, stderr, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ timedOut: true, exitCode: null });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ error, exitCode: null }));
    child.on('close', (exitCode) => finish({ exitCode, timedOut: false }));
    child.stdin.end(JSON.stringify(input));
  });
}

function normalizeFailureDecision({ event, hook, reason, durationMs = 0 }) {
  const onError = hook.onError ?? (event === 'PostToolUse' ? 'fail-open' : 'fail-closed');
  if (event === 'PreToolUse' && onError !== 'fail-open') {
    return { decision: 'deny', reason, outcome: reason, durationMs };
  }
  return { decision: 'allow', reason, outcome: reason, durationMs };
}

async function runHookCommand({ event, hook, payload, cwd, env }) {
  const timeoutMs = Number.isFinite(hook.timeoutMs) ? hook.timeoutMs : DEFAULT_TIMEOUT_MS;
  const spawned = await spawnCommand(hook.command, { cwd, env, input: payload, timeoutMs });
  const base = {
    id: hook.id,
    event,
    command: hook.command,
    durationMs: spawned.durationMs,
  };

  if (spawned.timedOut) {
    return { ...base, ...normalizeFailureDecision({ event, hook, reason: 'timeout', durationMs: spawned.durationMs }) };
  }
  if (spawned.error) {
    return { ...base, ...normalizeFailureDecision({ event, hook, reason: 'spawn_error', durationMs: spawned.durationMs }) };
  }

  const stdoutDecision = parseStdoutDecision(spawned.stdout);
  if (stdoutDecision) {
    return {
      ...base,
      decision: stdoutDecision.decision,
      reason: stdoutDecision.reason,
      outcome: 'ok',
      exitCode: spawned.exitCode,
    };
  }

  if (spawned.exitCode !== 0) {
    return { ...base, ...normalizeFailureDecision({ event, hook, reason: 'non_zero_exit', durationMs: spawned.durationMs }), exitCode: spawned.exitCode };
  }

  return { ...base, decision: 'allow', outcome: 'ok', exitCode: spawned.exitCode };
}

export function createHookRunner({ hooks = {}, cwd = process.cwd(), env = process.env } = {}) {
  async function run(event, payload) {
    const hookList = Array.isArray(hooks[event]) ? hooks[event] : [];
    const records = [];

    for (const hook of hookList) {
      if (!hook?.command || !matchesHook(hook, payload)) continue;
      const record = await runHookCommand({ event, hook, payload: { ...payload, event }, cwd, env });
      records.push(record);
      if (event === 'PreToolUse' && record.decision === 'deny') break;
    }

    return records;
  }

  return {
    run,
    runPreToolUse: (payload) => run('PreToolUse', payload),
    runPostToolUse: (payload) => run('PostToolUse', payload),
  };
}

export function mostRestrictiveDecision(records = []) {
  if (records.some((record) => record.decision === 'deny')) return 'deny';
  if (records.some((record) => record.decision === 'ask')) return 'ask';
  return 'allow';
}
