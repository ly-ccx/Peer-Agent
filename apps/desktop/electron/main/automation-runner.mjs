import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

function createBackgroundWebContents(onEvent = null) {
  return {
    isDestroyed: () => false,
    send(channel, payload) {
      onEvent?.({ channel, payload });
    },
  };
}

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

export function createAutomationRunner({
  store,
  conversationStore,
  llmChatService,
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
  if (!store || !conversationStore || !llmChatService) {
    throw new Error('automation_runner_dependencies_required');
  }
  const activeRuns = new Map();

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
        const conversation = conversationStore.createConversation({
          title: `Automation: ${initial.snapshot.name}`,
          workspacePath: executionWorkspace.workspacePath,
          mode: 'goal',
          modelProviderId: initial.snapshot.modelProviderId ?? null,
        });
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
        conversationStore.appendMessage(conversation.id, userMessage);
        conversationStore.appendMessage(conversation.id, assistantMessage);
        store.updateRun(initial.runId, {
          status: 'running',
          startedAt,
          conversationId: conversation.id,
        });

        const outcome = await llmChatService.sendMessage({
          messages: [{ role: 'user', content: initial.snapshot.prompt }],
          webContents: createBackgroundWebContents(onBackgroundEvent),
          streamId: `automation:${initial.runId}:${createId()}`,
          effort: 'default',
          mode: 'goal',
          conversationId: conversation.id,
          modelProviderId: initial.snapshot.modelProviderId ?? null,
          workspacePath: executionWorkspace.workspacePath,
          assistantMessageId: assistantMessage.id,
          permissionPolicy: permissionPolicyFromGrant(initial.snapshot.grant),
          runtimeReminders: [
            `Automation run ${initial.runId}. Use only the saved Automation Grant. Do not request permanent access changes.`,
          ],
        });
        const status = terminalRunStatus(outcome);
        const finishedAt = now();
        let changes = null;
        if (worktreeAdapter && executionWorkspace?.kind === 'worktree' && status !== 'waiting_user') {
          changes = await worktreeAdapter.collect(initial, executionWorkspace);
          changes = await worktreeAdapter.retainOrCleanup(initial, executionWorkspace, changes);
        }
        const updatedRun = store.updateRun(initial.runId, {
          status,
          ...(executionWorkspace?.baseline ? {
            snapshot: { ...initial.snapshot, gitBaseline: executionWorkspace.baseline },
          } : {}),
          ...(status === 'failed' ? { failureReason: outcome?.error || 'automation_agent_failed' } : {}),
          ...(status === 'waiting_user' ? { blockedReason: 'user_input' } : {}),
          ...(status === 'succeeded' || status === 'failed' || status === 'cancelled' ? { finishedAt } : {}),
          receipt: status === 'waiting_user' ? undefined : {
            summary: outcome?.summary,
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
        activeRuns.delete(initial.runId);
      }
    })();
    activeRuns.set(initial.runId, execution);
    return execution;
  }

  return Object.freeze({
    run,
    isRunning: (runId) => activeRuns.has(runId),
  });
}
