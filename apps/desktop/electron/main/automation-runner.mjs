import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createCallbackSink } from './agent-host/turn-sinks.mjs';

function permissionPolicyFromGrant(grant) {
  return Object.freeze({
    kind: 'automation',
    preset: grant.preset,
    allowedCapabilityIds: [...grant.allowedCapabilityIds],
    askCapabilityIds: [...grant.askCapabilityIds],
    blockedCapabilityIds: [...grant.blockedCapabilityIds],
  });
}

function terminalRunStatus(outcome) {
  if (outcome?.requestedUserInput) return 'waiting_user';
  if (outcome?.terminalStatus === 'aborted' || outcome?.terminalStatus === 'cancelled') return 'cancelled';
  if (outcome?.terminalStatus === 'error' || outcome?.terminalStatus === 'failed') return 'failed';
  return 'succeeded';
}

function normalizeSummary(value, maxLength = 2_000) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function finalAssistantSummary(conversationStore, conversationId, assistantMessageId) {
  const conversation = conversationStore.getConversation?.(conversationId);
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const selected = messages.find((message) => message?.id === assistantMessageId)
    ?? [...messages].reverse().find((message) => message?.role === 'assistant');
  return normalizeSummary(selected?.content);
}

function canonicalResult(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function previousCompletedSummary(store, run) {
  const previous = store.listRuns({ automationId: run.automationId, limit: 20 })
    .find((candidate) => candidate.runId !== run.runId && candidate.receipt?.summary);
  return normalizeSummary(previous?.receipt?.summary, 1_000);
}

function resultComparison(summary, previousSummary) {
  if (!summary || !previousSummary) return {};
  const resultChanged = canonicalResult(summary) !== canonicalResult(previousSummary);
  return {
    previousSummary,
    resultChanged,
    comparisonSummary: resultChanged ? 'Result changed from the previous completed run.' : 'No result change from the previous completed run.',
  };
}

export function createAutomationRunner({
  store,
  conversationStore,
  llmChatService = null,
  classicCoreBridge = null,
  worktreeAdapter = null,
  ensureWorkspace = async (workspacePath) => {
    const info = await stat(workspacePath);
    if (!info.isDirectory()) throw new Error('automation_workspace_not_directory');
  },
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
  onBackgroundEvent = null,
  onRunUpdated = null,
  logger = console,
} = {}) {
  if (!store || !conversationStore || (!llmChatService && !classicCoreBridge)) {
    throw new Error('automation_runner_dependencies_required');
  }
  const activeRuns = new Map();
  const activeStreams = new Map();

  async function cancel(runId) {
    const entry = activeStreams.get(runId);
    if (!entry) return { aborted: false };
    if (entry.engine === 'rust') {
      return (await classicCoreBridge?.abort?.(entry.streamId)) ?? { aborted: false };
    }
    return (await llmChatService?.abort?.(entry.streamId)) ?? { aborted: false };
  }

  async function run(runOrId) {
    const initial = typeof runOrId === 'string' ? store.getRun(runOrId) : runOrId;
    if (!initial) throw new Error('automation_run_not_found');
    if (activeRuns.has(initial.runId)) return activeRuns.get(initial.runId);

    const execution = (async () => {
      const startedAt = now();
      let executionWorkspace = null;
      try {
        await ensureWorkspace(initial.snapshot.workspacePath);
        executionWorkspace = worktreeAdapter
          ? await worktreeAdapter.prepare(initial)
          : { kind: 'workspace', workspacePath: initial.snapshot.workspacePath, baseline: null };
        if (store.getRun(initial.runId)?.status === 'cancelled') {
          return store.getRun(initial.runId);
        }
        const useRustCore = Boolean(classicCoreBridge?.isAvailable?.());
        const conversationInput = {
          title: `Automation: ${initial.snapshot.name}`,
          workspacePath: executionWorkspace.workspacePath,
          mode: 'goal',
          modelProviderId: initial.snapshot.modelProviderId ?? null,
          automationOrigin: {
            kind: 'automation_run',
            automationId: initial.automationId,
            runId: initial.runId,
            automationName: initial.snapshot.name,
            triggerSource: initial.triggerSource,
            originWorkspacePath: initial.snapshot.workspacePath,
            createdAt: startedAt,
          },
        };
        const conversation = useRustCore
          ? await classicCoreBridge.createConversation(conversationInput)
          : conversationStore.createConversation(conversationInput);
        const userMessage = {
          id: createId(),
          role: 'user',
          content: initial.snapshot.prompt,
          timestamp: Date.parse(startedAt),
        };
        const assistantMessage = {
          id: createId(),
          role: 'assistant',
          content: '',
          timestamp: Date.parse(startedAt),
        };
        if (useRustCore) {
          await classicCoreBridge.appendConversationMessage({
            id: conversation.id,
            message: userMessage,
            returnMessages: false,
          });
          await classicCoreBridge.appendConversationMessage({
            id: conversation.id,
            message: assistantMessage,
            returnMessages: false,
          });
        } else {
          conversationStore.appendMessage(conversation.id, userMessage);
          conversationStore.appendMessage(conversation.id, assistantMessage);
        }
        store.updateRun(initial.runId, {
          status: 'running',
          startedAt,
          conversationId: conversation.id,
        });

        const streamId = `automation:${initial.runId}:${createId()}`;
        const runtimeReminders = [
          `Automation run ${initial.runId}. Use only the saved Automation Grant. Do not request permanent access changes.`,
        ];
        const permissionPolicy = permissionPolicyFromGrant(initial.snapshot.grant);
        const sink = createCallbackSink(onBackgroundEvent);
        activeStreams.set(initial.runId, {
          streamId,
          engine: useRustCore ? 'rust' : 'ts',
        });

        const outcome = useRustCore
          ? await classicCoreBridge.send({
              streamId,
              conversationId: conversation.id,
              assistantMessageId: assistantMessage.id,
              workspacePath: executionWorkspace.workspacePath,
              mode: 'goal',
              modelProviderId: initial.snapshot.modelProviderId ?? null,
              effort: 'default',
              persistModelSelection: true,
              permissionPolicy,
              runtimeReminders,
            }, sink)
          : await llmChatService.sendMessage({
              messages: [{ role: 'user', content: initial.snapshot.prompt }],
              webContents: sink,
              streamId,
              effort: 'default',
              mode: 'goal',
              conversationId: conversation.id,
              modelProviderId: initial.snapshot.modelProviderId ?? null,
              workspacePath: executionWorkspace.workspacePath,
              assistantMessageId: assistantMessage.id,
              permissionPolicy,
              runtimeReminders,
            });
        const status = store.getRun(initial.runId)?.status === 'cancelled'
          ? 'cancelled'
          : terminalRunStatus(outcome);
        const finishedAt = now();
        let changes = null;
        if (worktreeAdapter && executionWorkspace?.kind === 'worktree' && status !== 'waiting_user') {
          changes = await worktreeAdapter.collect(initial, executionWorkspace);
          changes = await worktreeAdapter.retainOrCleanup(initial, executionWorkspace, changes);
        }
        const summary = normalizeSummary(outcome?.summary)
          ?? normalizeSummary(outcome?.text)
          ?? finalAssistantSummary(conversationStore, conversation.id, assistantMessage.id)
          ?? (status === 'succeeded' ? 'Run completed. Open the conversation for the full result.' : undefined);
        const comparison = resultComparison(summary, previousCompletedSummary(store, initial));
        const updatedRun = store.updateRun(initial.runId, {
          status,
          ...(executionWorkspace?.baseline ? {
            snapshot: { ...initial.snapshot, gitBaseline: executionWorkspace.baseline },
          } : {}),
          ...(status === 'failed' ? { failureReason: outcome?.error || 'automation_agent_failed' } : {}),
          ...(status === 'waiting_user' ? { blockedReason: 'user_input' } : {}),
          ...(status === 'succeeded' || status === 'failed' || status === 'cancelled' ? { finishedAt } : {}),
          receipt: status === 'waiting_user' ? undefined : {
            summary,
            ...comparison,
            error: status === 'failed' ? outcome?.error || 'Automation agent failed.' : undefined,
            evidence: [],
            evidenceRefs: [
              ...(outcome?.evidenceRefs ?? []),
              ...(changes?.diffArtifactRefs ?? []),
            ],
            verifications: [],
            ...(changes ? { changes } : {}),
            inputTokens: outcome?.usage?.inputTokens,
            outputTokens: outcome?.usage?.outputTokens,
            costUsd: outcome?.usage?.costUsd,
            durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
            completedAt: finishedAt,
          },
        });
        onRunUpdated?.(updatedRun);
        return updatedRun;
      } catch (error) {
        logger?.error?.('[automation-runner] run failed', error);
        const finishedAt = now();
        let changes = null;
        if (worktreeAdapter && executionWorkspace?.kind === 'worktree') {
          try {
            changes = await worktreeAdapter.collect(initial, executionWorkspace);
            changes = await worktreeAdapter.retainOrCleanup(initial, executionWorkspace, changes);
          } catch (collectError) {
            logger?.warn?.('[automation-runner] worktree evidence collection failed', collectError);
          }
        }
        const failedRun = store.updateRun(initial.runId, {
          status: 'failed',
          ...(executionWorkspace?.baseline ? {
            snapshot: { ...initial.snapshot, gitBaseline: executionWorkspace.baseline },
          } : {}),
          startedAt: store.getRun(initial.runId)?.startedAt ?? startedAt,
          finishedAt,
          failureReason: error instanceof Error ? error.message : String(error),
          receipt: {
            error: error instanceof Error ? error.message : String(error),
            evidence: [],
            evidenceRefs: changes?.diffArtifactRefs ?? [],
            verifications: [],
            ...(changes ? { changes } : {}),
            durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
            completedAt: finishedAt,
          },
        });
        onRunUpdated?.(failedRun);
        return failedRun;
      } finally {
        activeStreams.delete(initial.runId);
        activeRuns.delete(initial.runId);
      }
    })();
    activeRuns.set(initial.runId, execution);
    return execution;
  }

  return Object.freeze({
    run,
    cancel,
    isRunning: (runId) => activeRuns.has(runId),
  });
}
