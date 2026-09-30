import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createDelegationProvider } from './delegation-provider.mjs';
import { computeVerificationVerdict } from './verification-verdict.mjs';
import {
  PROJECT_AGENT_ALLOWED_CAPABILITIES,
  evaluateProjectAgentTurn,
} from './mode-policy.mjs';
import { DELEGATION_CAPABILITY_IDS } from './tool-specs.mjs';

const USER = { id: 'u1', role: 'user', kind: 'user_input' };
const ASSISTANT = { id: 'a1', role: 'assistant' };

function spawnInput(overrides = {}) {
  return {
    anchorMessageIds: ['u1'],
    title: 'Fix the gate',
    brief: 'Keep the project agent read-only.',
    successCriteria: ['The gate denies writes'],
    kind: 'code',
    readOnly: true,
    ...overrides,
  };
}

function call(capabilityId, args, toolCallId = 'tool-1') {
  return { call: { toolCallId, capabilityId, arguments: args } };
}

function agentContext(overrides = {}) {
  return {
    mode: 'project_agent',
    role: 'project_agent',
    turnId: 'turn-1',
    toolCallOrdinal: 0,
    conversationId: 'conv-1',
    messages: [USER, ASSISTANT],
    ...overrides,
  };
}

function outputOf(result) {
  return JSON.parse(result.result.outputPreview.legacyResult.output);
}

test('delegation capabilities are on the project agent whitelist and nowhere else is required', () => {
  for (const capabilityId of DELEGATION_CAPABILITY_IDS) {
    assert.equal(PROJECT_AGENT_ALLOWED_CAPABILITIES.includes(capabilityId), true);
    assert.equal(evaluateProjectAgentTurn({
      mode: 'project_agent',
      capabilityId,
      permissionKind: 'goal-create',
    }).allowed, true);
  }
  assert.equal(evaluateProjectAgentTurn({
    mode: 'work_session',
    role: 'work_session',
    capabilityId: 'local.delegation.spawn_session',
  }).applies, false);
});

test('a non-project-agent turn is depth limited before any port runs', async () => {
  let calls = 0;
  const provider = createDelegationProvider({
    supervisor: { spawn() { calls += 1; return { sessionId: 's1', status: 'running' }; } },
  });
  const result = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput()),
    agentContext({ mode: 'goal', role: 'work_session' }),
  );
  const output = outputOf(result);
  assert.equal(output.error, 'depth_limit');
  assert.equal(calls, 0);
  assert.equal(result.grant.granted, false);
  assert.equal(result.grant.reason, 'project_agent_dispatch');
  assert.match(result.result.evidence.summary, /depth_limit/);
});

test('spawn validates anchors and model availability, then replays the first result', async () => {
  const seen = [];
  const provider = createDelegationProvider({
    supervisor: {
      async spawn(input) {
        seen.push(input);
        return { sessionId: 'sess-1', status: 'queued', queuedBehind: 1 };
      },
    },
    checkModel({ modelProviderId }) {
      if (modelProviderId === 'missing-model') {
        return { ok: false, missing: 'missing-model is not in the project pool' };
      }
      return { ok: true };
    },
  });

  const missing = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput({ anchorMessageIds: ['nope'] })),
    agentContext(),
  );
  assert.equal(outputOf(missing).error, 'anchor_not_found');
  assert.equal(seen.length, 0);

  const notUser = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput({ anchorMessageIds: ['a1'] }), 'tool-2'),
    agentContext(),
  );
  assert.equal(outputOf(notUser).error, 'anchor_not_user_input');

  const unavailable = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput({
      modelPreference: { modelProviderId: 'missing-model', reason: 'user asked' },
    }), 'tool-3'),
    agentContext(),
  );
  assert.equal(outputOf(unavailable).error, 'model_unavailable');
  assert.equal(outputOf(unavailable).missing, 'missing-model is not in the project pool');
  assert.equal(seen.length, 0);

  const first = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput(), 'tool-4'),
    agentContext(),
  );
  const firstOutput = outputOf(first);
  assert.equal(firstOutput.sessionId, 'sess-1');
  assert.equal(firstOutput.status, 'queued');
  assert.equal(firstOutput.queuedBehind, 1);
  assert.equal(first.grant.granted, true);
  assert.equal(first.grant.reason, 'project_agent_dispatch');
  assert.ok(first.result.evidence.evidenceId);

  const replay = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput(), 'tool-5'),
    agentContext(),
  );
  assert.equal(outputOf(replay).sessionId, 'sess-1');
  assert.equal(outputOf(replay).replayed, true);
  assert.equal(seen.length, 1);
  assert.equal(resultGrantRecorded(first), true);
});

test('the durable ledger returns the first spawn after a new provider instance', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delegation-ledger-'));
  try {
    let calls = 0;
    const supervisor = {
      async spawn() {
        calls += 1;
        return { sessionId: 'sess-disk', status: 'running' };
      },
    };
    const first = createDelegationProvider({ supervisor, storeDir: root });
    const created = await first.executeCapability(
      call('local.delegation.spawn_session', spawnInput(), 'tool-disk'),
      agentContext({ workspaceId: 'ws-1' }),
    );
    assert.equal(outputOf(created).sessionId, 'sess-disk');
    const second = createDelegationProvider({ supervisor, storeDir: root });
    const replay = await second.executeCapability(
      call('local.delegation.spawn_session', spawnInput(), 'tool-disk-2'),
      agentContext({ workspaceId: 'ws-1' }),
    );
    assert.equal(outputOf(replay).sessionId, 'sess-disk');
    assert.equal(outputOf(replay).replayed, true);
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('list, get, cancel, message, and post_reply return structured success and errors', async () => {
  const provider = createDelegationProvider({
    supervisor: {
      list() {
        return [{ sessionId: 'sess-1', status: 'running' }];
      },
      get(input) {
        if (input.sessionId !== 'sess-1') return null;
        return {
          session: { sessionId: 'sess-1', status: 'running' },
          ...(input.detail === 'report' ? { report: { summary: 'done' } } : {}),
        };
      },
      cancel(input) {
        if (input.sessionId !== 'sess-1') return null;
        return { sessionId: input.sessionId, status: 'cancelled' };
      },
      message(input) {
        if (input.sessionId !== 'sess-1') return null;
        return { sessionId: input.sessionId, delivered: true, intent: input.intent };
      },
    },
    replyComposer: {
      postReply(input) {
        return { messageId: 'm-1', replyTo: input.replyTo };
      },
    },
  });
  const context = agentContext();

  const listed = outputOf(await provider.executeCapability(
    call('local.delegation.list_sessions', { limit: 10 }, 'list-1'),
    context,
  ));
  assert.equal(listed.sessions[0].sessionId, 'sess-1');

  const summary = outputOf(await provider.executeCapability(
    call('local.delegation.get_session', { sessionId: 'sess-1' }, 'get-1'),
    { ...context, toolCallOrdinal: 1 },
  ));
  assert.equal(summary.session.status, 'running');
  assert.equal(summary.report, undefined);

  const report = outputOf(await provider.executeCapability(
    call('local.delegation.get_session', { sessionId: 'sess-1', detail: 'report' }, 'get-2'),
    { ...context, toolCallOrdinal: 2 },
  ));
  assert.equal(report.report.summary, 'done');

  const missing = outputOf(await provider.executeCapability(
    call('local.delegation.get_session', { sessionId: 'missing' }, 'get-3'),
    { ...context, toolCallOrdinal: 3 },
  ));
  assert.equal(missing.error, 'session_not_found');

  const cancelled = outputOf(await provider.executeCapability(
    call('local.delegation.cancel_session', { sessionId: 'sess-1', reason: 'user asked' }, 'cancel-1'),
    { ...context, toolCallOrdinal: 4 },
  ));
  assert.equal(cancelled.status, 'cancelled');
  const cancelMissing = outputOf(await provider.executeCapability(
    call('local.delegation.cancel_session', { sessionId: 'missing', reason: 'nope' }, 'cancel-2'),
    { ...context, toolCallOrdinal: 5 },
  ));
  assert.equal(cancelMissing.error, 'session_not_found');

  const delivered = outputOf(await provider.executeCapability(
    call('local.delegation.message_session', {
      sessionId: 'sess-1',
      text: 'Use the second approach.',
      intent: 'answer',
    }, 'msg-1'),
    { ...context, toolCallOrdinal: 6 },
  ));
  assert.equal(delivered.delivered, true);
  const amend = outputOf(await provider.executeCapability(
    call('local.delegation.message_session', {
      sessionId: 'sess-1',
      text: 'change the goal',
      intent: 'amend',
    }, 'msg-2'),
    { ...context, toolCallOrdinal: 7 },
  ));
  assert.equal(amend.delivered, true);
  assert.equal(amend.intent, 'amend');
  assert.equal(amend.error, undefined);
  const messageMissing = outputOf(await provider.executeCapability(
    call('local.delegation.message_session', {
      sessionId: 'missing',
      text: 'hello',
      intent: 'answer',
    }, 'msg-3'),
    { ...context, toolCallOrdinal: 8 },
  ));
  assert.equal(messageMissing.error, 'session_not_found');

  const reply = outputOf(await provider.executeCapability(
    call('local.delegation.post_reply', { replyTo: ['u1'], text: 'Started it.' }, 'reply-1'),
    { ...context, toolCallOrdinal: 9 },
  ));
  assert.equal(reply.messageId, 'm-1');
  const proactive = outputOf(await provider.executeCapability(
    call('local.delegation.post_reply', { text: 'A note.', proactive: true }, 'reply-2'),
    { ...context, toolCallOrdinal: 10 },
  ));
  assert.equal(proactive.messageId, 'm-1');
  const bare = outputOf(await provider.executeCapability(
    call('local.delegation.post_reply', { text: 'no anchor' }, 'reply-3'),
    { ...context, toolCallOrdinal: 11 },
  ));
  assert.equal(bare.error, 'invalid_input');
  const tooLong = outputOf(await provider.executeCapability(
    call('local.delegation.post_reply', { replyTo: ['u1'], text: 'x'.repeat(2001) }, 'reply-4'),
    { ...context, toolCallOrdinal: 12 },
  ));
  assert.equal(tooLong.error, 'invalid_input');

  const unwired = createDelegationProvider();
  const noSupervisor = outputOf(await unwired.executeCapability(
    call('local.delegation.list_sessions', {}, 'list-missing'),
    context,
  ));
  assert.equal(noSupervisor.error, 'supervisor_unavailable');
});

test('引用限定范围内，越界的 message 和 cancel 被拒绝，新开任务不受限', async () => {
  let spawned = 0;
  let messaged = 0;
  let cancelled = 0;
  const provider = createDelegationProvider({
    supervisor: {
      spawn() {
        spawned += 1;
        return { sessionId: 's-new', status: 'running' };
      },
      message(input) {
        messaged += 1;
        return { sessionId: input.sessionId, delivered: true, intent: input.intent };
      },
      cancel() {
        cancelled += 1;
        return { sessionId: 's-keep', status: 'cancelled' };
      },
    },
  });
  const quoted = [
    { id: 'u0', role: 'user', kind: 'user_input' },
    { id: 'r1', role: 'assistant', kind: 'agent_reply', sources: ['s-keep'], replyTo: ['u0'] },
    { id: 'u1', role: 'user', kind: 'user_input', quoteRefs: ['r1', '登录任务在跑'] },
  ];
  const context = agentContext({ messages: quoted });

  const rejected = outputOf(await provider.executeCapability(
    call('local.delegation.cancel_session', { sessionId: 's-other', reason: '停掉别的' }, 'scope-cancel'),
    context,
  ));
  assert.equal(rejected.error, 'out_of_scope');
  assert.equal(rejected.sessionId, 's-other');
  assert.deepEqual(rejected.sessionIds, ['s-keep']);
  assert.equal(cancelled, 0);

  const amend = outputOf(await provider.executeCapability(
    call('local.delegation.message_session', {
      sessionId: 's-keep',
      text: '把标题改短',
      intent: 'amend',
    }, 'scope-amend'),
    { ...context, toolCallOrdinal: 1 },
  ));
  assert.equal(amend.delivered, true);
  assert.equal(messaged, 1);

  const spawnedOut = outputOf(await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput(), 'scope-spawn'),
    { ...context, toolCallOrdinal: 2 },
  ));
  assert.equal(spawnedOut.sessionId, 's-new');
  assert.equal(spawnedOut.error, undefined);
  assert.equal(spawned, 1);

  const nested = outputOf(await provider.executeCapability(
    call('local.delegation.message_session', {
      sessionId: 's-other',
      text: '不要动这个',
      intent: 'answer',
    }, 'scope-nested'),
    {
      locale: 'zh-CN',
      toolContext: {
        mode: 'project_agent',
        turnRole: 'project_agent',
        turnId: 'turn-nested',
        messages: quoted,
      },
    },
  ));
  assert.equal(nested.error, 'out_of_scope');
  assert.equal(messaged, 1);
});

function hostPlan(evidenceRef = 'ev-1') {
  return {
    verificationOutcome: 'passed',
    runner: { verifierRuns: [{ outcome: 'passed', note: '模型自己说通过了' }] },
    tasks: [{ taskId: 'leaf', status: 'completed', evidenceRefs: [evidenceRef] }],
    successCriteria: [{ id: 'c1', kind: 'test', description: '测试通过' }],
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef }],
  };
}

test('验证细节只来自宿主事实，模型自述和范围外的输出进不来', async () => {
  const long = '测'.repeat(2001);
  const facts = {
    plan: hostPlan('ev-real'),
    evidenceIndex: ['ev-real'],
    independentVerifier: 'passed',
    verifierModel: 'verifier-b',
    workerModel: 'worker-a',
    sameFamilyAsWorker: false,
    modelClaim: { outcome: 'failed', checks: [{ name: 'forged', result: 'passed' }] },
    outputs: [
      { name: 'npm test', evidenceRef: 'ev-real', text: long },
      { name: 'forged log', evidenceRef: 'ev-forged', text: 'should not appear' },
    ],
  };
  const provider = createDelegationProvider({
    verification: {
      facts(sessionId) {
        return sessionId === 's-keep' ? facts : null;
      },
    },
  });
  const detail = outputOf(await provider.executeCapability(
    call('local.delegation.get_verification_detail', { sessionId: 's-keep' }, 'verify-detail'),
    agentContext(),
  ));
  const host = computeVerificationVerdict(facts.plan, facts.evidenceIndex, {
    independentVerifier: 'passed',
    verifierModel: 'verifier-b',
    sameFamilyAsWorker: false,
  });
  assert.equal(detail.outcome, host.outcome);
  assert.equal(detail.outcome, 'passed');
  assert.equal(detail.checks.some((item) => item.name === 'forged'), false);
  assert.deepEqual(detail.checks.map((item) => item.evidenceRefs), [host.evidenceRefs, host.evidenceRefs]);
  assert.equal(detail.workerModel, 'worker-a');
  assert.equal(detail.verifierModel, 'verifier-b');
  assert.equal(detail.sameSource, false);
  assert.equal(detail.outputs.length, 1);
  assert.equal(detail.outputs[0].evidenceRef, 'ev-real');
  assert.equal(Array.from(detail.outputs[0].summary).length, 2000);
  assert.equal(detail.outputs[0].truncated, true);
  assert.equal(JSON.stringify(detail).includes('模型自己说通过了'), false);
  assert.equal(JSON.stringify(detail).includes('should not appear'), false);

  const denied = outputOf(await provider.executeCapability(
    call('local.delegation.get_verification_detail', { sessionId: 's-keep' }, 'verify-denied'),
    agentContext({
      toolCallOrdinal: 1,
      messages: [
        { id: 'r1', role: 'assistant', kind: 'agent_reply', sources: ['s-other'] },
        { id: 'u1', role: 'user', kind: 'user_input', quoteRefs: ['r1', '别的'] },
      ],
    }),
  ));
  assert.equal(denied.outcome, 'passed');
});

test('复核用 verifier 出新结论并更新卡片，期间任务是 verifying', async () => {
  const cards = [];
  let status = 'running';
  let pass = 0;
  const provider = createDelegationProvider({
    verification: {
      async markVerifying() {
        status = 'verifying';
      },
      async run(request) {
        assert.equal(status, 'verifying');
        assert.equal(request.role, 'verifier');
        assert.equal(request.preferDifferentSource, true);
        pass += 1;
        const evidenceRef = pass === 1 ? 'missing' : 'ev-real';
        return {
          ok: true,
          at: '2026-09-27T08:00:00.000Z',
          prose: '模型说这次通过',
          facts: {
            plan: hostPlan(evidenceRef),
            evidenceIndex: pass === 1 ? [] : ['ev-real'],
            independentVerifier: 'passed',
            verifierModel: 'other-family',
            workerModel: 'worker-a',
            sameFamilyAsWorker: false,
            modelClaim: { outcome: 'passed' },
          },
        };
      },
      async record({ event, card }) {
        cards.push({ outcome: event.outcome, content: card.content, verdictRef: card.verdictRef });
      },
    },
  });
  const first = outputOf(await provider.executeCapability(
    call('local.delegation.verify_session', { sessionId: 's-keep', focus: '测试' }, 'verify-1'),
    agentContext(),
  ));
  assert.equal(first.status, 'verifying');
  assert.notEqual(first.event.outcome, 'passed');
  assert.equal(first.card.content, first.event.outcome);
  assert.equal(first.card.cardId, 'card:verdict:s-keep');

  const second = outputOf(await provider.executeCapability(
    call('local.delegation.verify_session', { sessionId: 's-keep' }, 'verify-2'),
    agentContext({ toolCallOrdinal: 1 }),
  ));
  assert.equal(second.event.outcome, 'passed');
  assert.equal(second.event.verdictRef, 'verdict:s-keep:passed');
  assert.deepEqual(cards.map((item) => item.content), [first.event.outcome, 'passed']);
  assert.notEqual(cards[0].verdictRef, cards[1].verdictRef);
});

test('引用限定范围内，verify_session 越界被拒绝，读取细节不受限', async () => {
  let runs = 0;
  const provider = createDelegationProvider({
    verification: {
      async facts() {
        return {
          plan: hostPlan('ev-real'),
          evidenceIndex: ['ev-real'],
          independentVerifier: 'passed',
          workerModel: 'worker-a',
          verifierModel: 'verifier-b',
          sameFamilyAsWorker: false,
        };
      },
      async run() {
        runs += 1;
        return { ok: true, facts: { plan: hostPlan('ev-real'), evidenceIndex: ['ev-real'] } };
      },
      async markVerifying() {},
    },
  });
  const quoted = agentContext({
    messages: [
      { id: 'r1', role: 'assistant', kind: 'agent_reply', sources: ['s-other'] },
      { id: 'u1', role: 'user', kind: 'user_input', quoteRefs: ['r1', '别的'] },
    ],
  });
  const denied = outputOf(await provider.executeCapability(
    call('local.delegation.verify_session', { sessionId: 's-keep' }, 'verify-scope'),
    quoted,
  ));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'out_of_scope');
  assert.equal(runs, 0);
  const detail = outputOf(await provider.executeCapability(
    call('local.delegation.get_verification_detail', { sessionId: 's-keep' }, 'detail-scope'),
    { ...quoted, toolCallOrdinal: 1 },
  ));
  assert.equal(detail.outcome, 'passed');
});

test('set_proactivity 没有用户锚点就拒绝，成功时只改当前项目', async () => {
  const saved = [];
  const provider = createDelegationProvider({
    proactivity: {
      set(input) {
        saved.push(input);
        return { ok: true, level: input.level };
      },
    },
  });
  const missing = outputOf(await provider.executeCapability(
    call('local.delegation.set_proactivity', { level: 'quiet', anchorMessageId: 'missing' }),
    agentContext({ workspaceId: 'ws-1' }),
  ));
  assert.equal(missing.error, 'anchor_not_found');
  assert.equal(saved.length, 0);
  const assistant = outputOf(await provider.executeCapability(
    call('local.delegation.set_proactivity', { level: 'quiet', anchorMessageId: 'a1' }, 'tool-2'),
    agentContext({ workspaceId: 'ws-1', toolCallOrdinal: 1 }),
  ));
  assert.equal(assistant.error, 'anchor_not_user_input');
  const changed = outputOf(await provider.executeCapability(
    call('local.delegation.set_proactivity', { level: 'muted', anchorMessageId: 'u1' }, 'tool-3'),
    agentContext({ workspaceId: 'ws-1', toolCallOrdinal: 2 }),
  ));
  assert.equal(changed.ok, true);
  assert.equal(changed.level, 'muted');
  assert.equal(changed.workspaceId, 'ws-1');
  assert.deepEqual(saved, [{ workspaceId: 'ws-1', level: 'muted', anchorMessageId: 'u1' }]);
  const unwired = createDelegationProvider();
  const unavailable = outputOf(await unwired.executeCapability(
    call('local.delegation.set_proactivity', { level: 'low', anchorMessageId: 'u1' }, 'tool-4'),
    agentContext({ workspaceId: 'ws-1', toolCallOrdinal: 3 }),
  ));
  assert.equal(unavailable.error, 'proactivity_unavailable');
});

test('post_reply 看见本回合已经放进上下文的记忆和先前的工具结果', async () => {
  let seen = null;
  const provider = createDelegationProvider({
    replyComposer: {
      postReply(_input, view) {
        seen = view;
        return { messageId: 'm-1' };
      },
    },
  });
  const output = outputOf(await provider.executeCapability(
    call('local.delegation.post_reply', { replyTo: ['u1'], text: '收到' }, 'reply-mem'),
    agentContext({
      toolContext: {
        turnMemoryIds: ['mem-used', ''],
        turnToolCalls: [{ name: 'memory_remember', result: { ok: true, id: 'mem-new' } }],
      },
    }),
  ));
  assert.deepEqual(seen.memoryIds, ['mem-used']);
  assert.equal(seen.turnToolCalls[0].result.id, 'mem-new');
  assert.equal(output.messageId, 'm-1');
});

test('spawn passes the latest user history snapshot to the supervisor', async () => {
  const seen = [];
  const provider = createDelegationProvider({
    supervisor: {
      async spawn(input, context) {
        seen.push({ input, context });
        return { sessionId: 'sess-h', status: 'queued' };
      },
    },
  });
  const carried = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput(), 'tool-history'),
    agentContext({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      messages: [
        { id: 'old', role: 'user', kind: 'user_input', historyRef: 'hist-old', historySnapshotId: 'snap-old' },
        { id: 'u1', role: 'user', kind: 'user_input', historyRef: 'hist-1', historySnapshotId: 'snap-1', historyConfirmed: true },
        { id: 'a1', role: 'assistant', content: '好' },
      ],
    }),
  );
  assert.equal(outputOf(carried).ok, true);
  assert.equal(seen[0].context.parentConversationId, 'conv-1');
  assert.equal(seen[0].context.workspaceId, 'ws-1');
  assert.equal(seen[0].context.workspacePath, '/repo');
  assert.equal(seen[0].context.historyConversationId, 'hist-1');
  assert.equal(seen[0].context.backgroundSnapshotId, 'snap-1');
  assert.equal(seen[0].context.confirmMissing, true);

  const fresh = await provider.executeCapability(
    call('local.delegation.spawn_session', spawnInput({ title: '另一件' }), 'tool-history-2'),
    agentContext({
      workspaceId: 'ws-1',
      messages: [
        { id: 'u1', role: 'user', kind: 'user_input', content: '新的问题' },
      ],
    }),
  );
  assert.equal(outputOf(fresh).ok, true);
  assert.equal(seen[1].context.backgroundSnapshotId, undefined);
  assert.equal(seen[1].context.historyConversationId, undefined);
});

function resultGrantRecorded(result) {
  return Boolean(result.grant?.grantId && result.result?.evidence?.toolCallId === result.call.toolCallId);
}

test('spawn preserves structured Goal criteria and rejects incomplete or forged checks before dispatch', async () => {
  const seen = [];
  const provider = createDelegationProvider({ supervisor: { spawn(input) { seen.push(input); return { sessionId: 's-criteria', status: 'running' }; } } });
  const criterion = { id: 'source-check', kind: 'file-contains', description: 'Source declares BotProfile', path: 'project.ts', expect: 'BotProfile' };
  const result = await provider.executeCapability(call('local.delegation.spawn_session', spawnInput({ successCriteria: [criterion, 'Human review remains manual'] })), agentContext());
  assert.equal(outputOf(result).ok, true);
  assert.deepEqual(seen[0].successCriteria, [criterion, 'Human review remains manual']);
  for (const criteria of [
    [{ kind: 'file-contains', description: 'Missing expect', path: 'project.ts' }],
    [{ kind: 'command', description: 'Missing command' }],
    [{ ...criterion, passed: true }],
    [{ ...criterion }, { ...criterion }],
    ['Manual first', { ...criterion, id: 'c1' }],
  ]) {
    const failed = await provider.executeCapability(call('local.delegation.spawn_session', spawnInput({ successCriteria: criteria })), agentContext());
    assert.equal(outputOf(failed).error, 'invalid_input');
  }
  assert.equal(seen.length, 1);
});
