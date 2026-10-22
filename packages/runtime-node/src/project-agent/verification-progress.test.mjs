import test from 'node:test';
import assert from 'node:assert/strict';
import { observeVerification } from './verification-progress.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createVerificationContinuationPort } from './verification-continuation-port.mjs';
import { runContinuedVerification } from './verification-continuation.mjs';
import { beginVerificationAttempt } from './session-facts.mjs';
import { watchFactsFromPlan } from './watchdog.mjs';
import { createWatchPublisher } from './watch-publisher.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createAgentEventPublisher } from './agent-activity.mjs';

test('new call identities and timestamps do not turn repeated file contents into verification progress', () => {
  const result = (id, at) => ({ toolCallId: id, status: 'success', evidence: { evidenceId: id, createdAt: at },
    output: { path: 'src/module.mjs', contentHash: 'same-file-version', preview: 'same contents', mtimeMs: at } });
  const first = observeVerification({}, result('call_0123456789abcdef', 10), '2026-10-21T00:00:00Z');
  assert.equal(first.observationCount, 1);
  assert.equal(observeVerification(first, result('call_abcdef0123456789', 20), '2026-10-21T00:01:00Z'), null);
  const changed = result('call_abcdef0123456789', 20);
  changed.output.contentHash = 'changed-file-version';
  changed.output.preview = 'changed contents';
  assert.equal(observeVerification(first, changed, '2026-10-21T00:02:00Z').observationCount, 2);
});

test('paired tool facts cross the actual continuation store, live session projection, inbox and conversation activity', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-verification-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'w', title: 'Bot' });
  const coord = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'epoch' });
  coord.saveWork({ workId: 'work', workspaceId: 'w', parentConversationId: parent.id, state: 'waiting_children' });
  const release = registerWorkBudget('w', coord);
  t.after(release);
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'm', family: 'openai' };
  const plan = plans.createPlan({ conversationId: 'child', title: '核验修复', goal: 'Review', status: 'completed',
    tasks: [{ taskId: 'read', title: 'Read', status: 'completed', result: 'Read', evidenceRefs: ['initial'] }],
    delegationOrigin: { anchorMessageId: 'u', inputId: 'i', workspaceId: 'w', sessionId: 's',
      parentConversationId: parent.id, phase: 'running',
      modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
  plans.setRunnerState(plan.planId, { status: 'completed' });
  const end = beginVerificationAttempt(plan.planId, 'review');
  t.after(end);
  const port = createVerificationContinuationPort({ plan: plans.getPlan(plan.planId), goalPlanStore: plans,
    workId: 'work', sourceRevision: 'source', readSourceRevision: () => 'source' });
  const inbox = createProjectInbox({ rootDir: root });
  let clock = Date.parse('2026-10-21T00:00:00Z');
  const watch = createWatchPublisher({ now: () => new Date(clock).toISOString() });
  const publish = createAgentEventPublisher({ inbox, conversationStore: conversations,
    findSession: () => plans.getPlan(plan.planId) });
  const emit = () => publish('w', watch.publish('w', { sessions: [watchFactsFromPlan(plans.getPlan(plan.planId))] }));
  await runContinuedVerification({ identity: { planId: plan.planId, sourceRevision: 'source', modelKey: 'model' },
    port, now: () => clock, run: async ({ executionBudget, onToolResult }) => {
      executionBudget.guard.beforeRequest();
      emit();
      executionBudget.guard.beforeTool();
      onToolResult({ status: 'success', output: { path: 'source.mjs', contentHash: 'version', preview: 'actual paired result' } });
      executionBudget.guard.checkpoint({ provider: 'controlled', messages: [{ role: 'tool', content: 'actual paired result' }] });
      clock += 30_000; emit();
      assert.equal(watchFactsFromPlan(plans.getPlan(plan.planId)).status, 'verifying');
      return { events: [{ channel: 'chat:stream:delta', payload: { content: JSON.stringify({ passed: false, risks: ['specific unresolved criterion'] }) } }] };
    } });
  const activity = conversations.getPersistedConversationHistory(parent.id).messages.map(row => row.agentActivity);
  assert.deepEqual(activity.map(row => row.state), ['verifying', 'verifying']);
  assert.equal(activity.at(-1).verificationProgress.observationCount, 1);
  assert.equal(inbox.diagnosticSnapshot('w').events.filter(row => row.kind === 'session_progress').length, 2);
  assert.equal(plans.getPlan(plan.planId).runner.verificationContinuation.phase, 'completed');
  end();
  assert.notEqual(watchFactsFromPlan(plans.getPlan(plan.planId)).status, 'verifying');
});
