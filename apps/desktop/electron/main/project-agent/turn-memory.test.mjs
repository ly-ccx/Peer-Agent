import assert from 'node:assert/strict';
import test from 'node:test';
import { noteTurnToolCall } from './turn-memory.mjs';

test('只在项目代理回合记录已完成的工具调用', () => {
  const quiet = {};
  noteTurnToolCall(quiet, { name: 'memory_remember', result: '{"ok":true,"id":"mem-1"}' });
  assert.equal(quiet.turnToolCalls, undefined);

  const turn = { turnToolCalls: [] };
  noteTurnToolCall(turn, { name: 'memory_remember', input: { text: '短' }, result: '{"ok":true,"id":"mem-1"}' });
  noteTurnToolCall(turn, { name: 'post_reply', result: '不是 JSON' });
  assert.equal(turn.turnToolCalls[0].result.id, 'mem-1');
  assert.equal(turn.turnToolCalls[1].result, '不是 JSON');
});
