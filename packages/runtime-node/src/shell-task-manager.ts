import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  createNodeShellArtifactStore,
  type NodeShellArtifactDescriptor,
  type NodeShellArtifactMetadata,
  type NodeShellArtifactStore,
} from './shell-artifact-store.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export type NodeShellTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface NodeShellTaskOutput {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: Exclude<NodeShellTaskStatus, 'running'>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly interrupted: boolean;
  readonly stopReason: string | null;
  readonly truncated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifact: NodeShellArtifactDescriptor;
}

export interface NodeShellTaskHandle {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly startedAt: string;
  readonly status: 'running';
  readonly artifact: NodeShellArtifactDescriptor;
  readonly completion: Promise<NodeShellTaskOutput>;
}

export interface NodeShellTaskSnapshot {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: NodeShellTaskStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly stopReason: string | null;
  readonly artifact: NodeShellArtifactDescriptor;
}

export interface NodeShellStopResult {
  readonly found: boolean;
  readonly stopped: boolean;
  readonly taskId: string;
  readonly status: NodeShellTaskStatus | 'not_found';
  readonly reason: string;
  readonly artifact?: NodeShellArtifactDescriptor;
  readonly output?: NodeShellTaskOutput;
}

export interface RunNodeShellTaskOptions {
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly classification?: unknown;
  readonly signal?: AbortSignal;
}

export interface NodeShellTaskManager {
  readonly workspaceRoot: string;
  runTask(options: RunNodeShellTaskOptions): Promise<NodeShellTaskHandle>;
  stopTask(taskId: string, reason?: string): Promise<NodeShellStopResult>;
  getTask(taskId: string): NodeShellTaskSnapshot | null;
  listTasks(): readonly NodeShellTaskSnapshot[];
}

export interface CreateNodeShellTaskManagerOptions {
  readonly workspaceRoot: string;
  readonly artifactStore?: NodeShellArtifactStore;
  readonly artifactRoot?: string;
  readonly shellPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly now?: () => string;
  readonly taskIdFactory?: () => string;
  readonly logger?: Pick<Console, 'warn'>;
}

interface MutableTask {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd: string;
  readonly classification?: unknown;
  readonly child: ChildProcess;
  readonly artifact: Awaited<ReturnType<NodeShellArtifactStore['createTaskArtifact']>>;
  readonly startedAt: string;
  readonly completion: Promise<NodeShellTaskOutput>;
  status: NodeShellTaskStatus;
  completedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  interrupted: boolean;
  stopReason: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
}

function normalizeTaskId(factory: () => string): string {
  const raw = String(factory()).trim();
  const taskId = raw.startsWith('shell_') ? raw : `shell_${raw}`;
  if (!/^shell_[0-9a-f-]{36}$/i.test(taskId)) {
    throw new TypeError('Shell task ids must use shell_<uuid>.');
  }
  return taskId;
}

function normalizeReason(reason: string | undefined): string {
  const normalized = String(reason ?? '').trim();
  return normalized || 'user_requested';
}

function capOutput(
  buffer: string,
  value: Buffer,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const used = Buffer.byteLength(buffer);
  if (used >= maxBytes) return { text: buffer, truncated: true };
  const remaining = maxBytes - used;
  if (value.byteLength <= remaining) {
    return { text: buffer + value.toString('utf8'), truncated: false };
  }
  return {
    text: buffer + value.subarray(0, remaining).toString('utf8'),
    truncated: true,
  };
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.exitCode != null || child.signalCode != null) return false;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall through to the direct child signal when the process group is already gone.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function snapshot(task: MutableTask): NodeShellTaskSnapshot {
  return {
    taskId: task.taskId,
    toolCallId: task.toolCallId,
    command: task.command,
    cwd: task.cwd,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    exitCode: task.exitCode,
    signal: task.signal,
    timedOut: task.timedOut,
    interrupted: task.interrupted,
    stopReason: task.stopReason,
    artifact: task.artifact.descriptor,
  };
}

export function createNodeShellTaskManager(
  options: CreateNodeShellTaskManagerOptions,
): NodeShellTaskManager {
  if (!options?.workspaceRoot) {
    throw new TypeError('Node shell task manager requires workspaceRoot.');
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const artifactStore = options.artifactStore ?? createNodeShellArtifactStore({
    rootPath: options.artifactRoot,
  });
  const shellPath = options.shellPath ?? process.env.SHELL ?? '/bin/sh';
  const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  const now = options.now ?? (() => new Date().toISOString());
  const taskIdFactory = options.taskIdFactory ?? randomUUID;
  const logger = options.logger ?? console;
  const tasks = new Map<string, MutableTask>();

  const clearTaskTimers = (task: MutableTask): void => {
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    if (task.killTimer) clearTimeout(task.killTimer);
    task.timeoutTimer = null;
    task.killTimer = null;
    if (task.abortSignal && task.abortListener) {
      task.abortSignal.removeEventListener('abort', task.abortListener);
    }
    task.abortSignal = null;
    task.abortListener = null;
  };

  const requestStop = (task: MutableTask, reason: string): boolean => {
    if (task.status !== 'running') return false;
    task.stopReason = normalizeReason(reason);
    task.timedOut = task.stopReason === 'timeout';
    task.interrupted = true;
    const sent = terminateChild(task.child, 'SIGTERM');
    if (!task.killTimer) {
      task.killTimer = setTimeout(() => {
        if (task.status === 'running') terminateChild(task.child, 'SIGKILL');
      }, killGraceMs);
      task.killTimer.unref?.();
    }
    return sent;
  };

  return {
    workspaceRoot,
    async runTask(runOptions) {
      const taskId = normalizeTaskId(taskIdFactory);
      const startedAt = now();
      const metadata: NodeShellArtifactMetadata = {
        taskId,
        toolCallId: runOptions.toolCallId,
        command: runOptions.command,
        cwd: runOptions.cwd,
        workspaceRoot,
        classification: runOptions.classification,
        startedAt,
        completedAt: null,
        status: 'running',
        exitCode: null,
        signal: null,
        timedOut: false,
        interrupted: false,
        stopReason: null,
      };
      const artifact = await artifactStore.createTaskArtifact(metadata);
      const child = spawn(shellPath, ['-lc', runOptions.command], {
        cwd: runOptions.cwd,
        env: { ...process.env, ...options.env },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolveCompletion!: (output: NodeShellTaskOutput) => void;
      let settled = false;
      const completion = new Promise<NodeShellTaskOutput>((resolveCompletionPromise) => {
        resolveCompletion = resolveCompletionPromise;
      });
      const task: MutableTask = {
        taskId,
        toolCallId: runOptions.toolCallId,
        command: runOptions.command,
        cwd: runOptions.cwd,
        classification: runOptions.classification,
        child,
        artifact,
        startedAt,
        completion,
        status: 'running',
        completedAt: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        interrupted: false,
        stopReason: null,
        stdout: '',
        stderr: '',
        truncated: false,
        killTimer: null,
        timeoutTimer: null,
        abortSignal: null,
        abortListener: null,
      };
      tasks.set(taskId, task);

      const appendArtifact = (stream: 'stdout' | 'stderr', value: Buffer): void => {
        const write = stream === 'stdout'
          ? artifact.appendStdout(value.toString('utf8'))
          : artifact.appendStderr(value.toString('utf8'));
        void write.catch((error) => {
          logger.warn(`[runtime-node] failed to append ${stream} for ${taskId}:`, error);
        });
      };

      child.stdout?.on('data', (value: Buffer) => {
        const next = capOutput(task.stdout, value, maxOutputBytes);
        task.stdout = next.text;
        task.truncated ||= next.truncated;
        appendArtifact('stdout', value);
      });
      child.stderr?.on('data', (value: Buffer) => {
        const next = capOutput(task.stderr, value, maxOutputBytes);
        task.stderr = next.text;
        task.truncated ||= next.truncated;
        appendArtifact('stderr', value);
      });

      const settle = async (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        spawnError?: Error,
      ): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTaskTimers(task);
        task.exitCode = exitCode;
        task.signal = signal;
        task.completedAt = now();
        task.status = task.timedOut
          ? 'timeout'
          : task.stopReason
            ? 'cancelled'
            : spawnError || exitCode !== 0
              ? 'failed'
              : 'completed';
        if (spawnError) {
          const message = `${spawnError.message}\n`;
          task.stderr += message;
          void artifact.appendStderr(message).catch(() => undefined);
        }

        let finalArtifact = artifact.descriptor;
        try {
          finalArtifact = await artifact.finalize({
            ...metadata,
            completedAt: task.completedAt,
            status: task.status,
            exitCode: task.exitCode,
            signal: task.signal,
            timedOut: task.timedOut,
            interrupted: task.interrupted,
            stopReason: task.stopReason,
            truncated: task.truncated || artifact.descriptor.truncated,
          });
        } catch (error) {
          logger.warn(`[runtime-node] failed to finalize shell artifact for ${taskId}:`, error);
        }
        resolveCompletion({
          taskId,
          toolCallId: task.toolCallId,
          command: task.command,
          cwd: task.cwd,
          status: task.status as Exclude<NodeShellTaskStatus, 'running'>,
          stdout: task.stdout,
          stderr: task.stderr,
          exitCode: task.exitCode,
          signal: task.signal,
          timedOut: task.timedOut,
          cancelled: task.status === 'cancelled',
          interrupted: task.interrupted,
          stopReason: task.stopReason,
          truncated: task.truncated || finalArtifact.truncated,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          artifact: finalArtifact,
        });
      };

      const spawned = new Promise<void>((resolveSpawned, rejectSpawned) => {
        child.once('spawn', resolveSpawned);
        child.once('error', (error) => {
          void settle(null, null, error);
          rejectSpawned(error);
        });
      });
      child.once('close', (exitCode, signal) => {
        void settle(exitCode, signal);
      });

      task.timeoutTimer = setTimeout(() => {
        requestStop(task, 'timeout');
      }, Math.max(1, runOptions.timeoutMs));
      task.timeoutTimer.unref?.();

      if (runOptions.signal) {
        task.abortSignal = runOptions.signal;
        task.abortListener = () => requestStop(task, 'aborted');
        runOptions.signal.addEventListener('abort', task.abortListener, { once: true });
        if (runOptions.signal.aborted) requestStop(task, 'aborted');
      }

      try {
        await spawned;
      } catch (error) {
        await completion;
        throw error;
      }

      return {
        taskId,
        toolCallId: runOptions.toolCallId,
        startedAt,
        status: 'running',
        artifact: artifact.descriptor,
        completion,
      };
    },
    async stopTask(taskId, reason) {
      const normalizedTaskId = String(taskId ?? '').trim();
      const normalizedReason = normalizeReason(reason);
      const task = tasks.get(normalizedTaskId);
      if (!task) {
        return {
          found: false,
          stopped: false,
          taskId: normalizedTaskId,
          status: 'not_found',
          reason: 'task_not_found',
        };
      }
      if (task.status !== 'running') {
        const output = await task.completion;
        return {
          found: true,
          stopped: false,
          taskId: task.taskId,
          status: task.status,
          reason: 'task_not_running',
          artifact: output.artifact,
          output,
        };
      }
      requestStop(task, normalizedReason);
      const output = await task.completion;
      return {
        found: true,
        stopped: true,
        taskId: task.taskId,
        status: output.status,
        reason: output.stopReason ?? normalizedReason,
        artifact: output.artifact,
        output,
      };
    },
    getTask(taskId) {
      const task = tasks.get(String(taskId ?? '').trim());
      return task ? snapshot(task) : null;
    },
    listTasks() {
      return [...tasks.values()].map(snapshot);
    },
  };
}
