import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHostLease, resolveRoleRoute } from '@peer-agent/runtime-node';
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

function admitVerifierFixture(store, plan) {
  const ref = 'tool-result://host-verifier';
  store.recordEvidenceRefs({ planId: plan.planId, conversationId: plan.conversationId,
    evidenceRef: ref, capabilityId: 'local.file.read', toolName: 'read_file',
    bodyPreview: { kind: 'file', text: 'Observed verifier fixture body', truncated: false } });
  const updated = store.revisePlan(plan.planId, { tasks: plan.tasks.map(task => ({ ...task, evidenceRefs: [ref] })) },
    { reason: 'Indexed verifier fixture', changedBy: 'test' });
  Object.assign(plan, updated);
}

function queuedExecutor(scripts, seen) {
  const queue = scripts.map((script) => createScriptedTurnExecutor(script));
  return {
    async runTurn(input) {
      const next = queue.shift();
      if (!next) throw new Error('scripted executor has no remaining turn');
      seen.push({
        role: input.turnProfile?.role ?? null,
        modelProviderId: input.modelProviderId ?? null,
        turnProfile: input.turnProfile ?? null,
        workspacePath: input.workspacePath ?? null,
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
    admitVerifierFixture(goalPlanStore, plan);
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
    assert.equal(typeof host.goalRunner.verifyDelegatedSession, 'function');
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
    assert.match(seen[2].content, /Observed verifier fixture body/);
    assert.match(seen[2].content, /untrusted factual data/);
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier retries malformed output once through the same readonly executor', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verifier-format-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  try {
    const seen = [];
    const { host, plan } = openRoutedHost({ root, providers: [routableProvider({ id: 'one', isDefault: true })],
      modelId: 'one', seen, visualInputs: [], scripts: [
        [{ type: 'delta', content: 'Done.' }, { type: 'terminal', channel: 'done' }],
        [{ type: 'delta', content: VERIFIER_JSON }, { type: 'terminal', channel: 'done' }],
      ] });
    const report = await host.verifierRunner.runVerifier({ plan, verifierRunId: 'format-1' });
    assert.equal(report.passed, true);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map(item => item.role), ['verifier', 'verifier']);
    assert.match(seen[1].content, /Done\./);
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

function routableProvider(overrides) {
  return {
    enabled: true,
    apiKeyConfigured: true,
    supportsVision: false,
    contextWindow: 32_000,
    ...overrides,
  };
}

function openRoutedHost({
  root,
  providers,
  routing = null,
  modelId,
  scripts,
  seen,
  visualInputs,
  conversationWorkspacePath = null,
}) {
  const goalPlanStore = createGoalPlanStore();
  const plan = goalPlanStore.createPlan({
    conversationId: 'conv-route',
    title: 'Routed host',
    goal: 'Route explorer and verifier by role',
    successCriteria: ['Each role keeps its model'],
    tasks: [
      { taskId: 't1', order: 0, title: 'Task 1', status: 'pending', evidenceRefs: [] },
    ],
  });
  goalPlanStore.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'tester' });
    admitVerifierFixture(goalPlanStore, plan);
  const host = createDesktopGoalRunnerHost({
    goalPlanStore,
    conversationStore: {
      getConversation() {
        return { id: 'conv-route', workspacePath: conversationWorkspacePath, messages: [{ role: 'user', content: 'go', timestamp: 1 }] };
      },
      appendMessage() {},
    },
    agentTurnExecutor: queuedExecutor(scripts, seen),
    broadcast() {},
    llmChatService: {
      resolveGoalRole(input) {
        return resolveRoleRoute({
          ...input,
          providers,
          ...(routing ? { routing } : {}),
          spentUsd: 0,
        });
      },
    },
    goalWorktreeAdapter: null,
    goalTaskBranchAdapter: null,
    desktopPreviewProvider: null,
    runPlanVisualVerifier: async (input) => {
      visualInputs.push(input);
      return { passed: true, modelProviderId: input.modelProviderId };
    },
    resolveConversationModelProviderId: () => modelId,
    toDesktopProviderMessages: (messages) => messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    desktopContinuityContextFromProjection: () => [],
    workspaceRoot: root,
    getMainWindows: () => [],
  });
  return { host, plan };
}

test('readonly reviewers and report repair retain the task workspace instead of the global active project', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-review-workspace-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  try {
    for (const { binding, expected } of [
      { binding: {}, expected: '/bound-project' },
      { binding: { targetWorkspacePath: '/target-project' }, expected: '/target-project' },
      { binding: { targetWorkspacePath: '/target-project', deliveryBinding: { executionIsolation: 'worktree', worktreePath: '/task-worktree' } }, expected: '/task-worktree' },
    ]) {
      const seen = [], visualInputs = [];
      const { host, plan } = openRoutedHost({ root: '/unrelated-active-project',
        conversationWorkspacePath: '/bound-project',
        providers: [routableProvider({ id: 'one', isDefault: true, supportsVision: true })], modelId: 'one',
        seen, visualInputs, scripts: [
          [{ type: 'delta', content: EXPLORER_JSON }, { type: 'terminal', channel: 'done' }],
          [{ type: 'delta', content: 'Done.' }, { type: 'terminal', channel: 'done' }],
          [{ type: 'delta', content: VERIFIER_JSON }, { type: 'terminal', channel: 'done' }],
        ] });
      Object.assign(plan, binding);
      await host.explorerRunner.runExplorer({ plan, explorer: { explorerId: 'scope', request: { question: 'Read this project' } } });
      assert.equal((await host.verifierRunner.runVerifier({ plan, verifierRunId: 'scope' })).passed, true);
      await host.verifierRunner.runVerifier({ plan, verifierRunId: 'visual-scope', stage: 'visual' });
      assert.deepEqual(seen.map(turn => turn.workspacePath), [expected, expected, expected]);
      assert.equal(visualInputs[0].workspacePath, expected);
    }
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('one usable model keeps goal execution, explorer, verifier, and visual review on that model', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-route-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  try {
    const seen = [];
    const visualInputs = [];
    const only = routableProvider({
      id: 'only-model',
      provider: 'openai',
      model: 'only',
      isDefault: true,
      supportsVision: true,
    });
    const { host, plan } = openRoutedHost({
      root,
      providers: [only],
      modelId: 'only-model',
      scripts: [
        [{ type: 'terminal', channel: 'error', payload: { error: 'stop-after-one-goal-turn' } }],
        [
          { type: 'delta', content: EXPLORER_JSON },
          { type: 'terminal', channel: 'done' },
        ],
        [
          { type: 'delta', content: VERIFIER_JSON },
          { type: 'terminal', channel: 'done' },
        ],
      ],
      seen,
      visualInputs,
    });
    await host.goalRunner.start(plan.planId, { awaitIdle: true });
    await host.explorerRunner.runExplorer({
      plan,
      explorer: { explorerId: 'ex-1', request: { question: 'Where is the host?' } },
    });
    await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-1',
      stage: 'criteria',
      signal: null,
    });
    await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-visual',
      stage: 'visual',
      signal: null,
    });
    assert.equal(seen[0].role, 'goal_runner');
    assert.equal(seen[0].modelProviderId, 'only-model');
    assert.deepEqual(seen[0].turnProfile, { role: 'goal_runner' });
    assert.equal(seen[1].modelProviderId, 'only-model');
    assert.equal(seen[1].turnProfile.modelSelection.modelProviderId, 'only-model');
    assert.equal(seen[2].modelProviderId, 'only-model');
    assert.equal(seen[2].turnProfile.role, 'verifier');
    assert.equal(visualInputs.length, 1);
    assert.equal(visualInputs[0].modelProviderId, 'only-model');
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('explorer and verifier stay on the text default while visual review uses a vision model', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-route-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  try {
    const seen = [];
    const visualInputs = [];
    const text = routableProvider({
      id: 'text-default',
      provider: 'openai',
      model: 'text',
      isDefault: true,
    });
    const vision = routableProvider({
      id: 'vision-model',
      provider: 'anthropic',
      model: 'vision',
      supportsVision: true,
    });
    const { host, plan } = openRoutedHost({
      root,
      providers: [text, vision],
      modelId: 'text-default',
      scripts: [
        [
          { type: 'delta', content: EXPLORER_JSON },
          { type: 'terminal', channel: 'done' },
        ],
        [
          { type: 'delta', content: VERIFIER_JSON },
          { type: 'terminal', channel: 'done' },
        ],
      ],
      seen,
      visualInputs,
    });
    await host.explorerRunner.runExplorer({
      plan,
      explorer: { explorerId: 'ex-1', request: { question: 'Where is the host?' } },
    });
    await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-1',
      stage: 'criteria',
      signal: null,
    });
    await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-visual',
      stage: 'visual',
      signal: null,
    });
    assert.equal(seen[0].modelProviderId, 'text-default');
    assert.equal(seen[0].turnProfile.role, 'explorer');
    assert.equal(seen[1].modelProviderId, 'text-default');
    assert.equal(visualInputs[0].modelProviderId, 'vision-model');
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('visual review returns a structured miss when no model can see images', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-route-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  try {
    const visualInputs = [];
    const text = routableProvider({
      id: 'text-default',
      provider: 'openai',
      model: 'text',
      isDefault: true,
    });
    const { host, plan } = openRoutedHost({
      root,
      providers: [text],
      modelId: 'text-default',
      scripts: [],
      seen: [],
      visualInputs,
    });
    const visual = await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-visual',
      stage: 'visual',
      signal: null,
    });
    assert.equal(visual.passed, false);
    assert.equal(visual.missing, '没有能看图的模型');
    assert.equal(visualInputs.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier prefers another family and keeps that family inside the recovery list', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-route-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  try {
    const seen = [];
    const text = routableProvider({
      id: 'text-default',
      provider: 'openai',
      model: 'text',
      isDefault: true,
    });
    const other = routableProvider({
      id: 'other-family',
      provider: 'anthropic',
      model: 'other',
    });
    const { host, plan } = openRoutedHost({
      root,
      providers: [text, other],
      routing: {
        tiers: { strong: { primary: 'text-default', fallbacks: ['other-family'] } },
        roles: { verifier: { mode: 'tier', tier: 'strong' } },
        verifierPreferDifferentFamily: true,
      },
      modelId: 'text-default',
      scripts: [
        [
          { type: 'delta', content: VERIFIER_JSON },
          { type: 'terminal', channel: 'done' },
        ],
      ],
      seen,
      visualInputs: [],
    });
    await host.verifierRunner.runVerifier({
      plan,
      verifierRunId: 'ver-1',
      stage: 'criteria',
      signal: null,
    });
    assert.equal(seen[0].modelProviderId, 'other-family');
    assert.equal(seen[0].turnProfile.modelSelection.sameFamilyAsWorker, false);
    assert.deepEqual(seen[0].turnProfile.recoveryCandidateIds, ['other-family', 'text-default']);
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('explorer throws the router miss instead of calling the model', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-route-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  try {
    const seen = [];
    const goalPlanStore = createGoalPlanStore();
    const plan = goalPlanStore.createPlan({
      conversationId: 'conv-route',
      title: 'Missing model',
      goal: 'Fail closed',
      successCriteria: ['No turn'],
      tasks: [
        { taskId: 't1', order: 0, title: 'Task 1', status: 'pending', evidenceRefs: [] },
      ],
    });
    const host = createDesktopGoalRunnerHost({
      goalPlanStore,
      conversationStore: {
        getConversation() {
          return { id: 'conv-route', messages: [] };
        },
        appendMessage() {},
      },
      agentTurnExecutor: queuedExecutor([], seen),
      broadcast() {},
      llmChatService: {
        resolveGoalRole() {
          return { ok: false, reason: 'empty', missing: '没有可用的模型', candidateIds: [] };
        },
      },
      runPlanVisualVerifier: async () => {
        throw new Error('visual verifier must not run');
      },
      resolveConversationModelProviderId: () => 'text-default',
      toDesktopProviderMessages: (messages) => messages,
      desktopContinuityContextFromProjection: () => [],
      workspaceRoot: root,
      getMainWindows: () => [],
    });
    await assert.rejects(
      () => host.explorerRunner.runExplorer({
        plan,
        explorer: { explorerId: 'ex-1', request: { question: 'missing?' } },
      }),
      /没有可用的模型/,
    );
    assert.equal(seen.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary plans still run, and task plans run only while this desktop holds the lease', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-host-lease-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  const leases = createHostLease({
    rootDir: path.join(root, 'leases'),
    hostId: 'desktop-test',
    surface: 'desktop',
    pid: 404,
    appVersion: 'test',
    schedule: () => ({ unref() {} }),
    cancel() {},
  });
  try {
    const goalPlanStore = createGoalPlanStore();
    const selection = {
      providerId: 'local', modelId: 'worker-1', modelProviderId: 'worker-1', family: 'alpha',
    };
    const ordinary = goalPlanStore.createPlan({
      conversationId: 'conv-ordinary',
      title: 'Ordinary',
      goal: 'Ordinary plans ignore the host lease',
      successCriteria: ['The ordinary plan reaches the turn'],
      tasks: [{ taskId: 't1', order: 0, title: 'Task', status: 'pending', evidenceRefs: [] }],
    });
    const task = goalPlanStore.createPlan({
      conversationId: 'conv-task',
      title: 'Task',
      goal: 'Task plans follow the host lease',
      successCriteria: ['The task plan reaches the turn only with a lease'],
      tasks: [{ taskId: 't1', order: 0, title: 'Task', status: 'pending', evidenceRefs: [] }],
      delegationOrigin: {
        anchorMessageId: 'anchor-1',
        inputId: 'input-1',
        surface: 'desktop',
        workspaceId: 'ws-task',
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
    goalPlanStore.recordApproval(ordinary.planId, { decision: 'approve', decidedBy: 'tester' });
    goalPlanStore.recordApproval(task.planId, { decision: 'approve', decidedBy: 'tester' });
    assert.equal(goalPlanStore.getPlan(task.planId).delegationOrigin.workspaceId, 'ws-task');
    let lookups = 0;
    const host = createDesktopGoalRunnerHost({
      goalPlanStore,
      conversationStore: {
        getConversation() {
          lookups += 1;
          return null;
        },
        appendMessage() {},
      },
      agentTurnExecutor: { async runTurn() { throw new Error('conversation is missing'); } },
      broadcast() {},
      llmChatService: {},
      hostLeases: leases,
      goalWorktreeAdapter: null,
      goalTaskBranchAdapter: null,
      desktopPreviewProvider: null,
      runPlanVisualVerifier: async () => ({ passed: true }),
      resolveConversationModelProviderId: () => 'model-host',
      toDesktopProviderMessages: (messages) => messages,
      desktopContinuityContextFromProjection: () => [],
      workspaceRoot: root,
      getMainWindows: () => [],
    });

    await host.goalRunner.start(ordinary.planId, { awaitIdle: true });
    assert.equal(lookups > 0, true);

    lookups = 0;
    const before = goalPlanStore.getPlan(task.planId)?.runner;
    await host.goalRunner.start(task.planId, { awaitIdle: true });
    await host.goalRunner.resume(task.planId);
    assert.equal(lookups, 0);
    assert.deepEqual(goalPlanStore.getPlan(task.planId)?.runner, before);

    assert.equal(leases.acquire('ws-task').acquired, true);
    await host.goalRunner.start(task.planId, { awaitIdle: true });
    assert.equal(lookups > 0, true);
  } finally {
    leases.close();
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
