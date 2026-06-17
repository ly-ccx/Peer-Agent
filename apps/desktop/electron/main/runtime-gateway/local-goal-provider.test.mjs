import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createLocalGoalProvider } from './local-goal-provider.mjs';

let tmpRoot;
let store;
let provider;

function createCall(args = {}, toolCallId = 'local.goal.update:test') {
  return {
    toolCallId,
    capabilityId: 'local.goal.update',
    arguments: args,
    argumentsPreview: args,
    occurredAt: new Date().toISOString(),
  };
}

function seedPlan() {
  return store.createPlan({
    title: '重构鉴权',
    goal: '把鉴权抽到独立模块',
    successCriteria: ['全部测试通过'],
    tasks: [
      { taskId: 't1', order: 0, title: '抽接口', status: 'pending', evidenceRefs: [] },
      { taskId: 't2', order: 1, title: '迁移实现', status: 'pending', evidenceRefs: [] },
    ],
  });
}

describe('local goal provider', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'local-goal-provider-'));
    process.env.PEER_AGENT_HOME = path.join(tmpRoot, '.peer-agent');
    store = createGoalPlanStore();
    provider = createLocalGoalProvider({ goalPlanStore: store });
  });

  afterEach(() => {
    delete process.env.PEER_AGENT_HOME;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('declares the governed goal capability ids', () => {
    assert.equal(provider.providerId, 'local.goal.update');
    assert.deepEqual(provider.capabilityIds, ['local.goal.update', 'local.goal.create']);
  });

  it('creates an awaiting_approval plan via local.goal.create', async () => {
    const execution = await provider.executeCapability(
      {
        call: {
          toolCallId: 'local.goal.create:test',
          capabilityId: 'local.goal.create',
          arguments: {
            title: '重构鉴权',
            goal: '把鉴权抽到独立模块',
            tasks: [{ title: '抽接口' }, { title: '迁移实现', dependsOn: ['task-1'] }],
          },
          occurredAt: new Date().toISOString(),
        },
      },
      { locale: 'zh-CN', toolContext: { conversationId: 'conv-1' } },
    );

    assert.equal(execution.grant.granted, true);
    assert.equal(execution.grant.scope, 'local.goal.create');
    assert.equal(execution.result.status, 'success');

    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 'awaiting_approval');
    assert.equal(payload.taskCount, 2);

    const persisted = store.getPlan(payload.planId);
    assert.equal(persisted.status, 'awaiting_approval');
    assert.equal(persisted.conversationId, 'conv-1');
    assert.equal(persisted.tasks.length, 2);
  });

  it('rejects goal.create without goal or tasks', async () => {
    const execution = await provider.executeCapability(
      {
        call: {
          toolCallId: 'local.goal.create:bad',
          capabilityId: 'local.goal.create',
          arguments: { title: 'x' },
          occurredAt: new Date().toISOString(),
        },
      },
      { locale: 'en-US', toolContext: { conversationId: 'conv-1' } },
    );
    assert.equal(execution.result.status, 'failed');
    assert.equal(execution.grant.granted, false);
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, false);
  });

  it('writes evidence to a subtask and recomputes progress bottom-up', async () => {
    const plan = seedPlan();
    const execution = await provider.executeCapability(
      {
        call: createCall({
          planId: plan.planId,
          taskId: 't1',
          status: 'completed',
          evidenceRefs: ['local-shell-artifact://abc'],
          result: '接口已抽出',
        }),
      },
      { locale: 'zh-CN' },
    );

    assert.equal(execution.grant.granted, true);
    assert.equal(execution.grant.scope, 'local.goal.update');
    assert.equal(execution.result.status, 'success');

    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, true);
    assert.equal(payload.progress.completed, 1);
    assert.equal(payload.progress.total, 2);

    const persisted = store.getPlan(plan.planId);
    const t1 = persisted.tasks.find((t) => t.taskId === 't1');
    assert.equal(t1.status, 'completed');
    assert.deepEqual(t1.evidenceRefs, ['local-shell-artifact://abc']);
    // evidenceRefs are surfaced as Evidence artifactRefs
    assert.deepEqual(execution.result.evidence.artifactRefs, ['local-shell-artifact://abc']);
  });

  it('rejects completed without evidenceRefs (store-enforced governance)', async () => {
    const plan = seedPlan();
    const execution = await provider.executeCapability(
      {
        call: createCall({ planId: plan.planId, taskId: 't1', status: 'completed' }),
      },
      { locale: 'zh-CN' },
    );

    assert.equal(execution.result.status, 'failed');
    assert.equal(execution.grant.granted, false);
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /evidenceRefs/);

    // plan unchanged
    const persisted = store.getPlan(plan.planId);
    assert.equal(persisted.tasks.find((t) => t.taskId === 't1').status, 'pending');
  });

  it('fails when planId or taskId is missing', async () => {
    const execution = await provider.executeCapability(
      { call: createCall({ taskId: 't1', status: 'running' }) },
      { locale: 'en-US' },
    );
    assert.equal(execution.result.status, 'failed');
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /planId/);
  });

  it('fails gracefully for an unknown plan', async () => {
    const execution = await provider.executeCapability(
      { call: createCall({ planId: 'nope', taskId: 't1', status: 'running' }) },
      { locale: 'zh-CN' },
    );
    assert.equal(execution.result.status, 'failed');
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, false);
  });
});
