import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { buildShellSpawnArgs } from './shell-env-snapshot.mjs';
import { readTaskListeners } from './shell-task-listeners.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER_CHARS = 2_000_000;
const PROMPT_PATTERN = /(password|passphrase|continue\?|are you sure|press any key|enter .*:|input .*:)/i;

// 子进程 PATH 兜底：Electron GUI 启动时 process.env.PATH 仅含系统裸路径，
// 即使 shell snapshot 未生效（例如创建失败、.zshrc 提前 return），
// 这里仍能保证常见 user-bin 路径可被子进程看到。
function buildFallbackPath(homeDir) {
  const segments = [
    join(homeDir, '.local/bin'),
    join(homeDir, '.qoderwork/bin'),
    join(homeDir, 'bin'),
    join(homeDir, '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const current = process.env.PATH ?? '';
  return [...segments, current].filter(Boolean).join(':');
}

function clampTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function appendCapped(current, chunk) {
  const next = `${current}${chunk}`;
  if (next.length <= MAX_BUFFER_CHARS) return next;
  return `${next.slice(0, MAX_BUFFER_CHARS)}\n...[output buffer truncated]`;
}

function terminateChild(child, signal = 'SIGTERM') {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the shell process when the process group is already gone.
    }
  }
  child.kill(signal);
}

function processGroupExists(pid) {
  if (process.platform === 'win32' || !pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// A leader exiting does not prove its children have exited. Keep the task in
// stopping until its owned group is cleared, even when children closed stdio.
async function terminateTaskGroup(task) {
  terminateChild(task.child, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (processGroupExists(task.child.pid) && Date.now() < deadline) await delay(25);
  if (processGroupExists(task.child.pid)) {
    terminateChild(task.child, 'SIGKILL');
    // Let the kernel deliver KILL before completion observers probe the port.
    for (let n = 0; n < 40 && processGroupExists(task.child.pid); n++) await delay(25);
  }
}

export function createShellTaskManager({ artifactStore, logger = console } = {}) {
  const tasks = new Map();

  function listTasks() {
    for (const task of tasks.values()) {
      if (task.status !== 'running' || !task.runInBackground || task.listenerRead) continue;
      if (Date.now() - (task.listenersReadAt ?? 0) < 2000) continue;
      task.listenerRead = readTaskListeners(task.child.pid).then((listeners) => {
        task.listeners = task.status === 'running' ? listeners : [];
        task.listenersReadAt = Date.now();
      }).finally(() => { task.listenerRead = null; });
    }
    return [...tasks.values()].map((task) => ({
      taskId: task.taskId,
      toolCallId: task.toolCallId,
      command: task.command,
      cwd: task.cwd,
      conversationId: task.conversationId,
      runInBackground: task.runInBackground,
      description: task.description,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      exitCode: task.exitCode,
      timedOut: task.timedOut,
      promptDetected: task.promptDetected,
      stopReason: task.stopReason,
      stdout: task.stdout ?? '',
      stderr: task.stderr ?? '',
      listeners: task.status === 'running' ? (task.listeners ?? []) : [],
      artifactRef: task.artifact?.artifactRef ?? null,
    }));
  }

  function stopTask(taskIdOrToolCallId) {
    const task = tasks.get(taskIdOrToolCallId)
      ?? [...tasks.values()].find((candidate) => candidate.toolCallId === taskIdOrToolCallId && candidate.status === 'running');
    if (!task) {
      return { stopped: false, reason: 'shell_task_not_found' };
    }
    if (task.status !== 'running') {
      return { stopped: false, reason: 'shell_task_not_running', taskId: task.taskId };
    }
    task.stopReason = 'user_stopped';
    task.status = 'stopping';
    task.termination ??= terminateTaskGroup(task);
    return { stopped: true, taskId: task.taskId, toolCallId: task.toolCallId };
  }

  function stopActiveTask(conversationId = null) {
    const active = [...tasks.values()].reverse().find((task) =>
      task.status === 'running' && !task.runInBackground
      && task.conversationId === conversationId);
    return active ? stopTask(active.taskId) : { stopped: false, reason: 'no_running_shell_task' };
  }

  function runTask({
    runInBackground = false,
    conversationId = null,
    toolCallId,
    command,
    cwd,
    timeoutMs,
    description,
    classification,
  }) {
    const taskId = `shell_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const timeout = runInBackground && timeoutMs == null ? null : clampTimeout(timeoutMs);
    // Shell 环境快照：有快照 → source 快照后 eval 命令（PATH 含用户 .zshrc 注入的路径）；
    // 无快照 → fallback 到 login shell（-lc）。对齐 Claude Code ShellSnapshot 机制。
    const { shell: spawnShell, args: spawnArgs } = buildShellSpawnArgs(command);
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const child = spawn(spawnShell, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        // 最后一道保险：即使 snapshot 没捕获 .local/bin，子进程启动时 PATH 也含它
        PATH: buildFallbackPath(homeDir),
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const task = {
      conversationId,
      runInBackground,
      taskId,
      toolCallId,
      command,
      cwd,
      description,
      classification,
      child,
      status: 'running',
      startedAt,
      completedAt: null,
      exitCode: null,
      timedOut: false,
      promptDetected: false,
      stopReason: null,
    };
    tasks.set(taskId, task);

    let stdout = '';
    let stderr = '';

    const timer = timeout === null ? null : setTimeout(() => {
      task.timedOut = true;
      task.stopReason = 'timeout';
      task.status = 'stopping';
      task.termination ??= terminateTaskGroup(task);
    }, timeout);

    let settled = false;
    const completion = new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout = appendCapped(stdout, text);
        task.stdout = `${task.stdout ?? ''}${text}`.slice(-32_000);
        if (PROMPT_PATTERN.test(text)) task.promptDetected = true;
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr = appendCapped(stderr, text);
        task.stderr = `${task.stderr ?? ''}${text}`.slice(-32_000);
        if (PROMPT_PATTERN.test(text)) task.promptDetected = true;
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        stderr = appendCapped(stderr, error.message);
        task.stderr = `${task.stderr ?? ''}${error.message}`.slice(-32_000);
        task.status = 'failed';
        task.completedAt = new Date().toISOString();
        logger.error?.('[runtime-gateway] shell task failed:', error);
        resolveTask(resolve);
      });

      child.on('close', async (exitCode, signal) => {
        if (settled) return;
        clearTimeout(timer);
        // Also clean an orphaned owned group if the leader exits naturally.
        if (!task.termination && processGroupExists(child.pid)) {
          task.status = 'stopping';
          task.termination = terminateTaskGroup(task);
        }
        await task.termination;
        if (settled) return;
        task.exitCode = exitCode;
        task.completedAt = new Date().toISOString();
        if (task.stopReason || task.timedOut || signal) {
          task.status = 'cancelled';
        } else {
          task.status = exitCode === 0 ? 'success' : 'failed';
        }
        resolveTask(resolve);
      });

      async function resolveTask(done) {
        if (settled) return;
        settled = true;
        task.stdout ??= '';
        task.stderr ??= '';
        let artifact = {
          artifactRef: null,
          artifactRefs: [],
          truncated: false,
        };
        if (artifactStore) {
          try {
            artifact = await artifactStore.writeTaskArtifacts({
              taskId,
              toolCallId,
              command,
              cwd,
              stdout,
              stderr,
              classification,
              startedAt,
              completedAt: task.completedAt,
              conversationId,
              runInBackground,
            });
          } catch (error) {
            task.stderr = appendCapped(task.stderr, `\nArtifact write failed: ${error.message}`);
            logger.error?.('[runtime-gateway] shell artifact failed:', error);
          }
        }
        task.artifact = artifact;
        done({
          taskId,
          toolCallId,
          status: task.status,
          exitCode: task.exitCode,
          stdout,
          stderr,
          timedOut: task.timedOut,
          interrupted: task.status === 'cancelled',
          promptDetected: task.promptDetected,
          stopReason: task.stopReason,
          startedAt,
          completedAt: task.completedAt,
          artifact,
        });
      }
    });

    task.completion = completion;
    return {
      taskId,
      startedAt,
      completion,
    };
  }

  return {
    listTasks,
    runTask,
    stopTask,
    stopActiveTask,
    async dispose() {
      const active = [...tasks.values()].filter((task) => task.status === 'running' || task.status === 'stopping');
      for (const task of active) stopTask(task.taskId);
      await Promise.all([...tasks.values()].map((task) => task.completion));
    },
  };
}
