import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createScriptedTurnExecutor } from '@peer-agent/runtime-node/testing';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createDesktopGoalRunnerHost } from './goal-runner-host.mjs';

const EXPLORER_JSON = JSON.stringify({
  summary: 'explorer-found-the-module',
  findings: [],
  evidenceRefs: ['tool-result://host-explorer'],
  confidence: 'high',
});
const VERIFIER_JSON = JSON.stringify({
  passed: true,
  failedCriteria: [],
  missingEvidence: [],
  risks: [],
  evidenceRefs: ['tool-result://host-verifier'],
  recommendedNextAction: 'ship',
});

function queuedExecutor(scripts, seen) {
  const queue = scripts.map((script) => createScriptedTurnExecutor(script));
  return {
    async runTurn(input) {
      const next = queue.shift();
      if (!next) throw new Error('scripted executor has no remaining turn');
      seen.push({
        role: input.turnProfile?.role ?? null,
        content: input.messages?.map((message) => message.content).join('\n') ?? '',
      });
      return next.runTurn(input);
    },
  };
}

test('host runs one goal turn, one explorer, and one verifier through a scripted executor', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  try {
    const goalPlanStore = createGoalPlanStore();
    const plan = goalPlanStore.createPlan({
      conversationId: 'conv-host',
      title: 'Host assembly',
      goal: 'Exercise the desktop goal host',
      successCriteria: ['The host invoked each runner once'],
      tasks: [
        { taskId: 't1', order: 0, title: 'Task 1', status: 'pending', evidenceRefs: [] },
      ],
    });
    goalPlanStore.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'tester' });
    const appended = [];
    const seen = [];
    const executor = queuedExecutor([
      [{ type: 'terminal', channel: 'error', payload: { error: 'stop-after-one-goal-turn' } }],
      [
        { type: 'delta', content: EXPLORER_JSON },
        { type: 'tool', name: 'read_file', input: { path: 'README.md' } },
        { type: 'terminal', channel: 'done' },
      ],
      [
        { type: 'delta', content: VERIFIER_JSON },
        { type: 'terminal', channel: 'done' },
      ],
    ], seen);
    let visualCalls = 0;
    const host = createDesktopGoalRunnerHost({
      goalPlanStore,
      conversationStore: {
        getConversation() {
          return {
            id: 'conv-host',
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
          };
        },
        appendMessage(_id, message) {
          appended.push(message);
        },
      },
      agentTurnExecutor: executor,
      broadcast() {},
      llmChatService: {},
      goalWorktreeAdapter: null,
      goalTaskBranchAdapter: null,
      desktopPreviewProvider: null,
      runPlanVisualVerifier: async (input) => {
        visualCalls += 1;
        return { passed: true, verifierRunId: input.verifierRunId, stage: input.stage };
      },
      resolveConversationModelProviderId: () => 'model-host',
      toDesktopProviderMessages: (messages) => messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      desktopContinuityContextFromProjection: () => [],
      workspaceRoot: root,
      getMainWindows: () => [],
    });

    await host.goalRunner.start(plan.planId, { awaitIdle: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].role, 'goal_runner');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].role, 'assistant');

    const explorerReport = await host.explorerRunner.runExplorer({
      plan,
      explorer: { explorerId: 'ex-1', request: { question: 'Where is the host?' } },
    });
    assert.equal(explorerReport.summary, 'explorer-found-the-module');
    assert.equal(explorerReport.toolCallCount, 1);
    assert.deepEqual(explorerReport.allowedEvidenceRefs, []);

    const verifierReport = await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-1',
      stage: 'criteria',
      signal: null,
    });
    assert.equal(verifierReport.passed, true);
    assert.deepEqual(verifierReport.evidenceRefs, ['tool-result://host-verifier']);

    const visual = await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-visual',
      stage: 'visual',
      signal: null,
    });
    assert.equal(visualCalls, 1);
    assert.equal(visual.passed, true);

    assert.deepEqual(seen.map((turn) => turn.role), ['goal_runner', 'explorer', 'verifier']);
    assert.match(seen[0].content, /Host assembly/);
    assert.match(seen[1].content, /Explorer mission/);
    assert.match(seen[2].content, /Verifier mission/);
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
