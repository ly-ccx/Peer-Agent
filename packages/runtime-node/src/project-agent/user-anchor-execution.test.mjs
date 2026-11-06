import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createGoalRunner } from '../goal-runner.mjs';
import { createNodeProviderBundle } from '../provider-bundle.ts';
import { createSessionSupervisor } from './session-supervisor.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';

test('A5 allowed image delegation reaches the real GoalRunner and governed file execution exactly once', { timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-anchor-execution-'));
  const previousHome = process.env.PEER_AGENT_HOME; process.env.PEER_AGENT_HOME = root;
  const file = path.join(root, 'meta.zh.json'), body = path.join(root, 'self-host-quickstart.zh.mdx');
  const pages = ['index', 'tutorial', 'self-host-quickstart', '---工作区---', 'tasks'];
  writeFileSync(file, JSON.stringify({ pages }, null, 2)); writeFileSync(body, '正文保留\n');
  for (const locale of ['en', 'fr', 'ja', 'ko']) writeFileSync(path.join(root, `meta.${locale}.json`), JSON.stringify({ pages: ['index', 'tutorial'] }));
  const beforeOther = ['en', 'fr', 'ja', 'ko'].map(locale => readFileSync(path.join(root, `meta.${locale}.json`), 'utf8'));
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans'), readWorkspaceHead: () => ({ branch: 'fixture', commit: 'abc', source: 'workspace_head' }) });
  const parent = conversations.createConversation({ role: 'project_agent', title: 'fixture', workspaceId: 'w', workspacePath: root });
  const user = { id: 'input-remove', inputId: 'remove', role: 'user', kind: 'user_input', content: '把这个去掉吧',
    attachments: [{ id: 'image', kind: 'image', mimeType: 'image/png', name: 'sidebar.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }] };
  conversations.appendMessage(parent.id, user);
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'fixture', formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  store.saveWork({ workId: 'goal', parentConversationId: parent.id, state: 'runnable' });
  const release = registerWorkBudget('w', store);
  const approvals = [], executions = []; let turns = 0, finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const deadline = setTimeout(() => fail(Error('worker did not reach governed execution')), 8000);
  const bundle = createNodeProviderBundle({ workspaceRoot: root, mode: 'goal', requestPermission: prompt => {
    approvals.push(prompt); return { granted: true, reason: 'trusted_isolated_fixture_policy' };
  } });
  const runner = createGoalRunner({ goalPlanStore: plans, canRunPlan: () => true, logger: { info() {}, warn() {}, error() {} },
    chatRuntime: { async runGoalTurn({ planId }) {
      try {
        turns++;
        const run = async (capabilityId, args, id) => {
          const execution = await bundle.runtime.execute({ sessionId: plans.getPlan(planId).conversationId,
            projectionId: bundle.projection.createdAt, call: { toolCallId: id, capabilityId, arguments: args } });
          assert.equal(execution.result.status, 'completed', JSON.stringify(execution.result));
          assert.ok(execution.result.evidence); executions.push(execution);
          plans.recordEvidenceRefs({ planId, conversationId: plans.getPlan(planId).conversationId, toolCallId: id, capabilityId,
            evidenceRefs: [`tool-result://${id}`], toolResult: execution.result, permissionGrant: execution.result.permissionGrant });
          return execution.result.output;
        };
        const read = await run('local.file.read', { path: 'meta.zh.json' }, 'read-nav');
        const json = JSON.parse(read.content); json.pages = json.pages.filter(item => item !== 'self-host-quickstart');
        await run('local.file.write', { path: 'meta.zh.json', content: JSON.stringify(json, null, 2), allow_overwrite: true }, 'write-nav');
        const after = await run('local.file.read', { path: 'meta.zh.json' }, 'verify-nav');
        assert.deepEqual(JSON.parse(after.content).pages, pages.filter(item => item !== 'self-host-quickstart'));
        finish();
        return { awaitingParentAgent: true, text: '文件修改与读回已完成，等待独立核验。' };
      } catch (error) { fail(error); throw error; }
    } } });
  const catalog = [{ modelProviderId: 'worker', providerId: 'fixture', modelId: 'worker', family: 'alpha', tools: true, vision: true, contextTokens: 32000 }];
  const supervisor = createSessionSupervisor({ conversationStore: conversations, goalPlanStore: plans, goalRunner: runner, catalog,
    routing: { tiers: { strong: { primary: 'worker' } }, roles: { explorer: { mode: 'tier', tier: 'strong' }, session_worker: { mode: 'tier', tier: 'strong' }, verifier: { mode: 'tier', tier: 'strong' } }, verifierPreferDifferentFamily: false },
    canManageWorkspace: () => true, readPlanApproval: () => 'never',
    readDelegationCapabilities: () => bundle.projection.tools.map(tool => tool.capabilityId) });
  const provider = createDelegationProvider({ supervisor });
  const request = { call: { toolCallId: 'dispatch-nav', capabilityId: 'local.delegation.spawn_session', arguments: {
    anchorMessageIds: ['remove'], title: '移除侧栏项', brief: '移除中文导航中的 self-host-quickstart 并读回；其他文件仅作安全断言。',
    kind: 'docs', readOnly: false, isolation: 'none', requiredCapabilities: ['local.file.read', 'local.file.write'],
    successCriteria: [{ kind: 'model_review', description: '目标导航项移除且其余条目保留' }],
  } } };
  const ctx = { mode: 'project_agent', role: 'project_agent', workspaceId: 'w', workspacePath: root, conversationId: parent.id,
    turnProfile: { role: 'project_agent', workId: 'goal' }, currentInputAnchors: ['input-remove'], messages: [user], turnId: 'parent-turn', toolCallOrdinal: 1 };
  try {
    const receipt = await provider.executeCapability(request, ctx);
    assert.equal(receipt.result.status, 'success', JSON.stringify(receipt.result.output));
    await completed;
    const replayed = await provider.executeCapability({ call: { ...request.call, toolCallId: 'dispatch-retry' } }, ctx);
    assert.equal(replayed.result.output.replayed, true);
    assert.equal(conversations.listChildren(parent.id, { role: 'work_session' }).length, 1);
    assert.equal(turns, 1); assert.equal(executions.filter(item => item.result.capabilityId === 'local.file.write').length, 1);
    assert.ok(approvals.length > 0, 'the write still needed a real fixture policy decision');
    const write = executions.find(item => item.result.capabilityId === 'local.file.write');
    assert.equal(write.result.permissionGrant.decision, 'allow');
    assert.equal(write.result.evidence.toolCallId, 'write-nav');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pages, pages.filter(item => item !== 'self-host-quickstart'));
    assert.equal(readFileSync(body, 'utf8'), '正文保留\n');
    assert.deepEqual(['en', 'fr', 'ja', 'ko'].map(locale => readFileSync(path.join(root, `meta.${locale}.json`), 'utf8')), beforeOther);
    assert.deepEqual(store.read().mandates.goal.rootInputIds, ['remove']);
    assert.ok(plans.listEvidenceIndex().some(entry => entry.toolCallId === 'write-nav'));
  } finally {
    clearTimeout(deadline); await bundle.dispose(); release(); store.close();
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
