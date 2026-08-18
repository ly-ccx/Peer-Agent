import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const STDERR_DRAIN_MS = 15;

export type NodeShellSessionStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface NodeShellSessionCommandResult {
  readonly commandId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: NodeShellSessionStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly interrupted: boolean;
  readonly truncated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sessionRebuilt: boolean;
}

export interface RunNodeShellSessionCommandOptions {
  readonly conversationId?: string | null;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface NodeShellSessionManager {
  readonly workspaceRoot: string;
  runCommand(options: RunNodeShellSessionCommandOptions): Promise<NodeShellSessionCommandResult>;
  disposeConversation(conversationId: string): Promise<void>;
  disposeAll(): Promise<void>;
}

export interface CreateNodeShellSessionManagerOptions {
  readonly workspaceRoot: string;
  readonly shellPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly now?: () => string;
  /** Runs once when a session process is created or rebuilt. Used to seed login env. */
  readonly bootstrapScript?: string;
}

interface LiveSession {
  readonly key: string;
  child: ChildProcess;
  cwd: string;
  stdout: string;
  stderr: string;
  waiters: Array<(chunk: string) => void>;
  dead: boolean;
  bootstrapped: boolean;
}

function parseCommandTrailer(chunk: string, marker: string): {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly cwd: string;
} | null {
  const head = `${marker}\n`;
  const mid = `\n${marker}\n`;
  let stdout: string;
  let rest: string;
  if (chunk.startsWith(head)) {
    stdout = '';
    rest = chunk.slice(head.length);
  } else {
    const at = chunk.indexOf(mid);
    if (at < 0) return null;
    stdout = chunk.slice(0, at);
    rest = chunk.slice(at + mid.length);
  }
  const lines = rest.split('\n');
  if (lines.length < 2 || !lines[1]) return null;
  const parsedExit = Number(lines[0]);
  return {
    stdout,
    exitCode: Number.isInteger(parsedExit) ? parsedExit : null,
    cwd: lines[1],
  };
}

export function supportsPersistentShellSession(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function resolvePersistentShellPath(preferred?: string): string {
  const candidate = preferred || process.env.SHELL || '/bin/bash';
  if (/(?:^|\/)(?:ba)?sh$|(?:^|\/)zsh$/.test(candidate)) return candidate;
  return '/bin/bash';
}

export function sessionConversationKey(
  conversationId: string | null | undefined,
  fallback: string,
): string {
  const trimmed = typeof conversationId === 'string' ? conversationId.trim() : '';
  return trimmed || fallback;
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function capText(buffer: string, next: string, maxBytes: number): { text: string; truncated: boolean } {
  const used = Buffer.byteLength(buffer);
  if (used >= maxBytes) return { text: buffer, truncated: true };
  const remaining = maxBytes - used;
  const chunk = Buffer.from(next, 'utf8');
  if (chunk.byteLength <= remaining) return { text: buffer + next, truncated: false };
  return { text: buffer + chunk.subarray(0, remaining).toString('utf8'), truncated: true };
}

function terminateGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode != null || child.signalCode != null) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });
}

export function createNodeShellSessionManager(
  options: CreateNodeShellSessionManagerOptions,
): NodeShellSessionManager {
  if (!options?.workspaceRoot) {
    throw new TypeError('Node shell session manager requires workspaceRoot.');
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const shellPath = resolvePersistentShellPath(options.shellPath);
  const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  const now = options.now ?? (() => new Date().toISOString());
  const sessions = new Map<string, LiveSession>();
  const queues = new Map<string, Promise<unknown>>();
  const spawnedKeys = new Set<string>();
  const onProcessExit = (): void => {
    for (const session of sessions.values()) {
      terminateGroup(session.child, 'SIGKILL');
    }
  };
  process.once('exit', onProcessExit);

  const drop = (session: LiveSession): void => {
    session.dead = true;
    sessions.delete(session.key);
    terminateGroup(session.child, 'SIGTERM');
    setTimeout(() => terminateGroup(session.child, 'SIGKILL'), killGraceMs).unref?.();
  };

  const spawnSession = (key: string, cwd: string): LiveSession => {
    const child = spawn(shellPath, ['-s'], {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        PS1: '',
        PS2: '',
        PROMPT_COMMAND: '',
      },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: LiveSession = {
      key,
      child,
      cwd,
      stdout: '',
      stderr: '',
      waiters: [],
      dead: false,
      bootstrapped: !options.bootstrapScript,
    };
    const notify = (): void => {
      const snapshot = session.stdout;
      for (const waiter of session.waiters) waiter(snapshot);
    };
    child.stdout?.on('data', (value: Buffer) => {
      const next = capText(session.stdout, value.toString('utf8'), maxOutputBytes);
      session.stdout = next.text;
      notify();
    });
    child.stderr?.on('data', (value: Buffer) => {
      const next = capText(session.stderr, value.toString('utf8'), maxOutputBytes);
      session.stderr = next.text;
    });
    const markDead = (): void => {
      session.dead = true;
      if (sessions.get(key) === session) sessions.delete(key);
      notify();
    };
    child.once('close', markDead);
    child.once('error', markDead);
    spawnedKeys.add(key);
    sessions.set(key, session);
    return session;
  };

  const ensureSession = (key: string): { session: LiveSession; rebuilt: boolean } => {
    const existing = sessions.get(key);
    if (existing && !existing.dead && existing.child.exitCode == null) {
      return { session: existing, rebuilt: false };
    }
    const rebuilt = spawnedKeys.has(key);
    if (existing) drop(existing);
    return { session: spawnSession(key, workspaceRoot), rebuilt };
  };

  const writeScript = (session: LiveSession, script: string): void => {
    if (!session.child.stdin || session.child.stdin.destroyed || session.dead) {
      throw new Error('shell_session_closed');
    }
    session.child.stdin.write(script);
  };

  const runLocked = async (
    key: string,
    work: (session: LiveSession, rebuilt: boolean) => Promise<NodeShellSessionCommandResult>,
  ): Promise<NodeShellSessionCommandResult> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => {
        const current = ensureSession(key);
        return work(current.session, current.rebuilt);
      },
      () => {
        const current = ensureSession(key);
        return work(current.session, current.rebuilt);
      },
    );
    queues.set(key, run.catch(() => undefined));
    return run;
  };

  const disposeKey = async (key: string): Promise<void> => {
    const session = sessions.get(key);
    if (!session) return;
    drop(session);
    await wait(25);
  };

  const interruptThenDiscard = async (
    session: LiveSession,
    reason: 'timeout' | 'cancelled',
  ): Promise<void> => {
    terminateGroup(session.child, 'SIGINT');
    await wait(Math.min(killGraceMs, 400));
    if (!session.dead) drop(session);
    void reason;
  };

  return {
    workspaceRoot,
    async runCommand(runOptions) {
      const key = sessionConversationKey(runOptions.conversationId, 'unscoped');
      const startedAt = now();
      const commandId = `shell_${randomUUID()}`;
      const marker = `__PEER_END_${randomBytes(16).toString('hex')}__`;
      const requestedCwd = typeof runOptions.cwd === 'string' && runOptions.cwd.trim()
        ? resolve(runOptions.cwd)
        : undefined;

      return runLocked(key, async (initial, alreadyRebuilt) => {
        let session = initial;
        let rebuilt = alreadyRebuilt;
        if (session.dead) {
          session = spawnSession(key, workspaceRoot);
          rebuilt = true;
        }

        const bootstrap = !session.bootstrapped && options.bootstrapScript
          ? `${options.bootstrapScript.replace(/\s*$/, '')}\n`
          : '';
        if (bootstrap) session.bootstrapped = true;
        const prefix = requestedCwd && requestedCwd !== session.cwd
          ? `cd ${posixSingleQuote(requestedCwd)} || exit $?\n`
          : '';
        const script = `${bootstrap}${prefix}${runOptions.command}
__peer_status=$?
printf '%s\\n' '${marker}' >&2
printf '\\n%s\\n' '${marker}'
printf '%s\\n' "$__peer_status"
pwd
`;
        let startStdout = session.stdout.length;
        let startStderr = session.stderr.length;
        try {
          writeScript(session, script);
        } catch {
          drop(session);
          session = spawnSession(key, workspaceRoot);
          session.bootstrapped = Boolean(bootstrap) || session.bootstrapped;
          rebuilt = true;
          startStdout = 0;
          startStderr = 0;
          writeScript(session, script);
        }

        let timedOut = false;
        let cancelled = false;
        const abort = (): void => {
          cancelled = true;
          void interruptThenDiscard(session, 'cancelled');
        };
        if (runOptions.signal?.aborted) abort();
        else runOptions.signal?.addEventListener('abort', abort, { once: true });

        const timeout = setTimeout(() => {
          timedOut = true;
          void interruptThenDiscard(session, 'timeout');
        }, Math.max(1, runOptions.timeoutMs));
        timeout.unref?.();

        let parsed = parseCommandTrailer(session.stdout.slice(startStdout), marker);
        try {
          await new Promise<void>((resolveDone, rejectDone) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              session.waiters = session.waiters.filter((waiter) => waiter !== check);
              session.child.off('error', rejectDone);
              resolveDone();
            };
            const check = (buffer: string): void => {
              parsed = parseCommandTrailer(buffer.slice(startStdout), marker);
              if (parsed || session.dead || timedOut || cancelled) finish();
            };
            session.waiters.push(check);
            session.child.once('error', rejectDone);
            check(session.stdout);
          });
        } finally {
          clearTimeout(timeout);
          runOptions.signal?.removeEventListener('abort', abort);
        }

        await wait(STDERR_DRAIN_MS);
        const stdoutChunk = session.stdout.slice(startStdout);
        const stderrChunk = session.stderr.slice(startStderr);
        parsed = parsed ?? parseCommandTrailer(stdoutChunk, marker);
        const stdout = parsed?.stdout ?? stdoutChunk;
        const exitCode = parsed?.exitCode ?? null;
        if (parsed?.cwd) session.cwd = parsed.cwd;
        const cwd = parsed?.cwd ?? session.cwd;

        const stderrMarker = `${marker}\n`;
        const stderr = stderrChunk.includes(stderrMarker)
          ? stderrChunk.slice(0, stderrChunk.indexOf(stderrMarker))
          : stderrChunk;

        const status: NodeShellSessionStatus = timedOut
          ? 'timeout'
          : cancelled
            ? 'cancelled'
            : exitCode === 0
              ? 'completed'
              : 'failed';

        const truncated = Buffer.byteLength(session.stdout) >= maxOutputBytes
          || Buffer.byteLength(session.stderr) >= maxOutputBytes;
        session.stdout = '';
        session.stderr = '';

        return {
          commandId,
          command: runOptions.command,
          cwd,
          status,
          stdout,
          stderr,
          exitCode,
          signal: timedOut || cancelled ? 'SIGINT' : null,
          timedOut,
          cancelled,
          interrupted: timedOut || cancelled,
          truncated,
          startedAt,
          completedAt: now(),
          sessionRebuilt: rebuilt,
        };
      });
    },
    disposeConversation(conversationId) {
      return disposeKey(sessionConversationKey(conversationId, conversationId));
    },
    async disposeAll() {
      process.removeListener('exit', onProcessExit);
      await Promise.all([...sessions.keys()].map((key) => disposeKey(key)));
    },
  };
}
