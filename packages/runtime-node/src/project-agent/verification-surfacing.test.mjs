import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createSessionVerification } from './session-verification.mjs';
import { createSessionSupervisor } from './session-supervisor.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { composeReply } from './reply-composer.mjs';

for (const passed of [true, false]) test(`task verification and main-bot reporting share host facts after restart: ${passed}`, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-verification-surfacing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'ws', workspacePath: root });
  const child = conversations.createConversation({ role: 'work_session', workspaceId: 'ws', workspacePath: root, parentConversationId: parent.id });
  conversations.appendMessage(parent.id, { id: 'input', role: 'user', kind: 'user_input', content: '核对任务并说明结果' });
  const model = { providerId: 'local', modelId: 'configured', modelProviderId: 'configured', family: 'test' };
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const plan = plans.createPlan({ conversationId: child.id, title: '核对任务', goal: '核对任务',
    tasks: [{ taskId: 'leaf', title: '核对文件', status: 'completed', evidenceRefs: ['tool-result://fact'] }],
    delegationOrigin: { sessionId: 'session', workspaceId: 'ws', parentConversationId: parent.id, anchorMessageId: 'input', inputId: 'input', modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() }, phase: 'running', readOnly: true } });
  plans.recordEvidenceRefs({ planId: plan.planId, conversationId: child.id, evidenceRef: 'tool-result://fact', toolName: 'read_file' });
  plans.revisePlan(plan.planId, { status: 'completed', runner: { status: 'completed' } });
  const parentFile = path.join(root, 'conversations', `${parent.id}.jsonl`), before = readFileSync(parentFile);
  let verification;
  const supervisor = createSessionSupervisor({ conversationStore: conversations, goalPlanStore: plans, goalRunner: { start() {} },
    readSessionFacts: plan => ({ hostAuthority: verification.facts(plan.delegationOrigin.sessionId) }) });
  verification = createSessionVerification({ goalPlanStore: plans, verifySession: async () => ({ passed }),
    readReport: plan => supervisor.readReportSummary(plan.delegationOrigin.sessionId) });
  const provider = createDelegationProvider({ supervisor, verification });
  const context = { mode: 'project_agent', role: 'project_agent', workspaceId: 'ws', parentConversationId: parent.id,
    messages: [{ id: 'input', role: 'user', kind: 'user_input' }] };
  const call = (name, args) => ({ call: { toolCallId: name, capabilityId: `local.delegation.${name}`, arguments: args } });
  const reviewed = await provider.executeCapability(call('verify_session', { sessionId: 'session' }), context);
  assert.equal(reviewed.result.status, 'success', JSON.stringify(reviewed.result.output));
  assert.ok(reviewed.grant.granted);
  assert.ok(reviewed.result.evidence);
  const result = reviewed.result.output;
  assert.equal(result.card, undefined);
  assert.equal(result.status, passed ? 'passed' : 'failed');
  assert.deepEqual(readFileSync(parentFile), before, 'verification does not append or rewrite public messages');
  const reopened = createGoalPlanStore({ storeDir: plans.getStoreDir() });
  verification = createSessionVerification({ goalPlanStore: reopened, readReport: plan => supervisor.readReportSummary(plan.delegationOrigin.sessionId) });
  const detail = supervisor.get({ sessionId: 'session', detail: 'report' }).report.verification;
  const toolDetail = (await createDelegationProvider({ verification }).executeCapability(call('get_verification_detail', { sessionId: 'session' }), context)).result.output;
  const { ok, ...body } = toolDetail;
  assert.deepEqual(detail, body, 'task drawer and model tool use the same current verification');
  assert.equal(detail.outcome, result.status);
  assert.ok(detail.checks.some(check => check.evidenceRefs.includes('tool-result://fact')));
  const session = supervisor.get({ sessionId: 'session' });
  const reply = composeReply({ messageId: 'reply', kind: 'user', replyTo: ['input'], sources: ['session'],
    text: passed ? '文件核对完成，证据已验证。结果尚未签收。' : '文件已读取，但独立核对未通过，我会继续调查原因。',
    userMessages: context.messages, projectSessionIds: ['session'], statusClaims: [{ sessionId: 'session', status: session.status }],
    sessionStates: [{ sessionId: 'session', status: session.status }], verdicts: [{ sessionId: 'session', outcome: detail.outcome }] });
  assert.equal(reply.ok, true);
  conversations.appendMessage(parent.id, reply.message);
  assert.deepEqual((await conversations.readInteractionPage(parent.id)).messages.map(row => row.id), ['input', 'reply']);
  assert.equal(reopened.getPlan(plan.planId).resultAcceptance, undefined, 'reporting verification does not fabricate acceptance');
});
