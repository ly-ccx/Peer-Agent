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
  const base = pathToFileURL(process.argv[2] + '/node_modules/@peer-agent/runtime-node/dist/project-agent/').href;
  const { runContinuedVerification } = await import(base + 'verification-continuation.mjs');
  const { assessStall } = await import(base + 'watchdog.mjs');
  const { createSessionTakeover } = await import(base + 'session-takeover.mjs');
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

  let plan = { planId: 'p', conversationId: 'child', status: 'executing', runner: { status: 'paused', intent: 'verify' },
    delegationOrigin: { workspaceId: 'w', parentConversationId: 'parent', sessionId: 's', phase: 'paused', pausedRunnerIntent: 'verify' } };
  const binding = { workId: 'work', goalRevision: 1, executionEpoch: 'epoch' };
  const state = { transitions: { op: { action: 'handoff', oldSessionId: 's', executionEpoch: 'epoch', phase: 'stopping' } },
    mandates: { work: { goalRevision: 1 } }, works: { work: {} } };
  const store = { read: () => state, bindSession() {}, advanceTransition(id, from, patch) { Object.assign(state.transitions[id], patch); } };
  const release = registerWorkBudget('w', store);
  let promote;
  const promoted = new Promise(resolve => { promote = resolve; });
  try {
    const takeover = createSessionTakeover({ findBySession: () => plan,
      goalPlanStore: { getPlan: () => plan, revisePlan(id, patch) { plan = { ...plan, ...patch }; return plan; },
        setRunnerState(id, patch) { plan.runner = { ...plan.runner, ...patch }; } },
      goalRunner: { pause() {}, async waitForIdle() {} },
      executionScheduler: { cancelPlan() {}, async waitForPlanIdle() {} },
      exclusive: fn => fn(), canManageWorkspace: () => true, promote: async () => promote(),
      emit() {}, now: () => startedAt });
    assert.equal((await takeover.request({ sessionId: 's', operationId: 'op', binding }, { workspaceId: 'w', parentConversationId: 'parent' })).pending, true);
    await promoted;
    assert.equal(plan.runner.intent, 'execute', 'packaged correction handoff must execute remaining work');
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
