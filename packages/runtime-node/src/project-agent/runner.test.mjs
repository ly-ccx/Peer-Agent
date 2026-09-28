import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInputQueue, inputMessageId } from './input-queue.mjs';
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
      assert.deepEqual(args.turnProfile.context, { sources: [] });
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
    assert.equal(capped.status(), 'idle');
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
        result: { meta: { surfacing: 'digest' } },
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
