import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

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
  approvalStore = null,
  readPlanApproval = null,
  isolationPlanner = undefined,
  canManageWorkspace = undefined,
  now = () => '2026-09-27T00:00:00.000Z',
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
    approvalStore,
    readPlanApproval,
    ...(isolationPlanner ? { isolationPlanner } : {}),
    ...(canManageWorkspace ? { canManageWorkspace } : {}),
    now,
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

test('automatic task identity survives rewording and restart without merging different intents', async () => {
  const env = await harness();
  try {
    const criteria = [{id:'c1',kind:'file-contains',description:'Check file',path:'README.md',expect:'Peer'}];
    const input = spawnInput({kind:'research',readOnly:true,successCriteria:criteria});
    const first = await env.supervisor.spawn(input, contextOf(env));
    const firstPlan = env.goalPlanStore.getPlan(env.supervisor.get({sessionId:first.sessionId}).planId);
    const legacyKey = createHash('sha256').update(JSON.stringify({parentConversationId:env.parent.id,
      anchorMessageIds:input.anchorMessageIds,title:input.title,brief:input.brief,kind:input.kind,
      readOnly:input.readOnly,successCriteria:input.successCriteria})).digest('hex');
    env.goalPlanStore.revisePlan(firstPlan.planId,{delegationOrigin:{...firstPlan.delegationOrigin,idempotencyKey:legacyKey}},
      {reason:'simulate a persisted pre-repair task',changedBy:'test'});
    const restarted = createSessionSupervisor({conversationStore:env.conversationStore,goalPlanStore:env.goalPlanStore,
      goalRunner:env.goalRunner,catalog:visionCatalog(),routing:routing()});
    const second = await restarted.spawn({...input,title:'Different title',brief:'Reworded request',
      successCriteria:[{...criteria[0],id:'another-id',description:'Same check, new prose'}]},contextOf(env));
    assert.equal(second.sessionId,first.sessionId); assert.equal(second.replayed,true);
    const other = await restarted.spawn({...input,successCriteria:[{...criteria[0],expect:'Other'}]},contextOf(env));
    assert.notEqual(other.sessionId,first.sessionId);
    env.conversationStore.appendMessage(env.parent.id,{id:'anchor-2',role:'user',kind:'user_input',content:'Run again'});
    const again = await restarted.spawn({...input,anchorMessageIds:['anchor-2']},contextOf(env));
    assert.notEqual(again.sessionId,first.sessionId);
    const replacement = await restarted.spawn({...input,supersedes:first.sessionId},contextOf(env));
    assert.notEqual(replacement.sessionId,first.sessionId);
  } finally { await env.cleanup(); }
});

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
    assert.doesNotMatch(after.messages.at(-1).content, /来自项目代理转达/);
    assert.equal(after.messages.at(-1).relayFrom, undefined);
    assert.equal(await env.supervisor.get({ sessionId: 'missing' }), null);
  } finally {
    await env.cleanup();
  }
});

test('开任务时把锚点上的附件引用带进任务', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    env.conversationStore.appendMessage(env.parent.id, {
      id: 'anchor-shot',
      role: 'user',
      kind: 'user_input',
      content: '看这张图',
      attachmentRefs: ['local-appshot-artifact://abc-123'],
      attachments: [{
        id: 'att-shot',
        kind: 'image',
        name: 'Appshot — TextEdit',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AA==',
        artifactRef: 'local-appshot-artifact://abc-123',
      }],
    });
    const opened = await env.supervisor.spawn(
      spawnInput({ anchorMessageIds: ['anchor-shot'], title: '看图', brief: '看这张截图' }),
      contextOf(env, { inputId: 'input-shot' }),
    );
    assert.equal(opened.status, 'running');
    const children = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' });
    const child = env.conversationStore.getConversation(children[0].id);
    assert.deepEqual(child.messages[0].attachmentRefs, ['local-appshot-artifact://abc-123']);
    assert.equal(child.messages[0].attachments[0].dataUrl, 'data:image/png;base64,AA==');
  } finally {
    await env.cleanup();
  }
});

test('未解析的附件和工具结果仍然挡住开任务', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    env.conversationStore.appendMessage(env.parent.id, {
      id: 'anchor-ref-only',
      role: 'user',
      kind: 'user_input',
      content: '只有引用',
      attachments: [{
        id: 'att-ref',
        kind: 'image',
        name: 'opaque',
        artifactRef: 'local-appshot-artifact://abc-123',
      }],
    });
    const opaque = await env.supervisor.spawn(
      spawnInput({ anchorMessageIds: ['anchor-ref-only'], title: '看引用', brief: '只有引用' }),
      contextOf(env, { inputId: 'input-ref' }),
    );
    assert.equal(opaque.error, 'spawn_failed');
    assert.equal(opaque.message, 'BACKGROUND_CONFIRMATION_REQUIRED');

    env.conversationStore.appendMessage(env.parent.id, {
      id: 'tool-row',
      role: 'tool',
      content: '工具结果',
    });
    env.conversationStore.appendMessage(env.parent.id, {
      id: 'anchor-after-tool',
      role: 'user',
      kind: 'user_input',
      content: '看这张图',
      attachments: [{
        id: 'att-shot',
        kind: 'image',
        name: 'Appshot — TextEdit',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AA==',
      }],
    });
    const blocked = await env.supervisor.spawn(
      spawnInput({ anchorMessageIds: ['anchor-after-tool'], title: '看图', brief: '看这张截图' }),
      contextOf(env, { inputId: 'input-blocked' }),
    );
    assert.equal(blocked.error, 'spawn_failed');
    assert.equal(blocked.message, 'BACKGROUND_CONFIRMATION_REQUIRED');
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
    const code = await blind.spawn(spawnInput({ kind: 'ui', title: '需要视觉模型' }), contextOf(env));
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

test('failed startup retains an isolated Plan when rollback cleanup fails', async () => {
  let env;
  const planner = { prepare: async plan => ({ ok: true, plan: env.goalPlanStore.recordDeliveryIsolation(plan.planId,
    { executionIsolation: 'worktree', taskBranch: 'fixture', worktreePath: '/fixture/retained' }) }),
    cleanup: async plan => plan };
  env = await harness({ isolationPlanner: planner, goalRunner: { start: async () => { throw new Error('start failed'); } } });
  try {
    const result = await env.supervisor.spawn(spawnInput({ isolation: 'worktree' }), contextOf(env));
    assert.equal(result.error, 'spawn_failed'); assert.ok(result.sessionId);
    const saved = env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: result.sessionId }).planId);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.deliveryBinding.worktreePath, '/fixture/retained');
    assert.equal(env.conversationStore.getConversation(saved.conversationId).status, 'active');
  } finally { await env.cleanup(); }
});

test('cancellation waits for the active turn to settle before removing its execution site', async () => {
  const calls = [];
  const env = await harness({ goalRunner: { start: async () => {}, pause: () => calls.push('abort'),
    waitForIdle: async () => { await Promise.resolve(); calls.push('settled'); } },
    isolationPlanner: { prepare: async plan => ({ ok: true, plan }), cleanup: async plan => { calls.push('cleanup'); return plan; } } });
  try {
    const opened = await env.supervisor.spawn(spawnInput(), contextOf(env));
    await env.supervisor.cancel({ sessionId: opened.sessionId });
    assert.deepEqual(calls, ['abort', 'settled', 'cleanup']);
    assert.equal(env.supervisor.get({ sessionId: opened.sessionId }).status, 'cancelled');
  } finally { await env.cleanup(); }
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

test('missing independent verification cannot mint policy acceptance', async () => {
  const env = await harness();
  try {
    const opened = await completedSession(env);
    env.conversationStore.appendMessage(env.parent.id, { id: 'result', role: 'assistant',
      kind: 'agent_reply', content: 'Result', sources: [opened.sessionId] });
    const result = await env.supervisor.settle(opened.sessionId);
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.includes('verification_below_floor'));
    assert.equal(env.goalPlanStore.getPlan(opened.planId).resultAcceptance, undefined);
  } finally { await env.cleanup(); }
});

test('回复引用任务之后才代签，字段含 acceptedBy、acceptedAt 和 verdictRef', { timeout: 20_000 }, async () => {
  const env = await harness({ readSessionFacts: () => ({ hostAuthority: { independentVerifier: 'passed' } }) });
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

test('policy acceptance only authorizes merge when host project policy enables it', async () => {
  for (const enabled of [false, true]) {
    const env = await harness({ readSessionFacts: () => ({ autoHandoffOnPolicyAccept: enabled,
      hostAuthority: { independentVerifier: 'passed' } }) });
    try {
      let merged = 0;
      env.goalRunner.handoffDelegatedPlan = async plan => { merged++; return plan; };
      const opened = await completedSession(env);
      env.goalPlanStore.recordDeliveryIsolation(opened.planId, { executionIsolation: 'worktree', taskBranch: 'fixture', worktreePath: '/fixture' });
      env.conversationStore.appendMessage(env.parent.id, { id: 'reply', role: 'assistant', kind: 'agent_reply', sources: [opened.sessionId], content: 'Checked' });
      const result = await env.supervisor.settle(opened.sessionId, { autoHandoffOnPolicyAccept: true, userAgreed: true });
      assert.equal(result.accepted, true);
      assert.equal(merged, enabled ? 1 : 0);
      assert.equal(Boolean(env.goalPlanStore.getPlan(opened.planId).delegationOrigin.handoffAuthorizedAt), enabled);
    } finally { await env.cleanup(); }
  }
});

test('a host without this workspace lease never prepares or starts an isolated session', async () => {
  let prepared = 0; let started = 0;
  const env = await harness({ canManageWorkspace: () => false,
    isolationPlanner: { prepare: async plan => { prepared++; return { ok: true, plan }; }, cleanup: async plan => plan },
    goalRunner: { start: async () => { started++; } } });
  try {
    const opened = await env.supervisor.spawn(spawnInput({ isolation: 'worktree' }), contextOf(env));
    assert.equal(opened.error, undefined);
    assert.equal(opened.status, 'queued');
    await env.supervisor.reconcile();
    assert.equal(prepared, 0); assert.equal(started, 0);
  } finally { await env.cleanup(); }
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

test('计划批准挡住启动，批准后才跑；只读任务在 writes 下直接跑', { timeout: 30_000 }, async () => {
  const recorded = [];
  const env = await harness({
    approvalStore: {
      append(row) {
        recorded.push(row);
        return row;
      },
    },
    readPlanApproval: () => 'writes',
  });
  try {
    const direct = await env.supervisor.spawn(
      spawnInput({ title: '只看', brief: '只读看一眼', readOnly: true }),
      contextOf(env, { inputId: 'input-ro' }),
    );
    assert.equal(direct.status, 'running');
    assert.equal(recorded.length, 0);

    const held = await env.supervisor.spawn(spawnInput(), contextOf(env, { inputId: 'input-hold' }));
    assert.equal(held.status, 'awaiting_approval');
    const stored = env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: held.sessionId }).planId);
    assert.equal(stored.delegationOrigin.phase, 'awaiting_approval');
    assert.equal(stored.status, 'paused');
    assert.equal(recorded[0].capabilityId, 'goal.plan');
    assert.equal(recorded[0].kind, 'plan_approval');
    assert.match(recorded[0].summary, /让登录流程重新可用/);
    assert.match(recorded[0].summary, /登录请求返回成功/);
    const turnsBefore = env.turns.length;
    await env.supervisor.cancel({ sessionId: direct.sessionId, reason: 'slot free' });

    const resumed = await env.supervisor.resumeFromApproval(recorded[0]);
    assert.equal(resumed.ok, true);
    assert.equal(env.turns.length > turnsBefore, true);
    assert.equal(env.goalPlanStore.getPlan(stored.planId).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('已有任务在跑时，批准计划只排队，取消占用后再启动', async () => {
  const starts = [];
  const recorded = [];
  const env = await harness({
    goalRunner: {
      async start(planId) { starts.push(planId); },
      pause() {},
    },
    approvalStore: {
      append(row) {
        recorded.push(row);
        return row;
      },
    },
  });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: false }),
      contextOf(env, { inputId: 'input-run' }),
    );
    assert.equal(running.status, 'running');
    assert.equal(starts.length, 1);
    const held = await env.supervisor.spawn(
      spawnInput({ title: '等批准', brief: '批准后再做' }),
      contextOf(env, { inputId: 'input-held', planApproval: 'always' }),
    );
    assert.equal(held.status, 'awaiting_approval');
    const resumed = await env.supervisor.resumeFromApproval(recorded[0]);
    assert.equal(resumed.queued, true);
    assert.equal(starts.length, 1);
    const heldPlanId = env.supervisor.get({ sessionId: held.sessionId }).planId;
    assert.equal(env.goalPlanStore.getPlan(heldPlanId).delegationOrigin.phase, 'queued');

    await env.supervisor.cancel({ sessionId: running.sessionId, reason: '让出' });
    assert.equal(starts.length, 2);
    assert.equal(starts[1], heldPlanId);
    assert.equal(env.goalPlanStore.getPlan(heldPlanId).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('拒绝计划批准会取消还没启动的任务', async () => {
  const env = await harness({
    goalRunner: { async start() {}, pause() {} },
    readPlanApproval: () => 'always',
  });
  try {
    const held = await env.supervisor.spawn(spawnInput(), contextOf(env));
    assert.equal(held.status, 'awaiting_approval');
    const cancelled = await env.supervisor.cancel({
      sessionId: held.sessionId,
      reason: 'plan_approval_denied',
    });
    assert.equal(cancelled.status, 'cancelled');
    const plan = env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: held.sessionId }).planId);
    assert.equal(plan.status, 'cancelled');
  } finally {
    await env.cleanup();
  }
});

test('代理不在线时回答直接投进任务，并记 user_intervened', async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(spawnInput({ readOnly: true }), contextOf(env));
    const rejected = await env.supervisor.deliverAnswer({
      sessionId: opened.sessionId,
      workspaceId: 'ws-other',
      text: '用方案 A',
      answerTo: `card:question:${opened.sessionId}:q1`,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'workspace_mismatch');
    const delivered = await env.supervisor.deliverAnswer({
      sessionId: opened.sessionId,
      workspaceId: 'ws-1',
      text: '用方案 A',
      answerTo: `card:question:${opened.sessionId}:q1`,
    });
    assert.equal(delivered.userIntervened, true);
    assert.equal(delivered.session.interventions[0].id, delivered.messageId);
  } finally {
    await env.cleanup();
  }
});

function countingRunner() {
  const starts = [];
  return {
    starts,
    goalRunner: {
      async start(planId) { starts.push(planId); },
      pause() {},
    },
  };
}

function planIdOf(env, sessionId) {
  return env.supervisor.get({ sessionId }).planId;
}

test('占用名额的任务完成后，排队的下一个会启动', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: false }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '等前面做完' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    assert.equal(runner.starts.length, 1);
    const runningPlanId = planIdOf(env, running.sessionId);
    const queuedPlanId = planIdOf(env, queued.sessionId);
    env.goalPlanStore.setPlanStatus(runningPlanId, 'completed');
    const released = await env.supervisor.releaseSlot({ planId: runningPlanId });
    assert.equal(released.ok, true);
    assert.equal(runner.starts.length, 2);
    assert.equal(runner.starts[1], queuedPlanId);
    assert.equal(env.goalPlanStore.getPlan(queuedPlanId).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('占用名额的任务失败后，排队的下一个会启动', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: true }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '等前面失败' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    const runningPlanId = planIdOf(env, running.sessionId);
    env.goalPlanStore.setPlanStatus(runningPlanId, 'failed');
    const released = await env.supervisor.releaseSlot({ planId: runningPlanId });
    assert.equal(released.ok, true);
    assert.equal(runner.starts.at(-1), planIdOf(env, queued.sessionId));
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, queued.sessionId)).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('名额还被占用时，完成通知不会启动第二个任务', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: false }),
      contextOf(env, { inputId: 'input-run' }),
    );
    await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '先别启动' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    const released = await env.supervisor.releaseSlot({ planId: planIdOf(env, running.sessionId) });
    assert.equal(released.reason, 'still_running');
    assert.equal(runner.starts.length, 1);
  } finally {
    await env.cleanup();
  }
});

test('拒绝前置任务后，依赖任务等待用户且不会启动', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const held = await env.supervisor.spawn(
      spawnInput({ title: '等批准', brief: '先批准' }),
      contextOf(env, { inputId: 'input-held', planApproval: 'always' }),
    );
    assert.equal(held.status, 'awaiting_approval');
    const dependent = await env.supervisor.spawn(
      spawnInput({ title: '随后', brief: '等前置结束', dependsOn: [held.sessionId] }),
      contextOf(env, { inputId: 'input-dep' }),
    );
    assert.equal(dependent.status, 'queued');
    assert.equal(runner.starts.length, 0);
    await env.supervisor.cancel({ sessionId: held.sessionId, reason: 'plan_approval_denied' });
    const dependentPlanId = planIdOf(env, dependent.sessionId);
    assert.deepEqual(runner.starts, []);
    assert.equal(env.supervisor.get({ sessionId: dependent.sessionId }).status, 'waiting_user');
    assert.equal(env.goalPlanStore.getPlan(dependentPlanId).runner.status, 'waiting_user');
  } finally {
    await env.cleanup();
  }
});

test('依赖被拒绝后，其他任务释放槽位也不会误启动依赖任务', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '占住名额', readOnly: true }),
      contextOf(env, { inputId: 'input-run', planApproval: 'never' }),
    );
    const held = await env.supervisor.spawn(
      spawnInput({ title: '等批准', brief: '先批准' }),
      contextOf(env, { inputId: 'input-held', planApproval: 'always' }),
    );
    const dependent = await env.supervisor.spawn(
      spawnInput({ title: '随后', brief: '等前置结束', dependsOn: [held.sessionId] }),
      contextOf(env, { inputId: 'input-dep', planApproval: 'never' }),
    );
    await env.supervisor.cancel({ sessionId: held.sessionId, reason: 'plan_approval_denied' });
    const dependentPlanId = planIdOf(env, dependent.sessionId);
    assert.equal(env.goalPlanStore.getPlan(dependentPlanId).delegationOrigin.phase, 'queued');
    assert.equal(runner.starts.length, 1);

    const runningPlanId = planIdOf(env, running.sessionId);
    env.goalPlanStore.setPlanStatus(runningPlanId, 'failed');
    await env.supervisor.releaseSlot({ planId: runningPlanId });
    assert.equal(runner.starts.includes(dependentPlanId), false);
    assert.equal(env.goalPlanStore.getPlan(dependentPlanId).runner.status, 'waiting_user');
  } finally {
    await env.cleanup();
  }
});

test('更早的排队任务依赖未满足时，启动后面可运行的', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '占住名额', readOnly: true }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const held = await env.supervisor.spawn(spawnInput({ title: '等待批准', brief: '批准依赖后才执行' }),
      contextOf(env, { planApproval: 'always' }));
    const blocked = await env.supervisor.spawn(
      spawnInput({ title: '还不能做', brief: '等一个还不存在的前置', dependsOn: [held.sessionId] }),
      contextOf(env, { inputId: 'input-blocked' }),
    );
    const ready = await env.supervisor.spawn(
      spawnInput({ title: '可以做', brief: '没有前置' }),
      contextOf(env, { inputId: 'input-ready' }),
    );
    await env.supervisor.cancel({ sessionId: running.sessionId, reason: '让出' });
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, blocked.sessionId)).delegationOrigin.phase, 'queued');
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, ready.sessionId)).delegationOrigin.phase, 'running');
    assert.equal(runner.starts.at(-1), planIdOf(env, ready.sessionId));
  } finally {
    await env.cleanup();
  }
});

test('任务在启动过程中结束时，队列会在当前锁放开后继续唤醒', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-01-promote-'));
  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const starts = [];
  let notify = null;
  const goalRunner = {
    async start(planId) {
      starts.push(planId);
      if (starts.length === 2) {
        goalPlanStore.setPlanStatus(planId, 'completed');
        notify?.({ planId, type: 'goalRunner:completed' });
      }
    },
    setOnPlanTerminal(fn) { notify = fn; },
    pause() {},
  };
  const env = await harness({ goalPlanStore, goalRunner });
  try {
    const first = await env.supervisor.spawn(
      spawnInput({ title: '第一件', brief: '先做', readOnly: false }),
      contextOf(env, { inputId: 'in-1' }),
    );
    const second = await env.supervisor.spawn(
      spawnInput({ title: '第二件', brief: '接着做' }),
      contextOf(env, { inputId: 'in-2' }),
    );
    const third = await env.supervisor.spawn(
      spawnInput({ title: '第三件', brief: '最后做' }),
      contextOf(env, { inputId: 'in-3' }),
    );
    assert.equal(starts.length, 1);
    await env.supervisor.cancel({ sessionId: first.sessionId, reason: '做完了' });
    assert.equal(starts.length, 2);
    await new Promise((resolve) => setImmediate(resolve));
    const thirdPlanId = planIdOf(env, third.sessionId);
    assert.equal(starts.length, 3);
    assert.equal(starts[2], thirdPlanId);
    assert.equal(env.goalPlanStore.getPlan(thirdPlanId).delegationOrigin.phase, 'running');
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, second.sessionId)).status, 'completed');
  } finally {
    await env.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('普通计划完成不会把项目任务从队列里拉起来', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: false }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '不要被普通计划唤醒' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    const other = env.goalPlanStore.createGoalContract({
      conversationId: env.parent.id,
      title: '用户自己的计划',
      goal: '与委托无关',
      status: 'executing',
      successCriteria: ['留下'],
    });
    env.goalPlanStore.setPlanStatus(other.planId, 'completed');
    const released = await env.supervisor.releaseSlot({ planId: other.planId });
    assert.equal(released.reason, 'not_delegated');
    assert.equal(runner.starts.length, 1);
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, queued.sessionId)).delegationOrigin.phase, 'queued');
  } finally {
    await env.cleanup();
  }
});

function persistFinalFailure(store, planId) {
  store.setPlanStatus(planId, 'failed');
  store.setRunnerState(planId, {
    enabled: true,
    status: 'failed',
    intent: 'block',
    phase: 'blocked',
    lastError: 'boom',
    interruption: {
      source: 'runGoalTurn',
      reason: 'boom',
      interruptedAt: '2026-09-27T00:00:00.000Z',
    },
  });
}

test('重试用尽后落成 interrupted 的失败会让出队列', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: true }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '等前面失败' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    const runningPlanId = planIdOf(env, running.sessionId);
    persistFinalFailure(env.goalPlanStore, runningPlanId);
    const stored = env.goalPlanStore.getPlan(runningPlanId);
    assert.equal(stored.status, 'interrupted');
    assert.equal(stored.runner.status, 'failed');
    assert.equal(stored.runner.interruption.recoverable, false);
    const released = await env.supervisor.releaseSlot({ planId: runningPlanId });
    assert.equal(released.ok, true);
    assert.equal(runner.starts.at(-1), planIdOf(env, queued.sessionId));
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, queued.sessionId)).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('可恢复中断仍占着名额，不启动下一个', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: false }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '先别启动' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    const runningPlanId = planIdOf(env, running.sessionId);
    env.goalPlanStore.setRunnerState(runningPlanId, {
      enabled: true,
      status: 'running',
      interruption: {
        source: 'runGoalTurn',
        reason: 'timeout',
        interruptedAt: '2026-09-27T00:00:00.000Z',
        recoverable: true,
        attempt: 1,
      },
      recoverableInterruptionCount: 1,
      maxRecoverableInterruptionRetries: 3,
    });
    const released = await env.supervisor.releaseSlot({ planId: runningPlanId });
    assert.equal(released.reason, 'still_running');
    assert.equal(runner.starts.length, 1);
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, queued.sessionId)).delegationOrigin.phase, 'queued');
  } finally {
    await env.cleanup();
  }
});

test('前置最终失败后，依赖任务持久化 waiting_user', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '前置', brief: '先做完', readOnly: true }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const dependent = await env.supervisor.spawn(
      spawnInput({ title: '随后', brief: '等前置结束', dependsOn: [running.sessionId] }),
      contextOf(env, { inputId: 'input-dep' }),
    );
    assert.equal(dependent.status, 'queued');
    persistFinalFailure(env.goalPlanStore, planIdOf(env, running.sessionId));
    await env.supervisor.releaseSlot({ planId: planIdOf(env, running.sessionId) });
    assert.equal(runner.starts.includes(planIdOf(env, dependent.sessionId)), false);
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, dependent.sessionId)).runner.status, 'waiting_user');
    assert.equal(env.supervisor.get({ sessionId: dependent.sessionId }).queueReason, 'dependency_failed');
    const resume = await env.supervisor.resumeFromApproval({ sessionId: dependent.sessionId });
    assert.equal(resume.reason, 'scheduler_not_admitted');
  } finally {
    await env.cleanup();
  }
});

test('重新建立监督者时，已经结束的占用者会把队列里的下一个拉起来', async () => {
  const runner = countingRunner();
  const env = await harness({ goalRunner: runner.goalRunner });
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '先占住名额', readOnly: false }),
      contextOf(env, { inputId: 'input-run' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '等着', brief: '等重启' }),
      contextOf(env, { inputId: 'input-next' }),
    );
    const whileRunning = createSessionSupervisor({
      conversationStore: env.conversationStore,
      goalPlanStore: env.goalPlanStore,
      goalRunner: runner.goalRunner,
      now: () => '2026-09-27T00:00:00.000Z',
    });
    await whileRunning.reconciled;
    assert.equal(runner.starts.length, 1);

    env.goalPlanStore.setPlanStatus(planIdOf(env, running.sessionId), 'completed');
    const afterRestart = createSessionSupervisor({
      conversationStore: env.conversationStore,
      goalPlanStore: env.goalPlanStore,
      goalRunner: runner.goalRunner,
      now: () => '2026-09-27T00:00:00.000Z',
    });
    await afterRestart.reconciled;
    assert.equal(runner.starts.at(-1), planIdOf(env, queued.sessionId));
    assert.equal(env.goalPlanStore.getPlan(planIdOf(env, queued.sessionId)).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('amend 在等待用户时作为回答投递，并标注来自项目代理', async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(spawnInput(), contextOf(env));
    const planId = env.supervisor.get({ sessionId: opened.sessionId }).planId;
    const before = env.goalPlanStore.getPlan(planId);
    assert.equal(before.runner.waitingOnUser, true);
    const delivered = await env.supervisor.message({
      sessionId: opened.sessionId,
      text: '把标题改短',
      intent: 'amend',
    });
    assert.equal(delivered.delivery, 'answer');
    assert.equal(delivered.relayFrom, 'project_agent');
    assert.equal(env.turns.length, 2);
    const child = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' })[0];
    const relay = env.conversationStore.getConversation(child.id).messages.find((item) => item.relayFrom === 'project_agent');
    assert.equal(relay.content, '来自项目代理转达：用户说把标题改短');
    assert.equal(relay.routeIntent, 'answer');
    const fresh = env.goalPlanStore.getPlan(planId);
    assert.notEqual(fresh.status, 'cancelled');
  } finally {
    await env.cleanup();
  }
});

test('amend 在运行中留到下一回合，不取消未完成任务', async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(
      spawnInput({ title: '正在改文案', brief: '改登录文案' }),
      contextOf(env, { inputId: 'input-running' }),
    );
    const planId = env.supervisor.get({ sessionId: opened.sessionId }).planId;
    env.goalPlanStore.revisePlan(planId, {
      tasks: [{ taskId: 'leaf-1', title: '改文案', status: 'running', subtasks: [] }],
    }, { reason: 'test leaf', changedBy: 'test' });
    env.goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'running',
      intent: 'execute',
      phase: 'orient',
      waitingOnUser: false,
    });
    const delivered = await env.supervisor.message({
      sessionId: opened.sessionId,
      text: '标题再短一点',
      intent: 'amend',
    });
    assert.equal(delivered.delivery, 'next_turn');
    assert.equal(delivered.relayFrom, 'project_agent');
    assert.equal(env.turns.length, 1);
    const fresh = env.goalPlanStore.getPlan(planId);
    assert.equal(fresh.status, 'executing');
    assert.equal(fresh.tasks[0].status, 'running');
    assert.equal(fresh.runner.status, 'running');
    const correction = fresh.runTrace.events.find((event) => event.type === 'user_correction');
    assert.equal(correction.payload.relayFrom, 'project_agent');
    assert.equal(correction.payload.effect, 'next_turn');
    assert.match(correction.summary, /来自项目代理转达：用户说标题再短一点/);
    const child = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' })
      .find((item) => item.delegation?.sessionId === opened.sessionId);
    const relay = env.conversationStore.getConversation(child.id).messages.at(-1);
    assert.equal(relay.content, '来自项目代理转达：用户说标题再短一点');
    assert.equal(relay.relayFrom, 'project_agent');
    assert.equal(relay.routeIntent, 'correction');
  } finally {
    await env.cleanup();
  }
});

test('supersedes 停掉旧会话并开新会话，缺失的旧会话不会开新任务', async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(spawnInput(), contextOf(env));
    const missing = await env.supervisor.spawn(spawnInput({
      title: '不该出现',
      brief: '旧会话不存在',
      supersedes: 'missing-session',
    }), contextOf(env, { inputId: 'input-missing' }));
    assert.equal(missing.error, 'session_not_found');
    assert.equal(env.conversationStore.listChildren(env.parent.id, { role: 'work_session' }).length, 1);

    const replaced = await env.supervisor.spawn(spawnInput({
      title: '换成短标题',
      brief: '用短标题重做登录',
      supersedes: opened.sessionId,
    }), contextOf(env, { inputId: 'input-replace' }));
    assert.equal(replaced.error, undefined);
    assert.notEqual(replaced.sessionId, opened.sessionId);
    assert.equal(env.supervisor.get({ sessionId: opened.sessionId }).status, 'superseded');
    const again = await env.supervisor.spawn(spawnInput({
      title: '换成短标题',
      brief: '用短标题重做登录',
      supersedes: opened.sessionId,
    }), contextOf(env, { inputId: 'input-replay' }));
    assert.equal(again.replayed, true);
    assert.equal(again.sessionId, replaced.sessionId);
    assert.equal(env.conversationStore.listChildren(env.parent.id, { role: 'work_session' }).length, 2);
  } finally {
    await env.cleanup();
  }
});

test('supersedes 建成后才停旧会话，排队中的其他任务不会抢走名额', async () => {
  const env = await harness();
  try {
    const running = await env.supervisor.spawn(
      spawnInput({ title: '正在做', brief: '占住名额' }),
      contextOf(env, { inputId: 'input-holder' }),
    );
    const queued = await env.supervisor.spawn(
      spawnInput({ title: '在排队', brief: '等名额' }),
      contextOf(env, { inputId: 'input-queued' }),
    );
    assert.equal(queued.status, 'queued');
    const original = env.goalPlanStore.createGoalContract.bind(env.goalPlanStore);
    env.goalPlanStore.createGoalContract = (input) => {
      if (input?.title === '替换失败') throw new Error('snapshot broke');
      return original(input);
    };
    const failed = await env.supervisor.spawn(spawnInput({
      title: '替换失败',
      brief: '这一次不该停掉旧任务',
      supersedes: running.sessionId,
    }), contextOf(env, { inputId: 'input-fail' }));
    assert.equal(failed.error, 'spawn_failed');
    assert.notEqual(env.supervisor.get({ sessionId: running.sessionId }).status, 'superseded');
    assert.equal(env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: queued.sessionId }).planId).delegationOrigin.phase, 'queued');

    env.goalPlanStore.createGoalContract = original;
    const replaced = await env.supervisor.spawn(spawnInput({
      title: '换成新的',
      brief: '接过正在跑的名额',
      supersedes: running.sessionId,
    }), contextOf(env, { inputId: 'input-take' }));
    assert.equal(replaced.error, undefined);
    assert.equal(replaced.status, 'running');
    assert.equal(env.supervisor.get({ sessionId: running.sessionId }).status, 'superseded');
    assert.equal(env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: queued.sessionId }).planId).delegationOrigin.phase, 'queued');
    assert.equal(env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: replaced.sessionId }).planId).delegationOrigin.phase, 'running');
  } finally {
    await env.cleanup();
  }
});

test('已经结束的会话拒绝 amend', async () => {
  const env = await harness();
  try {
    const opened = await env.supervisor.spawn(spawnInput({ title: '做完了', brief: '不再改' }), contextOf(env, { inputId: 'input-done' }));
    const planId = env.supervisor.get({ sessionId: opened.sessionId }).planId;
    const child = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' })
      .find((item) => item.delegation?.sessionId === opened.sessionId);
    const before = env.conversationStore.getConversation(child.id).messages.length;
    env.goalPlanStore.setPlanStatus(planId, 'completed');
    const delivered = await env.supervisor.message({
      sessionId: opened.sessionId,
      text: '再改一下',
      intent: 'amend',
    });
    assert.equal(delivered.error, 'session_not_running');
    assert.equal(env.conversationStore.getConversation(child.id).messages.length, before);
  } finally {
    await env.cleanup();
  }
});

test('开任务时子会话沿用指定的历史背景快照', { timeout: 20_000 }, async () => {
  const env = await harness();
  try {
    const history = env.conversationStore.createConversation({ title: '旧对话', workspacePath: env.root });
    env.conversationStore.appendMessage(history.id, { id: 'old-1', role: 'user', content: '以前的原话' });
    const persisted = env.conversationStore.getPersistedConversationHistory(history.id);
    const captured = env.conversationStore.captureInheritedBackground(history.id, {
      expectedRevision: persisted.contentRevision,
      runtimeState: {
        conversationId: history.id,
        contentRevision: persisted.contentRevision,
        status: 'idle',
      },
      capturedAt: '2026-09-28T00:00:00.000Z',
    });
    const opened = await env.supervisor.spawn(
      spawnInput(),
      contextOf(env, { backgroundSnapshotId: captured.snapshotId, inputId: 'input-history' }),
    );
    assert.equal(opened.error, undefined);
    const child = env.conversationStore.listChildren(env.parent.id, { role: 'work_session' })
      .find((item) => item.delegation?.sessionId === opened.sessionId);
    assert.equal(child.backgroundSnapshotId, captured.snapshotId);
    const snapshot = env.conversationStore.readInheritedBackground(child.backgroundSnapshotId);
    assert.equal(snapshot.sourceConversationId, history.id);
    assert.equal(snapshot.entries.some((entry) => entry.text.includes('以前的原话')), true);
    assert.equal(snapshot.entries.some((entry) => entry.text.includes('请把登录修好')), false);
  } finally {
    await env.cleanup();
  }
});

test('supervisor admits one writer and two readers, reserves before start and persists host queue facts', async () => {
  const runner=countingRunner();const env=await harness({goalRunner:runner.goalRunner});
  try {
    const spawned=[];
    for (const [title,readOnly] of [['writer',false],['reader1',true],['reader2',true],['reader3',true],['writer2',false]]) {
      spawned.push(await env.supervisor.spawn(spawnInput({title,brief:title,readOnly}),contextOf(env,{inputId:title})));
    }
    assert.deepEqual(spawned.map(s=>s.status),['running','running','running','queued','queued']);
    assert.equal(runner.starts.length,3);
    assert.deepEqual(env.supervisor.get({sessionId:spawned[4].sessionId}).queuedBehind,[{sessionId:spawned[0].sessionId,title:env.supervisor.get({sessionId:spawned[0].sessionId}).title}]);
    await env.supervisor.cancel({sessionId:spawned[1].sessionId});
    assert.equal(runner.starts.length,4);
    assert.equal(runner.starts.at(-1),planIdOf(env,spawned[3].sessionId));
    await env.supervisor.releaseSlot({planId:planIdOf(env,spawned[1].sessionId)});
    assert.equal(runner.starts.length,4);
  } finally {await env.cleanup();}
});

test('accepted dependency wakes its queued child; completed without acceptance never does', async () => {
  const runner=countingRunner();const env=await harness({goalRunner:runner.goalRunner,
    resolveAcceptancePolicy:()=> 'confirm', readSessionFacts:()=>({hostAuthority:{independentVerifier:'passed'}})});
  try {
    const dep=await completedSession(env);
    const child=await env.supervisor.spawn(spawnInput({title:'child',brief:'after acceptance',dependsOn:[dep.sessionId]}),contextOf(env));
    assert.equal(child.status,'queued');assert.equal(runner.starts.length,1);
    env.conversationStore.appendMessage(env.parent.id,{id:'reported',role:'assistant',kind:'agent_reply',sources:[dep.sessionId],content:'done'});
    await env.supervisor.releaseSlot({planId:dep.planId});assert.equal(runner.starts.length,1);
    assert.equal((await env.supervisor.confirmResult(dep.sessionId)).accepted,true);
    assert.equal(runner.starts.at(-1),planIdOf(env,child.sessionId));
    assert.equal(runner.starts.length,2);
    await env.supervisor.confirmResult(dep.sessionId);assert.equal(runner.starts.length,2);
  } finally {await env.cleanup();}
});

test('missing and foreign dependencies reject before creating child conversations', async () => {
  const env=await harness({goalRunner:countingRunner().goalRunner});
  try {
    const dep=await env.supervisor.spawn(spawnInput({title:'foreign',brief:'foreign'}),contextOf(env,{workspaceId:'other'}));
    const before=env.conversationStore.listChildren(env.parent.id).length;
    for(const dependsOn of [['missing'],[dep.sessionId]]) {
      const result=await env.supervisor.spawn(spawnInput({dependsOn}),contextOf(env));
      assert.equal(result.error,'invalid_dependency');
    }
    assert.equal(env.conversationStore.listChildren(env.parent.id).length,before);
  } finally {await env.cleanup();}
});

test('stored priority controls promotion after supervisor restart', async () => {
  const runner=countingRunner();const env=await harness({goalRunner:runner.goalRunner});
  try {
    const first=await env.supervisor.spawn(spawnInput({title:'first',brief:'first'}),contextOf(env));
    const low=await env.supervisor.spawn(spawnInput({title:'low',brief:'low',priority:'low'}),contextOf(env));
    const high=await env.supervisor.spawn(spawnInput({title:'high',brief:'high',priority:'high'}),contextOf(env));
    const reloaded=createGoalPlanStore({storeDir:env.goalPlanStore.getStoreDir()});
    assert.equal(reloaded.getPlan(planIdOf(env,high.sessionId)).delegationOrigin.priority,'high');
    const restarted=createSessionSupervisor({conversationStore:env.conversationStore,goalPlanStore:reloaded,
      goalRunner:runner.goalRunner,catalog:visionCatalog(),routing:routing()});
    await restarted.reconciled;
    await restarted.cancel({sessionId:first.sessionId});
    assert.equal(runner.starts.at(-1),planIdOf(env,high.sessionId));
    assert.equal(reloaded.getPlan(planIdOf(env,low.sessionId)).delegationOrigin.phase,'queued');
  } finally {await env.cleanup();}
});

test('runner startup failure releases its reservation and does not strand the other selected readers', async () => {
  const env=await harness({goalRunner:countingRunner().goalRunner});
  try {
    const plans=[];
    for(let n=0;n<3;n++) {
      const result=await env.supervisor.spawn(spawnInput({title:`读取任务${n}`,brief:`读取任务${n}`,readOnly:true}),contextOf(env,{planApproval:'always'}));
      const plan=env.goalPlanStore.getPlan(planIdOf(env,result.sessionId));
      plans.push(plan);
    }
    for (const plan of plans) env.goalPlanStore.revisePlan(plan.planId,{delegationOrigin:{...plan.delegationOrigin,phase:'queued'}},{changedBy:'test'});
    const starts=[];
    const restarted=createSessionSupervisor({conversationStore:env.conversationStore,goalPlanStore:env.goalPlanStore,
      goalRunner:{async start(id){starts.push(id);if(starts.length===1) throw Error('startup failed');},setOnPlanTerminal(){}},catalog:visionCatalog(),routing:routing()});
    await restarted.reconciled;
    assert.equal(starts.length,3);assert.equal(new Set(starts).size,3);
    assert.equal(env.goalPlanStore.getPlan(starts[0]).status,'failed');
    for(const id of starts.slice(1)) assert.equal(env.goalPlanStore.getPlan(id).delegationOrigin.phase,'running');
  } finally {await env.cleanup();}
});

test('supersession is reversible, preserves task facts and never replays an old restore anchor', async () => {
  const env = await harness();
  try {
    const a = await env.supervisor.spawn(spawnInput({ title: 'A' }), contextOf(env));
    const aPlan = env.supervisor.get({ sessionId: a.sessionId }).planId;
    const originalIntent = env.goalPlanStore.getPlan(aPlan).runner.intent;
    env.goalPlanStore.revisePlan(aPlan, { evidenceRefs: ['artifact:a'], involvedFiles: ['keep.txt'] });
    const b = await env.supervisor.spawn(spawnInput({ title: 'B', brief: 'replace A', supersedes: a.sessionId }), contextOf(env));
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).supersededBy, b.sessionId);
    assert.equal(env.goalPlanStore.getPlan(aPlan).status, 'paused');
    const restored = await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env));
    assert.equal(restored.error, undefined);
    assert.equal(env.supervisor.get({ sessionId: b.sessionId }).supersededBy, a.sessionId);
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).supersededBy, undefined);
    assert.deepEqual(env.goalPlanStore.getPlan(aPlan).evidenceRefs, ['artifact:a']);
    assert.deepEqual(env.goalPlanStore.getPlan(aPlan).involvedFiles, ['keep.txt']);
    assert.equal(env.goalPlanStore.getPlan(aPlan).runner.intent, originalIntent);
    const c = await env.supervisor.spawn(spawnInput({ title: 'C', brief: 'replace A again', supersedes: a.sessionId }), contextOf(env));
    assert.equal(c.error, undefined);
    const replay = await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env));
    assert.equal(replay.replayed, true);
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).supersededBy, c.sessionId);
    assert.equal(env.supervisor.get({ sessionId: c.sessionId }).status === 'superseded', false);
  } finally { await env.cleanup(); }
});

test('restore and replace enforce workspace, parent, user anchor and result-ready boundaries', async () => {
  const env = await harness();
  try {
    const a = await env.supervisor.spawn(spawnInput(), contextOf(env));
    assert.equal((await env.supervisor.spawn(spawnInput({ supersedes: a.sessionId, title: 'other' }), contextOf(env, { workspaceId: 'other' }))).error, 'out_of_scope');
    assert.equal(env.conversationStore.listChildren(env.parent.id, { role: 'work_session' }).length, 1);
    await env.supervisor.spawn(spawnInput({ supersedes: a.sessionId, title: 'B', brief: 'replace' }), contextOf(env));
    assert.equal((await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'missing' }, contextOf(env))).error, 'invalid_anchor');
    assert.equal((await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env, { parentConversationId: 'other' }))).error, 'out_of_scope');
    const planId = env.supervisor.get({ sessionId: a.sessionId }).planId;
    env.goalPlanStore.setPlanStatus(planId, 'completed');
    assert.equal((await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env))).error, 'session_not_running');
    assert.equal((await env.supervisor.spawn(spawnInput({ supersedes: a.sessionId, title: 'C', brief: 'replace finished' }), contextOf(env))).error, 'session_not_running');
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).status, 'result_ready');
  } finally { await env.cleanup(); }
});

test('superseded tasks retain isolation for seven days then cancel silently and clean through existing ports', async () => {
  let time = '2026-09-27T00:00:00.000Z';
  const cleaned = [];
  const env = await harness({ now: () => time,
    isolationPlanner: { prepare: async plan => ({ ok: true, plan }), cleanup: async plan => { cleaned.push(plan.planId); return plan; } } });
  try {
    const a = await env.supervisor.spawn(spawnInput({ title: 'A' }), contextOf(env));
    const planId = env.supervisor.get({ sessionId: a.sessionId }).planId;
    env.goalPlanStore.revisePlan(planId, { deliveryBinding: { ...env.goalPlanStore.getPlan(planId).deliveryBinding,
      executionIsolation: 'worktree', worktreePath: '/fixture/isolated-A' } });
    await env.supervisor.spawn(spawnInput({ title: 'B', brief: 'replace', supersedes: a.sessionId }), contextOf(env));
    assert.equal(cleaned.includes(planId), false);
    assert.equal(env.goalPlanStore.getPlan(planId).deliveryBinding.worktreePath, '/fixture/isolated-A');
    time = '2026-10-03T23:59:59.000Z'; await env.supervisor.reconcile();
    assert.equal(cleaned.includes(planId), false);
    time = '2026-10-04T00:00:00.000Z'; await env.supervisor.reconcile();
    assert.equal(env.goalPlanStore.getPlan(planId).status, 'cancelled');
    assert.equal(cleaned.includes(planId), true);
    await env.supervisor.reconcile();
    assert.equal(cleaned.filter(id => id === planId).length, 2);
    assert.equal(env.events.find(event => event.sessionId === a.sessionId && event.reason === 'supersession_expired').surfacing, 'silent');
  } finally { await env.cleanup(); }
});

test('restoring a superseded approval candidate keeps its approval gate closed', async () => {
  const env = await harness({ readPlanApproval: () => 'always' });
  try {
    const a = await env.supervisor.spawn(spawnInput({ title: 'A' }), contextOf(env));
    await env.supervisor.spawn(spawnInput({ title: 'B', brief: 'replace', supersedes: a.sessionId }), contextOf(env));
    const approval = await env.supervisor.resumeFromApproval({ sessionId: a.sessionId });
    assert.equal(approval.ok, false);
    await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env));
    assert.equal(env.goalPlanStore.getPlan(env.supervisor.get({ sessionId: a.sessionId }).planId).delegationOrigin.phase, 'awaiting_approval');
    assert.equal(env.turns.length, 0);
  } finally { await env.cleanup(); }
});

test('reprioritizing queued work is durable and does not bypass the write slot', async () => {
  const env = await harness();
  try {
    await env.supervisor.spawn(spawnInput({ title: 'holder' }), contextOf(env));
    const low = await env.supervisor.spawn(spawnInput({ title: 'low', brief: 'queued', priority: 'low' }), contextOf(env));
    const changed = await env.supervisor.reprioritize({ sessionId: low.sessionId, priority: 'high' }, contextOf(env));
    assert.equal(changed.status, 'queued');
    assert.equal(env.goalPlanStore.getPlan(changed.planId).delegationOrigin.priority, 'high');
    const restarted = createGoalPlanStore({ storeDir: env.goalPlanStore.getStoreDir() });
    assert.equal(restarted.getPlan(changed.planId).delegationOrigin.priority, 'high');
    assert.equal((await env.supervisor.reprioritize({ sessionId: low.sessionId, priority: 'top' }, contextOf(env))).error, 'invalid_priority');
  } finally { await env.cleanup(); }
});

test('failed replacement releases its slot while the old task remains recoverable', async () => {
  let starts = 0;
  const env = await harness({ goalRunner: { start: async () => { starts++; if (starts === 2) throw new Error('replacement crashed'); }, pause() {}, waitForIdle: async () => {} } });
  try {
    const a = await env.supervisor.spawn(spawnInput({ title: 'A' }), contextOf(env));
    const b = await env.supervisor.spawn(spawnInput({ title: 'B', brief: 'replace A', supersedes: a.sessionId }), contextOf(env));
    assert.equal(b.status, 'failed');
    assert.equal(env.supervisor.get({ sessionId: b.sessionId }).status, 'failed');
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).status, 'superseded');
    const restored = await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env));
    assert.equal(restored.error, undefined);
    assert.equal(env.goalPlanStore.getPlan(restored.planId).delegationOrigin.phase, 'running');
    assert.equal(starts, 3);
  } finally { await env.cleanup(); }
});

test('manual delegated pause closes admission until an anchored restore', async () => {
  const env = await harness();
  try {
    const a = await env.supervisor.spawn(spawnInput({ title: 'A' }), contextOf(env));
    const planId = env.supervisor.get({ sessionId: a.sessionId }).planId;
    env.goalRunner.pause(planId, 'user_pause'); await env.goalRunner.waitForIdle(planId);
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).status, 'paused');
    await env.supervisor.reconcile();
    assert.equal(env.goalPlanStore.getPlan(planId).delegationOrigin.phase, 'paused');
    const resumed = await env.supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'anchor-1' }, contextOf(env));
    assert.equal(resumed.error, undefined); assert.notEqual(resumed.status, 'paused');
  } finally { await env.cleanup(); }
});

test('supersession closes the persisted admission gate before waiting for an in-flight tool', async () => {
  let release; let began;
  const settling = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  let starts = 0; let cleanups = 0;
  const env = await harness({ goalRunner: { start: async () => { starts++; }, pause() {}, waitForIdle: () => { began(); return settling; } },
    isolationPlanner: { prepare: async plan => ({ ok: true, plan }), cleanup: async plan => { cleanups++; return plan; } } });
  try {
    const a = await env.supervisor.spawn(spawnInput({ title: 'A' }), contextOf(env));
    const replacing = env.supervisor.spawn(spawnInput({ title: 'B', brief: 'replace', supersedes: a.sessionId }), contextOf(env));
    await started;
    assert.equal(env.supervisor.get({ sessionId: a.sessionId }).status, 'superseded');
    assert.equal(starts, 1); assert.equal(cleanups, 0);
    release(); assert.equal((await replacing).error, undefined); assert.equal(starts, 2);
  } finally { release(); await env.cleanup(); }
});
