import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTurnExecutor } from './agent-turn-executor.mjs';
import { createBroadcastSink } from './turn-sinks.mjs';

test('runTurn forwards the sink and turn profile and returns the service outcome', async () => {
  const seen = [];
  const executor = createAgentTurnExecutor({
    llmChatService: {
      async sendMessage(input) {
        input.webContents.send('chat:stream:delta', { content: 'ok' });
        seen.push(input.turnProfile);
        return { terminalStatus: 'done', toolCallCount: 0 };
      },
    },
  });
  const events = [];
  const outcome = await executor.runTurn({
    turnProfile: { role: 'goal_runner' },
    sink: { send: (channel, payload) => events.push({ channel, payload }) },
    streamId: 's1',
    messages: [],
  });
  assert.deepEqual(outcome, { terminalStatus: 'done', toolCallCount: 0 });
  assert.deepEqual(seen, [{ role: 'goal_runner' }]);
  assert.deepEqual(events, [{ channel: 'chat:stream:delta', payload: { content: 'ok' } }]);
});

test('a goal turn still finishes when the broadcast sink has no windows', async () => {
  const executor = createAgentTurnExecutor({
    llmChatService: {
      async sendMessage(input) {
        input.webContents.send('chat:stream:delta', { content: 'background' });
        input.webContents.send('chat:stream:done', {});
        return { terminalStatus: 'done' };
      },
    },
  });
  const outcome = await executor.runTurn({
    turnProfile: { role: 'goal_runner' },
    sink: createBroadcastSink({ getWindows: () => [] }),
    streamId: 's2',
  });
  assert.equal(outcome.terminalStatus, 'done');
});

test('项目代理回合把流上的工具调用带回 runner', async () => {
  const executor = createAgentTurnExecutor({
    llmChatService: {
      async sendMessage(input) {
        input.webContents.send('chat:stream:delta', { content: '旁白' });
        input.webContents.send('chat:stream:tool-call', {
          tool: 'post_reply',
          toolCallId: 'c1',
          args: { text: '收到', replyTo: ['u1'] },
        });
        input.webContents.send('chat:stream:tool-result', {
          toolCallId: 'c1',
          result: JSON.stringify({ ok: true, meta: { memoryUsed: ['mem-1'], surfacing: 'message' } }),
        });
        return { terminalStatus: 'done', toolCallCount: 1, memoryIds: ['mem-1'] };
      },
    },
  });
  const events = [];
  const outcome = await executor.runTurn({
    turnProfile: { role: 'project_agent' },
    mode: 'project_agent',
    sink: { send: (channel) => events.push(channel) },
  });
  assert.deepEqual(events, ['chat:stream:delta', 'chat:stream:tool-call', 'chat:stream:tool-result']);
  assert.equal(outcome.text, '旁白');
  assert.deepEqual(outcome.memoryIds, ['mem-1']);
  assert.equal(outcome.toolCalls[0].name, 'post_reply');
  assert.deepEqual(outcome.toolCalls[0].input, { text: '收到', replyTo: ['u1'] });
  assert.deepEqual(outcome.toolCalls[0].result.meta.memoryUsed, ['mem-1']);
});

test('runTurn rejects a missing chat service or sink', () => {
  assert.throws(() => createAgentTurnExecutor({}), /sendMessage/);
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage() {} } });
  assert.throws(() => executor.runTurn({ sink: {} }), /sink/);
});

test('readonly verifier cancellation uses the existing abort seam without sending a signal parameter', async () => {
  const controller = new AbortController();
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const aborted = [];
  const executor = createAgentTurnExecutor({llmChatService:{
    sendMessage(input) {
      assert.equal(Object.hasOwn(input,'signal'),false);
      started();return new Promise(resolve=>{release=resolve;});
    },
    abort(id) {aborted.push(id);release({terminalStatus:'aborted'});},
  }});
  const pending=executor.runTurn({turnProfile:{role:'verifier'},streamId:'verify-cancel',signal:controller.signal,sink:{send(){}}});
  await ready;controller.abort();
  assert.equal((await pending).terminalStatus,'aborted');
  assert.deepEqual(aborted,['verify-cancel']);
});

test('project cancellation aborts the existing stream and detaches after completion', async () => {
  const controller = new AbortController();
  const aborted = [];
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const executor = createAgentTurnExecutor({ llmChatService: {
    sendMessage(input) {
      assert.equal(Object.hasOwn(input, 'signal'), false);
      started();
      return new Promise(resolve => { release = resolve; });
    },
    abort(streamId) { aborted.push(streamId); release({ terminalStatus: 'aborted' }); },
  } });
  const pending = executor.runTurn({ mode: 'project_agent', streamId: 'cancel-stream', signal: controller.signal, sink: { send() {} } });
  await ready;
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.terminalStatus, 'aborted');
  assert.deepEqual(aborted, ['cancel-stream']);
  const alreadyAborted = await executor.runTurn({ mode: 'project_agent', signal: controller.signal, sink: { send() {} } });
  assert.equal(alreadyAborted.terminalStatus, 'aborted');
  assert.deepEqual(aborted, ['cancel-stream']);
});

test('all executor roles share the cap; cancelled waiters never reach sendMessage and errors release leases', async () => {
  const gates=[]; const seen=[];
  const executor=createAgentTurnExecutor({llmChatService:{sendMessage(input) {
    seen.push(input.turnProfile.role); return new Promise((resolve,reject)=>gates.push({resolve,reject}));
  }}});
  executor.executionScheduler.configure({getConcurrency:()=>1});
  const sink={send(){}};
  const worker=executor.runTurn({turnProfile:{role:'work_session'},sink});
  await Promise.resolve();
  const controller=new AbortController();
  const cancelled=executor.runTurn({turnProfile:{role:'verifier'},sink,signal:controller.signal});
  const user=executor.runTurn({turnProfile:{role:'project_agent'},plan:{kind:'user'},sink});
  controller.abort(); assert.equal((await cancelled).terminalStatus,'aborted');
  assert.deepEqual(seen,['work_session']);
  const failure=assert.rejects(worker,/failed/);gates.shift().reject(Error('failed'));await failure;
  await Promise.resolve();assert.deepEqual(seen,['work_session','project_agent']);
  gates.shift().resolve({terminalStatus:'done'});await user;
  assert.deepEqual(executor.executionScheduler.stats(),{active:0,waiting:0,limit:1});
});

test('cancelling an active plan aborts the service and returns the shared lease', async () => {
  let ready; const started=new Promise(resolve=>{ready=resolve;}); let finish;
  const executor=createAgentTurnExecutor({llmChatService:{sendMessage(){ready();return new Promise(resolve=>{finish=resolve;});},
    abort(){finish({terminalStatus:'aborted'});}}});
  const turn=executor.runTurn({turnProfile:{role:'work_session',planId:'p'},sink:{send(){}}});
  await started;executor.executionScheduler.cancelPlan('p');
  assert.equal((await turn).terminalStatus,'aborted');assert.equal(executor.executionScheduler.stats().active,0);
});
