import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTurnExecutor } from './agent-turn-executor.mjs';
import { createBroadcastSink } from './turn-sinks.mjs';

test('project-agent failure retains request recovery facts from the stream beside completed tool results', async () => {
  const providerRecovery = { kind: 'response_headers_timeout', retryable: true, phase: 'response_headers', requestId: 'request-7', attempts: 4, maxAttempts: 4, exhausted: true, replaySafe: true };
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    input.webContents.send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'read', args: { path: 'report' } });
    input.webContents.send('chat:stream:tool-result', { toolCallId: 'read', result: '{"ok":true,"content":"saved"}' });
    input.webContents.send('chat:stream:error', { error: 'connect timeout after 20000ms (ConnectTimeoutError)', providerRecovery });
    return { terminalStatus: 'error', toolCallCount: 1 };
  } } });
  const outcome = await executor.runTurn({ mode: 'project_agent', sink: { send() {} } });
  assert.deepEqual(outcome.providerRecovery, providerRecovery);
  assert.deepEqual(outcome.toolCalls[0].result, { ok: true, content: 'saved' });
  assert.equal(outcome.retryable, false, 'request retries already belonged to the service');
});

test('project agent separates its scheduling slice from hard budget and preserves host tool timing', async () => {
  let request;
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    request = input;
    input.webContents.send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'read', startedAtMs: 1000, args: { path: 'report' } });
    input.webContents.send('chat:stream:tool-result', { toolCallId: 'read', startedAtMs: 1000, endedAtMs: 1250, result: '{"ok":true}' });
    input.webContents.send('chat:stream:error', { error: 'agent_tool_budget_exhausted' });
    return { terminalStatus: 'error', toolCallCount: 1 };
  } } });
  const result = await executor.runTurn({ mode: 'project_agent', limits: { maxRounds: 6, maxToolCalls: 12 }, remainingToolCalls: 2,
    roundIndex: 3, sink: { send() {} } });
  assert.equal(request.executionBudget.maxTurns, 2);
  assert.equal(request.executionBudget.sliceToolCalls, 2);
  assert.equal(request.executionBudget.maxToolCalls, Infinity);
  assert.equal(request.executionBudget.yieldAtTurnLimit, true);
  assert.equal(request.executionBudget.maxToolBatchCalls, 32);
  assert.equal(result.retryable, false);
  assert.equal(result.toolCalls[0].startedAtMs, 1000);
  assert.equal(result.toolCalls[0].endedAtMs, 1250);
  assert.deepEqual(result.toolCalls[0].result, { ok: true });
});

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
  let workerStarted,userStarted;
  const workerReady=new Promise(resolve=>{workerStarted=resolve;});
  const userReady=new Promise(resolve=>{userStarted=resolve;});
  const executor=createAgentTurnExecutor({llmChatService:{sendMessage(input) {
    seen.push(input.turnProfile.role);
    if(input.turnProfile.role==='work_session')workerStarted();else if(input.turnProfile.role==='project_agent')userStarted();
    return new Promise((resolve,reject)=>gates.push({resolve,reject}));
  }}});
  executor.executionScheduler.configure({getConcurrency:()=>1});
  const sink={send(){}};
  const worker=executor.runTurn({turnProfile:{role:'work_session'},sink});
  await workerReady;
  const controller=new AbortController();
  const cancelled=executor.runTurn({turnProfile:{role:'verifier'},sink,signal:controller.signal});
  const user=executor.runTurn({turnProfile:{role:'project_agent'},plan:{kind:'user'},sink});
  controller.abort(); assert.equal((await cancelled).terminalStatus,'aborted');
  assert.deepEqual(seen,['work_session']);
  const failure=assert.rejects(worker,/failed/);gates.shift().reject(Error('failed'));await failure;
  await userReady;assert.deepEqual(seen,['work_session','project_agent']);
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


test('frozen effort is passed to the existing chat service for bot and task turns', async () => {
  const calls = [];
  const executor = createAgentTurnExecutor({ llmChatService: { sendMessage: async input => { calls.push(input); return { terminalStatus: 'done' }; } } });
  for (const role of ['project_agent', 'session_worker', 'verifier']) {
    await executor.runTurn({ turnProfile: { role, modelSelection: { modelProviderId: 'm', reasoningEffort: 'max' } },
      modelProviderId: 'm', effort: 'default', sink: { send() {} } });
  }
  assert.deepEqual(calls.map(call => call.effort), ['max', 'max', 'max']);
  await executor.runTurn({ effort: 'low', sink: { send() {} } });
  assert.equal(calls.at(-1).effort, 'low');
});

test('a long validated reply uses the complete local execution receipt, never its clipped UI preview', async () => {
  const { finishAgentTurn, planAgentTurn } = await import('../../../../../packages/runtime-node/src/project-agent/agent-turn-plan.mjs');
  const { formatToolResultForStream } = await import('../chat-runtime/tool-orchestrator.mjs');
  const message = { id: 'reply:long:1', kind: 'agent_reply', role: 'assistant', content: '完整结论。'.repeat(1500),
    replyTo: ['input-i'], sources: ['real-session'], meta: { sessionStates: [{ sessionId: 'real-session', status: 'running', sourceRevision: 'actual', observationRevision: 'observed' }] } };
  const receipt = { ok: true, messageId: message.id, message, meta: message.meta };
  const output = JSON.stringify(receipt);
  const preview = formatToolResultForStream({ name: 'post_reply', args: {}, output });
  assert.ok(output.length > 4000); assert.ok(preview.length <= 4000); assert.equal(JSON.parse(preview).kind, 'truncated_tool_result_preview');
  const events = [];
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    input.webContents.send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'long', args: { text: 'model draft cannot replace host message' } });
    input.agentProgress.onToolExecution({ call: { toolCallId: 'long', capabilityId: 'local.delegation.post_reply' },
      grant: { toolCallId: 'long', granted: true }, result: { toolCallId: 'long', status: 'success', output: receipt } });
    input.webContents.send('chat:stream:tool-result', { toolCallId: 'long', result: preview });
    return { terminalStatus: 'done' };
  } } });
  const outcome = await executor.runTurn({ mode: 'project_agent', sink: { send: (channel, payload) => events.push({ channel, payload }) } });
  const finished = finishAgentTurn({ turnId: 'long', plan: planAgentTurn({ kind: 'user', userInputs: [{ inputId: 'i' }] }), rounds: [{ toolCalls: outcome.toolCalls }] });
  assert.equal(finished.failed, undefined); assert.equal(finished.replied, true);
  assert.equal(finished.messages.at(-1).content, message.content);
  assert.deepEqual(finished.messages.at(-1).meta.sessionStates, message.meta.sessionStates);
  assert.equal(events.at(-1).payload.result, preview, 'renderer still receives only the bounded preview');
});

for (const invalid of ['grant_denied', 'wrong_id', 'wrong_capability', 'failed_result']) test(`local control receipt cannot publish a reply with ${invalid}`, async () => {
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    input.webContents.send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'r', args: { text: 'untrusted' } });
    input.agentProgress.onToolExecution({ call: { toolCallId: invalid === 'wrong_id' ? 'foreign' : 'r', capabilityId: invalid === 'wrong_capability' ? 'local.file.read' : 'local.delegation.post_reply' },
      grant: { toolCallId: 'r', granted: invalid !== 'grant_denied' }, result: { toolCallId: 'r', status: invalid === 'failed_result' ? 'failed' : 'success', output: { ok: true, message: { kind: 'agent_reply', content: 'forged' } } } });
    input.webContents.send('chat:stream:tool-result', { toolCallId: 'r', result: '{"ok":false,"error":"denied"}' });
    return { terminalStatus: 'done' };
  } } });
  const result = await executor.runTurn({ mode: 'project_agent', sink: { send() {} } });
  const { acceptedReplyResult } = await import('../../../../../packages/runtime-node/src/project-agent/agent-turn-plan.mjs');
  assert.equal(acceptedReplyResult(result.toolCalls[0].result), false);
});

test('executor admits UI heartbeats before cognition and after settled accounting', async () => {
  let before=false,after=false;
  const executor=createAgentTurnExecutor({llmChatService:{async sendMessage(){assert.equal(before,true);setImmediate(()=>{after=true;});return{terminalStatus:'done',toolCallCount:0};}}});
  setImmediate(()=>{before=true;});
  await executor.runTurn({turnProfile:{role:'goal_runner'},sink:{send(){}}});
  assert.equal(after,true);
});
