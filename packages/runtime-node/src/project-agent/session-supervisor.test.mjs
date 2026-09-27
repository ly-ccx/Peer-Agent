import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createGoalRunner } from '../goal-runner.mjs';
import { createScriptedTurnExecutor } from '../testing/scripted-turn-executor.mjs';
import { createSessionSupervisor, evaluateWorkSessionWrite } from './session-supervisor.mjs';

function model(id, extra = {}) {
  return {
    modelProviderId: id,
    providerId: 'local',
    modelId: id,
    family: 'alpha',
    tools: true,
    vision: true,
    contextTokens: 32_000,
    ...extra,
  };
}

function routing() {
  return {
    tiers: {
      strong: { primary: 'worker-1' },
      vision: { primary: 'vision-1' },
    },
    roles: {
      session_worker: { mode: 'tier', tier: 'strong' },
      explorer: { mode: 'tier', tier: 'strong' },
      verifier: { mode: 'tier', tier: 'strong' },
      visual_verifier: { mode: 'tier', tier: 'vision' },
    },
    verifierPreferDifferentFamily: false,
  };
}

function visionCatalog() {
  return [
    model('worker-1'),
    model('vision-1', { family: 'beta', tools: false, vision: true }),
  ];
}

async function harness({
  catalog = visionCatalog(),
  goalPlanStore: injectedStore = null,
  goalRunner: injectedRunner = null,
  resolveAcceptancePolicy = null,
  readSessionFacts = null,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b2-04-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  const conversationStore = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const goalPlanStore = injectedStore || createGoalPlanStore({
    storeDir: path.join(root, 'goal-plans'),
    readWorkspaceHead: () => ({ branch: 'feature', commit: 'abc123', source: 'workspace_head' }),
  });
  const turns = [];
  const events = [];
  const aborts = [];
  const goalRunner = injectedRunner || createGoalRunner({
    goalPlanStore,
    canRunPlan: () => true,
    logger: { info() {}, warn() {}, error() {} },
    maxRecoverableInterruptionRetries: 0,
    chatRuntime: {
      async runGoalTurn(input) {
        const played = await createScriptedTurnExecutor([
          { type: 'delta', content: '脚本回合' },
          { type: 'terminal', channel: 'done' },
        ]).runTurn({ sink: { send() {} } });
        turns.push({ planId: input.planId, text: played.text });
        return { ...played, requestedUserInput: true, blockedReason: 'scripted-hold' };
      },
    },
  });
  const parent = conversationStore.createConversation({
    title: '项目代理',
    role: 'project_agent',
    workspaceId: 'ws-1',
    workspacePath: root,
    mode: 'chat',
  });
  conversationStore.appendMessage(parent.id, {
    id: 'anchor-1',
    role: 'user',
    kind: 'user_input',
    content: '请把登录修好',
  });
  const supervisor = createSessionSupervisor({
    conversationStore,
    goalPlanStore,
    goalRunner,
    catalog,
    routing: routing(),
    abortStream: async (request) => { aborts.push(request); },
    emitEvent: (event) => { events.push(event); },
    resolveAcceptancePolicy,
    readSessionFacts,
    now: () => '2026-09-27T00:00:00.000Z',
  });
  return {
    root,
    conversationStore,
    goalPlanStore,
    goalRunner,
    supervisor,
    turns,
    events,
    aborts,
    parent,
    async cleanup() {
      if (previous === undefined) delete process.env.PEER_AGENT_HOME;
      else process.env.PEER_AGENT_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function spawnInput(extra = {}) {
  return {
    anchorMessageIds: ['anchor-1'],
    title: '修复登录',
    brief: '让登录流程重新可用',
    successCriteria: ['登录请求返回成功'],
    kind: 'ui',
    readOnly: false,
    ...extra,
  };
}

function contextOf(env, extra = {}) {
  return {
    parentConversationId: env.parent.id,
    workspaceId: 'ws-1',
    workspacePath: env.root,
    surface: 'desktop',
    inputId: 'input-1',
    ...extra,
  };
}

test('delegationOrigin 往返，非法来源被丢弃', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b2-04-origin-'));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  try {
    const selection = {
      providerId: 'local', modelId: 'worker-1', modelProviderId: 'worker-1', family: 'alpha',
    };
    const kept = store.createPlan({
      conversationId: 'origin-conv',
      title: '保留来源',
      goal: '保留来源',
      delegationOrigin: {
        anchorMessageId: 'anchor-1',
        inputId: 'input-1',
        surface: 'desktop',
        memorySnapshotId: null,
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        readOnly: true,
        phase: 'queued',
        depth: 1,
        modelSelection: {
          worker: selection,
          explorer: selection,
          verifier: { ...selection, sameFamilyAsWorker: true },
          source: { worker: 'global' },
          resolvedAt: '2026-09-27T00:00:00.000Z',
        },
      },
    });
    const loaded = store.getPlan(kept.planId);
    assert.equal(loaded.delegationOrigin.memorySnapshotId, null);
    assert.equal(loaded.delegationOrigin.workspaceId, 'ws-1');
    assert.equal(loaded.delegationOrigin.readOnly, true);
    assert.equal(loaded.delegationOrigin.phase, 'queued');
    assert.equal(loaded.delegationOrigin.modelSelection.worker.modelProviderId, 'worker-1');

    const dropped = store.createPlan({
      conversationId: 'other-conv',
      title: '丢弃来源',
      goal: '丢弃来源',
      delegationOrigin: { anchorMessageId: 'only-anchor' },
    });
    assert.equal(store.getPlan(dropped.planId).delegationOrigin, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('开任务全链路：冻结模型、子会话、委托消息、计划、启动与事件', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(spawnInput(), contextOf(env));
    assert.equal(opened.status, 'running');
    assert.equal(opened.replayed, undefined);
    assert.equal(env.turns.length, 1);
    assert.equal(env.turns[0].text, '脚本回合');
    assert.equal(env.events[0].kind, 'session_started');
    assert.equal(env.events[0].sessionId, opened.sessionId);

    const children = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' });
    assert.equal(children.length, 1);
    assert.equal(children[0].mode, 'goal');
    assert.equal(children[0].delegation.sessionId, opened.sessionId);
    assert.equal(children[0].delegation.anchorMessageId, 'anchor-1');
    assert.equal(children[0].modelProviderId, 'worker-1');
    assert.ok(children[0].backgroundSnapshotId);

    const child = env.conversationStore.getConversation(children[0].id);
    assert.equal(child.messages[0].role, 'user');
    assert.match(child.messages[0].content, /让登录流程重新可用/);
    assert.match(child.messages[0].content, /登录请求返回成功/);
    assert.match(child.messages[0].content, /请把登录修好/);
    assert.match(child.messages[0].content, /可以在工作区边界内修改/);

    const session = env.supervisor.get({ sessionId: opened.sessionId, detail: 'report' });
    const plan = env.goalPlanStore.getPlan(session.planId);
    assert.equal(plan.activation.kind, 'accepted_goal');
    assert.equal(plan.conversationId, children[0].id);
    assert.match(plan.delegationOrigin.memorySnapshotId, /^snap-/);
    const snapFile = path.join(env.root, 'projects', 'ws-1', 'memory', 'snapshots.jsonl');
    assert.match(readFileSync(snapFile, 'utf8'), new RegExp(plan.delegationOrigin.memorySnapshotId));
    assert.equal(plan.delegationOrigin.depth, 1);
    assert.equal(plan.delegationOrigin.modelSelection.worker.modelProviderId, 'worker-1');
    assert.equal(plan.delegationOrigin.modelSelection.visualVerifier.modelProviderId, 'vision-1');
    assert.equal(typeof plan.delegationOrigin.modelSelection.verifier.sameFamilyAsWorker, 'boolean');
    assert.equal(plan.deliveryBinding.executionIsolation, 'none');
    assert.equal(plan.deliveryBinding.targetBranch, 'feature');
    assert.equal(plan.successCriteria[0].description, '登录请求返回成功');
    assert.equal(session.report.summary, '让登录流程重新可用');
    assert.deepEqual(session.report.keyFindings, ['登录请求返回成功']);

    const replied = await env.supervisor.message({
      sessionId: opened.sessionId,
      text: '补充：保留现有文案',
      intent: 'answer',
    });
    assert.equal(replied.sessionId, opened.sessionId);
    const after = env.conversationStore.getConversation(children[0].id);
    assert.equal(after.messages.at(-1).role, 'user');
    assert.match(after.messages.at(-1).content, /保留现有文案/);
    assert.equal(await env.supervisor.get({ sessionId: 'missing' }), null);
  } finally {
    await env.cleanup();
  }
});

test('模型不可用时不建任何对象', { timeout: 20_000 }, async () => {
  const env = await harness({
    catalog: [
      model('worker-1', { vision: false }),
      model('vision-1', { family: 'beta', tools: false, vision: true }),
    ],
  });
  try {
    const beforePlans = env.goalPlanStore.listPlans().length;
    const ui = await env.supervisor.spawn(spawnInput({ kind: 'ui' }), contextOf(env));
    assert.equal(ui.error, 'model_unavailable');
    assert.equal(typeof ui.missing, 'string');
    assert.equal(ui.missing.length > 0, true);

    const blind = createSessionSupervisor({
      conversationStore: env.conversationStore,
      goalPlanStore: env.goalPlanStore,
      goalRunner: env.goalRunner,
      catalog: [model('worker-1', { vision: false })],
      routing: routing(),
      emitEvent: (event) => { env.events.push(event); },
    });
    const code = await blind.spawn(spawnInput({ kind: 'code', title: '只读调研' }), contextOf(env));
    assert.equal(code.error, 'model_unavailable');
    assert.equal(env.conversationStore.listChildren(env.parent.id, { role: 'work_session' }).length, 0);
    assert.equal(env.goalPlanStore.listPlans().length, beforePlans);
    assert.equal(env.turns.length, 0);
    assert.equal(env.events.length, 0);
  } finally {
    await env.cleanup();
  }
});

test('只读任务写入被拒', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(spawnInput({
      title: '查看登录',
      brief: '只看不改',
      readOnly: true,
      kind: 'code',
    }), contextOf(env, { inputId: 'input-ro' }));
    const plan = env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: opened.sessionId }).planId);
    assert.equal(plan.delegationOrigin.readOnly, true);
    const child = env.conversationStore.getConversation(plan.conversationId);
    assert.match(child.messages[0].content, /只读/);
    for (const action of [
      { capabilityId: 'local.file.write', toolName: 'write_file', permissionKind: 'file-write' },
      { capabilityId: 'local.file.edit', toolName: 'edit_file' },
      { capabilityId: 'local.shell.exec', toolName: 'bash', permissionKind: 'shell' },
    ]) {
      assert.equal(evaluateWorkSessionWrite(plan, action).allowed, false);
      assert.equal(env.supervisor.evaluateWrite(opened.sessionId, action).error, 'read_only');
    }
    assert.equal(evaluateWorkSessionWrite(plan, { capabilityId: 'local.file.read', toolName: 'read_file' }).allowed, true);

    const writable = await env.supervisor.spawn(spawnInput({
      title: '修改登录',
      brief: '可以改登录',
      readOnly: false,
    }), contextOf(env, { inputId: 'input-rw' }));
    const writablePlan = env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: writable.sessionId }).planId);
    assert.equal(evaluateWorkSessionWrite(writablePlan, { capabilityId: 'local.file.write', toolName: 'write_file' }).allowed, true);
  } finally {
    await env.cleanup();
  }
});

test('排队、取消与出队保持先后顺序', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const first = await env.supervisor.spawn(spawnInput({ title: '第一件', brief: '先做第一件' }), contextOf(env, { inputId: 'in-1' }));
    const second = await env.supervisor.spawn(spawnInput({ title: '第二件', brief: '再做第二件' }), contextOf(env, { inputId: 'in-2' }));
    const third = await env.supervisor.spawn(spawnInput({ title: '第三件', brief: '最后做第三件' }), contextOf(env, { inputId: 'in-3' }));
    assert.equal(first.status, 'running');
    assert.equal(second.status, 'queued');
    assert.equal(second.queuedBehind, 1);
    assert.equal(third.status, 'queued');
    assert.equal(third.queuedBehind, 2);
    assert.equal(env.turns.length, 1);

    const seenDuringAbort = [];
    const cancelling = createSessionSupervisor({
      conversationStore: env.conversationStore,
      goalPlanStore: env.goalPlanStore,
      goalRunner: env.goalRunner,
      catalog: visionCatalog(),
      routing: routing(),
      emitEvent: (event) => { env.events.push(event); },
      abortStream: async (request) => {
        seenDuringAbort.push(env.goalPlanStore.getPlan(request.planId).status);
        env.aborts.push(request);
      },
    });
    const cancelled = await cancelling.cancel({ sessionId: first.sessionId, reason: '用户叫停' });
    assert.equal(seenDuringAbort[0], 'paused');
    assert.equal(env.aborts[0].reason, '用户叫停');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(env.events.some((event) => event.kind === 'cancelled' && event.sessionId === first.sessionId), true);

    const firstChild = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' })
      .find((row) => row.delegation.sessionId === first.sessionId);
    assert.equal(env.conversationStore.getConversation(firstChild.id).status, 'active');
    assert.equal(env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: second.sessionId }).planId).delegationOrigin.phase, 'running');
    assert.equal(env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: third.sessionId }).planId).delegationOrigin.phase, 'queued');
    assert.equal(env.turns.length, 2);
    assert.deepEqual(env.turns.map((turn) => turn.planId), [
      env.supervisor.get({ sessionId: first.sessionId }).planId,
      env.supervisor.get({ sessionId: second.sessionId }).planId,
    ]);
    assert.equal(env.supervisor.list({ workspaceId: 'ws-1', status: 'cancelled' })
      .some((session) => session.sessionId === first.sessionId), true);
  } finally {
    await env.cleanup();
  }
});

test('幂等重放不重复建', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const input = spawnInput({ title: '只建一次', brief: '同一件事' });
    const context = contextOf(env, { inputId: 'input-once' });
    const first = await env.supervisor.spawn(input, context);
    const second = await env.supervisor.spawn(input, context);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.replayed, true);
    assert.equal(env.conversationStore.listChildren(env.parent.id, { role: 'work_session' }).length, 1);
    assert.equal(env.turns.length, 1);
  } finally {
    await env.cleanup();
  }
});

test('每个任务一个子会话，不触发同会话单活跃约束', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const parentPlan = env.goalPlanStore.createGoalContract({
      conversationId: env.parent.id,
      title: '代理自己的计划',
      goal: '这条计划必须留下',
      status: 'executing',
      successCriteria: ['还在'],
    });
    await env.supervisor.spawn(spawnInput({ title: '任务甲', brief: '甲的目标' }), contextOf(env, { inputId: 'in-a' }));
    await env.supervisor.spawn(spawnInput({ title: '任务乙', brief: '乙的目标' }), contextOf(env, { inputId: 'in-b' }));
    assert.equal(env.goalPlanStore.getPlan(parentPlan.planId).status, 'executing');
    const children = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' });
    assert.equal(children.length, 2);
    for (const child of children) {
      const plans = env.goalPlanStore.listPlansByConversation(child.id);
      assert.equal(plans.length, 1);
      assert.equal(plans[0].status === 'cancelled', false);
      assert.notEqual(plans[0].conversationId, env.parent.id);
    }
  } finally {
    await env.cleanup();
  }
});

test('启动失败时归档子会话并删掉计划', { timeout: 20_000 }, async () => {
  const env = await harness({
    goalRunner: {
      async start() { throw new Error('runner-down'); },
      pause() {},
    },
  });
  try {
    const opened = await env.supervisor.spawn(spawnInput({ title: '会失败', brief: '建到一半' }), contextOf(env));
    assert.equal(opened.error, 'spawn_failed');
    assert.match(opened.message, /runner-down/);
    const children = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' });
    assert.equal(children.length, 1);
    const archived = env.conversationStore.getConversation(children[0].id);
    assert.equal(archived.status, 'archived');
    assert.match(archived.messages.map((message) => message.content).join('\n'), /runner-down/);
    const leftover = readdirSync(env.goalPlanStore.getStoreDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => env.goalPlanStore.getPlan(name.slice(0, -'.json'.length)))
      .filter((plan) => plan?.delegationOrigin);
    assert.equal(leftover.length, 0);
    assert.equal(env.events.length, 0);
  } finally {
    await env.cleanup();
  }
});

function hostPassPatch() {
  return {
    tasks: [{ taskId: 'leaf', status: 'completed', evidenceRefs: ['ev-1'] }],
    successCriteria: [{ id: 'c1', kind: 'test', description: '测试通过' }],
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'ev-1' }],
  };
}

async function completedSession(env) {
  const opened = await env.supervisor.spawn(spawnInput(), contextOf(env));
  const planId = env.supervisor.get({ sessionId: opened.sessionId }).planId;
  env.goalPlanStore.revisePlan(planId, hostPassPatch(), { reason: 'host evidence', changedBy: 'test' });
  env.goalPlanStore.recordEvidenceRefs({
    planId,
    evidenceRefs: ['ev-1'],
  });
  env.goalPlanStore.setPlanStatus(planId, 'completed');
  return { ...opened, planId };
}

test('回复引用任务之后才代签，字段含 acceptedBy、acceptedAt 和 verdictRef', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const opened = await completedSession(env);
    const early = await env.supervisor.settle(opened.sessionId, { userAgreed: true, acceptedBy: 'user' });
    assert.equal(early.accepted, false);
    assert.equal(early.acceptedBy, undefined);
    assert.equal(env.goalPlanStore.getPlan(opened.planId).resultAcceptance, undefined);

    env.conversationStore.appendMessage(env.parent.id, {
      id: 'note-1',
      role: 'assistant',
      content: '模型说做完了',
      sources: [opened.sessionId],
    });
    const unlabeled = await env.supervisor.settle(opened.sessionId);
    assert.equal(unlabeled.accepted, false);
    assert.equal(env.goalPlanStore.getPlan(opened.planId).resultAcceptance, undefined);

    env.conversationStore.appendMessage(env.parent.id, {
      id: 'reply-1',
      role: 'assistant',
      kind: 'agent_reply',
      content: '登录已经修好',
      sources: [opened.sessionId],
    });
    const settled = await env.supervisor.settle(opened.sessionId);
    assert.equal(settled.accepted, true);
    assert.equal(settled.acceptedBy, 'policy');
    const stored = env.goalPlanStore.getPlan(opened.planId).resultAcceptance;
    assert.equal(stored.acceptedBy, 'policy');
    assert.equal(stored.acceptedAt, '2026-09-27T00:00:00.000Z');
    assert.equal(stored.verdictRef, `verdict:${opened.sessionId}:passed`);
  } finally {
    await env.cleanup();
  }
});

test('项目策略为 confirm 时不代签，用户确认写入 acceptedBy user', { timeout: 20_000 }, async () => {
  const env = await harness({ resolveAcceptancePolicy: () => 'confirm' });
  try {
    const opened = await completedSession(env);
    env.conversationStore.appendMessage(env.parent.id, {
      id: 'reply-1',
      role: 'assistant',
      kind: 'agent_reply',
      content: '登录已经修好',
      meta: { sources: [opened.sessionId] },
    });
    const settled = await env.supervisor.settle(opened.sessionId, { userAgreed: true });
    assert.equal(settled.accepted, false);
    assert.equal(settled.reasons.includes('project_requires_confirm'), true);
    assert.equal(env.goalPlanStore.getPlan(opened.planId).resultAcceptance, undefined);

    const confirmed = await env.supervisor.confirmResult(opened.sessionId);
    assert.equal(confirmed.accepted, true);
    assert.equal(confirmed.resultAcceptance.acceptedBy, 'user');
    assert.equal(confirmed.resultAcceptance.acceptedAt, '2026-09-27T00:00:00.000Z');
    assert.equal(confirmed.resultAcceptance.verdictRef, `verdict:${opened.sessionId}:passed`);
    assert.equal(env.goalPlanStore.getPlan(opened.planId).resultAcceptance.acceptedBy, 'user');
  } finally {
    await env.cleanup();
  }
});
