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
import {
  createNodeShellTaskManager,
  type NodeShellTaskOutput,
} from './shell-task-manager.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const PREVIEW_CHARS = 4_000;
const SHELL_MODE_SCOPES = Object.freeze(['chat', 'goal'] as const);

export const NODE_SHELL_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: 'local.shell.exec',
    displayName: 'Run shell command',
    description: 'Run a foreground or background shell command inside the active workspace with risk-based approval.',
    riskLevel: 'L3_sensitive',
    modeScopes: SHELL_MODE_SCOPES,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
        background: { type: 'boolean' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.shell.stop',
    displayName: 'Stop shell task',
    description: 'Stop a shell task started by this host and workspace using its opaque task id.',
    riskLevel: 'L2_low_write',
    modeScopes: SHELL_MODE_SCOPES,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 43, maxLength: 43 },
        reason: { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
]);

function normalizeTimeout(value: unknown, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function requireCommand(input: Record<string, unknown>): string {
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw new Error('invalid_command');
  }
  return input.command.trim();
}

function requireTaskId(input: Record<string, unknown>): string {
  if (typeof input.taskId !== 'string' || !/^shell_[0-9a-f-]{36}$/i.test(input.taskId.trim())) {
    throw new Error('invalid_task_id');
  }
  return input.taskId.trim();
}

function stopReason(input: Record<string, unknown>): string | undefined {
  if (typeof input.reason !== 'string') return undefined;
  return input.reason.trim() || undefined;
}

function classificationMetadata(
  classification: ReturnType<typeof classifyNodeShellCommand>,
): Readonly<Record<string, unknown>> {
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

function taskOutputPayload(output: NodeShellTaskOutput): Readonly<Record<string, unknown>> {
  return {
    taskId: output.taskId,
    toolCallId: output.toolCallId,
    command: output.command,
    cwd: output.cwd,
    status: output.status,
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.exitCode,
    signal: output.signal,
    timedOut: output.timedOut,
    cancelled: output.cancelled,
    interrupted: output.interrupted,
    stopReason: output.stopReason,
    truncated: output.truncated,
    startedAt: output.startedAt,
    completedAt: output.completedAt,
    artifactRef: output.artifact.artifactRef,
    artifactRefs: output.artifact.artifactRefs,
  };
}

function taskOutputPreview(output: NodeShellTaskOutput): Readonly<Record<string, unknown>> {
  return {
    taskId: output.taskId,
    status: output.status,
    command: output.command,
    stdout: output.stdout.slice(0, PREVIEW_CHARS),
    stderr: output.stderr.slice(0, PREVIEW_CHARS),
    exitCode: output.exitCode,
    signal: output.signal,
    timedOut: output.timedOut,
    cancelled: output.cancelled,
    interrupted: output.interrupted,
    stopReason: output.stopReason,
    truncated: output.truncated,
    artifactRef: output.artifact.artifactRef,
    artifactRefs: output.artifact.artifactRefs,
  };
}

function taskResultStatus(output: NodeShellTaskOutput): RuntimeToolResult['status'] {
  return output.status;
}

function taskError(output: NodeShellTaskOutput): RuntimeToolResult['error'] | undefined {
  if (output.status === 'completed') return undefined;
  const code = output.status === 'timeout'
    ? 'shell_timeout'
    : output.status === 'cancelled'
      ? 'aborted'
      : 'shell_exit_nonzero';
  return {
    code,
    message: output.stopReason ?? output.status,
    recoverable: true,
  };
}

function taskSummary(output: NodeShellTaskOutput, timeoutMs: number): string {
  if (output.status === 'cancelled') return 'Shell command was cancelled.';
  if (output.status === 'timeout') return `Shell command timed out after ${timeoutMs}ms.`;
  return `Shell command exited with code ${output.exitCode}.`;
}

export function createNodeShellProvider(options: NodeShellProviderOptions): CapabilityProvider {
  if (!options?.workspaceRoot) {
    throw new TypeError('Node shell provider requires workspaceRoot.');
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const taskManager = options.taskManager ?? createNodeShellTaskManager({
    workspaceRoot,
    artifactRoot: options.artifactRoot,
    shellPath: options.shellPath,
    env: options.env,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs: options.killGraceMs,
    now: clock.now,
  });

  return {
    providerId: 'runtime-node.shell',
    capabilities: NODE_SHELL_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = request.toolCall as RuntimeSdkToolCall;
      const input = asRecord(request.input ?? request.toolCall.input);
      try {
        if (call.capabilityId === 'local.shell.stop') {
          const taskId = requireTaskId(input);
          const result = await taskManager.stopTask(taskId, stopReason(input));
          const grant = createNodePermissionGrant({
            clock,
            call,
            decision: 'allow',
            reason: 'shell_task_stop_same_scope',
            metadata: { taskId, workspaceRoot },
          });
          if (!result.found) {
            return createNodeToolResult({
              clock,
              call,
              status: 'failed',
              summary: `Shell task not found: ${taskId}.`,
              output: result,
              outputPreview: result,
              grant,
              error: {
                code: 'shell_task_not_found',
                message: result.reason,
                recoverable: true,
              },
              metadata: { taskId, workspaceRoot },
            });
          }

          const artifactRefs = result.artifact?.artifactRefs ?? [];
          const output = {
            taskId: result.taskId,
            stopped: result.stopped,
            status: result.status,
            reason: result.reason,
            artifactRef: result.artifact?.artifactRef ?? null,
            artifactRefs,
            ...(result.output ? { task: taskOutputPayload(result.output) } : {}),
          };
          return createNodeToolResult({
            clock,
            call,
            status: 'completed',
            summary: result.stopped
              ? `Shell task stopped: ${result.taskId}.`
              : `Shell task was already ${result.status}: ${result.taskId}.`,
            output,
            outputPreview: {
              taskId: result.taskId,
              stopped: result.stopped,
              status: result.status,
              reason: result.reason,
              artifactRef: result.artifact?.artifactRef ?? null,
              artifactRefs,
            },
            grant,
            artifactRefs,
            metadata: {
              taskId: result.taskId,
              stopped: result.stopped,
              taskStatus: result.status,
              workspaceRoot,
            },
          });
        }

        if (call.capabilityId !== 'local.shell.exec') {
          throw new Error(`unsupported_shell_capability:${call.capabilityId}`);
        }

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
                reason: 'Shell execution requires local approval.',
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
        const background = input.background === true;
        const task = await taskManager.runTask({
          toolCallId: call.toolCallId,
          command,
          cwd: classification.cwd,
          timeoutMs,
          classification: classificationData,
          signal: background ? undefined : context.signal,
        });
        const grant = createNodePermissionGrant({
          clock,
          call,
          decision: 'allow',
          reason: classification.decision === 'allow'
            ? 'classified_readonly'
            : 'approved_shell_execution',
          metadata: classificationData,
        });

        if (background) {
          const artifactRefs = task.artifact.artifactRefs;
          const output = {
            taskId: task.taskId,
            backgroundTaskId: task.taskId,
            toolCallId: task.toolCallId,
            command,
            cwd: classification.cwd,
            status: 'running',
            startedAt: task.startedAt,
            timeoutMs,
            artifactRef: task.artifact.artifactRef,
            artifactRefs,
          };
          return createNodeToolResult({
            clock,
            call,
            status: 'completed',
            summary: `Shell background task started: ${task.taskId}.`,
            output,
            outputPreview: output,
            grant,
            artifactRefs,
            metadata: {
              ...classificationData,
              taskId: task.taskId,
              timeoutMs,
              background: true,
            },
          });
        }

        const shellOutput = await task.completion;
        const status = taskResultStatus(shellOutput);
        return createNodeToolResult({
          clock,
          call,
          status,
          summary: taskSummary(shellOutput, timeoutMs),
          output: taskOutputPayload(shellOutput),
          outputPreview: taskOutputPreview(shellOutput),
          grant,
          error: taskError(shellOutput),
          artifactRefs: shellOutput.artifact.artifactRefs,
          metadata: {
            ...classificationData,
            taskId: task.taskId,
            timeoutMs,
            background: false,
          },
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
