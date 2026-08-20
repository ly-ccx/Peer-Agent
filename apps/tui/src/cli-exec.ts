import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextAccountingModelKey, type LocalAccessLevel } from '@peer-agent/protocol';
import type { ModelReasoningEffort } from '@peer-agent/runtime-node';

import { createChatController } from './chat-controller.ts';
import type { PeerExecOptions } from './cli-argv.ts';
import { CLI_EXIT, type CliExitCode } from './cli-exit.ts';
import { collectPlanIds, driveNewGoalPlansToSettled, type ExecGoalDriveOutcome } from './cli-exec-goal.ts';
import { encodeExecJson, isAuthFailureReason } from './cli-output.ts';
import { resolveExecCatalogEntry } from './cli-model-ref.ts';
import { resolveExecToolAllowlist } from './cli-tools.ts';
import { createTuiConversationPersistence } from './conversation-persistence.ts';
import { createTuiRuntime } from './tui-runtime.ts';

const ACCESS_TO_LEVEL: Readonly<Record<PeerExecOptions['access'], LocalAccessLevel>> = {
  ask: 'ask_before_local',
  session: 'session_local',
  full: 'full_local',
};

const EFFORTS = new Set<ModelReasoningEffort>([
  'off',
  'low',
  'medium',
  'default',
  'high',
  'xhigh',
  'max',
]);

export interface RunPeerExecIo {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly readStdin?: () => Promise<string>;
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

async function readStream(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function lastAssistantText(messages: readonly { role: string; content: string }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.content.trim()) return message.content;
  }
  return '';
}

export async function runPeerExec(
  options: PeerExecOptions,
  io: RunPeerExecIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<CliExitCode> {
  const startedAt = Date.now();
  const stdinIsTTY = io.stdinIsTTY ?? io.stdin.isTTY === true;
  const env = io.env ?? process.env;

  if (options.access === 'ask' && !stdinIsTTY) {
    writeLine(io.stderr, 'peer exec: --access ask cannot wait for approval without a TTY');
    return CLI_EXIT.usage;
  }

  const workspaceRoot = path.resolve(options.workspace ?? env.PEER_WORKSPACE_ROOT ?? process.cwd());
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    writeLine(io.stderr, `peer exec: --workspace is not an existing directory: ${workspaceRoot}`);
    return CLI_EXIT.usage;
  }

  let toolAllowlist: readonly string[] | undefined;
  if (options.tools) {
    const resolved = resolveExecToolAllowlist(options.tools);
    if (!resolved.ok) {
      writeLine(io.stderr, resolved.message);
      return CLI_EXIT.usage;
    }
    toolAllowlist = resolved.capabilityIds;
  }

  const promptParts = options.promptParts.filter((part) => part !== '-');
  const shouldReadStdin = options.promptParts.length === 0
    || (options.promptParts.length === 1 && options.promptParts[0] === '-');
  let prompt = promptParts.join(' ').trim();
  if (shouldReadStdin) {
    if (stdinIsTTY && !prompt) {
      writeLine(io.stderr, 'peer exec: prompt is required (pass arguments or pipe stdin)');
      return CLI_EXIT.usage;
    }
    const stdinText = (await (io.readStdin ?? (() => readStream(io.stdin)))()).trim();
    if (!prompt) prompt = stdinText;
  }
  if (!prompt) {
    writeLine(io.stderr, 'peer exec: prompt is required (pass arguments or pipe stdin)');
    return CLI_EXIT.usage;
  }

  const userDataPath = env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
  const runtime = createTuiRuntime({
    workspaceRoot,
    userDataPath,
    accessLevel: ACCESS_TO_LEVEL[options.access],
    toolAllowlist,
    denyInteractiveTools: true,
  });

  try {
  if (!runtime.modelConfig.configured) {
    writeLine(io.stderr, 'peer exec: model is not configured');
    return CLI_EXIT.auth;
  }

  const current = runtime.modelSelection.getSelection();
  if (options.provider || options.model) {
    const resolved = resolveExecCatalogEntry(runtime.modelSelection.catalog, {
      provider: options.provider,
      model: options.model,
    });
    if (!resolved.ok) {
      writeLine(io.stderr, resolved.message);
      return CLI_EXIT.usage;
    }
    const match = runtime.modelSelection.catalog.find((entry) => (
      entry.providerId === resolved.entry.providerId
      && entry.modelId === resolved.entry.modelId
    ));
    if (!match?.available) {
      writeLine(io.stderr, `peer exec: ${resolved.entry.providerId} has no credential for ${resolved.entry.modelId}`);
      return CLI_EXIT.auth;
    }
    runtime.modelSelection.setSelection({
      providerId: match.providerId,
      modelId: match.modelId,
      reasoningEffort: match.supportedReasoningEfforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : match.defaultReasoningEffort,
    });
  }
  if (options.effort) {
    if (!EFFORTS.has(options.effort as ModelReasoningEffort)) {
      writeLine(io.stderr, `peer exec: unknown --effort ${options.effort}`);
      return CLI_EXIT.usage;
    }
    const selection = runtime.modelSelection.getSelection();
    const entry = runtime.modelSelection.catalog.find((item) => (
      item.providerId === selection.providerId && item.modelId === selection.modelId
    ));
    const effort = options.effort as ModelReasoningEffort;
    if (entry && !entry.supportedReasoningEfforts.includes(effort)) {
      writeLine(io.stderr, `peer exec: --effort ${effort} is not supported by ${selection.modelId}`);
      return CLI_EXIT.usage;
    }
    runtime.modelSelection.setSelection({
      ...selection,
      reasoningEffort: effort,
    });
  }

  const persistence = createTuiConversationPersistence({
    workspacePath: workspaceRoot,
    initialMode: options.mode,
    initialModel: runtime.modelSelection.getSelection(),
    getContextWindow: (selection) => runtime.modelSelection.catalog.find((entry) => (
      entry.providerId === selection.providerId && entry.modelId === selection.modelId
    ))?.contextWindow,
  });
  const controller = createChatController({
    host: runtime.host,
    model: runtime.model,
    initialMode: options.mode,
    getConversationId: () => persistence.ensureConversation(),
    getContextWindow: () => {
      const selection = runtime.modelSelection.getSelection();
      return runtime.modelSelection.catalog.find((entry) => (
        entry.providerId === selection.providerId && entry.modelId === selection.modelId
      ))?.contextWindow;
    },
    getModelKey: () => {
      const selection = runtime.modelSelection.getSelection();
      return contextAccountingModelKey(selection.providerId, selection.modelId);
    },
  });

  const onSignal = () => {
    controller.cancel();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // Goal 自驱闭环：send() 前采集本会话计划基线，send() 后如有新计划则由
  // 共享 Goal Runner 驱动至终态（详见 cli-exec-goal.ts 模块注释）。
  const goalBridge = runtime.host.goalBridge;
  const conversationIdForGoal = () => persistence.getConversationId() ?? undefined;
  const planIdsBefore = goalBridge
    ? collectPlanIds(goalBridge, conversationIdForGoal())
    : new Set<string>();

  try {
    const sendResult = await controller.send(prompt, {
      // RuntimePipeline defaults to 64 when maxTurns is omitted.
      maxTurns: options.maxTurns ?? Number.POSITIVE_INFINITY,
    });

    // 模型在本轮创建了 GoalPlan 且尚未到终态 → exec 进程内驱动到终态/停止态。
    let goalOutcome: ExecGoalDriveOutcome | null = null;
    if (goalBridge) {
      goalOutcome = await driveNewGoalPlansToSettled({
        bridge: goalBridge,
        chat: controller,
        getConversationId: conversationIdForGoal,
        planIdsBefore,
      });
      persistence.syncSnapshot(controller.getSnapshot());
    }

    persistence.syncSnapshot(controller.getSnapshot());
    const snapshot = controller.getSnapshot();
    const resultText = sendResult.output?.trim() || lastAssistantText(snapshot.messages);
    const error = sendResult.status === 'completed' || sendResult.status === 'stopped'
      ? null
      : (sendResult.reason || snapshot.error || sendResult.status);
    const ok = sendResult.status === 'completed' || sendResult.status === 'stopped';
    const payload = {
      sessionId: persistence.getConversationId() ?? '',
      ok,
      result: resultText || null,
      error,
      turns: sendResult.turns,
      durationMs: Date.now() - startedAt,
      ...(snapshot.usage ? { usage: snapshot.usage } : {}),
      ...(goalOutcome?.report ? { goal: goalOutcome.report } : {}),
    };

    if (options.outputFormat === 'json') {
      writeLine(io.stdout, encodeExecJson(payload));
    } else if (resultText) {
      writeLine(io.stdout, resultText);
    }
    if (!ok && options.outputFormat !== 'json' && error) {
      writeLine(io.stderr, error);
    }

    if (sendResult.status === 'exhausted') return CLI_EXIT.maxTurns;
    if (sendResult.status === 'cancelled') return CLI_EXIT.cancelled;
    // Goal 自驱结果的退出码优先级高于单轮 send 的兜底：计划终态/停止态是更强的信号。
    if (goalOutcome?.drove) {
      if (goalOutcome.exitKind === 'waiting_user') return CLI_EXIT.waitingUser;
      if (goalOutcome.exitKind === 'goal_failed') return CLI_EXIT.goalFailed;
      // exitKind === 'ok' | 'cancelled'：计划完成/取消沿用下方常规路径。
    }
    if (ok) return CLI_EXIT.ok;
    if (isAuthFailureReason(error ?? undefined)) return CLI_EXIT.auth;
    return CLI_EXIT.runtime;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  } finally {
    await runtime.dispose();
  }
}
