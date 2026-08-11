import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createTaskOverviewAggregator } from './task-overview-aggregator.mjs';

const planCount = Number.parseInt(process.env.PEER_PERF_PLAN_COUNT ?? '1000', 10);
const iterations = Number.parseInt(process.env.PEER_PERF_ITERATIONS ?? '5', 10);
const storeDir = mkdtempSync(path.join(tmpdir(), 'peer-workspace-switch-perf-'));
const workspacePath = '/tmp/peer-workspace-switch-target';

try {
  const now = new Date().toISOString();
  const index = [];
  for (let i = 0; i < planCount; i += 1) {
    const planId = `perf-plan-${i}`;
    const plan = {
      planId,
      title: `Performance plan ${i}`,
      goal: 'Measure workspace switch projection cost',
      status: 'executing',
      workflowKind: 'goal_self_driven',
      conversationId: `conversation-${i}`,
      targetWorkspacePath: i === 0 ? workspacePath : `/tmp/other-workspace-${i}`,
      tasks: [{ taskId: 'work', title: 'Work', status: 'running', evidenceRefs: [] }],
      progress: { total: 1, completed: 0, failed: 0, blocked: 0, percent: 0 },
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    index.push({
      planId,
      title: plan.title,
      status: plan.status,
      workflowKind: plan.workflowKind,
      conversationId: plan.conversationId,
      threadId: null,
      originWorkspacePath: null,
      targetWorkspacePath: plan.targetWorkspacePath,
      version: plan.version,
      percent: 0,
      createdAt: now,
      updatedAt: now,
    });
    writeFileSync(path.join(storeDir, `${planId}.json`), `${JSON.stringify(plan)}\n`);
  }
  writeFileSync(path.join(storeDir, 'index.jsonl'), `${index.map((item) => JSON.stringify(item)).join('\n')}\n`);

  const goalPlanStore = createGoalPlanStore({ storeDir });
  const aggregator = createTaskOverviewAggregator({
    goalPlanStore,
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [],
    listShellTasks: () => [],
    listProviders: () => [],
  });

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now();
    const items = aggregator.listTaskOverview({ workspacePath, includeTerminal: false, limit: 200 });
    samples.push({ iteration: i + 1, items: items.length, durationMs: performance.now() - startedAt });
  }

  const coldMs = samples[0]?.durationMs ?? 0;
  const warmSamples = samples.slice(1).map((sample) => sample.durationMs);
  const warmAverageMs = warmSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, warmSamples.length);
  console.log(JSON.stringify({ planCount, coldMs, warmAverageMs, samples }, null, 2));
} finally {
  rmSync(storeDir, { recursive: true, force: true });
}
