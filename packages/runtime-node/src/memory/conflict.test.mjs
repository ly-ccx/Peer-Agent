import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryConflictDecision } from './conflict.mjs';

const item = (id, extra = {}) => ({ id, workspaceId: 'w', scope: 'project', kind: 'fact', trust: 'verified', status: 'active',
  topicKey: 'test.command', topicValue: 'pnpm test', createdAt: '2026-10-01T00:00:00Z', ...extra });

test('conflict requires a shared single-value topic in the same scope', () => {
  const current = item('new');
  assert.deepEqual(memoryConflictDecision(current, [item('same', { text: 'other words' }),
    item('other', { workspaceId: 'other', topicValue: 'bun test' }), item('no-key', { topicKey: null, topicValue: 'bun test' }),
    item('forgotten', { status: 'forgotten', topicValue: 'bun test' })]), { replaceIds: [], conflictIds: [] });
});

test('new authoritative statements replace older claims; ambiguous contradictory values need a choice', () => {
  assert.deepEqual(memoryConflictDecision(item('new', { topicValue: 'bun test', createdAt: '2026-10-02T00:00:00Z' }), [item('old')]),
    { replaceIds: ['old'], conflictIds: [] });
  assert.deepEqual(memoryConflictDecision(item('new', { topicValue: 'bun test' }), [item('old')]), { replaceIds: [], conflictIds: ['old'] });
  assert.deepEqual(memoryConflictDecision(item('new', { scope: 'user', kind: 'preference', trust: 'inferred', topicValue: 'brief', createdAt: '2026-10-02T00:00:00Z' }),
    [item('old', { scope: 'user', kind: 'preference', trust: 'inferred', topicValue: 'detailed' })]), { replaceIds: [], conflictIds: ['old'] });
});
