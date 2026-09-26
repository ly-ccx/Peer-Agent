import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createApprovalStore } from '@peer-agent/runtime-node';
import { createDesktopGoalRunnerHost } from './goal-runner-host.mjs';
import {
  WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES,
  resolveDelegatedWorkTurn,
  resolveWorkSessionProfile,
} from './work-session-profile.mjs';
import { createChatPermissionGate } from '../chat-runtime/permission-gate.mjs';
import { buildRuntimeTools } from '../llm-chat-service.mjs';
import { createRuntimeToolProjection } from '../tools/index.mjs';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000042';

function selection(modelProviderId) {
  return {
    providerId: 'openai',
    modelId: modelProviderId,
    modelProviderId,
    family: 'openai',
  };
}

function taskPlan(modelSelection) {
  return {
    planId: 'plan-task',
    conversationId: 'conv-task',
    delegationOrigin: {
      workspaceId: WORKSPACE_ID,
      sessionId: 'sess-task',
      memorySnapshotId: 'mem-1',
      ...(modelSelection ? { modelSelection } : {}),
    },
  };
}

function toolNames(projectionOptions) {
  const { modelProjection } = createRuntimeToolProjection({ projectionOptions });
  return modelProjection.tools.map((tool) => tool.name);
}

test('a plan without delegationOrigin is not a work session', () => {
  assert.equal(resolveWorkSessionProfile({ plan: { planId: 'p1' }, kind: 'worker' }), null);
  assert.equal(resolveDelegatedWorkTurn({ planId: 'p1' }, 'worker', {
    conversationModelProviderId: 'conversation-model',
  }), null);
});

test('task execution uses the frozen worker even when the conversation model changes', () => {
  let routed = 0;
  const turn = resolveDelegatedWorkTurn(taskPlan({
    worker: selection('frozen-worker'),
    explorer: selection('frozen-explorer'),
    verifier: { ...selection('frozen-verifier'), sameFamilyAsWorker: false },
    visualVerifier: selection('frozen-visual'),
  }), 'worker', {
    conversationModelProviderId: 'conversation-model',
    routeRole() {
      routed += 1;
      return { ok: true, selection: selection('routed') };
    },
  });
  assert.equal(routed, 0);
  assert.equal(turn.modelProviderId, 'frozen-worker');
  assert.equal(turn.turnProfile.role, 'work_session');
  assert.equal(turn.turnProfile.workspaceId, WORKSPACE_ID);
  assert.equal(turn.turnProfile.sessionId, 'sess-task');
  assert.equal(turn.turnProfile.memorySnapshotId, 'mem-1');
  assert.deepEqual(turn.turnProfile.excludeCapabilityPrefixes, ['local.web.control.']);
  assert.equal(turn.turnProfile.modelSelection.source, 'task');
});

test('explorer, verifier, and visual review use their frozen slots', () => {
  const plan = taskPlan({
    worker: selection('frozen-worker'),
    explorer: selection('frozen-explorer'),
    verifier: { ...selection('frozen-verifier'), sameFamilyAsWorker: false },
    visualVerifier: selection('frozen-visual'),
  });
  assert.equal(resolveDelegatedWorkTurn(plan, 'explorer').modelProviderId, 'frozen-explorer');
  const verifier = resolveDelegatedWorkTurn(plan, 'verifier');
  assert.equal(verifier.modelProviderId, 'frozen-verifier');
  assert.equal(verifier.turnProfile.modelSelection.sameFamilyAsWorker, false);
  assert.equal(resolveDelegatedWorkTurn(plan, 'visual_verifier').modelProviderId, 'frozen-visual');
});

test('a delegated plan with no snapshot falls back to conversation and role routing', () => {
  const plan = taskPlan(null);
  const worker = resolveDelegatedWorkTurn(plan, 'worker', {
    conversationModelProviderId: 'conversation-model',
  });
  assert.equal(worker.modelProviderId, 'conversation-model');
  assert.equal(worker.turnProfile.role, 'work_session');
  assert.deepEqual(
    worker.turnProfile.excludeCapabilityPrefixes,
    WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES,
  );

  const explorer = resolveDelegatedWorkTurn(plan, 'explorer', {
    conversationModelProviderId: 'conversation-model',
    routeRole(kind) {
      assert.equal(kind, 'explorer');
      return {
        ok: true,
        selection: selection('routed-explorer'),
        source: 'global',
        candidateIds: ['routed-explorer', 'conversation-model'],
      };
    },
  });
  assert.equal(explorer.modelProviderId, 'routed-explorer');
  assert.deepEqual(explorer.turnProfile.recoveryCandidateIds, ['routed-explorer', 'conversation-model']);
});

test('work session projection drops L1 embedded browser and keeps L2', () => {
  const excluded = toolNames({
    mode: 'goal',
    excludeCapabilityPrefixes: ['local.web.control.'],
  });
  assert.equal(excluded.includes('browser_open_panel'), false);
  assert.equal(excluded.includes('browser_navigate'), false);
  assert.equal(excluded.includes('browser_external_open'), true);
  assert.equal(excluded.includes('bash'), true);
  assert.equal(excluded.includes('read_file'), true);

  const ordinary = toolNames({ mode: 'goal' });
  assert.equal(ordinary.includes('browser_open_panel'), true);
  assert.equal(ordinary.includes('browser_external_open'), true);

  const fromProfile = buildRuntimeTools({
    mode: 'goal',
    excludeCapabilityPrefixes: ['local.web.control.'],
  }).tools.map((tool) => tool.function.name);
  assert.equal(fromProfile.includes('browser_open_panel'), false);
  assert.equal(fromProfile.includes('browser_external_open'), true);
  const classic = buildRuntimeTools({ mode: 'goal' }).tools.map((tool) => tool.function.name);
  assert.equal(classic.includes('browser_open_panel'), true);
});

test('the host passes the frozen model and work_session profile into each task turn', async () => {
  const seen = [];
  const visualInputs = [];
  const plan = taskPlan({
    worker: selection('frozen-worker'),
    explorer: selection('frozen-explorer'),
    verifier: selection('frozen-verifier'),
    visualVerifier: selection('frozen-visual'),
  });
  const host = createDesktopGoalRunnerHost({
    goalPlanStore: { getPlan: () => null, setRunnerState() {} },
    conversationStore: {
      getConversation: () => ({ id: 'conv-task', workspacePath: '/tmp/task', messages: [] }),
      appendMessage() {},
    },
    agentTurnExecutor: {
      async runTurn(input) {
        seen.push(input);
        return { terminalStatus: 'done', toolCallCount: 0 };
      },
    },
    broadcast() {},
    llmChatService: {
      resolveGoalRole() {
        throw new Error('snapshot turn must not resolve a live role');
      },
    },
    runPlanVisualVerifier: async (input) => {
      visualInputs.push(input);
      return { passed: true };
    },
    resolveConversationModelProviderId: () => 'conversation-model',
    toDesktopProviderMessages: (messages) => messages,
    desktopContinuityContextFromProjection: () => [],
    workspaceRoot: '/tmp/task',
    getMainWindows: () => [],
  });

  await host.explorerRunner.runExplorer({
    plan,
    explorer: { explorerId: 'ex-1', request: { question: 'Where?' } },
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

  assert.equal(seen[0].modelProviderId, 'frozen-explorer');
  assert.equal(seen[0].turnProfile.role, 'work_session');
  assert.deepEqual(seen[0].turnProfile.excludeCapabilityPrefixes, ['local.web.control.']);
  assert.equal(seen[1].modelProviderId, 'frozen-verifier');
  assert.equal(seen[1].turnProfile.role, 'work_session');
  assert.equal(visualInputs[0].modelProviderId, 'frozen-visual');
});

test('pending approval records keep the task workspace, session, and plan', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'work-session-approvals-'));
  try {
    const store = createApprovalStore({ rootDir: root });
    const activeStreams = new Map([['s-task', {
      permissionIds: new Set(),
      turnProfile: {
        role: 'work_session',
        workspaceId: WORKSPACE_ID,
        sessionId: 'sess-task',
        planId: 'plan-task',
      },
    }]]);
    const events = [];
    const gate = createChatPermissionGate({
      activeStreams,
      approvalStore: store,
      resolveApprovalScope: () => ({
        workspaceId: '00000000-0000-4000-8000-000000000099',
        planId: 'other-plan',
        conversationId: 'c1',
      }),
    });
    const pending = gate.createFilePermissionRequester({
      webContents: { send(channel, payload) { events.push({ channel, payload }); } },
      streamId: 's-task',
      toolCallId: 'tool-task',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/a.txt', content: 'x' },
      filePath: '/outside/a.txt',
      workspacePath: '/workspace',
    });
    const open = store.list({ state: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0].workspaceId, WORKSPACE_ID);
    assert.equal(open[0].sessionId, 'sess-task');
    assert.equal(open[0].planId, 'plan-task');
    const file = readFileSync(store.fileFor(WORKSPACE_ID), 'utf8');
    assert.equal(file.includes('sess-task'), true);
    assert.equal(file.includes('"planId":"plan-task"'), true);
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-task',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await pending).granted, true);

    const ordinary = new Map([['s-plain', { permissionIds: new Set(), turnProfile: { role: 'goal_runner' } }]]);
    const ordinaryStore = createApprovalStore({ rootDir: path.join(root, 'plain') });
    const ordinaryGate = createChatPermissionGate({
      activeStreams: ordinary,
      approvalStore: ordinaryStore,
      resolveApprovalScope: () => ({ workspaceId: WORKSPACE_ID, planId: 'plan-classic', conversationId: 'c1' }),
    });
    ordinaryGate.createFilePermissionRequester({
      webContents: { send() {} },
      streamId: 's-plain',
      toolCallId: 'tool-classic',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/b.txt', content: 'y' },
      filePath: '/outside/b.txt',
      workspacePath: '/workspace',
    });
    const classic = ordinaryStore.list({ state: 'open' })[0];
    assert.equal(classic.workspaceId, WORKSPACE_ID);
    assert.equal(classic.planId, 'plan-classic');
    assert.equal(classic.sessionId, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
