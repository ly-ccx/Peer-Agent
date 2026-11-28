import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { trackExecutionHandle } from './project-agent/execution-handles.mjs';

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const STDERR_DRAIN_MS = 15;
const GROUP_CONFIRM_MS = 750;

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
  readonly toolCallId?: string;
  readonly conversationId?: string | null;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Recheck host authority after queueing, immediately before each command write. Throw to refuse dispatch. */
  readonly beforeExecute?: (cwd: string) => void;
  readonly ownership?: NodeShellCommandOwnership;
}

export interface NodeShellCommandOwnership {
  beforeSpawn(): { started(pid: number | undefined): void; stopped(): void };
  beforeWrite(pid: number | undefined): void;
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
  readonly child: ChildProcess;
  readonly complete: (output: { completedAt: string }) => void;
  readonly recordStop?: () => void;
  cwd: string;
  stdout: string;
  stderr: string;
  waiters: Array<(chunk: string) => void>;
  dead: boolean;
  closed: boolean;
  groupEnded: boolean;
  stopping?: Promise<void>;
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

function terminateGroup(session: LiveSession, signal: NodeJS.Signals): void {
  if (groupEnded(session)) return;
  const { child } = session;
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        session.groupEnded = true;
        return;
      }
    }
  }
  if (child.exitCode != null || child.signalCode != null) return;
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function groupEnded(session: LiveSession): boolean {
  if (session.groupEnded) return true;
  const pid = session.child.pid;
  if (!pid) return session.closed;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    // Once the original group is absent, never signal a later reuse of its ID.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') session.groupEnded = true;
  }
  return session.groupEnded;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });
}

async function waitForStop(session: LiveSession, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    if (groupEnded(session) && session.closed) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await wait(Math.min(25, remaining));
  }
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
  let disposed = false;
  const onProcessExit = (): void => {
    for (const session of sessions.values()) {
      terminateGroup(session, 'SIGKILL');
    }
  };
  process.once('exit', onProcessExit);

  const drain = async (session: LiveSession, interrupt: boolean): Promise<void> => {
    if (interrupt) {
      terminateGroup(session, 'SIGINT');
      if (await waitForStop(session, Math.min(killGraceMs, 400))) return;
    }
    if (groupEnded(session) && session.closed) return;
    terminateGroup(session, 'SIGTERM');
    if (await waitForStop(session, killGraceMs)) return;
    terminateGroup(session, 'SIGKILL');
    if (!await waitForStop(session, GROUP_CONFIRM_MS)) {
      throw new Error('shell_session_stop_unconfirmed');
    }
  };

  const stopSession = (session: LiveSession, interrupt = false): Promise<void> => {
    if (session.stopping) return session.stopping;
    session.dead = true;
    const stop = drain(session, interrupt).then(() => {
      session.recordStop?.();
      if (sessions.get(session.key) === session) sessions.delete(session.key);
      session.complete({ completedAt: now() });
    });
    session.stopping = stop;
    void stop.catch(() => { session.stopping = undefined; });
    return stop;
  };

  const spawnSession = (key: string, cwd: string, toolCallId?: string, ownership?: NodeShellCommandOwnership): LiveSession => {
    const record = ownership?.beforeSpawn();
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
    let close!: (output: { completedAt: string }) => void;
    const completion = new Promise<{ completedAt: string }>(resolveClose => { close = resolveClose; });
    const session: LiveSession = {
      key,
      child,
      complete: close,
      recordStop: record?.stopped,
      cwd,
      stdout: '',
      stderr: '',
      waiters: [],
      dead: false,
      closed: false,
      groupEnded: false,
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
      notify();
    };
    child.once('exit', () => {
      markDead();
      void stopSession(session).catch(() => {});
    });
    child.once('close', () => {
      session.closed = true;
      markDead();
      void stopSession(session).catch(() => {});
    });
    child.once('error', markDead);
    spawnedKeys.add(key);
    sessions.set(key, session);
    if (toolCallId) trackExecutionHandle({ conversationId: key, handleId: `shell-session:${randomUUID()}`, toolCallId,
      completion, stop: () => stopSession(session) });
    try { record?.started(child.pid); }
    catch (error) { void stopSession(session).catch(() => {}); throw error; }
    return session;
  };

  const ensureSession = async (key: string, admit: () => void, toolCallId?: string, ownership?: NodeShellCommandOwnership): Promise<{ session: LiveSession; rebuilt: boolean }> => {
    const existing = sessions.get(key);
    if (existing && !existing.dead && existing.child.exitCode == null) {
      return { session: existing, rebuilt: false };
    }
    const rebuilt = spawnedKeys.has(key);
    if (existing) await stopSession(existing);
    admit();
    return { session: spawnSession(key, workspaceRoot, toolCallId, ownership), rebuilt };
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
    admit: (cwd: string) => void,
    requestedCwd?: string,
    toolCallId?: string,
    ownership?: NodeShellCommandOwnership,
  ): Promise<NodeShellSessionCommandResult> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const start = async () => {
      const check = () => {
        if (disposed) throw new Error('shell_session_closed');
        admit(requestedCwd || sessions.get(key)?.cwd || workspaceRoot);
      };
      const current = await ensureSession(key, check, toolCallId, ownership);
      return work(current.session, current.rebuilt);
    };
    const run = previous.then(start, start);
    queues.set(key, run.catch(() => undefined));
    return run;
  };

  const disposeKey = async (key: string): Promise<void> => {
    const session = sessions.get(key);
    if (session) await stopSession(session);
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
        if (disposed) throw new Error('shell_session_closed');
        runOptions.beforeExecute?.(requestedCwd || initial.cwd);
        let session = initial;
        let rebuilt = alreadyRebuilt;
        if (session.dead) {
          await stopSession(session);
          if (disposed) throw new Error('shell_session_closed');
          runOptions.beforeExecute?.(requestedCwd || workspaceRoot);
          session = spawnSession(key, workspaceRoot, runOptions.toolCallId, runOptions.ownership);
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
          runOptions.ownership?.beforeWrite(session.child.pid);
          writeScript(session, script);
        } catch (error) {
          await stopSession(session);
          if (runOptions.ownership) throw error;
          if (disposed) throw new Error('shell_session_closed');
          runOptions.beforeExecute?.(requestedCwd || workspaceRoot);
          session = spawnSession(key, workspaceRoot, runOptions.toolCallId);
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
          void stopSession(session, true).catch(() => {});
        };
        if (runOptions.signal?.aborted) abort();
        else runOptions.signal?.addEventListener('abort', abort, { once: true });

        const timeout = setTimeout(() => {
          timedOut = true;
          void stopSession(session, true).catch(() => {});
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
              if (parsed || session.closed || timedOut || cancelled) finish();
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
      }, cwd => runOptions.beforeExecute?.(cwd), requestedCwd, runOptions.toolCallId, runOptions.ownership);
    },
    disposeConversation(conversationId) {
      return disposeKey(sessionConversationKey(conversationId, conversationId));
    },
    async disposeAll() {
      disposed = true;
      const outcomes = await Promise.allSettled([...sessions.keys()].map(disposeKey));
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      process.removeListener('exit', onProcessExit);
    },
  };
}
