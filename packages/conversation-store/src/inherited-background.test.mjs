import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInheritedBackground } from './inherited-background.mjs';

const options = { expectedRevision: 3, capturedAt: '2026-09-06T10:00:00Z', runtimeState: { conversationId: 'p', contentRevision: 3, status: 'idle' } };
const make = (messages, extra = {}) => ({ conversationId: 'p', contentRevision: 3, messages, ...extra });
for (const compacted of [false, true]) {
  for (const running of [false, true]) {
    test(`background data: compacted=${compacted} x running=${running}`, () => {
      const rows = [{ id: 'u', role: 'user', content: 'old question' }];
      if (compacted) rows.push({ id: 's', role: 'user', content: 'summary', _compaction: { summary: 'summary' } });
      rows.push({ id: 'a', role: 'assistant', content: 'reply', thinking: 'private', permissions: ['approved'] });
      const input = make(rows);
      const runtimeState = { ...options.runtimeState, status: running ? 'running' : 'idle', activeMessageId: running ? 'a' : null };
      const result = buildInheritedBackground(input, { ...options, runtimeState });
      assert.deepEqual(result.entries.map((e) => e.sourceMessageId), [compacted ? 's' : 'u', ...running ? [] : ['a']]);
      assert.equal(result.status, compacted ? 'compacted' : 'full');
      assert.deepEqual(result.coveredMessageIds, compacted ? ['u'] : []);
      assert.equal(result.excludedFromMessageId, running ? 'a' : null);
      assert.equal(JSON.stringify(result).includes('private'), false);
      assert.equal(JSON.stringify(result).includes('approved'), false);
      rows[0].content = 'changed after capture';
      assert.equal(result.entries.some((e) => e.text.includes('changed')), false);
    });
  }
}

test('background omissions: tools and attachments are explicit, not replayed', () => {
  const result = buildInheritedBackground(make([
    { id: 'sys', role: 'system', content: 'privileged' },
    { id: 'u', role: 'user', content: 'question', attachments: [{ secret: true }] },
    { id: 'a', role: 'assistant', content: 'checking', tool_calls: [{ id: 'call' }] },
    { id: 't', role: 'tool', content: 'tool secret' },
  ]), options);
  assert.equal(result.status, 'partial');
  assert.equal(result.requiresMissingConfirmation, true);
  assert.equal(result.missingItems.length, 3);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('privileged'), false);
});

test('background budget never silently truncates', () => {
  const history = make([{ id: 'u', role: 'user', content: '😀😀' }]);
  assert.equal(buildInheritedBackground(history, { ...options, maxCharacters: 2 }).characterCount, 2);
  assert.throws(() => buildInheritedBackground(history, { ...options, maxCharacters: 1 }), { code: 'BACKGROUND_BUDGET_EXCEEDED' });
});

test('background refuses stale revision, unknown liveness and missing active target', () => {
  const history = make([]);
  assert.throws(() => buildInheritedBackground(history, { ...options, expectedRevision: 4 }), { code: 'BACKGROUND_VERSION_CHANGED' });
  assert.throws(() => buildInheritedBackground(history, { ...options, runtimeState: null }), { code: 'BACKGROUND_RUNTIME_UNCONFIRMED' });
  const runtimeState = { ...options.runtimeState, status: 'running', activeMessageId: 'a' };
  assert.throws(() => buildInheritedBackground(history, { ...options, runtimeState }), { code: 'BACKGROUND_RUNTIME_UNCONFIRMED' });
  assert.equal(buildInheritedBackground(make([], { excludedFromMessageId: 'a' }), { ...options, runtimeState }).excludedFromMessageId, 'a');
});
