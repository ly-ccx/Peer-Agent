import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore } from '../../../../../packages/runtime-node/src/goal-plan-store.mjs';
import { createProjectAgentHost } from '../../../../../packages/runtime-node/src/project-agent/runtime-host.mjs';
import { createSessionSupervisor } from '../../../../../packages/runtime-node/src/project-agent/session-supervisor.mjs';
import { setDiagnosticPhaseObserver } from '../../../../../packages/runtime-node/src/diagnostic-phase.mjs';
import { pathToFileURL } from 'node:url';
import { createDelegationFactsReader } from './delegation-facts-reader.mjs';

const WORKSPACE_ID = 'ws-1';

function modelSelection() {
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'mp', family: 'f' };
  return { worker: model, explorer: model, verifier: model, resolvedAt: '2026-11-07T00:00:00.000Z' };
}

test('one host sweep normalizes both large plans once, then the same instances stay cached', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watch-sweep-large-'));
  const workspacePath = path.join(dir, 'workspace');
  mkdirSync(workspacePath);
  const phases = [];
  const observe = (name, fields) => phases.push({ name, ...fields });
  const previous = setDiagnosticPhaseObserver(observe);
  let restoreBuilt = () => {};
  try {
    const built = await import(pathToFileURL(path.join(
      import.meta.dirname, '../../../../../packages/runtime-node/dist/diagnostic-phase.mjs',
    )).href);
    const prior = built.setDiagnosticPhaseObserver(observe);
    restoreBuilt = () => built.setDiagnosticPhaseObserver(prior);
  } catch { /* 未构建时只观察源码模块。 */ }
  const timers = new Map();
  let nextId = 1;
  try {
    const planDir = path.join(dir, 'goal-plans');
    const writer = createGoalPlanStore({ storeDir: planDir });
    const conversations = createConversationStore({ storeDir: path.join(dir, 'conversations') });
    const conversation = conversations.createConversation({
      role: 'project_agent', workspaceId: WORKSPACE_ID, title: 'bot', workspacePath,
    });
    for (const bytes of [90 * 1024 * 1024, 80 * 1024 * 1024]) {
      const plan = writer.createPlan({
        title: 't', goal: 'g', conversationId: conversation.id, originWorkspacePath: workspacePath,
      });
      writer.revisePlan(plan.planId, {
        status: 'completed',
        originWorkspacePath: workspacePath,
        delegationOrigin: {
          sessionId: `session-${bytes}`,
          workspaceId: WORKSPACE_ID,
          phase: 'running',
          parentConversationId: conversation.id,
          anchorMessageId: 'anchor',
          inputId: 'input',
          modelSelection: modelSelection(),
        },
        tasks: [{
          taskId: 't', title: 't', status: 'completed', updatedAt: '2026-11-07T03:00:00.000Z',
          result: 'x'.repeat(bytes), subtasks: [],
        }],
      });
    }
    const plans = createGoalPlanStore({ storeDir: planDir });
    const reader = createDelegationFactsReader({ conversationStore: conversations, goalPlanStore: plans });
    let lastFacts = null;
    const supervisor = createSessionSupervisor({
      conversationStore: conversations,
      goalPlanStore: plans,
      deferRecovery: true,
      canManageWorkspace: () => true,
      autonomousCoordinationEnabled: () => false,
    });
    const host = createProjectAgentHost({
      rootDir: path.join(dir, 'runtime'),
      executeTurn: async () => ({ ok: true }),
      holdsLease: () => true,
      readLeaseEpoch: () => 'host:1',
      listWorkspaceIds: () => [WORKSPACE_ID],
      resolveConversationId: () => conversation.id,
      readFacts: (workspaceId) => {
        lastFacts = reader(workspaceId);
        return lastFacts;
      },
      reconcileSessions: () => supervisor.reconcile(),
      schedule: (fn) => {
        const id = nextId;
        nextId += 1;
        timers.set(id, fn);
        return id;
      },
      clearSchedule: (id) => { timers.delete(id); },
      now: () => new Date('2026-11-07T04:00:00.000Z'),
    });
    async function sweep() {
      const pending = [...timers.entries()];
      assert.equal(pending.length, 1);
      timers.delete(pending[0][0]);
      phases.length = 0;
      const started = performance.now();
      await pending[0][1]();
      return { ms: performance.now() - started, phases: phases.splice(0) };
    }
    const first = await sweep();
    const second = await sweep();
    host.dispose();
    assert.equal(lastFacts.sessions.length, 2);
    const tally = (sample) => {
      const out = {};
      for (const phase of sample.phases) {
        const row = out[phase.name] || { calls: 0, miss: 0, ms: 0, plans: 0 };
        row.calls += 1;
        if (phase.hit === 0) row.miss += 1;
        row.ms += phase.ms || 0;
        if (Number.isFinite(phase.plans)) row.plans = phase.plans;
        out[phase.name] = row;
      }
      return out;
    };
    const firstTallies = tally(first);
    const secondTallies = tally(second);
    const detail = JSON.stringify({ firstMs: Math.round(first.ms), secondMs: Math.round(second.ms), first: firstTallies, second: secondTallies });
    assert.equal(firstTallies['watch.readFacts'].plans, 2, detail);
    assert.ok(firstTallies['watch.readFacts'].miss >= 1, detail);
    assert.equal(secondTallies['watch.readFacts'].miss, 0, detail);
    assert.ok(firstTallies['plan.normalize'].miss >= 2, detail);
    assert.equal(secondTallies['plan.normalize'].miss, 0, detail);
    assert.ok(firstTallies['plan.reportRevision'].miss >= 2, detail);
    assert.equal(secondTallies['plan.reportRevision']?.miss || 0, 0, detail);
    assert.ok(firstTallies['plan.catalog'].miss >= 2, detail);
    assert.equal(secondTallies['plan.catalog']?.miss || 0, 0, detail);
    assert.ok(second.ms * 4 < first.ms, detail);
    assert.ok(second.ms < 1000, detail);
  } finally {
    setDiagnosticPhaseObserver(previous);
    restoreBuilt();
    rmSync(dir, { recursive: true, force: true });
  }
});
