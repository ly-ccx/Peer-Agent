import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget, createWorkBudgetGuard } from './work-budget.mjs';
import { createReplyDelivery } from './reply-delivery.mjs';
function world(executeTurn, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'r88-flow-'));
  const inbox = createProjectInbox({ rootDir: root });
  const messages = [];
  const opts = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'test-owner' };
  const store = createWorkCoordinationStore(opts);
  const ports = { workspaceId: 'w', conversationId: 'c', inbox, coordinationStore: store,
    executeTurn, appendMessage: (_id, message) => messages.push(message), readMessages: () => messages,
    resolveModel: () => ({ modelProviderId: 'm' }), retryDelays: [], ...extra };
  let runner = createProjectAgentRunner(ports);
  return { root, inbox, messages, store, get runner() { return runner; }, restart() { runner.dispose(); runner = createProjectAgentRunner({ ...ports, coordinationStore: createWorkCoordinationStore(opts) }); },
    close() { runner.dispose(); rmSync(root, { recursive: true, force: true }); } };
}
const event = (id, kind, sessionId = 's') => ({ eventId: id, kind, sessionId, workspaceId: 'w', at: '2026-10-07T00:00:00Z', payload: {} });
test('routine events never call a model; completed result wakes once without fresh user input', async () => {
  let requests = 0;
  const env = world(async () => { requests++; return { toolCalls: [] }; });
  try {
    env.inbox.append('w', [event('started', 'session_started'), event('progress', 'progress')]);
    await env.runner.kick(); assert.equal(requests, 0);
    env.inbox.append('w', [event('done', 'result_ready')]);
    await env.runner.kick(); assert.equal(requests, 1);
    env.restart(); env.inbox.append('w', [event('done', 'result_ready')]);
    await env.runner.kick(); assert.equal(requests, 1);
  } finally { env.close(); }
});
test('more than twenty useful tools continue across slices and restart; native history stays private', async () => {
  let slice = 0;
  const env = world(async input => {
    const index = ++slice;
    if (index > 1) assert.equal(input.turnProfile.providerCheckpoint.messages[0].thinking, 'private');
    return index <= 3 ? { turnEnd: 'yielded', toolCalls: Array.from({ length: 9 }, (_, n) => ({ name: 'read_file', input: { path: `file-${index}-${n}` }, result: { content: `finding-${index}-${n}` } })),
      providerCheckpoint: { messages: [{ thinking: 'private' }] } } : { text: '看完了，共核对了 27 项。' };
  });
  try {
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '检查项目' }]);
    env.restart(); await env.runner.kick(); await env.runner.kick(); await env.runner.kick();
    assert.equal(slice, 4); assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 1);
    assert.equal(JSON.stringify(env.messages).includes('private'), false);
    assert.equal(Object.values(env.store.read().works)[0].state, 'delivered');
    await env.runner.kick(); assert.equal(slice, 4);
  } finally { env.close(); }
});
test('same facts with fresh UUIDs stop on the third slice across restart', async () => {
  let requests = 0;
  const env = world(async () => ({ turnEnd: 'yielded', toolCalls: [{ name: 'get_session', input: { sessionId: `id-${++requests}` }, result: JSON.stringify({ status: 'blocked', requestId: `uuid-${requests}`, updatedAt: Date.now() }) }], providerCheckpoint: {} }));
  try {
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '核对' }]);
    await env.runner.kick(); env.restart(); await env.runner.kick();
    assert.equal(requests, 3); assert.equal(Object.values(env.store.read().works)[0].state, 'blocked_system');
    await env.runner.kick(); assert.equal(requests, 3);
  } finally { env.close(); }
});
test('reordered and repeated observations cannot reset the no-progress guard', async () => {
  let requests = 0;
  const observations = [
    { name: 'read_file', input: { path: 'README.md' }, result: { content: 'unchanged' } },
    { name: 'get_session', input: { sessionId: 's' }, result: { status: 'blocked' } },
  ];
  const env = world(async () => {
    requests++;
    return { turnEnd: 'yielded', toolCalls: requests % 2 ? observations : [...observations].reverse().concat(observations), providerCheckpoint: {} };
  });
  try {
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '核对' }]);
    env.restart(); await env.runner.kick(); await env.runner.kick();
    assert.equal(requests, 3);
    assert.equal(Object.values(env.store.read().works)[0].state, 'blocked_system');
    await env.runner.kick(); assert.equal(requests, 3);
  } finally { env.close(); }
});
test('a new child result bypasses a failed parent attempt', async () => {
  let requests = 0;
  const env = world(async () => ++requests === 1 ? { ok: false, error: 'agent_loop_exhausted', retryable: false } : { toolCalls: [] });
  try {
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '检查' }]);
    env.inbox.append('w', [event('done', 'result_ready')]);
    await env.runner.kick(); assert.equal(requests, 2);
    assert.equal(env.store.pendingEvents().length, 0);
  } finally { env.close(); }
});
test('journal truncated tail has an audited recovery; protected checkpoints are immutable', () => {
  const env = world(async () => ({}));
  try {
    env.store.transfer([event('a', 'result_ready')]);
    const old = env.store.checkpoint('work', { native: 'first' });
    const fresh = env.store.checkpoint('work', { native: 'second' });
    assert.notEqual(old, fresh); assert.equal(env.store.readCheckpoint(old).native, 'first');
    assert.equal(statSync(path.join(env.root, 'w', 'checkpoints', old)).mode & 0o777, 0o600);
    appendFileSync(path.join(env.root, 'w', 'coordination.jsonl'), '{"kind":');
    assert.throws(() => env.store.read()); env.store.recover();
    assert.equal(env.store.pendingEvents()[0].eventId, 'a');
    assert.ok(env.store.read().lastRecovery.backup);
    assert.match(readFileSync(path.join(env.root, 'w', env.store.read().lastRecovery.backup), 'utf8'), /\{"kind":$/);
  } finally { env.close(); }
});
test('stale prepared reply is invalidated without signing a changed report', async () => {
  const env = world(async () => ({})); let signed = 0;
  try {
    env.store.append({ kind: 'reply_prepared', message: { id: 'r' } });
    await createReplyDelivery({ store: env.store, readMessages: () => [], appendMessage: () => assert.fail('must not append'),
      validate: () => false, accept: () => signed++ }).recover();
    assert.equal(signed, 0); assert.equal(env.store.read().deliveries.r.state, 'invalidated');
  } finally { env.close(); }
});
test('shared hard request/tool budgets survive restart, charge roles and keep unknown usage', () => {
  const env = world(async () => ({}));
  env.store.saveWork({ workId: 'work', state: 'runnable' });
  const release = registerWorkBudget('w', env.store, { maxModelRequests: 2, maxToolCalls: 1 });
  try {
    const parent = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
    const child = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'work_session' });
    parent.beforeRequest(); child.beforeRequest(); parent.beforeTool();
    assert.throws(() => child.beforeRequest(), /budget_limited/); assert.throws(() => child.beforeTool(), /budget_limited/);
    parent.finish({ totalTokens: 15 }); child.finish(undefined);
    const budget = env.store.read().works.work.budget;
    assert.equal(budget.modelRequests, 2); assert.equal(budget.tokens, 15); assert.equal(budget.unknownUsage, true);
    env.restart(); assert.equal(env.store.read().works.work.budget.modelRequests, 2);
  } finally { release(); env.close(); }
});

test('runner restarts only a prepared acceptance, with no new model request or duplicate reply', async () => {
  let requested=0,accepted=0;
  const env=world(async()=>{requested++;return{text:'已经看完了。'};},{onReplied:()=>{if(++accepted===1)throw Error('disk temporarily unavailable');}});
  try{
    await env.runner.enqueueUserInputs([{inputId:'i',text:'看项目'}]);
    assert.equal(requested,1);assert.equal(env.runner.hasContinuation(),true);
    env.restart();await env.runner.kick();
    assert.equal(requested,1);assert.equal(accepted,2);
    assert.equal(env.messages.filter(row=>row.kind==='agent_reply').length,1);
    assert.equal(Object.values(env.store.read().works)[0].state,'delivered');
    assert.equal(env.runner.hasContinuation(),false);
  }finally{env.close();}
});


test('a crash after delivered but before handled/work receipts never repeats cognition', async () => {
  let requests = 0;
  const env = world(async () => { requests++; return { text: '完成了。' }; });
  try {
    const save = env.store.saveWork;
    env.store.saveWork = work => {
      if (Object.values(env.store.read().deliveries).some(row => row.state === 'delivered')) throw Error('crash before work receipt');
      return save(work);
    };
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '查看项目' }]);
    assert.equal(Object.values(env.store.read().works)[0].state, 'runnable');
    env.restart(); await env.runner.kick();
    assert.equal(requests, 1);
    assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 1);
    assert.equal(Object.values(env.store.read().works)[0].state, 'delivered');
  } finally { env.close(); }
});


test('a dispatch without a paired native checkpoint blocks restart instead of repeating its side effect', () => {
  const env = world(async () => ({}));
  env.store.saveWork({ workId: 'work', state: 'runnable' });
  const release = registerWorkBudget('w', env.store);
  let nextRelease;
  try {
    const original = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
    original.beforeRequest(); original.beforeTool({ toolCallId: 'write-once', capabilityId: 'local.file.write' });
    release(); env.restart(); nextRelease = registerWorkBudget('w', env.store);
    const recovered = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
    assert.throws(() => recovered.beforeRequest(), /execution_outcome_unknown/);
    assert.equal(env.store.read().works.work.budget.toolCalls, 1);
    recovered.finish();
  } finally { nextRelease?.(); release(); env.close(); }
});

test('explicit retry transfers the persisted legacy wake batch before acknowledging it and settles activity', async () => {
  const env = world(async () => ({ toolCalls: [{ name: 'post_reply', input: { text: '重试完成。', replyTo: [] }, result: { ok: true } }] }));
  try {
    env.messages.push({ id: 'old', turnId: 'old', kind: 'agent_turn', turnKind: 'wake', userInputs: [], rounds: [],
      meta: { recovery: { throughSeq: 0, events: [event('old-result', 'session_verified')] } } });
    env.messages.push({ id: 'old-failed', turnId: 'old', kind: 'system_card', card: 'agent_unavailable',
      content: 'agent_tool_budget_exhausted' });
    env.restart();
    assert.equal(env.store.read().events['old-result'].handled, false);
    await env.runner.retry();
    assert.equal(env.runner.status(), 'idle');
    assert.equal(env.runner.activity().phase, 'done');
    assert.equal(env.store.read().events['old-result'].handled, true);
    assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 1);
  } finally { env.close(); }
});

test('a later result preserves the earlier report slice until both batches settle', async () => {
  let requests = 0;
  const env = world(async () => ++requests === 1
    ? { turnEnd: 'yielded', toolCalls: [{ name: 'get_session', input: { sessionId: 's' }, result: { status: 'result_ready' } }], providerCheckpoint: { messages: [] } }
    : { toolCalls: [{ name: 'post_reply', input: { text: '核对好了。', replyTo: [] }, result: { ok: true } }] },
  { resolveRoster: () => [{ sessionId: 's', status: 'result_ready', sourceRevision: 'r1' }] });
  try {
    env.inbox.append('w', [event('readable', 'report_available')]); await env.runner.kick();
    const initial = Object.values(env.store.read().works)[0];
    assert.deepEqual(initial.sessionIds, ['s']); assert.equal(initial.state, 'runnable');
    env.inbox.append('w', [event('verified', 'result_ready')]); await env.runner.kick();
    const works = Object.values(env.store.read().works);
    assert.equal(works.length, 2); assert.equal(works[0].workId, initial.workId);
    assert.ok(works.every(work => work.state === 'delivered'));
    assert.equal(env.runner.hasContinuation(), false);
    assert.equal(requests, 3);
    await env.runner.kick(); assert.equal(requests, 3);
  } finally { env.close(); }
});

test('a child question cannot park a yielded parent before the question reaches the main conversation', async () => {
  let requests = 0;
  const env = world(async () => ++requests === 1
    ? { turnEnd: 'yielded', toolCalls: [{ name: 'get_session', input: { sessionId: 's' }, result: { status: 'waiting_user', question: '使用可读记录，还是补充缺失记录？' } }], providerCheckpoint: { messages: [] } }
    : { toolCalls: [{ name: 'post_reply', input: { text: '有两条记录无法读取。使用可读记录，还是补充缺失记录？', replyTo: [] }, result: { ok: true } }] },
  { resolveRoster: () => [{ sessionId: 's', status: 'waiting_user', sourceRevision: 'r1' }] });
  try {
    env.inbox.append('w', [event('question', 'needs_user')]);
    await env.runner.kick();
    const work = Object.values(env.store.read().works)[0];
    assert.equal(work.state, 'runnable'); assert.equal(work.end, 'yielded');
    assert.equal(env.messages.some(row => row.card === 'agent_unavailable'), false);
    env.restart(); await env.runner.kick();
    assert.equal(requests, 2);
    assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 1);
    assert.equal(Object.values(env.store.read().works)[0].state, 'waiting_user');
    assert.equal(Object.values(env.store.read().works)[0].end, 'awaiting_user');
    await env.runner.kick(); assert.equal(requests, 2);
  } finally { env.close(); }
});


test('new result batches never overwrite a yielded result checkpoint; each survives restart and reports once', async () => {
  const seen = [];
  const env = world(async input => {
    const checkpoint = input.turnProfile.providerCheckpoint;
    const id = checkpoint?.result || input.plan.events[0].sessionId;
    seen.push([id, Boolean(checkpoint)]);
    if (!checkpoint) return { turnEnd: 'yielded', toolCalls: [{ name: 'get_session', input: { sessionId: id }, result: { status: 'result_ready', report: id } }], providerCheckpoint: { result: id } };
    return { toolCalls: [{ name: 'post_reply', input: { text: `${id} 已核对并交付。`, replyTo: [] }, result: { ok: true } }] };
  }, { resolveRoster: () => [{ sessionId: 'B', status: 'result_ready' }, { sessionId: 'C', status: 'result_ready' }] });
  try {
    env.inbox.append('w', [event('done-B', 'result_ready', 'B')]);
    await env.runner.kick();
    assert.equal(env.store.read().events['done-B'].handled, false);
    const first = Object.values(env.store.read().works)[0];
    env.inbox.append('w', [event('done-C', 'result_ready', 'C')]);
    await env.runner.kick();
    const works = Object.values(env.store.read().works);
    assert.equal(works.length, 2);
    assert.equal(env.store.read().works[first.workId].checkpointRef, first.checkpointRef);
    assert.equal(env.store.read().events['done-C'].handled, false);
    env.restart();
    await env.runner.kick();
    await env.runner.kick();
    assert.deepEqual(seen, [['B', false], ['C', false], ['B', true], ['C', true]]);
    assert.equal(env.store.read().events['done-B'].handled, true);
    assert.equal(env.store.read().events['done-C'].handled, true);
    assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 2);
    env.restart(); await env.runner.kick();
    assert.equal(seen.length, 4);
  } finally { env.close(); }
});
