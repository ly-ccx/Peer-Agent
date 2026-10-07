import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore, createSessionSupervisor } from '@peer-agent/runtime-node';
import { createDesktopGoalRunnerHost } from '../agent-host/goal-runner-host.mjs';
import { createGoalWorktreeAdapter } from '../goal-worktree-adapter.mjs';
import { createAutomationWorktreeAdapter } from '../automation-worktree-adapter.mjs';
import { createGoalTaskBranchAdapter } from '../goal-task-branch.mjs';
import { resolveActiveGoalExecutionBinding } from '../chat-runtime/goal-mode-gate.mjs';

test('three real Git worktrees run concurrently through the production host and merge back after explicit decisions', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-three-writers-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, 'data');
  const repository = path.join(root, 'repository');
  const git = (args, cwd = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const live = new Set();
  const paths = [];
  const evidence = [];
  let peak = 0;
  let host;
  t.after(() => {
    release(); host?.goalRunner.stopAll?.();
    if (previous === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'pipe' });
  git(['config', 'user.name', 'B4 fixture']); git(['config', 'user.email', 'b4@test.invalid']);
  writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
  git(['add', '.']); git(['commit', '-m', 'baseline']);
  const baseline = git(['rev-parse', 'HEAD']);
  const store = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const isolation = createGoalWorktreeAdapter({ goalPlanStore: store,
    worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: path.join(root, 'worktrees'), artifactDir: path.join(root, 'artifacts') }) });
  host = createDesktopGoalRunnerHost({ goalPlanStore: store, conversationStore: conversations,
    goalWorktreeAdapter: isolation, goalTaskBranchAdapter: createGoalTaskBranchAdapter({ goalPlanStore: store }),
    hostLeases: { holds: () => true }, broadcast() {}, llmChatService: {},
    resolveConversationModelProviderId: () => 'worker', toDesktopProviderMessages: messages => messages,
    desktopContinuityContextFromProjection: () => [], workspaceRoot: repository, getMainWindows: () => [],
    agentTurnExecutor: { async runTurn(input) {
      const plan = store.getPlan(store.listPlansByConversation(input.conversationId)[0].planId);
      const site = plan.deliveryBinding.worktreePath;
      assert.equal((await isolation.inspectIsolationFacts(plan)).existingWorktree, true);
      const binding = resolveActiveGoalExecutionBinding(input.conversationId, repository, store);
      assert.equal(binding.executionWorkspacePath, site);
      assert.deepEqual(binding.writableRoots, [site]);
      live.add(plan.planId); paths.push(site); peak = Math.max(peak, live.size);
      await barrier;
      // Scripted executor fixture performs a real filesystem edit; no network model is used.
      const file = `${plan.title}.txt`;
      writeFileSync(path.join(site, file), `${plan.title}\n`);
      live.delete(plan.planId);
      return { requestedUserInput: true, terminalStatus: 'done' };
    } },
  });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'w', workspacePath: repository });
  conversations.appendMessage(parent.id, { id: 'anchor', role: 'user', kind: 'user_input', content: 'Run three isolated writers' });
  const model = { modelProviderId: 'worker', providerId: 'local', modelId: 'worker', family: 'f', tools: true, vision: true, contextTokens: 32_000 };
  const supervisor = createSessionSupervisor({ goalPlanStore: store, conversationStore: conversations,
    goalRunner: host.goalRunner, canManageWorkspace: () => true, catalog: [model],
    routing: { tiers: { strong: { primary: 'worker' }, vision: { primary: 'worker' } },
      roles: Object.fromEntries(['session_worker', 'explorer', 'verifier', 'visual_verifier'].map(role => [role, { mode: 'tier', tier: 'strong' }])) },
    resolveAcceptancePolicy: () => 'confirm', readSessionFacts: () => ({ hostAuthority: { independentVerifier: 'passed' } }) });
  await supervisor.reconciled;
  const sessions = [];
  for (let i = 1; i <= 3; i++) {
    const name = `writer-${i}`;
    const opened = await supervisor.spawn({ anchorMessageIds: ['anchor'], title: name, brief: `Write ${name}.txt`,
      kind: 'code', isolation: 'worktree', readOnly: false,
      successCriteria: [{ id: 'c', kind: 'file-contains', path: `${name}.txt`, expect: name, description: name }] },
    { parentConversationId: parent.id, workspaceId: 'w', workspacePath: repository, inputId: name });
    assert.equal(opened.error, undefined); sessions.push(opened.sessionId);
  }
  for (let retry = 0; peak < 3 && retry < 100; retry++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(peak, 3, JSON.stringify(sessions.map(sessionId => {
    const plan = store.getPlan(supervisor.get({ sessionId }).planId); return { status: plan.status, runner: plan.runner };
  })));
  assert.equal(new Set(paths).size, 3);
  assert.equal(git(['rev-parse', 'HEAD']), baseline);
  release();
  for (const sessionId of sessions) {
    let plan = store.getPlan(supervisor.get({ sessionId }).planId);
    await host.goalRunner.waitForIdle(plan.planId);
    plan = store.getPlan(plan.planId);
    const file = `${plan.title}.txt`; const ref = `file-fixture:${sessionId}`;
    assert.equal(readFileSync(path.join(plan.deliveryBinding.worktreePath, file), 'utf8').trim(), plan.title);
    store.recordEvidenceRefs({ planId: plan.planId, conversationId: plan.conversationId, evidenceRef: ref,
      capabilityId: 'local.file.read', toolName: 'read_file', bodyPreview: { kind: 'file', text: plan.title, truncated: false } });
    store.revisePlan(plan.planId, { tasks: plan.tasks.map(task => ({ ...task, status: 'completed', evidenceRefs: [ref] })),
      criterionResults: [{ criterionId: 'c', passed: true, evidenceRef: ref }], qualityReview: { status: 'passed', reviewedAt: new Date().toISOString() } });
    store.setRunnerState(plan.planId, { enabled:false,status: 'completed', waitingOnUser: false });
    store.setPlanStatus(plan.planId, 'completed');
    const confirmation = await supervisor.confirmResult(sessionId); assert.equal(confirmation.accepted, true, JSON.stringify(confirmation));
    plan = store.getPlan(plan.planId);
    assert.notEqual(plan.deliveryHandoff?.status, 'delivered');
    const site = plan.deliveryBinding.worktreePath;
    const result = await supervisor.handleHandoffAnswer({ workspaceId: 'w', sessionId, text: '合回改动',
      answerTo: `card:question:${sessionId}:${supervisor.deliveryFacts(sessionId).questionId}` });
    assert.equal(result.plan.deliveryHandoff.status, 'delivered');
    assert.equal(git(['show', `main:${file}`]), plan.title);
    assert.equal(existsSync(site), false);
    evidence.push({ session: plan.title, isolated: true, targetBranch: plan.deliveryBinding.targetBranch,
      commitSha: result.plan.deliveryHandoff.commitSha, verdict: result.plan.deliveryHandoff.verdict,
      cleaned: !existsSync(site), signedBy: result.plan.resultAcceptance.acceptedBy });
  }
  const facts = await isolation.inspectIsolationFacts({ deliveryBinding: { targetWorkspacePath: repository,
    executionIsolation: 'worktree', worktreePath: repository, taskBranch: 'main' } });
  assert.equal(facts.existingWorktree, false);
  const invalid = await isolation.discardLine({ delegationOrigin: { workspaceId: 'w' }, deliveryBinding: {
    targetWorkspacePath: repository, executionIsolation: 'worktree', worktreePath: repository, taskBranch: 'main' } });
  assert.equal(invalid.reason, 'invalid_worktree');
  assert.equal(existsSync(path.join(repository, 'README.md')), true);
  if (process.env.PEER_B4_EVIDENCE_OUT) writeFileSync(process.env.PEER_B4_EVIDENCE_OUT,
    JSON.stringify({ scenario: 'B4-02 three writers', executor: 'scripted production host; real Git and filesystem', peak, baseline, evidence }, null, 2));
});

test('a superseded real worktree retains uncommitted edits and the restored production host reuses it', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-restore-worktree-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, 'data');
  const repository = path.join(root, 'repository');
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  let host;
  t.after(() => { host?.goalRunner.stopAll?.();
    if (previous === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'pipe' });
  git(['config', 'user.name', 'B4 fixture']); git(['config', 'user.email', 'b4@test.invalid']);
  writeFileSync(path.join(repository, 'README.md'), 'baseline\n'); git(['add', '.']); git(['commit', '-m', 'baseline']);
  const store = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const isolation = createGoalWorktreeAdapter({ goalPlanStore: store,
    worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: path.join(root, 'worktrees'), artifactDir: path.join(root, 'artifacts') }) });
  host = createDesktopGoalRunnerHost({ goalPlanStore: store, conversationStore: conversations,
    goalWorktreeAdapter: isolation, goalTaskBranchAdapter: createGoalTaskBranchAdapter({ goalPlanStore: store }),
    hostLeases: { holds: () => true }, broadcast() {}, llmChatService: {},
    resolveConversationModelProviderId: () => 'worker', toDesktopProviderMessages: messages => messages,
    desktopContinuityContextFromProjection: () => [], workspaceRoot: repository, getMainWindows: () => [],
    agentTurnExecutor: { async runTurn(input) {
      const plan = store.getPlan(store.listPlansByConversation(input.conversationId)[0].planId);
      writeFileSync(path.join(plan.deliveryBinding.worktreePath, 'unfinished.txt'), `${plan.title} work in progress\n`);
      return { requestedUserInput: true, terminalStatus: 'done' };
    } } });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'w', workspacePath: repository });
  conversations.appendMessage(parent.id, { id: 'anchor', role: 'user', kind: 'user_input', content: 'start' });
  conversations.appendMessage(parent.id, { id: 'restore', role: 'user', kind: 'user_input', content: 'restore the original' });
  const model = { modelProviderId: 'worker', providerId: 'local', modelId: 'worker', family: 'f', tools: true, vision: true, contextTokens: 32_000 };
  const supervisor = createSessionSupervisor({ goalPlanStore: store, conversationStore: conversations,
    goalRunner: host.goalRunner, canManageWorkspace: () => true, catalog: [model],
    routing: { tiers: { strong: { primary: 'worker' }, vision: { primary: 'worker' } },
      roles: Object.fromEntries(['session_worker', 'explorer', 'verifier', 'visual_verifier'].map(role => [role, { mode: 'tier', tier: 'strong' }])) } });
  await supervisor.reconciled;
  const context = { parentConversationId: parent.id, workspaceId: 'w', workspacePath: repository };
  const input = { anchorMessageIds: ['anchor'], title: 'original', brief: 'edit', kind: 'code', readOnly: false, isolation: 'worktree', successCriteria: [{kind:'model_review',description:'review'}] };
  const a = await supervisor.spawn(input, context); assert.equal(a.error, undefined);
  const id = supervisor.get({ sessionId: a.sessionId }).planId;
  await host.goalRunner.waitForIdle(id);
  const site = store.getPlan(id).deliveryBinding.worktreePath;
  assert.equal(readFileSync(path.join(site, 'unfinished.txt'), 'utf8'), 'original work in progress\n');
  const b = await supervisor.spawn({ ...input, title: 'replacement', brief: 'new direction', supersedes: a.sessionId }, context);
  assert.equal(b.error, undefined);
  await host.goalRunner.waitForIdle(supervisor.get({ sessionId: b.sessionId }).planId);
  assert.equal(supervisor.get({ sessionId: a.sessionId }).status, 'superseded');
  assert.equal(readFileSync(path.join(site, 'unfinished.txt'), 'utf8'), 'original work in progress\n');
  assert.equal((await supervisor.resume({ sessionId: a.sessionId, anchorMessageId: 'restore' }, context)).error, undefined);
  await host.goalRunner.waitForIdle(id);
  assert.equal(store.getPlan(id).deliveryBinding.worktreePath, site);
  assert.equal((await isolation.inspectIsolationFacts(store.getPlan(id))).existingWorktree, true);
  assert.equal(supervisor.get({ sessionId: b.sessionId }).supersededBy, a.sessionId);
  assert.equal(readFileSync(path.join(site, 'unfinished.txt'), 'utf8'), 'original work in progress\n');
  assert.equal(existsSync(path.join(repository, 'unfinished.txt')), false);
});
