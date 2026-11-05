import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const app = path.resolve(process.argv[2]);
const archive = path.join(app, 'Contents/Resources/app.asar');
const names = ['verification-continuation', 'verification-progress', 'watchdog', 'watch-publisher', 'session-takeover'];
const hashes = {};
for (const name of names) {
  const entry = 'node_modules/@peer-agent/runtime-node/dist/project-agent/' + name + '.mjs';
  const bytes = extractFile(archive, entry);
  assert.deepEqual(bytes, readFileSync(path.join(repo, 'packages/runtime-node/dist/project-agent', name + '.mjs')),
    'Packaged runtime differs from final compiled module: ' + name);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}

async function packagedChecks() {
  const assert = (await import('node:assert/strict')).default;
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  const base = pathToFileURL(process.argv[2] + '/node_modules/@peer-agent/runtime-node/dist/project-agent/').href;
  const root = process.env.PEER_AGENT_HOME;
  const { runContinuedVerification } = await import(base + 'verification-continuation.mjs');
  const { assessStall } = await import(base + 'watchdog.mjs');
  const { createSessionSupervisor } = await import(base + 'session-supervisor.mjs');
  const { createWorkCoordinationStore } = await import(base + 'work-coordination-store.mjs');
  const { createGoalPlanStore } = await import(new URL('../goal-plan-store.mjs', base));
  const { createConversationStore } = await import(pathToFileURL(
    process.argv[2] + '/node_modules/@peer-agent/conversation-store/dist/index.mjs').href);
  const { registerWorkBudget } = await import(base + 'work-budget.mjs');
  const identity = { planId: 'packaged-review', sourceRevision: 'source', modelKey: 'model' };
  let count = 0;
  const reviewed = await runContinuedVerification({ identity, allowedEvidenceRefs: ['indexed'],
    run: async ({ attempt, executionBudget }) => {
      count++; executionBudget.guard.beforeRequest();
      if (attempt) {
        assert.equal(executionBudget.maxToolCalls, 0);
        assert.throws(() => executionBudget.guard.beforeTool(), { code: 'verifier_report_invalid' });
      }
      return { events: [{ channel: 'chat:stream:delta', payload: {
        content: attempt ? JSON.stringify({ passed: true, evidenceRefs: ['indexed'] }) : 'invalid format' } }] };
    } });
  assert.equal(reviewed.passed, true); assert.equal(count, 2);
  const startedAt = '2026-10-21T00:00:00Z';
  const at = Date.parse(startedAt) + 10 * 60_000;
  assert.equal(assessStall({ sessionId: 's', status: 'verifying',
    verificationProgress: { startedAt, lastProgressAt: startedAt } }, { now: at }).stalled, true);
  await assert.rejects(runContinuedVerification({ identity, now: () => at,
    port: { load: () => ({ ...identity, continuationId: 'review', phase: 'ready', startedAt, lastProgressAt: startedAt,
      deadlineAt: new Date(at + 60_000).toISOString(), modelRequests: 1, toolCalls: 0, formatAttempt: 0, evidenceRefs: [] }) },
    run: () => assert.fail('idle packaged review must not dispatch') }), { code: 'verifier_no_progress' });

  const workspaceId = 'packaged-takeover';
  const conversationStore = createConversationStore({ storeDir: join(root, 'conversations') });
  const goalPlanStore = createGoalPlanStore({ storeDir: join(root, 'goal-plans') });
  const parent = conversationStore.createConversation({ title: 'Packaged probe', role: 'project_agent', workspaceId, workspacePath: root });
  conversationStore.appendMessage(parent.id, { id: 'anchor', role: 'user', kind: 'user_input', content: 'Correct the remaining work.' });
  const model = { modelProviderId: 'probe', providerId: 'local', modelId: 'probe', family: 'probe', tools: true, contextTokens: 32_000 };
  const route = { mode: 'tier', tier: 'strong' };
  const starts = [];
  const supervisor = createSessionSupervisor({ conversationStore, goalPlanStore, catalog: [model],
    routing: { tiers: { strong: { primary: 'probe' } }, roles: { session_worker: route, explorer: route, verifier: route } },
    goalRunner: { async start(planId) { starts.push(goalPlanStore.getPlan(planId)?.runner?.intent); }, async resume() {} },
    readDelegationCapabilities: () => ['local.file.read'], autonomousCoordinationEnabled: () => true });
  await supervisor.reconciled;
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId, holdsLease: () => true, leaseEpoch: () => 'packaged-owner',
    formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  store.saveWork({ workId: 'work', parentConversationId: parent.id, state: 'waiting_children' });
  const release = registerWorkBudget(workspaceId, store);
  try {
    const context = { workspaceId, workspacePath: root, conversationId: parent.id, parentConversationId: parent.id,
      currentInputAnchors: ['anchor'], inputId: 'anchor', workId: 'work', surface: 'desktop' };
    const opened = await supervisor.coordinateWork({ action: 'parallel', reason: 'Inspect remaining work', task: {
      anchorMessageIds: ['anchor'], title: 'Inspect', brief: 'Read the current report', kind: 'research', readOnly: true,
      requiredCapabilities: ['local.file.read'], successCriteria: [{ kind: 'model_review', description: 'Explain the remaining work' }],
    } }, { ...context, deliveryKey: 'original' });
    assert.ok(opened.sessionId, JSON.stringify(opened));
    const { planId } = supervisor.get({ sessionId: opened.sessionId });
    const plan = goalPlanStore.getPlan(planId);
    goalPlanStore.revisePlan(planId, { delegationOrigin: { ...plan.delegationOrigin,
      phase: 'paused', pausedFromPhase: 'running', pausedRunnerIntent: 'verify' } });
    goalPlanStore.setRunnerState(planId, { status: 'paused', intent: 'verify' });
    starts.length = 0;
    const handoff = await supervisor.coordinateWork({ action: 'handoff', sessionId: opened.sessionId,
      expectedRevision: 1, reason: 'Apply the correction to the remaining work' }, { ...context, deliveryKey: 'correction' });
    assert.ok(['stopping', 'ready', 'completed'].includes(handoff.phase), JSON.stringify(handoff));
    const deadline = Date.now() + 3000;
    while (store.read().transitions.correction?.phase !== 'completed' && Date.now() < deadline) await delay(20);
    assert.equal(store.read().transitions.correction?.phase, 'completed', JSON.stringify(store.read().transitions.correction));
    assert.equal(starts.at(-1), 'execute', 'packaged correction handoff must execute remaining work');
    assert.equal(goalPlanStore.getPlan(planId).delegationOrigin.takeover.phase, 'completed');
  } finally { release(); }
  console.log(JSON.stringify({ checks: ['format_repair_no_tools', 'verification_stall', 'idle_review_settlement', 'correction_handoff_execute'], passed: true }));
}

const root = mkdtempSync(path.join(os.tmpdir(), 'peer-packaged-verification-'));
try {
  const probe = path.join(root, 'probe.mjs');
  writeFileSync(probe, '(' + packagedChecks.toString() + ')().catch(error => { console.error(error); process.exitCode = 1; });');
  const result = execFileSync(path.join(app, 'Contents/MacOS/Peer Agent'), [probe, archive],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PEER_AGENT_HOME: path.join(root, 'home') } });
  console.log(JSON.stringify({ archive, hashes, runtime: JSON.parse(result.trim()), installed: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
