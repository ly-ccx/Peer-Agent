import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { classifyShellCommand } from './shell-classifier.mjs';
import { createShellArtifactStore } from './shell-artifacts.mjs';
import { createPermissionReview } from './permission-review.mjs';
import { redactShellOutput, outputRedactions } from './shell-redaction.mjs';
import { createShellTaskManager } from './shell-task-manager.mjs';

export { classifyShellCommand } from './shell-classifier.mjs';

const MAX_CONTEXT_STREAM_CHARS = 4_000;

function readShellArgs(call) {
  // arguments 优先，但如果是空对象要 fallback 到 argumentsPreview——
  // normalizeClientToolCall 构造 ClientToolCall 时只设 argumentsPreview
  // 字段（来自 dispatching event 的 argumentsPreview），不设 arguments。
  // 如果 arguments 存在但没有 command 字段，也应该 fallback。
  const args = call.arguments && typeof call.arguments === 'object'
    ? call.arguments
    : null;
  if (args && Object.keys(args).length > 0 && (args.command || args.cwd)) {
    return args;
  }
  return call.argumentsPreview && typeof call.argumentsPreview === 'object'
    ? call.argumentsPreview
    : args ?? {};
}

function nowIso() {
  return new Date().toISOString();
}

function createGrant({ toolCallId, granted, classification, decision }) {
  return {
    grantId: randomUUID(),
    toolCallId,
    granted: Boolean(granted),
    duration: granted ? (decision.ruleId ? 'scope' : 'once') : 'denied',
    scope: `local.shell.exec:${classification?.category ?? 'unknown'}`,
    decidedAt: nowIso(),
  };
}

function previewText(value, maxChars = MAX_CONTEXT_STREAM_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const headChars = Math.max(1_000, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(800, maxChars - headChars - 80);
  return {
    text: `${text.slice(0, headChars)}\n...[context preview truncated: ${text.length} chars]...\n${text.slice(-tailChars)}`,
    truncated: true,
  };
}

function lineCount(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  return text.split('\n').length;
}

function quoteShellPath(filePath) {
  return `"${String(filePath ?? '').replace(/(["\\$`])/g, '\\$1')}"`;
}

function buildSuggestedRetrieval({ artifact, status }) {
  if (!artifact?.stdoutPath && !artifact?.stderrPath) return [];
  const suggestions = [];
  if (artifact.stdoutPath) {
    suggestions.push(`rg -n "FAIL|Error|error|failed|Expected|panic" ${quoteShellPath(artifact.stdoutPath)}`);
    suggestions.push(`tail -n 120 ${quoteShellPath(artifact.stdoutPath)}`);
  }
  if (status !== 'success' && artifact.stderrPath) {
    suggestions.push(`sed -n '1,160p' ${quoteShellPath(artifact.stderrPath)}`);
  }
  return suggestions;
}

function buildLocalToolResultRef({ call, classification, taskOutput, stdoutPreview, stderrPreview, contextTruncated }) {
  const artifact = taskOutput.artifact ?? {};
  return {
    kind: 'local_tool_result_ref',
    command: classification.command,
    cwd: classification.cwd,
    exitCode: taskOutput.exitCode,
    status: taskOutput.status,
    stdoutPath: artifact.stdoutPath ?? null,
    stderrPath: artifact.stderrPath ?? null,
    metadataPath: artifact.metadataPath ?? null,
    artifactRef: artifact.artifactRef ?? null,
    artifactRefs: artifact.artifactRefs ?? [],
    stdoutChars: String(taskOutput.stdout ?? '').length,
    stderrChars: String(taskOutput.stderr ?? '').length,
    stdoutLines: lineCount(taskOutput.stdout),
    stderrLines: lineCount(taskOutput.stderr),
    stdoutPreview: stdoutPreview || null,
    stderrPreview: stderrPreview || null,
    contextPreviewTruncated: contextTruncated,
    suggestedRetrieval: buildSuggestedRetrieval({ artifact, status: taskOutput.status }),
    toolCallId: call.toolCallId,
  };
}

function deniedResult({ call, locale, classification, decision }) {
  const reason = decision.reason || classification.reason;
  return {
    toolCallId: call.toolCallId,
    status: 'denied',
    outputPreview: {
      status: 'permission_denied',
      reason,
      category: classification.category,
      riskLevel: classification.riskLevel,
      cwd: classification.cwd,
      features: classification.features ?? [],
    },
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary: locale === 'zh-CN'
        ? `本地 Shell 指令未执行：${reason}。`
        : `Local shell command was not executed: ${reason}.`,
      locale,
      returnedToCloud: false,
      dataLevel: classification.dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt: nowIso(),
  };
}

function invalidCommandResult({ call, locale, reason }) {
  return {
    grant: {
      grantId: randomUUID(),
      toolCallId: call.toolCallId,
      granted: false,
      duration: 'denied',
      scope: 'local.shell.exec:invalid',
      decidedAt: nowIso(),
    },
    result: {
      toolCallId: call.toolCallId,
      status: 'denied',
      outputPreview: {
        status: 'invalid_shell_call',
        reason,
      },
      evidence: {
        evidenceId: randomUUID(),
        toolCallId: call.toolCallId,
        summary: locale === 'zh-CN'
          ? `本地 Shell 指令无效：${reason}。`
          : `Local shell command is invalid: ${reason}.`,
        locale,
        returnedToCloud: false,
        dataLevel: 'D0_public',
        redactions: [],
        artifactRefs: [],
      },
      completedAt: nowIso(),
    },
  };
}

function shellRunResult({ call, locale, classification, taskOutput, runMode = 'foreground' }) {
  const redactedStdout = redactShellOutput(taskOutput.stdout);
  const redactedStderr = redactShellOutput(taskOutput.stderr);
  const stdoutPreview = previewText(redactedStdout);
  const stderrPreview = previewText(redactedStderr);
  const redactions = outputRedactions(taskOutput.stdout, taskOutput.stderr, redactedStdout, redactedStderr);
  if (taskOutput.artifact?.truncated) redactions.push('artifact_truncated');
  if (stdoutPreview.truncated || stderrPreview.truncated) redactions.push('context_preview_truncated');
  const status = taskOutput.status;
  const summary = locale === 'zh-CN'
    ? `本地 Shell 指令执行完成，状态：${status}，退出码：${taskOutput.exitCode ?? '-'}。`
    : `Local shell command completed with status ${status}, exit code ${taskOutput.exitCode ?? '-'}.`;
  const localToolResultRef = buildLocalToolResultRef({
    call,
    classification,
    taskOutput,
    stdoutPreview: stdoutPreview.text,
    stderrPreview: stderrPreview.text,
    contextTruncated: stdoutPreview.truncated || stderrPreview.truncated,
  });

  return {
    toolCallId: call.toolCallId,
    status,
    outputPreview: {
      status,
      exitCode: taskOutput.exitCode,
      stdout: stdoutPreview.text || null,
      stderr: stderrPreview.text || null,
      stdoutPreview: stdoutPreview.text || null,
      stderrPreview: stderrPreview.text || null,
      stdoutChars: localToolResultRef.stdoutChars,
      stderrChars: localToolResultRef.stderrChars,
      stdoutLines: localToolResultRef.stdoutLines,
      stderrLines: localToolResultRef.stderrLines,
      contextPreviewTruncated: localToolResultRef.contextPreviewTruncated,
      interrupted: taskOutput.interrupted,
      timedOut: taskOutput.timedOut,
      promptDetected: taskOutput.promptDetected,
      backgroundTaskId: taskOutput.taskId,
      outputArtifactRef: taskOutput.artifact?.artifactRef ?? null,
      outputArtifactPath: taskOutput.artifact?.localPath ?? null,
      stdoutArtifactPath: taskOutput.artifact?.stdoutPath ?? null,
      stderrArtifactPath: taskOutput.artifact?.stderrPath ?? null,
      metadataArtifactPath: taskOutput.artifact?.metadataPath ?? null,
      suggestedRetrieval: localToolResultRef.suggestedRetrieval,
      localToolResultRef,
      category: classification.category,
      riskLevel: classification.riskLevel,
      cwd: classification.cwd,
      runMode,
      backgroundCompleted: runMode === 'background',
    },
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary,
      locale,
      returnedToCloud: false,
      dataLevel: classification.dataLevel,
      redactions: [...new Set(redactions)],
      artifactRefs: taskOutput.artifact?.artifactRefs ?? [],
    },
    completedAt: taskOutput.completedAt ?? nowIso(),
  };
}

function shellBackgroundStartedResult({ call, locale, classification, task }) {
  const summary = locale === 'zh-CN'
    ? `本地 Shell 后台任务已启动：${task.taskId}。`
    : `Local shell background task started: ${task.taskId}.`;
  return {
    toolCallId: call.toolCallId,
    status: 'success',
    outputPreview: {
      status: 'running',
      exitCode: null,
      stdout: null,
      stderr: null,
      stdoutPreview: null,
      stderrPreview: null,
      interrupted: false,
      timedOut: false,
      promptDetected: false,
      backgroundTaskId: task.taskId,
      outputArtifactRef: null,
      category: classification.category,
      riskLevel: classification.riskLevel,
      cwd: classification.cwd,
    },
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary,
      locale,
      returnedToCloud: false,
      dataLevel: classification.dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt: nowIso(),
  };
}

function shellStopResult({ call, locale, stopResult }) {
  const granted = Boolean(stopResult.stopped || stopResult.reason === 'shell_task_not_running');
  return {
    grant: {
      grantId: randomUUID(),
      toolCallId: call.toolCallId,
      granted,
      duration: granted ? 'once' : 'denied',
      scope: 'local.shell.stop',
      decidedAt: nowIso(),
    },
    result: {
      toolCallId: call.toolCallId,
      status: stopResult.stopped ? 'success' : 'failed',
      outputPreview: stopResult,
      evidence: {
        evidenceId: randomUUID(),
        toolCallId: call.toolCallId,
        summary: locale === 'zh-CN'
          ? `本地 Shell 停止请求结果：${stopResult.stopped ? '已发送停止信号' : stopResult.reason}。`
          : `Local shell stop result: ${stopResult.stopped ? 'stop signal sent' : stopResult.reason}.`,
        locale,
        returnedToCloud: false,
        dataLevel: 'D1_internal',
        redactions: [],
        artifactRefs: [],
      },
      completedAt: nowIso(),
    },
  };
}

export function createLocalShellProvider({
  workspaceRoot,
  userDataPath = os.tmpdir(),
  approvalDecider,
  permissionReview = createPermissionReview({ userDataPath, workspaceRoot, approvalDecider }),
  artifactStore = createShellArtifactStore({ userDataPath }),
  taskManager = createShellTaskManager({ artifactStore }),
} = {}) {
  async function execute(call, locale, context = {}) {
    const args = readShellArgs(call);
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) {
      return invalidCommandResult({ call, locale, reason: 'empty_command' });
    }

    let classification;
    try {
      classification = classifyShellCommand({
        command,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        workspaceRoot,
      });
    } catch (error) {
      classification = {
        allowed: false,
        category: 'invalid',
        reason: error.code ?? 'invalid_cwd',
        riskLevel: 'L4_privileged',
        dataLevel: 'D2_sensitive',
        requiresApproval: false,
        defaultBehavior: 'deny',
        command,
        cwd: workspaceRoot,
        features: [],
      };
    }

    const decision = await permissionReview.decideShellExecution({
      call,
      classification,
      localApproval: context.localApproval,
    });
    const grant = createGrant({
      toolCallId: call.toolCallId,
      granted: decision.granted,
      classification,
      decision,
    });

    if (!decision.granted) {
      return {
        grant,
        result: deniedResult({ call, locale, classification, decision }),
      };
    }

    const task = taskManager.runTask({
      toolCallId: call.toolCallId,
      command,
      cwd: classification.cwd,
      timeoutMs: args.timeoutMs,
      description: typeof args.description === 'string' ? args.description : call.reason,
      classification,
    });

    if (args.runInBackground === true) {
      if (typeof context.emitFollowUpExecution === 'function') {
        task.completion
          .then((taskOutput) => context.emitFollowUpExecution({
            call,
            grant,
            result: shellRunResult({
              call,
              locale,
              classification,
              taskOutput,
              runMode: 'background',
            }),
          }))
          .catch(() => undefined);
      } else {
        task.completion.catch(() => undefined);
      }
      return {
        grant,
        result: shellBackgroundStartedResult({ call, locale, classification, task }),
      };
    }

    const taskOutput = await task.completion;
    return {
      grant,
      result: shellRunResult({ call, locale, classification, taskOutput }),
    };
  }

  async function stop(call, locale) {
    const args = readShellArgs(call);
    const stopResult = args.taskId || args.backgroundTaskId || args.toolCallId
      ? taskManager.stopTask(args.taskId || args.backgroundTaskId || args.toolCallId)
      : taskManager.stopActiveTask();
    return shellStopResult({ call, locale, stopResult });
  }

  async function executeCapability(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    if (call.capabilityId === 'local.shell.exec') {
      const { grant, result } = await execute(call, locale, context);
      return { call, grant, result };
    }
    if (call.capabilityId === 'local.shell.stop') {
      const { grant, result } = await stop(call, locale);
      return { call, grant, result };
    }
    return null;
  }

  return {
    providerId: 'local.shell',
    capabilityIds: ['local.shell.exec', 'local.shell.stop'],
    executeCapability,
    execute,
    stop,
    listTasks: taskManager.listTasks,
    stopTask: taskManager.stopTask,
    stopActiveTask: taskManager.stopActiveTask,
    permissionReview,
  };
}

export async function executeLocalShell({
  call,
  workspaceRoot,
  locale,
  permissionDecider,
  userDataPath = os.tmpdir(),
}) {
  const provider = createLocalShellProvider({
    workspaceRoot,
    userDataPath,
    approvalDecider: permissionDecider,
  });
  return provider.execute(call, locale);
}
