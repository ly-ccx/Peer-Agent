import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createDelegationProvider } from './delegation-provider.mjs';
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
        return { sessionId: input.sessionId, delivered: true };
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
  assert.equal(amend.error, 'unsupported_intent');
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

function resultGrantRecorded(result) {
  return Boolean(result.grant?.grantId && result.result?.evidence?.toolCallId === result.call.toolCallId);
}
