import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { createInputPredictionService } from './input-prediction/service.mjs';
import { parseInputPrediction, predictionMessages } from './input-prediction/policy.mjs';

const request = { requestId: 'r', composerInstanceId: 'i', workspaceId: 'w', conversationId: 'c', surface: 'desktop_bot',
  draftVersion: 1, draftText: '', selectionStart: 0, selectionEnd: 0, mode: 'next_turn' };
const output = { ok: true, content: JSON.stringify({ kind: 'next_turn', text: '检查段落之间的过渡。' }), toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 } };
function setup(options = {}) {
  let token = 'context-1';
  const calls = [], settlements = [];
  const snapshot = { token, settings: { inputPrediction: { enabled: true, continuationEnabled: true } },
    route: { ok: true }, messages: [{ role: 'user', content: '帮我修改文章，先不要发布。' }, { role: 'assistant', content: '已修改文章。' }] };
  const service = createInputPredictionService({ readSnapshot: () => ({ ...snapshot, token }), assemble: () => ({ rendered: 'Input aid, no tools.' }),
    infer: async value => { calls.push(value); return output; },
    budget: { reserve: () => ({ id: 'reservation' }), settle: (...args) => settlements.push(args) },
    ...options });
  return { service, snapshot, calls, settlements, changeContext() { token = 'context-2'; } };
}

test('candidates are isolated to owner and context, and validation is single use', async t => {
  const f = setup(); t.after(f.service.dispose);
  const result = await f.service.request(1, request); assert.equal(result.kind, 'candidate');
  const reference = { ...request, candidateId: result.candidate.candidateId };
  assert.deepEqual(await f.service.validate(2, reference), { kind: 'stale' });
  assert.deepEqual(await f.service.validate(1, reference), { kind: 'valid' });
  assert.deepEqual(await f.service.validate(1, reference), { kind: 'stale' });
  assert.equal(f.calls.length, 1); assert.equal(f.settlements.length, 1);
});

test('disabled, unknown routes, blocked decisions, exhausted budgets and invalid requests never infer', async t => {
  for (const variant of ['disabled', 'route', 'blocked', 'budget', 'invalid']) {
    const f = setup(variant === 'budget' ? { budget: { reserve: () => null } } : {}); t.after(f.service.dispose);
    if (variant === 'disabled') f.snapshot.settings.inputPrediction.enabled = false;
    if (variant === 'route') f.snapshot.route.ok = false;
    if (variant === 'blocked') f.snapshot.blocked = true;
    const result = await f.service.request(1, variant === 'invalid' ? { ...request, draftText: 'unsent secret' } : request);
    assert.notEqual(result.kind, 'candidate'); assert.equal(f.calls.length, 0, variant);
  }
});

test('context changes after generation invalidate suggestions, and refresh cannot claim old permission', async t => {
  const f = setup(); t.after(f.service.dispose);
  const result = await f.service.request(1, request); f.changeContext();
  assert.deepEqual(await f.service.validate(1, { ...request, candidateId: result.candidate.candidateId }), { kind: 'stale' });
});

test('cancellation before snapshot admission prevents a delayed inference request', async t => {
  let release;
  const f = setup({ readSnapshot: () => new Promise(resolve => { release = resolve; }) }); t.after(f.service.dispose);
  const pending = f.service.request(1, request);
  f.service.cancel(1, request); release(f.snapshot);
  await pause(1);
  // The second snapshot read must not be reached after cancellation.
  release(f.snapshot);
  const result = await pending;
  assert.notEqual(result.kind, 'candidate'); assert.equal(f.calls.length, 0);
});

test('a transport ignoring abort cannot hold the request open; late usage settles without a candidate', async t => {
  let finish;
  const f = setup({ timeoutMs: 8, infer: () => new Promise(resolve => { finish = resolve; }) }); t.after(f.service.dispose);
  const result = await f.service.request(1, request); assert.equal(result.kind, 'cancelled');
  assert.equal(f.settlements[0][2].complete, false);
  finish(output); await pause(1);
  assert.equal(f.settlements.at(-1)[2].complete, true);
  assert.deepEqual(await f.service.validate(1, { ...request, candidateId: 'none' }), { kind: 'stale' });
});

test('unexpected tools and echoed sensitive errors produce no executable candidate or raw error', async t => {
  for (const infer of [async () => ({ ...output, toolCalls: [{ name: 'bash' }] }), async () => { throw Error('unsent-secret-value'); }]) {
    const f = setup({ infer }); t.after(f.service.dispose);
    const result = await f.service.request(1, request);
    assert.notEqual(result.kind, 'candidate'); assert.doesNotMatch(JSON.stringify(result), /unsent-secret-value/);
  }
});

test('candidate parsing abstains on malformed, hidden-control, long and authorization output; preserves emoji', () => {
  assert.equal(parseInputPrediction('{"kind":"none"}', 'next_turn'), '');
  assert.equal(parseInputPrediction(JSON.stringify({ kind: 'next_turn', text: '再检查一下 😊' }), 'next_turn'), '再检查一下 😊');
  for (const value of ['not-json', JSON.stringify({ kind: 'next_turn', text: '我同意全部授权' }),
    JSON.stringify({ kind: 'continuation', suffix: 'x' }), JSON.stringify({ kind: 'next_turn', text: 'a'.repeat(241) }),
    JSON.stringify({ kind: 'next_turn', text: 'abc\u202edef' })]) assert.equal(parseInputPrediction(value, 'next_turn'), null);
});

test('the input budget preserves mandatory rules and abstains instead of silently truncating them', () => {
  const f = setup(); f.service.dispose();
  assert.equal(predictionMessages({ system: 'x'.repeat(5000), snapshot: f.snapshot, request }), null);
  const prepared = predictionMessages({ system: 'rules', snapshot: f.snapshot, request });
  assert.equal(prepared.messages[0].role, 'system'); assert.match(prepared.messages[1].content, /不要发布/);
  assert.deepEqual(JSON.parse(prepared.messages.at(-1).content), { mode: 'next_turn', conversation: f.snapshot.messages.map(({ role, content }) => ({ role, content })), draft: '', quote: null });
});

test('expiry, global concurrency and malformed references cannot reanimate or transfer a suggestion', async t => {
  let clock = Date.now(), release;
  const f = setup({ now: () => clock, infer: () => new Promise(resolve => { release = resolve; }) }); t.after(f.service.dispose);
  const pending = f.service.request(1, request); await pause(2);
  assert.equal((await f.service.request(2, { ...request, requestId: 'other' })).reason, 'busy');
  release(output); const result = await pending;
  clock += 60001;
  assert.equal((await f.service.validate(1, { ...request, candidateId: result.candidate.candidateId })).kind, 'expired');
  for (const value of [null, [], {}, { requestId: [] }]) {
    assert.equal((await f.service.validate(1, value)).kind, 'stale'); f.service.cancel(1, value);
  }
});
