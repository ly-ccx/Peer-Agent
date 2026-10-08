import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInputQueue, inputMessageId } from './input-queue.mjs';
import { createCircuitBreaker } from './circuit-breaker.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { SAME_PROVIDER_RETRY_DELAYS_MS, createProjectAgentRunner } from './runner.mjs';
import { createScriptedTurnExecutor } from '../testing/scripted-turn-executor.mjs';

function world(workspaceId = 'ws-1') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b2-07-runner-'));
  const inbox = createProjectInbox({ rootDir: root });
  const messages = [];
  return {
    root,
    inbox,
    messages,
    workspaceId,
    append(_conversationId, message) {
      messages.push(message);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runnerFor(box, executeTurn, extra = {}) {
  return createProjectAgentRunner({
    workspaceId: box.workspaceId,
    conversationId: 'conv-agent',
    inbox: box.inbox,
    executeTurn,
    appendMessage: box.append,
    resolveModel: () => ({ modelProviderId: 'model-pa' }),
    resolveContext: () => ({ sources: [] }),
    retryDelays: [0, 0, 0],
    ...extra,
  });
}

function input(inputId, text) {
  return { inputId, text, surface: 'desktop' };
}

test('inner loop exhaustion is not retried and keeps executed tools, timing and public progress', async () => {
  const box = world(); let attempts = 0;
  const runner = runnerFor(box, async ({ sink, streamId, remainingToolCalls }) => {
    attempts++; assert.equal(remainingToolCalls, 20);
    sink.send('chat:stream:delta', { streamId, content: '已核对文件。' });
    return { ok: false, retryable: false, error: 'agent_tool_budget_exhausted', text: 'Read progress',
      toolCalls: [{ name: 'read_file', input: { path: 'report' }, result: { ok: true, evidenceRefs: ['tool-result://real'] }, startedAtMs: 1000, endedAtMs: 2250 }] };
  });
  try {
    await runner.enqueueUserInputs([input('bounded', '检查')]);
    assert.equal(attempts, 1);
    const turn = box.messages.find(message => message.kind === 'agent_turn');
    assert.equal(turn.rounds[0].toolCalls[0].endedAtMs, 2250);
    assert.deepEqual(turn.rounds[0].toolCalls[0].result.evidenceRefs, ['tool-result://real']);
    assert.equal(turn.publicUpdates[0].text, '已核对文件。');
    assert.equal(box.messages.some(message => message.kind === 'agent_reply'), false);
    assert.equal(runner.activity()?.phase, 'error');
  } finally { runner.dispose(); box.cleanup(); }
});

test('exhausted wake is consumed durably, excluded from the provider breaker, and only retried explicitly', async () => {
  const box = world(); let attempts = 0, failures = 0;
  const breaker = { admit: () => ({ allowed: true }), abandonTrial() {}, success() {},
    failure() { failures++; }, state: () => ({ status: 'open', openUntil: '2000-01-01' }) };
  const executeTurn = async ({ plan }) => {
    attempts++;
    assert.equal(plan.events[0].eventId, 'evt-budget');
    return attempts === 1 ? { ok: false, retryable: false, error: 'agent_tool_budget_exhausted: limit' } : { text: '', toolCalls: [] };
  };
  const extra = { circuitBreaker: breaker, readMessages: () => box.messages };
  let runner = runnerFor(box, executeTurn, extra);
  try {
    box.inbox.append(box.workspaceId, [{ eventId: 'evt-budget', kind: 'session_verified', sessionId: 's1', at: '2026-09-27T00:00:01.000Z', payload: {} }]);
    await runner.kick();
    assert.equal(attempts, 1); assert.equal(failures, 0);
    assert.equal(box.inbox.takeBatch(box.workspaceId).events.length, 0);
    await runner.kick(); assert.equal(attempts, 1);
    runner.dispose(); runner = runnerFor(box, executeTurn, extra);
    await runner.kick(); assert.equal(attempts, 1);
    assert.equal(runner.parked().kind, 'wake');
    await runner.retry(); assert.equal(attempts, 2); assert.equal(runner.status(), 'idle');
  } finally { runner.dispose(); box.cleanup(); }
});

test('a new user input can proceed after exhaustion without replaying the failed input', async () => {
  const box = world(), acknowledged = [], inputIds = [];
  const runner = runnerFor(box, async ({ plan }) => {
    inputIds.push(plan.userInputs.map(input => input.inputId));
    return inputIds.length === 1 ? { ok: false, retryable: false, error: 'agent_loop_exhausted: limit' } : { text: '新回复' };
  }, { onInputsCompleted: inputs => acknowledged.push(inputs.map(input => input.inputId)) });
  try {
    await runner.enqueueUserInputs([input('old', '检查')]);
    assert.equal(runner.status(), 'error');
    await runner.enqueueUserInputs([input('new', '请说明现状')]);
    assert.deepEqual(inputIds, [['old'], ['new']]);
    assert.deepEqual(acknowledged, [['old'], ['new']]);
    assert.equal(runner.status(), 'idle');
  } finally { runner.dispose(); box.cleanup(); }
});

test('manual wake retry is visible before completion and stoppable without changing wake authority', async () => {
  const box = world(), started = gate('retry did not start');
  let attempts = 0;
  const runner = runnerFor(box, async ({ plan, sink, streamId, signal }) => {
    attempts++;
    assert.equal(plan.kind, 'wake');
    assert.deepEqual(plan.userInputs, []);
    assert.equal(plan.limits.maxToolCalls, 12);
    assert.equal(plan.events[0].eventId, 'retry-event');
    if (attempts === 1) return { ok: false, retryable: false, error: 'agent_tool_budget_exhausted' };
    sink.send('chat:stream:thinking', { streamId, content: 'PRIVATE_REASONING' });
    sink.send('chat:stream:delta', { streamId, content: '正在重试。' });
    started.open(streamId);
    if (attempts === 2) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    }
    return { toolCalls: [{ name: 'post_reply', input: { text: '已确认当前进展。', replyTo: ['input-real'] }, result: { ok: true } }] };
  }, { readMessages: () => box.messages });
  try {
    box.inbox.append(box.workspaceId, [{ eventId: 'retry-event', kind: 'session_verified', sessionId: 's', at: '2026-10-06T00:00:00Z', payload: {} }]);
    await runner.kick();
    assert.equal(runner.activity(), null, 'automatic wake remains quiet');
    const done = runner.retry();
    const turnId = await started.ready;
    assert.equal(box.messages.filter(message => message.kind === 'agent_turn').length, 1, 'retry is still pending');
    assert.equal(runner.activity().turnId, turnId);
    assert.equal(runner.activity().segments[0].text, '正在重试。');
    assert.doesNotMatch(JSON.stringify(runner.activity()), /PRIVATE_REASONING/);
    assert.equal(runner.stopResponse(turnId).ok, true);
    await done;
    assert.equal(runner.activity().phase, 'stopped');
    const turn = box.messages.find(message => message.id === turnId);
    assert.equal(turn.turnKind, 'wake');
    assert.deepEqual(turn.publicUpdates, [{ id: 'text-1', text: '正在重试。' }]);
    await runner.retryStopped(turnId);
    assert.equal(attempts, 3, 'stopped wake retry retains events despite empty user inputs');
    assert.equal(runner.status(), 'idle');
    assert.equal(box.messages.at(-1).content, '已确认当前进展。');
  } finally { runner.dispose(); box.cleanup(); }
});

test('manual retry continues from the attempted tool results but a new user input does not inherit them', async () => {
  const box = world(); let attempts = 0;
  const runner = runnerFor(box, async ({ plan }) => {
    attempts++;
    if (attempts === 1) return { ok: false, retryable: false, error: 'agent_tool_budget_exhausted', text: 'PRIVATE_THINKING',
      toolCalls: [{ name: 'get_session', input: { sessionId: 's' }, result: { status: 'waiting_user', evidenceRefs: ['tool-result://read'] } }] };
    if (attempts === 2) {
      assert.match(plan.turnProfile.context.retryContinuity.tools[0].resultPreview, /waiting_user/);
      assert.equal(plan.limits.maxToolCalls, 12);
      assert.doesNotMatch(JSON.stringify(plan.turnProfile.context.retryContinuity), /PRIVATE_THINKING/);
    } else assert.equal(plan.turnProfile.context?.retryContinuity, undefined);
    return { toolCalls: [{ name: 'post_reply', input: { text: '已说明当前情况。', replyTo: ['input-real'] }, result: { ok: true } }] };
  }, { readMessages: () => box.messages });
  try {
    box.inbox.append(box.workspaceId, [{ eventId: 'facts-event', kind: 'session_verified', sessionId: 's', at: '2026-10-06T00:00:00Z', payload: {} }]);
    await runner.kick(); await runner.retry();
    await runner.enqueueUserInputs([input('new-request', '新的问题')]);
    assert.equal(attempts, 3);
  } finally { runner.dispose(); box.cleanup(); }
});

test('stopped manual wake survives restart without automatically replaying its events', async () => {
  const box = world(), started = gate('wake retry did not start'); let attempts = 0;
  const executeTurn = async ({ plan, streamId, signal }) => {
    attempts++;
    assert.equal(plan.events[0].eventId, 'stopped-event');
    if (attempts === 1) return { ok: false, retryable: false, error: 'agent_tool_budget_exhausted' };
    if (attempts === 2) {
      started.open(streamId);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    }
    return { toolCalls: [{ name: 'post_reply', input: { text: '重启后继续回复。', replyTo: ['input-real'] }, result: { ok: true } }] };
  };
  const extra = { readMessages: () => box.messages };
  let runner = runnerFor(box, executeTurn, extra);
  try {
    box.inbox.append(box.workspaceId, [{ eventId: 'stopped-event', kind: 'session_verified', sessionId: 's', at: '2026-10-06T00:00:00Z', payload: {} }]);
    await runner.kick();
    const pending = runner.retry(), turnId = await started.ready;
    assert.equal(runner.stopResponse(turnId).ok, true); await pending;
    const turn = box.messages.find(message => message.id === turnId);
    assert.equal(turn.meta.diagnosticTiming.outcome, 'stopped');
    assert.equal(turn.meta.recovery.events[0].eventId, 'stopped-event');
    runner.dispose(); runner = runnerFor(box, executeTurn, extra);
    await runner.kick(); assert.equal(attempts, 2);
    assert.equal(runner.parked().kind, 'wake');
    await runner.retry(); assert.equal(attempts, 3);
    assert.equal(box.messages.at(-1).content, '重启后继续回复。');
  } finally { runner.dispose(); box.cleanup(); }
});

test('legacy exhausted wake is parked after restart without acknowledging an unknown batch', async () => {
  const box = world(); let attempts = 0;
  box.messages.push({ id: 'old-turn', kind: 'agent_turn', turnKind: 'wake', userInputs: [] },
    { id: 'old-turn-card', turnId: 'old-turn', kind: 'system_card', card: 'agent_unavailable', content: '代理暂时不可用：agent_tool_budget_exhausted: limit' });
  box.inbox.append(box.workspaceId, [{ eventId: 'uncommitted', kind: 'session_verified', sessionId: 's1', at: '2026-09-27T00:00:01.000Z', payload: {} }]);
  const runner = runnerFor(box, async () => { attempts++; return { text: '新回复' }; }, { readMessages: () => box.messages });
  try {
    await runner.kick(); assert.equal(attempts, 0);
    assert.equal(box.inbox.takeBatch(box.workspaceId).events.length, 1);
    await runner.enqueueUserInputs([input('fresh', '说明现状')]);
    assert.equal(attempts, 1);
    assert.equal(box.inbox.takeBatch(box.workspaceId).events.length, 0);
  } finally { runner.dispose(); box.cleanup(); }
});

test('user turn persists only public Activity text across tool boundaries, separately from raw rounds', async () => {
  const box = world();
  const runner = runnerFor(box, async ({ sink, streamId }) => {
    const send = (channel, payload) => sink.send(channel, { streamId, ...payload });
    send('chat:stream:thinking', { content: 'PRIVATE_REASONING' });
    send('chat:stream:delta', { content: '我先核对。' });
    send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'read', args: {} });
    send('chat:stream:tool-result', { toolCallId: 'read', result: { ok: true } });
    send('chat:stream:delta', { content: '核对后有一个发现。' });
    return { text: 'INTERNAL_AGGREGATE', toolCalls: [{ name: 'post_reply', input: { text: '结论', replyTo: ['input-update'] }, result: { ok: true } }] };
  });
  try {
    await runner.enqueueUserInputs([input('update', '核对')]);
    const turn = box.messages.find(message => message.kind === 'agent_turn');
    assert.deepEqual(turn.publicUpdates, [{ id: 'text-1', text: '我先核对。' }, { id: 'text-2', text: '核对后有一个发现。' }]);
    assert.equal(turn.rounds[0].text, 'INTERNAL_AGGREGATE');
    assert.doesNotMatch(JSON.stringify(turn.publicUpdates), /PRIVATE_REASONING|INTERNAL_AGGREGATE/);
    assert.equal(box.messages.find(message => message.kind === 'agent_reply').content, '结论');
  } finally { runner.dispose(); box.cleanup(); }
});

test('a real text delta is observable while the provider is still pending', async () => {
  const box = world(), started = gate('provider did not start'), finish = gate('provider did not finish');
  const runner = runnerFor(box, async ({ sink, streamId }) => {
    sink.send('chat:stream:delta', { streamId, content: 'First chunk' });
    started.open();
    await finish.ready;
    return { text: 'First chunk and final', toolCalls: [] };
  });
  try {
    const done = runner.enqueueUserInputs([input('live', 'hello')]);
    await started.ready;
    assert.equal(box.messages.filter(message => message.kind === 'agent_reply').length, 0);
    assert.equal(runner.activity()?.segments[0]?.text, 'First chunk');
    finish.open();
    await done;
    assert.equal(box.messages.filter(message => message.kind === 'agent_reply').length, 1);
  } finally { finish.open(); runner.dispose(); box.cleanup(); }
});

test('stopping an exact user turn keeps partial text and real tools, completes inputs without a circuit failure', async () => {
  const box = world(), started = gate('not started'), completed = [], failures = [];
  let call = 0;
  const runner = runnerFor(box, async ({ sink, streamId, signal }) => {
    call++;
    sink.send('chat:stream:delta', { streamId, content: 'Partial answer' });
    started.open(streamId);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, terminalStatus: 'aborted', text: 'Partial answer',
      toolCalls: [{ name: 'read_file', input: { path: 'a' }, result: { ok: true } }] };
  }, { onInputsCompleted: inputs => completed.push(...inputs),
    circuitBreaker: { admit: () => ({ allowed: true }), failure: info => failures.push(info), abandonTrial() {} } });
  try {
    const done = runner.enqueueUserInputs([input('stop', 'hello')]);
    const turnId = await started.ready;
    assert.equal(runner.stopResponse('old').code, 'STALE_TURN');
    assert.equal(runner.stopResponse(turnId).ok, true);
    await done;
    assert.equal(failures.length, 0);
    assert.equal(completed[0].inputId, 'stop');
    assert.equal(box.messages.find(message => message.kind === 'agent_turn').rounds[0].toolCalls[0].name, 'read_file');
    assert.equal(box.messages.find(message => message.card === 'agent_stopped').content, 'Partial answer');
    assert.deepEqual(box.messages.find(message => message.kind === 'agent_turn').publicUpdates, [{ id: 'text-1', text: 'Partial answer' }]);
    assert.equal(box.messages.some(message => message.kind === 'agent_reply'), false);
    assert.equal(runner.stopResponse(turnId).code, 'STALE_TURN');
    assert.equal(call, 1);
  } finally { runner.dispose(); box.cleanup(); }
});

test('post_reply argument deltas remain provisional until the governed result is accepted', async () => {
  const box = world(), started = gate('post reply not started'), finish = gate('post reply not released');
  const runner = runnerFor(box, async ({ sink, streamId }) => {
    sink.send('chat:stream:tool-progress', { streamId, tool: 'post_reply', toolCallId: 'reply', replyText: 'Draft reply' });
    started.open(); await finish.ready;
    sink.send('chat:stream:tool-call', { streamId, tool: 'post_reply', toolCallId: 'reply', args: { text: 'Draft reply' } });
    sink.send('chat:stream:tool-result', { streamId, toolCallId: 'reply', result: JSON.stringify({ ok: true, output: { error: 'claim not supported' } }) });
    return { toolCalls: [{ name: 'post_reply', input: { text: 'Draft reply' }, result: { ok: true, output: { error: 'claim not supported' } } }] };
  });
  try {
    const done = runner.enqueueUserInputs([input('preview', 'hello')]);
    await started.ready;
    assert.equal(runner.activity().replyText, 'Draft reply');
    assert.equal(box.messages.some(message => message.kind === 'agent_reply'), false);
    finish.open(); await done;
    assert.equal(runner.activity().replyText, '');
    assert.equal(runner.activity().phase, 'error');
    assert.equal(box.messages.some(message => message.kind === 'agent_reply'), false);
    assert.equal(box.messages.some(message => message.card === 'agent_unavailable'), true);
  } finally { finish.open(); runner.dispose(); box.cleanup(); }
});

test('a late stop cannot overwrite an already persisted reply while its acknowledgement is pending', async () => {
  const box = world(), saving = gate('ack not entered'), ack = gate('ack not released');
  const runner = runnerFor(box, async () => ({ text: 'Complete reply' }), {
    async onReplied() { saving.open(); await ack.ready; },
  });
  try {
    const done = runner.enqueueUserInputs([input('completed', 'hello')]);
    await saving.ready;
    assert.equal(runner.stopResponse(runner.activity().turnId).code, 'STALE_TURN');
    ack.open(); await done;
    assert.equal(box.messages.filter(message => message.kind === 'agent_reply').length, 1);
    assert.equal(box.messages.some(message => message.card === 'agent_stopped'), false);
  } finally { ack.open(); runner.dispose(); box.cleanup(); }
});

function gate(label) {
  let open;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), 2000);
    open = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
  });
  return { ready, open };
}

function scriptedTurn(script) {
  const recorded = [];
  const player = createScriptedTurnExecutor(script.map((step) => {
    if (step.type !== 'tool') return step;
    return {
      ...step,
      async executeTool(played) {
        const result = typeof step.executeTool === 'function' ? await step.executeTool(played) : null;
        recorded.push({ name: step.name, input: step.input ?? null, result });
        return result;
      },
    };
  }));
  return async (args) => {
    const outcome = await player.runTurn({ sink: args.sink, turnProfile: args.turnProfile });
    return {
      text: outcome.text,
      toolCalls: recorded.splice(0, recorded.length),
      toolCallCount: outcome.toolCallCount,
      terminalStatus: outcome.terminalStatus,
    };
  };
}

test('同提供方重试退避与 ADR 30 一致', () => {
  assert.deepEqual(SAME_PROVIDER_RETRY_DELAYS_MS, [500, 1500, 3000]);
});

test('用户回合开任务后，事件回流触发唤醒并 post_reply', async () => {
  const box = world('ws-chain');
  const statuses = [];
  const seen = [];
  const sent = [];
  try {
    const queue = createInputQueue({
      rootDir: box.root,
      holdsLease: () => true,
      resolveConversationId: () => 'conv-agent',
      hasMessage: (_conversationId, messageId) => box.messages.some((message) => message.id === messageId),
      appendMessage: box.append,
    });
    const inputId = 'in-chain';
    const runUser = scriptedTurn([
      {
        type: 'tool',
        name: 'spawn_session',
        input: { title: '看一下' },
        async executeTool() {
          box.inbox.append(box.workspaceId, [{
            eventId: 'evt-chain',
            kind: 'session_verified',
            sessionId: 'sess-1',
            at: '2026-09-27T00:00:01.000Z',
            payload: { summary: 'done' },
          }]);
          return { sessionId: 'sess-1' };
        },
      },
      { type: 'delta', content: '已开工' },
      { type: 'terminal', channel: 'done' },
    ]);
    const runWake = scriptedTurn([
      {
        type: 'tool',
        name: 'post_reply',
        input: { text: '任务做完了', replyTo: [inputMessageId(inputId)], sources: ['sess-1'] },
        async executeTool() {
          return { ok: true };
        },
      },
      { type: 'terminal', channel: 'done' },
    ]);
    const runner = runnerFor(box, async (args) => {
      assert.equal(runner.status(), 'waiting_provider');
      assert.equal(args.mode, 'project_agent');
      assert.equal(args.turnProfile.role, 'project_agent');
      assert.deepEqual(args.turnProfile.context, { sources: [], ...(args.plan.events.length ? { events: args.plan.events } : {}), ...(args.plan.kind === 'user' ? { inputAnchors: [{ messageId: inputMessageId(inputId), text: '帮我看一下' }] } : {}) });
      assert.equal(args.modelProviderId, 'model-pa');
      seen.push(args.plan);
      return args.plan.kind === 'wake' ? runWake(args) : runUser(args);
    }, {
      onStatus: (status) => statuses.push(status),
      sink: { send(channel, payload) { sent.push({ channel, payload }); } },
    });
    queue.submitInput({
      inputId,
      workspaceId: box.workspaceId,
      surface: 'desktop',
      text: '帮我看一下',
      createdAt: '2026-09-27T00:00:00.000Z',
    });
    const consumed = queue.consume(box.workspaceId);
    await runner.enqueueUserInputs(consumed.consumed);

    assert.deepEqual(seen.map((plan) => plan.kind), ['user', 'wake']);
    assert.equal(seen[1].reminder.kind, 'project-agent-wake');
    assert.equal(seen[1].events[0].eventId, 'evt-chain');
    assert.equal(box.messages.filter((message) => message.role === 'user').length, 1);
    const turns = box.messages.filter((message) => message.kind === 'agent_turn');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].rounds[0].toolCalls[0].name, 'spawn_session');
    const replies = box.messages.filter((message) => message.kind === 'agent_reply');
    assert.equal(replies.length, 2);
    assert.equal(replies[0].fallback, true);
    assert.equal(replies[0].content, '已开工');
    assert.deepEqual(replies[0].replyTo, [inputMessageId(inputId)]);
    assert.equal(replies[1].fallback, false);
    assert.equal(replies[1].content, '任务做完了');
    assert.deepEqual(replies[1].sources, ['sess-1']);
    assert.equal(box.inbox.cursor(box.workspaceId).seq, 1);
    assert.equal(runner.status(), 'idle');
    assert.ok(statuses.includes('thinking'));
    assert.ok(statuses.includes('waiting_provider'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:delta'));
  } finally {
    box.cleanup();
  }
});

test('用户输入在安全点抢占唤醒，游标留到用户回合成功后才推进', async () => {
  const box = world('ws-pre');
  const entered = gate('wake did not start');
  const release = gate('wake was not released');
  let cursorDuringUser = null;
  try {
    box.inbox.append(box.workspaceId, [{
      eventId: 'evt-pre',
      kind: 'session_verified',
      sessionId: 'sess-9',
      at: '2026-09-27T00:00:02.000Z',
      payload: { summary: 'ready' },
    }]);
    const runner = runnerFor(box, async ({ plan, signal }) => {
      if (plan.kind === 'wake') {
        entered.open();
        await release.ready;
        assert.equal(signal.aborted, true);
        return {
          preempted: true,
          text: '来不及说',
          toolCallCount: 1,
          toolCalls: [{ name: 'list_sessions', input: {}, result: { ok: true } }],
        };
      }
      cursorDuringUser = box.inbox.cursor(box.workspaceId).seq;
      assert.equal(plan.events[0].eventId, 'evt-pre');
      assert.equal(plan.reminder, null);
      return { text: '收到' };
    });
    const done = runner.kick();
    await entered.ready;
    const queued = runner.enqueueUserInputs([input('user-1', '我先说')]);
    release.open();
    await done;
    await queued;
    assert.equal(cursorDuringUser, 0);
    assert.equal(box.inbox.cursor(box.workspaceId).seq, 1);
    assert.equal(box.messages.filter((message) => message.kind === 'agent_reply').length, 1);
    assert.equal(box.messages.find((message) => message.kind === 'agent_reply').fallback, true);
    assert.equal(box.messages.find((message) => message.turnKind === 'wake').rounds[0].toolCalls[0].name, 'list_sessions');
    assert.equal(runner.mailbox().events.length, 0);
    assert.equal(runner.status(), 'idle');
  } finally {
    box.cleanup();
  }
});

test('用户回合没有 post_reply 时，兜底回复盖住本回合的全部输入', async () => {
  const box = world('ws-fallback');
  try {
    const play = scriptedTurn([
      { type: 'delta', content: '两件一起看' },
      { type: 'terminal', channel: 'done' },
    ]);
    const seen = [];
    const runner = runnerFor(box, async (args) => {
      seen.push(args.plan.userInputs.map((item) => item.inputId));
      return play(args);
    });
    await runner.enqueueUserInputs([input('left', '左边'), input('right', '右边')]);
    assert.deepEqual(seen, [['left', 'right']]);
    const reply = box.messages.find((message) => message.kind === 'agent_reply');
    assert.equal(reply.fallback, true);
    assert.equal(reply.content, '两件一起看');
    assert.deepEqual(reply.replyTo, ['input-left', 'input-right']);
    assert.equal(box.messages.some((message) => message.kind === 'system_card'), false);
  } finally {
    box.cleanup();
  }
});

test('回合带回的记忆 id 写进兜底回复和 post_reply', async () => {
  const box = world('ws-memory');
  try {
    const runner = runnerFor(box, async () => ({ text: '记下了', memoryIds: ['mem-1'] }));
    await runner.enqueueUserInputs([input('m1', '记住')]);
    const fallback = box.messages.find((message) => message.kind === 'agent_reply');
    assert.deepEqual(fallback.meta.memoryUsed, ['mem-1']);
  } finally {
    box.cleanup();
  }

  const spoken = world('ws-memory-reply');
  try {
    const runner = runnerFor(spoken, async () => ({
      text: '',
      toolCalls: [
        { name: 'memory_remember', input: {}, result: { ok: true, id: 'mem-new' } },
        {
          name: 'post_reply',
          input: { text: '记住了', replyTo: ['input-m2'] },
          result: { ok: true, meta: { memoryUsed: ['mem-used'], surfacing: 'message' } },
        },
      ],
    }));
    await runner.enqueueUserInputs([input('m2', '记住')]);
    const reply = spoken.messages.find((message) => message.kind === 'agent_reply');
    assert.equal(reply.content, '记住了');
    assert.deepEqual(reply.meta.memoryUsed, ['mem-used']);
    assert.deepEqual(reply.meta.memoryLearned, ['mem-new']);
    assert.equal(reply.meta.surfacing, 'message');
  } finally {
    spoken.cleanup();
  }
});

test('可重试错误按 ADR 30 再试三次，第四次成功不写卡片', async () => {
  const box = world('ws-retry-ok');
  let calls = 0;
  try {
    const runner = runnerFor(box, async () => {
      calls += 1;
      if (calls < 4) return { ok: false, retryable: true, error: '临时中断' };
      return { text: '恢复了' };
    });
    await runner.enqueueUserInputs([input('once', '再试')]);
    assert.equal(calls, 4);
    assert.equal(runner.status(), 'idle');
    assert.equal(box.messages.some((message) => message.kind === 'system_card'), false);
    assert.equal(box.messages.find((message) => message.kind === 'agent_reply').content, '恢复了');
  } finally {
    box.cleanup();
  }
});

test('重试耗尽后写入不可用卡片，retry 先重跑失败回合', async () => {
  const box = world('ws-retry-fail');
  const seen = [];
  let fail = true;
  try {
    const runner = runnerFor(box, async ({ plan }) => {
      seen.push(plan.userInputs[0].inputId);
      if (fail) return { ok: false, retryable: true, error: '连接中断' };
      return { text: `好了:${plan.userInputs[0].inputId}` };
    });
    await runner.enqueueUserInputs([input('first', '第一句')]);
    assert.equal(seen.length, 4);
    assert.equal(runner.status(), 'error');
    assert.deepEqual(runner.parked().inputIds, ['first']);
    const card = box.messages.find((message) => message.kind === 'system_card');
    assert.equal(card.content, '代理暂时不可用：连接中断');
    assert.deepEqual(card.actions, ['retry']);
    assert.equal(box.messages.filter((message) => message.role === 'user').length, 0);

    const queued = await runner.enqueueUserInputs([input('second', '后到')]);
    assert.equal(queued.skipped, 'error');
    assert.equal(seen.length, 4);
    assert.deepEqual(runner.mailbox().userInputs.map((item) => item.inputId), ['second']);

    fail = false;
    await runner.retry();
    assert.deepEqual(seen, ['first', 'first', 'first', 'first', 'first', 'second']);
    assert.equal(runner.status(), 'idle');
    assert.equal(runner.parked(), null);
    const replies = box.messages.filter((message) => message.kind === 'agent_reply');
    assert.deepEqual(replies.map((message) => message.content), ['好了:first', '好了:second']);
    assert.ok(replies.every((message) => message.fallback === true));
  } finally {
    box.cleanup();
  }
});

test('不可重试的失败只打一次，停住的唤醒会被用户输入接走', async () => {
  const box = world('ws-wake-fail');
  const kinds = [];
  let cursorDuringUser = null;
  try {
    box.inbox.append(box.workspaceId, [{
      eventId: 'evt-fail',
      kind: 'failed',
      sessionId: 'sess-2',
      at: '2026-09-27T00:00:03.000Z',
      payload: {},
    }]);
    const runner = runnerFor(box, async ({ plan }) => {
      kinds.push(plan.kind);
      if (plan.kind === 'wake') return { ok: false, retryable: false, error: '拒绝' };
      cursorDuringUser = box.inbox.cursor(box.workspaceId).seq;
      assert.equal(plan.events[0].eventId, 'evt-fail');
      return { text: '用户来了' };
    });
    await runner.kick();
    assert.deepEqual(kinds, ['wake']);
    assert.equal(box.inbox.cursor(box.workspaceId).seq, 0);
    assert.equal(box.messages.find((message) => message.kind === 'system_card').content, '代理暂时不可用：拒绝');
    assert.equal(box.messages.some((message) => message.kind === 'agent_reply'), false);

    const queued = await runner.enqueueUserInputs([input('after', '换我')]);
    assert.equal(queued.skipped, 'error');
    assert.deepEqual(kinds, ['wake']);
    await runner.retry();
    assert.deepEqual(kinds, ['wake', 'user']);
    assert.equal(cursorDuringUser, 0);
    assert.equal(box.inbox.cursor(box.workspaceId).seq, 1);
    assert.equal(box.messages.filter((message) => message.kind === 'agent_reply').length, 1);
    assert.equal(box.messages.find((message) => message.kind === 'agent_reply').content, '用户来了');
  } finally {
    box.cleanup();
  }
});

test('同一项目的回合串行，进行中的新输入并进下一轮', async () => {
  const box = world('ws-serial');
  const started = gate('first turn did not start');
  const release = gate('first turn was not released');
  let active = 0;
  let maxActive = 0;
  const seen = [];
  try {
    const runner = runnerFor(box, async ({ plan }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push(plan.userInputs.map((item) => item.inputId));
      if (seen.length === 1) {
        started.open();
        await release.ready;
      }
      active -= 1;
      return { text: 'ok' };
    });
    const first = runner.enqueueUserInputs([input('first', '一')]);
    await started.ready;
    const second = runner.enqueueUserInputs([input('second', '二'), input('third', '三')]);
    assert.equal(seen.length, 1);
    assert.equal(maxActive, 1);
    release.open();
    await first;
    await second;
    assert.deepEqual(seen, [['first'], ['second', 'third']]);
    assert.equal(maxActive, 1);
  } finally {
    box.cleanup();
  }
});

test('两个项目的回合可以重叠', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b2-07-two-'));
  const inbox = createProjectInbox({ rootDir: root });
  const release = gate('overlap was not released');
  const overlapped = gate('two projects did not overlap');
  let active = 0;
  let maxActive = 0;
  let ready = 0;
  try {
    const executeTurn = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      ready += 1;
      if (ready === 2) overlapped.open();
      await release.ready;
      active -= 1;
      return { text: 'ok' };
    };
    const left = createProjectAgentRunner({
      workspaceId: 'ws-left',
      conversationId: 'conv-left',
      inbox,
      executeTurn,
      appendMessage() {},
      resolveModel: () => ({ modelProviderId: 'model-pa' }),
      retryDelays: [0, 0, 0],
    });
    const right = createProjectAgentRunner({
      workspaceId: 'ws-right',
      conversationId: 'conv-right',
      inbox,
      executeTurn,
      appendMessage() {},
      resolveModel: () => ({ modelProviderId: 'model-pa' }),
      retryDelays: [0, 0, 0],
    });
    const pending = Promise.all([
      left.enqueueUserInputs([input('L', '左')]),
      right.enqueueUserInputs([input('R', '右')]),
    ]);
    await overlapped.ready;
    assert.equal(maxActive, 2);
    release.open();
    await pending;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('计时器只入邮箱，轮次和工具上限会停住循环', async () => {
  const box = world('ws-limits');
  try {
    const runner = runnerFor(box, async () => ({ text: '不该跑' }));
    const queued = runner.enqueueTimer({ id: 'digest-1', kind: 'digest_due' });
    assert.equal(queued.queued, true);
    await runner.kick();
    assert.equal(box.messages.length, 0);
    assert.equal(runner.mailbox().timers[0].kind, 'digest_due');
    assert.equal(runner.status(), 'idle');

    let userRounds = 0;
    const capped = runnerFor(box, async ({ plan, roundIndex }) => {
      if (plan.kind === 'user') {
        userRounds += 1;
        assert.equal(roundIndex, userRounds - 1);
      }
      return {
        continued: true,
        toolCallCount: 3,
        toolCalls: [{ name: 'list_sessions', input: {}, result: { ok: true } }],
        text: '',
      };
    });
    await capped.enqueueUserInputs([input('cap', '测上限')]);
    assert.equal(userRounds, 7);
    assert.equal(capped.status(), 'error');
    assert.ok(box.messages.some(message => message.card === 'agent_unavailable'));
    assert.equal(box.messages.some(message => message.kind === 'agent_reply' && !message.content), false);
    const userTurn = box.messages.find((message) => message.turnKind === 'user');
    assert.equal(userTurn.rounds.length, 7);

    box.inbox.append(box.workspaceId, [{
      eventId: 'evt-cap',
      kind: 'session_verified',
      sessionId: 'sess-cap',
      at: '2026-09-27T00:00:04.000Z',
      payload: {},
    }]);
    let wakeRounds = 0;
    const waking = runnerFor(box, async ({ plan }) => {
      if (plan.kind !== 'wake') return { text: 'skip' };
      wakeRounds += 1;
      return {
        continued: true,
        toolCallCount: 3,
        toolCalls: [{ name: 'list_sessions', input: {}, result: {} }],
        text: '',
      };
    });
    await waking.kick();
    assert.equal(wakeRounds, 4);
    assert.equal(box.inbox.cursor(box.workspaceId).seq, 1);
    const wakeReplies = box.messages.filter((message) => message.kind === 'agent_reply' && message.fallback !== true);
    assert.equal(wakeReplies.length, 0);
  } finally {
    box.cleanup();
  }
});

test('post_reply 结束本回合，即使执行器还想继续', async () => {
  const box = world('ws-stop');
  let calls = 0;
  try {
    const runner = runnerFor(box, async () => {
      calls += 1;
      return {
        continued: true,
        toolCallCount: 1,
        toolCalls: [{
          name: 'post_reply',
          input: { text: '说完了', replyTo: ['input-stop'] },
          result: { ok: true },
        }],
      };
    });
    await runner.enqueueUserInputs([input('stop', '说')]);
    assert.equal(calls, 1);
    const reply = box.messages.find((message) => message.kind === 'agent_reply');
    assert.equal(reply.fallback, false);
    assert.equal(reply.content, '说完了');
  } finally {
    box.cleanup();
  }
});

test('没有租约时不跑回合，没有模型时停在错误等 retry', async () => {
  const box = world('ws-lease');
  let calls = 0;
  try {
    const runner = runnerFor(box, async () => {
      calls += 1;
      return { text: 'nope' };
    }, { holdsLease: () => false });
    const skipped = await runner.enqueueUserInputs([input('held', '不跑')]);
    assert.equal(skipped.skipped, 'not-host');
    assert.equal(calls, 0);
    assert.equal(runner.status(), 'idle');
    assert.equal(runner.mailbox().userInputs.length, 1);

    let allowModel = false;
    const unmet = runnerFor(box, async () => {
      calls += 1;
      return { text: '有模型了' };
    }, {
      resolveModel: () => (allowModel
        ? { modelProviderId: 'model-pa' }
        : { ok: false, missing: '没有可用的模型' }),
    });
    await unmet.enqueueUserInputs([input('need-model', '需要模型')]);
    assert.equal(calls, 0);
    assert.equal(unmet.status(), 'error');
    assert.match(box.messages.find((message) => message.kind === 'system_card').content, /没有可用的模型/);
    allowModel = true;
    await unmet.retry();
    assert.equal(calls, 1);
    assert.equal(unmet.status(), 'idle');
  } finally {
    box.cleanup();
  }
});

test('同一条今日小结只进一次邮箱，写入对话后才确认', async () => {
  const box = world('ws-digest-ack');
  const delivered = [];
  try {
    const runner = runnerFor(box, async () => ({ text: '不该跑模型' }), {
      onDigestDelivered: (message) => delivered.push(message.meta.digestDate),
    });
    const timer = {
      kind: 'digest_due',
      wake: true,
      id: 'digest:ws-digest-ack:2026-09-27',
      message: {
        id: 'digest:ws-digest-ack:2026-09-27',
        role: 'assistant',
        kind: 'agent_reply',
        content: '一条',
        meta: { surfacing: 'digest', digestDate: '2026-09-27' },
      },
    };
    assert.equal(runner.enqueueTimer(timer).queued, true);
    assert.equal(runner.enqueueTimer({ ...timer }).duplicate, true);
    assert.equal(runner.mailbox().timers.length, 1);
    await runner.kick();
    assert.deepEqual(delivered, ['2026-09-27']);
    assert.equal(box.messages[0].content, '一条');
  } finally {
    box.cleanup();
  }
});

test('今日小结定时邮件唤醒后写入分隔消息，digest 回复改入暂存', async () => {
  const box = world('ws-digest');
  const held = [];
  try {
    const runner = runnerFor(box, async () => ({ text: '不该跑模型' }), {
      onDigest: (item) => held.push(item),
    });
    runner.enqueueTimer({
      kind: 'digest_due',
      wake: true,
      id: 'digest:ws-digest:2026-09-27',
      message: {
        id: 'digest:ws-digest:2026-09-27',
        role: 'assistant',
        kind: 'agent_reply',
        separatorLabel: '今天 09:00 · 今日小结',
        content: '登录修好了',
        meta: { surfacing: 'digest' },
      },
    });
    await runner.kick();
    assert.equal(runner.mailbox().timers.length, 0);
    assert.equal(box.messages.length, 1);
    assert.equal(box.messages[0].separatorLabel, '今天 09:00 · 今日小结');
    assert.equal(box.messages[0].content, '登录修好了');

    const holding = runnerFor(box, async () => ({
      toolCalls: [{
        name: 'post_reply',
        input: { text: '先记下', proactive: true },
        result: { ok: true, meta: { surfacing: 'digest' } },
      }],
    }), {
      onDigest: (item) => held.push(item),
    });
    box.inbox.append(box.workspaceId, [{
      eventId: 'evt-digest-hold',
      kind: 'session_verified',
      sessionId: 'sess-1',
      at: '2026-09-27T01:00:00.000Z',
      payload: {},
    }]);
    await holding.kick();
    assert.equal(held.length, 1);
    assert.equal(held[0].text, '先记下');
    assert.equal(box.messages.filter((message) => message.content === '先记下').length, 0);
  } finally {
    box.cleanup();
  }
});

test('回合结束后触发整理，学到的 id 出现在下一条回复', async () => {
  const box = world('ws-curator');
  const seen = [];
  try {
    const runner = runnerFor(box, async () => ({ text: '好' }), {
      onCurator: async (info) => {
        seen.push({
          kind: info.kind,
          events: (info.events || []).map((event) => event.kind),
        });
        return { learnedIds: info.kind === 'user' ? ['mem-curated'] : [] };
      },
    });
    await runner.enqueueUserInputs([input('a', '一')]);
    const first = box.messages.filter((message) => message.kind === 'agent_reply');
    assert.equal(first.length, 1);
    assert.equal(first[0].meta, undefined);
    assert.deepEqual(seen.map((item) => item.kind), ['user']);

    await runner.enqueueUserInputs([input('b', '二')]);
    const replies = box.messages.filter((message) => message.kind === 'agent_reply');
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[1].meta.memoryLearned, ['mem-curated']);

    box.inbox.append(box.workspaceId, [{
      eventId: 'evt-curator',
      kind: 'session_verified',
      sessionId: 'sess-1',
      at: '2026-09-27T02:00:00.000Z',
      payload: { summary: '做完了' },
    }]);
    await runner.kick();
    assert.deepEqual(seen.map((item) => item.kind), ['user', 'user', 'wake']);
    assert.deepEqual(seen[2].events, ['session_verified']);
  } finally {
    box.cleanup();
  }
});

test('被频率挡住的整理到点后自己再跑，学到的 id 出现在下一条回复', async () => {
  const box = world('ws-curator-due');
  const seen = [];
  try {
    const runner = runnerFor(box, async () => ({ text: '好' }), {
      onCurator: async (info) => {
        seen.push(info.kind);
        if (info.kind === 'user') return { retryAt: new Date(Date.now() + 30).toISOString() };
        return { learnedIds: ['mem-due'] };
      },
    });
    await runner.enqueueUserInputs([input('a', '一')]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(seen, ['user', 'due']);
    await runner.enqueueUserInputs([input('b', '二')]);
    const replies = box.messages.filter((message) => message.kind === 'agent_reply');
    assert.deepEqual(replies[1].meta.memoryLearned, ['mem-due']);
  } finally {
    box.cleanup();
  }
});


test('runner counts failed turns once, suppresses open wakes and acknowledges successful inputs once', async () => {
  const box = world('breaker-runner'); let clock = Date.parse('2026-10-01T00:00:00Z'); let calls = 0, succeed = false;
  const breaker = createCircuitBreaker({ rootDir: box.root, workspaceId: box.workspaceId, now: () => new Date(clock).toISOString() });
  const completed = [];
  const runner = runnerFor(box, async () => { calls++; return succeed ? { text: 'done' } : { ok: false, retryable: true, error: 'offline' }; },
    { circuitBreaker: breaker, now: () => new Date(clock).toISOString(), onInputsCompleted: inputs => completed.push(...inputs) });
  try {
    await runner.enqueueUserInputs([input('one', 'do it')]);
    assert.equal(calls, 4); assert.equal(breaker.state().failures, 1);
    for (let n = 0; n < 4; n++) await runner.retry();
    assert.equal(breaker.state().status, 'open'); assert.equal(calls, 20);
    await runner.kick(); await runner.enqueueUserInputs([input('two', 'then this'), input('two', 'duplicate')]);
    assert.equal(calls, 20);
    assert.match(box.messages.at(-1).content, /连续失败|暂停自动/);
    assert.deepEqual(completed, []);
    succeed = true; await runner.retry();
    assert.equal(breaker.state().status, 'closed'); assert.deepEqual(completed.map(item => item.inputId), ['one', 'two']);
    const before = calls; await runner.enqueueUserInputs([input('two', 'replay')]); assert.equal(calls, before);
    succeed = false; await runner.enqueueUserInputs([input('three', 'again')]);
    for (let n = 0; n < 4; n++) await runner.retry();
    const openCalls = calls; clock += 10 * 60_000; succeed = true; await runner.kick();
    assert.ok(calls > openCalls); assert.equal(breaker.state().status, 'closed');
  } finally { runner.dispose(); box.cleanup(); }
});

test('restart repairs a circuit card interrupted after failure persistence without executing or duplicating', async () => {
  const box = world('breaker-card-gap'); let calls = 0;
  const breaker = createCircuitBreaker({ rootDir: box.root, workspaceId: box.workspaceId });
  for (let n = 0; n < 5; n++) breaker.failure({ turnId: `fail-${n}`, reason: 'offline', retry: { kind: 'user', userInputs: [input('one', 'do it')] } });
  let runner;
  try {
    const restart = () => runnerFor(box, async () => { calls++; return { text: 'unexpected' }; }, {
      circuitBreaker: createCircuitBreaker({ rootDir: box.root, workspaceId: box.workspaceId }),
      readMessages: () => box.messages,
    });
    runner = restart(); await runner.enqueueUserInputs([input('one', 'do it')]);
    assert.equal(calls, 0);
    const card = box.messages.find(message => message.card === 'agent_unavailable');
    assert.equal(card?.turnId, 'fail-4'); assert.match(card?.content, /暂停自动/);
    assert.deepEqual(box.messages.find(message => message.id === 'fail-4')?.userInputs.map(item => item.inputId), ['one']);
    runner.dispose(); runner = restart(); await runner.enqueueUserInputs([input('one', 'do it')]);
    assert.equal(box.messages.filter(message => message.card === 'agent_unavailable').length, 1);
    assert.equal(calls, 0);
  } finally { runner?.dispose(); box.cleanup(); }
});
