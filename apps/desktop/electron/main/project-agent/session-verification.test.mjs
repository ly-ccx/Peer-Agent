import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGoalPlanStore } from '../../../../../packages/runtime-node/src/goal-plan-store.mjs';
import { createSessionSupervisor } from '../../../../../packages/runtime-node/src/project-agent/session-supervisor.mjs';
import { createDelegationProvider } from '../../../../../packages/runtime-node/src/project-agent/delegation-provider.mjs';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import {
  createSessionVerification,
  installSessionVerification,
} from './session-verification.mjs';

const selection = {
  providerId: 'local',
  modelId: 'worker-1',
  modelProviderId: 'worker-1',
  family: 'alpha',
};

function origin(extra = {}) {
  return {
    anchorMessageId: 'anchor-1',
    inputId: 'input-1',
    surface: 'desktop',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    parentConversationId: 'parent-1',
    readOnly: true,
    phase: 'running',
    depth: 1,
    modelSelection: {
      worker: selection,
      explorer: selection,
      verifier: { ...selection, modelId: 'verifier-1', modelProviderId: 'verifier-1', family: 'beta', sameFamilyAsWorker: false },
      source: { worker: 'global', verifier: 'global' },
      resolvedAt: '2026-09-27T00:00:00.000Z',
    },
    ...extra,
  };
}

test('桌面复核端口从宿主计划和证据索引取事实，复核完成后退出 verifying', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-04-verify-'));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const appended = [];
  try {
    const created = store.createPlan({
      conversationId: 'child-1',
      title: '登录',
      goal: '登录',
      successCriteria: ['能登录'],
      tasks: [{ taskId: 'leaf', status: 'completed', evidenceRefs: ['tool-result://host-verifier'] }],
      delegationOrigin: origin(),
    });
    store.registerEvidenceRefs?.(created.planId, ['tool-result://host-verifier']);
    const verification = createSessionVerification({
      goalPlanStore: store,
      verifySession: async (plan, focus) => {
        assert.equal(plan.planId, created.planId);
        assert.equal(focus, '登录');
        return { passed: true, verifierModel: 'verifier-1', sameFamilyAsWorker: false };
      },
      appendMessage: (conversationId, message) => appended.push({ conversationId, message }),
    });
    installSessionVerification(verification);
    const supervisor = createSessionSupervisor({
      conversationStore: {
        getConversation() { return null; },
        getPersistedConversationHistory() { return { messages: [] }; },
      },
      goalPlanStore: store,
      goalRunner: { async start() {} },
    });
    const provider = createDelegationProvider({ verification });
    const reviewed = JSON.parse((await provider.executeCapability({
      call: {
        toolCallId: 'verify-1',
        capabilityId: 'local.delegation.verify_session',
        arguments: { sessionId: 'session-1', focus: '登录' },
      },
    }, {
      mode: 'project_agent',
      role: 'project_agent',
      messages: [{ id: 'u1', role: 'user', kind: 'user_input' }],
    })).result.outputPreview.legacyResult.output);
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.status, 'verifying');
    assert.notEqual(store.getPlan(created.planId).delegationOrigin.verifying, true);
    assert.equal(supervisor.get({ sessionId: 'session-1' }).status, 'waiting_user');
    assert.equal(appended[0].conversationId, 'parent-1');
    assert.equal(appended[0].message.kind, 'system_card');
    assert.equal(appended[0].message.cards[0].content, reviewed.event.outcome);

    const host = createLocalToolHost({
      workspaceRoot: root,
      userDataPath: root,
      sessionStore: { getSession: () => ({ locale: 'zh-CN' }) },
    });
    const executed = await host.execute({
      sessionId: 'session-1',
      projectionId: 'projection-1',
      conversationId: 'parent-1',
      call: {
        toolCallId: 'detail-1',
        capabilityId: 'local.delegation.get_verification_detail',
        arguments: { sessionId: 'session-1' },
      },
    }, {
      mode: 'project_agent',
      role: 'project_agent',
      toolContext: { mode: 'project_agent', turnRole: 'project_agent', messages: [] },
    });
    const detail = JSON.parse(executed.result.outputPreview.legacyResult.output);
    assert.equal(detail.ok, true);
    assert.equal(detail.sessionId, 'session-1');
    assert.equal(detail.workerModel, 'worker-1');
    assert.equal(detail.sameSource, false);
  } finally {
    installSessionVerification(null);
    rmSync(root, { recursive: true, force: true });
  }
});
