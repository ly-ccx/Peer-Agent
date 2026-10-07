import assert from 'node:assert/strict';
import test from 'node:test';
import { readRetryContinuity } from './retry-continuity.mjs';

test('retry excerpts bind one canonical turn and contain only actual tool results', () => {
  const messages = [{ id: 'selected', kind: 'agent_turn', rounds: [{ text: 'PRIVATE_THINKING', toolCalls: [
    { name: 'get_session', input: { sessionId: 's' }, result: { status: 'waiting_user', evidenceRefs: ['tool-result://actual'] } },
    { name: 'unexecuted', result: null },
  ] }] }, { id: 'other', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'wrong', result: 'unrelated' }] }] }];
  const snapshot = readRetryContinuity(messages, 'selected');
  assert.equal(snapshot.turnId, 'selected');
  assert.equal(snapshot.tools.length, 1);
  assert.match(snapshot.tools[0].resultPreview, /waiting_user/);
  assert.deepEqual(snapshot.tools[0].evidenceRefs, ['tool-result://actual']);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_THINKING|unexecuted|unrelated/);
  assert.equal(readRetryContinuity(messages, 'missing'), null);
});

test('retry payload bounds include serialized previews and reference overhead', () => {
  const snapshot = readRetryContinuity([{ id: 't', kind: 'agent_turn', rounds: [{ toolCalls: Array.from({ length: 30 }, (_, i) => ({
    name: `tool-${i}`, input: { path: 'x'.repeat(4000) }, result: { output: '\\"'.repeat(4000), evidenceRefs: ['tool-result://' + 'a'.repeat(400)] },
  })) }] }], 't');
  assert.ok(snapshot.tools.length <= 16);
  assert.ok(JSON.stringify(snapshot).length <= 12000);
  assert.ok(snapshot.tools.every(tool => tool.truncated));
});
