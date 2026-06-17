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
    assert.deepEqual(provider.capabilityIds, [
      'local.goal.update',
      'local.goal.create',
      'local.goal.read',
    ]);
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

    // A（0006）：创建结果必须回显权威 taskId 清单，供后续 goal_update_task 使用。
    assert.ok(Array.isArray(payload.tasks));
    assert.equal(payload.tasks.length, 2);
    assert.equal(payload.tasks[0].taskId, 'task-1');
    assert.equal(payload.tasks[1].taskId, 'task-2');
    assert.equal(payload.tasks[0].title, '抽接口');
    assert.equal(payload.tasks[0].status, 'pending');

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

  it('reads back a plan with authoritative taskIds via local.goal.read', async () => {
    const plan = seedPlan();
    const execution = await provider.executeCapability(
      {
        call: {
          toolCallId: 'local.goal.read:test',
          capabilityId: 'local.goal.read',
          arguments: { planId: plan.planId },
          occurredAt: new Date().toISOString(),
        },
      },
      { locale: 'zh-CN', toolContext: { conversationId: 'conv-1' } },
    );

    assert.equal(execution.result.status, 'success');
    assert.equal(execution.grant.scope, 'local.goal.read');
    assert.equal(execution.grant.granted, true);
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.planId, plan.planId);
    assert.deepEqual(
      payload.plan.tasks.map((t) => t.taskId),
      ['t1', 't2'],
    );
  });

  it('lists active plans by conversation when planId is omitted', async () => {
    const created = await provider.executeCapability(
      {
        call: {
          toolCallId: 'local.goal.create:conv',
          capabilityId: 'local.goal.create',
          arguments: {
            title: '重构鉴权',
            goal: '把鉴权抽到独立模块',
            tasks: [{ title: '抽接口' }, { title: '迁移实现' }],
          },
          occurredAt: new Date().toISOString(),
        },
      },
      { locale: 'zh-CN', toolContext: { conversationId: 'conv-7' } },
    );
    const createdPayload = JSON.parse(created.result.outputPreview.legacyResult.output);

    const execution = await provider.executeCapability(
      {
        call: {
          toolCallId: 'local.goal.read:conv',
          capabilityId: 'local.goal.read',
          arguments: {},
          occurredAt: new Date().toISOString(),
        },
      },
      { locale: 'zh-CN', toolContext: { conversationId: 'conv-7' } },
    );

    assert.equal(execution.result.status, 'success');
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, true);
    assert.equal(payload.conversationId, 'conv-7');
    assert.ok(Array.isArray(payload.plans));
    const found = payload.plans.find((p) => p.planId === createdPayload.planId);
    assert.ok(found, 'created plan should be listed for its conversation');
    assert.deepEqual(
      found.tasks.map((t) => t.taskId),
      ['task-1', 'task-2'],
    );
  });

  it('fails read for an unknown planId', async () => {
    const execution = await provider.executeCapability(
      {
        call: {
          toolCallId: 'local.goal.read:missing',
          capabilityId: 'local.goal.read',
          arguments: { planId: 'does-not-exist' },
          occurredAt: new Date().toISOString(),
        },
      },
      { locale: 'zh-CN' },
    );
    assert.equal(execution.result.status, 'failed');
    const payload = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(payload.ok, false);
  });
});
