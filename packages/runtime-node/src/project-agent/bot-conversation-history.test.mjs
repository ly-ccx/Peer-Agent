import test from 'node:test';
import assert from 'node:assert/strict';
import { dispositionEventsFromToolCalls } from '@peer-agent/protocol';
import { projectBotConversationHistory, createBotConversationHistory } from './bot-conversation-history.mjs';

test('presentation history retains truthful dispatch badges without execution payloads', () => {
  const calls = [
    { name: 'spawn_session', input: { title: 'parallel', private: 'private prompt' }, result: { sessionId: 's1', status: 'running', private: 'large evidence' } },
    { name: 'spawn_session', input: { dependsOn: ['s1'], title: 'queued' }, result: { output: { sessionId: 's2', status: 'queued', private: 'large evidence' } } },
    { name: 'spawn_session', input: { supersedes: 's1' }, result: { sessionId: 's3' } },
    { name: 'message_session', input: { intent: 'amend', sessionId: 's3', text: 'private prompt' }, result: { ok: true } },
    { name: 'cancel_session', input: { sessionId: 's2', reason: 'user stop' }, result: { output: { ok: true, sessionId: 's2' } } },
    { name: 'cancel_session', input: { sessionId: 's3' }, result: { ok: false, error: 'denied' } },
    { name: 'spawn_session', input: {}, result: null },
    { name: 'read_file', input: { path: 'private path' }, result: { body: 'private file' } },
  ];
  const rows = projectBotConversationHistory({ messages: [{ id: 'reply', kind: 'agent_reply', content: 'public reply' },
    { id: 'turn', kind: 'agent_turn', userInputs: [{ inputId: 'user' }], dispositionCalls: [{ name: 'forged' }], rounds: [{ text: 'private thinking', toolCalls: calls }] }] });
  assert.equal(rows[0].content, 'public reply');
  const compact = rows[1];
  assert.equal(compact.rounds, undefined);
  assert.deepEqual(dispositionEventsFromToolCalls('user', compact.dispositionCalls), dispositionEventsFromToolCalls('user', calls));
  assert.equal(compact.dispositionCalls[0].input.title, 'parallel');
  assert.equal(compact.dispositionCalls.length, calls.length - 1);
  assert.ok(!JSON.stringify(rows).includes('private'));
  assert.ok(!JSON.stringify(rows).includes('forged'));
});

test('string-encoded disposition inputs and results use the same normalized result', () => {
  const call = { name: 'spawn_session', input: { dependsOn: ['s1'] }, result: { output: { sessionId: 's2', queued: true } } };
  const encoded = { ...call, input: JSON.stringify(call.input), result: JSON.stringify(call.result) };
  const rows = projectBotConversationHistory({ messages: [{ kind: 'agent_turn', rounds: [{ toolCalls: [encoded] }] }] });
  assert.deepEqual(dispositionEventsFromToolCalls('user', rows[0].dispositionCalls), dispositionEventsFromToolCalls('user', [call]));
});

test('compact conversation reader is an explicit projection; canonical history remains unchanged', () => {
  const original = { messages: [{ id: 'turn', kind: 'agent_turn', rounds: [{ text: 'execution source' }] }] };
  let projection;
  const read = createBotConversationHistory({ createHistoryProjection(fn) { projection = fn; return () => fn(original); } });
  assert.equal(read('c')[0].rounds, undefined);
  assert.equal(typeof projection, 'function');
  assert.equal(original.messages[0].rounds[0].text, 'execution source');
});


test('legacy malformed round entries remain unavailable facts rather than breaking chat presentation', () => {
  const rows = projectBotConversationHistory({messages:[{kind:'agent_turn',rounds:[null,{}, {toolCalls:{}}, {toolCalls:[null,{}]}]}]});
  assert.deepEqual(rows[0].dispositionCalls,[]);
});
