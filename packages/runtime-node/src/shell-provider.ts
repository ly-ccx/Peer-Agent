import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import type {
  CapabilityManifest,
  CapabilityProvider,
  RuntimeToolResult,
} from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';

import type { NodeShellProviderOptions } from './provider-contracts.ts';
import {
  asRecord,
  createNodePermissionGrant,
  createNodeToolResult,
  createProviderRuntimeClock,
} from './provider-utils.ts';
import { classifyNodeShellCommand } from './shell-classifier.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const PREVIEW_CHARS = 4_000;

export const NODE_SHELL_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: 'local.shell.exec',
    displayName: 'Run shell command',
    description: 'Run a shell command inside the active workspace with risk-based approval.',
    riskLevel: 'L3_sensitive',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
]);

interface ShellOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

function normalizeTimeout(value: unknown, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function capOutput(buffer: string, value: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(buffer) >= maxBytes) return { text: buffer, truncated: true };
  const remaining = maxBytes - Buffer.byteLength(buffer);
  if (value.byteLength <= remaining) return { text: buffer + value.toString('utf8'), truncated: false };
  return { text: buffer + value.subarray(0, remaining).toString('utf8'), truncated: true };
}

async function runShellCommand({
  shellPath,
  command,
  cwd,
  env,
  timeoutMs,
  maxOutputBytes,
  signal,
}: {
  readonly shellPath: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}): Promise<ShellOutput> {
  if (signal?.aborted) {
    return {
      stdout: '', stderr: '', exitCode: null, signal: null,
      timedOut: false, cancelled: true, truncated: false,
    };
  }

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(shellPath, ['-lc', command], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const kill = (killSignal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, killSignal);
          return;
        } catch {
          // Fall back to the direct child when the process group has already exited.
        }
      }
      if (!child.killed) child.kill(killSignal);
    };
    const stop = () => {
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 250).unref();
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = capOutput(stdout, chunk, maxOutputBytes);
      stdout = next.text;
      truncated ||= next.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = capOutput(stderr, chunk, maxOutputBytes);
      stderr = next.text;
      truncated ||= next.truncated;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        stdout,
        stderr,
        exitCode,
        signal: closeSignal,
        timedOut,
        cancelled,
        truncated,
      });
    });
  });
}

function requireCommand(input: Record<string, unknown>): string {
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw new Error('invalid_command');
  }
  return input.command.trim();
}

function classificationMetadata(classification: ReturnType<typeof classifyNodeShellCommand>): Readonly<Record<string, unknown>> {
  return {
    allowed: classification.allowed,
    command: classification.command,
    cwd: classification.cwd,
    category: classification.category,
    riskLevel: classification.riskLevel,
    decision: classification.decision,
    reason: classification.reason,
  };
}

export function createNodeShellProvider(options: NodeShellProviderOptions): CapabilityProvider {
  if (!options?.workspaceRoot) {
    throw new TypeError('Node shell provider requires workspaceRoot.');
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shellPath = options.shellPath || process.env.SHELL || '/bin/sh';

  return {
    providerId: 'runtime-node.shell',
    capabilities: NODE_SHELL_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = request.toolCall as RuntimeSdkToolCall;
      const input = asRecord(request.input ?? request.toolCall.input);
      try {
        const command = requireCommand(input);
        const classification = classifyNodeShellCommand({
          command,
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
          workspaceRoot,
        });
        const classificationData = classificationMetadata(classification);
        if (classification.decision === 'deny' || !classification.allowed) {
          const reason = classification.reason;
          return createNodeToolResult({
            clock,
            call,
            status: 'denied',
            summary: `Shell command denied: ${reason}.`,
            grant: createNodePermissionGrant({
              clock,
              call,
              decision: 'deny',
              reason,
              metadata: classificationData,
            }),
            error: { code: reason, message: reason, recoverable: false },
            metadata: classificationData,
          });
        }

        if (classification.decision === 'ask') {
          const approval = options.requestApproval
            ? await options.requestApproval({
                tool: call.capabilityId,
                toolName: 'Run shell command',
                capabilityId: call.capabilityId,
                args: input,
                workspacePath: workspaceRoot,
                reason: `${classification.category}: ${command}`,
                confirmation: {
                  kind: 'capability-approval',
                  approvalKind: 'shell-exec',
                  reason: 'shell_execution_requires_approval',
                },
                scope: {
                  kind: 'capability-approval',
                  capabilityId: call.capabilityId,
                  workspaceRoot,
                },
                riskLevel: classification.riskLevel,
                dataLevel: 'D1_internal',
                metadata: classificationData,
              })
            : { granted: false, reason: 'approval_unavailable' };
          if (!approval.granted) {
            const reason = approval.reason || 'user_denied';
            return createNodeToolResult({
              clock,
              call,
              status: 'denied',
              summary: `Shell command denied: ${reason}.`,
              grant: createNodePermissionGrant({
                clock,
                call,
                decision: 'deny',
                reason,
                metadata: classificationData,
              }),
              error: { code: reason, message: reason, recoverable: true },
              metadata: classificationData,
            });
          }
        }

        if (context.signal?.aborted) {
          return createNodeToolResult({
            clock,
            call,
            status: 'cancelled',
            summary: 'Shell command was cancelled.',
            error: { code: 'aborted', message: 'aborted', recoverable: true },
            metadata: classificationData,
          });
        }
        const timeoutMs = normalizeTimeout(input.timeoutMs, defaultTimeoutMs, maxTimeoutMs);
        const shellOutput = await runShellCommand({
          shellPath,
          command,
          cwd: classification.cwd,
          env: { ...process.env, ...(options.env ?? {}) },
          timeoutMs,
          maxOutputBytes,
          signal: context.signal,
        });
        const status: RuntimeToolResult['status'] = shellOutput.cancelled
          ? 'cancelled'
          : shellOutput.timedOut
            ? 'timeout'
            : shellOutput.exitCode === 0
              ? 'completed'
              : 'failed';
        const grant = createNodePermissionGrant({
          clock,
          call,
          decision: 'allow',
          reason: classification.decision === 'allow' ? 'classified_readonly' : 'approved_shell_execution',
          metadata: classificationData,
        });
        return createNodeToolResult({
          clock,
          call,
          status,
          summary: shellOutput.cancelled
            ? 'Shell command was cancelled.'
            : shellOutput.timedOut
              ? `Shell command timed out after ${timeoutMs}ms.`
              : `Shell command exited with code ${shellOutput.exitCode}.`,
          output: { command, cwd: classification.cwd, ...shellOutput },
          outputPreview: {
            command,
            stdout: shellOutput.stdout.slice(0, PREVIEW_CHARS),
            stderr: shellOutput.stderr.slice(0, PREVIEW_CHARS),
            exitCode: shellOutput.exitCode,
            timedOut: shellOutput.timedOut,
            cancelled: shellOutput.cancelled,
            truncated: shellOutput.truncated,
          },
          grant,
          error: status === 'completed'
            ? undefined
            : {
                code: status === 'timeout' ? 'shell_timeout' : status === 'cancelled' ? 'aborted' : 'shell_exit_nonzero',
                message: status,
                recoverable: true,
              },
          metadata: { ...classification, timeoutMs },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createNodeToolResult({
          clock,
          call,
          status: reason === 'aborted' ? 'cancelled' : 'failed',
          summary: `Shell capability failed: ${reason}.`,
          grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
          error: { code: reason, message: reason, recoverable: true },
        });
      }
    },
  };
}
