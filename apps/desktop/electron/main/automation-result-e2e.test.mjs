import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createAutomationStore } from './automation-store.mjs';
import { createConversationStore } from './conversation-store.mjs';
import { createAutomationOutcomeController } from './automation-outcome-controller.mjs';
import { createAutomationRunner } from './automation-runner.mjs';

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-automation-result-e2e-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runInput(definition, runId, scheduledAt) {
  return {
    automationId: definition.automationId,
    idempotencyKey: `${definition.automationId}:${runId}`,
    triggerSource: 'manual',
    status: 'queued',
    scheduledAt,
    snapshot: {
      definitionVersion: definition.version,
      name: definition.name,
      prompt: definition.prompt,
      workspacePath: definition.workspacePath,
      schedule: definition.schedule,
      grant: definition.grant,
      budget: definition.budget,
    },
  };
}

test('three persisted Runs verify first, unchanged, and changed result consumption', async () => {
  const originWorkspace = path.join(root, 'origin-workspace');
  const worktreeRoot = path.join(root, 'worktrees');
  mkdirSync(originWorkspace, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  const automationStore = createAutomationStore({ storeDir: path.join(root, 'automations') });
  const conversationStore = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const definition = automationStore.createDefinition({
    name: 'Result acceptance',
    prompt: 'Return a deterministic acceptance result.',
    workspacePath: originWorkspace,
    schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
    grant: {
      preset: 'work_in_workspace',
      workspacePath: originWorkspace,
      allowedCapabilityIds: [],
      askCapabilityIds: [],
      blockedCapabilityIds: [],
      confirmedAt: '2026-08-06T00:00:00.000Z',
      version: 1,
    },
    notifications: {
      needsAttention: 'system_and_badge',
      failed: true,
      succeeded: true,
      succeededOnlyOnChange: true,
    },
    budget: { timeoutMs: 60_000 },
    missedRunPolicy: 'run_latest',
    overlapPolicy: 'skip',
    status: 'active',
  }, { automationId: 'automation-result-e2e', now: '2026-08-06T00:00:00.000Z' });

  const results = ['AUTOMATION_RESULT_V1', 'AUTOMATION_RESULT_V1', 'AUTOMATION_RESULT_V2'];
  let resultIndex = 0;
  let id = 0;
  const shownNotifications = [];
  const notificationTargets = [];
  const outcomeController = createAutomationOutcomeController({
    store: automationStore,
    createNotification(options) {
      const listeners = new Map();
      return {
        on(event, listener) { listeners.set(event, listener); },
        show() {
          shownNotifications.push(options);
          listeners.get('click')?.();
        },
      };
    },
    openRun(target) { notificationTargets.push(target); },
    logger: { warn() {} },
  });

  const runnerTimes = [
    '2026-08-06T01:00:01.000Z', '2026-08-06T01:00:02.000Z',
    '2026-08-06T02:00:01.000Z', '2026-08-06T02:00:02.000Z',
    '2026-08-06T03:00:01.000Z', '2026-08-06T03:00:02.000Z',
  ];
  const runner = createAutomationRunner({
    store: automationStore,
    conversationStore,
    createId: () => `message-${++id}`,
    now: () => runnerTimes.shift(),
    ensureWorkspace: async () => {},
    worktreeAdapter: {
      async prepare(run) {
        const workspacePath = path.join(worktreeRoot, run.runId);
        mkdirSync(workspacePath, { recursive: true });
        return { kind: 'worktree', workspacePath, baseline: `baseline-${run.runId}` };
      },
      async collect(_run, execution) {
        return {
          worktreePath: execution.workspacePath,
          branch: 'acceptance',
          changedFiles: [],
          diffArtifactRefs: [],
          retained: false,
        };
      },
      async retainOrCleanup(_run, _execution, changes) { return changes; },
    },
    llmChatService: {
      async sendMessage(input) {
        const content = results[resultIndex++];
        conversationStore.updateMessageById(input.conversationId, input.assistantMessageId, { content });
        return { terminalStatus: 'done', evidenceRefs: [`evidence://result-${resultIndex}`] };
      },
    },
    onRunUpdated: (run) => outcomeController.handleRunUpdated(run),
  });

  const persistedRuns = [];
  for (let index = 0; index < 3; index += 1) {
    const runId = `run-${index + 1}`;
    automationStore.createRun(runInput(
      definition,
      runId,
      `2026-08-06T0${index + 1}:00:00.000Z`,
    ), { runId, now: `2026-08-06T0${index + 1}:00:00.000Z` });
    await runner.run(runId);
    persistedRuns.push(automationStore.getRun(runId));
  }

  assert.deepEqual(persistedRuns.map((run) => run.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.deepEqual(persistedRuns.map((run) => run.receipt.summary), results);
  assert.equal(persistedRuns[0].receipt.previousSummary, undefined);
  assert.equal(persistedRuns[0].receipt.resultChanged, undefined);
  assert.equal(persistedRuns[1].receipt.previousSummary, 'AUTOMATION_RESULT_V1');
  assert.equal(persistedRuns[1].receipt.resultChanged, false);
  assert.match(persistedRuns[1].receipt.comparisonSummary, /No result change/);
  assert.equal(persistedRuns[2].receipt.previousSummary, 'AUTOMATION_RESULT_V1');
  assert.equal(persistedRuns[2].receipt.resultChanged, true);
  assert.match(persistedRuns[2].receipt.comparisonSummary, /Result changed/);

  assert.equal(shownNotifications.length, 2, 'first and changed results should notify');
  assert.deepEqual(notificationTargets.map((target) => target.runId), ['run-1', 'run-3']);
  assert.equal(automationStore.getDefinition(definition.automationId).lastRunAt, persistedRuns[2].finishedAt);

  const originConversations = conversationStore.listConversationsByWorkspace(originWorkspace);
  assert.equal(originConversations.length, 3);
  assert.ok(originConversations.every((conversation) => conversation.workspacePath.startsWith(worktreeRoot)));
  assert.ok(originConversations.every((conversation) => (
    conversation.automationOrigin.originWorkspacePath === originWorkspace
  )));
  assert.deepEqual(
    new Set(originConversations.map((conversation) => conversation.automationOrigin.runId)),
    new Set(['run-1', 'run-2', 'run-3']),
  );

  const firstReceipt = structuredClone(automationStore.getRun('run-1').receipt);
  const firstConversation = originConversations.find((conversation) => conversation.automationOrigin.runId === 'run-1');
  conversationStore.appendMessage(firstConversation.id, {
    id: 'follow-up', role: 'user', content: 'Explain the result.', timestamp: Date.now(),
  });
  assert.deepEqual(automationStore.getRun('run-1').receipt, firstReceipt, 'follow-up chat must not mutate Receipt');

  const reopenedAutomationStore = createAutomationStore({ storeDir: path.join(root, 'automations') });
  const reopenedConversationStore = createConversationStore({ storeDir: path.join(root, 'conversations') });
  assert.equal(reopenedAutomationStore.getRun('run-3').receipt.summary, 'AUTOMATION_RESULT_V2');
  assert.equal(reopenedConversationStore.listConversationsByWorkspace(originWorkspace).length, 3);
});
