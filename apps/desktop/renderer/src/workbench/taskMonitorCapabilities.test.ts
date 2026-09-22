import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMsg } from '../chat/state/types.ts';
import { projectUsedMonitorCapabilities } from './taskMonitorCapabilities.ts';

function message(tool: string, called: boolean): ChatMsg {
  return { role: 'assistant', content: tool, segments: called
    ? [{ type: 'tool-call', tool, toolCallId: 'call-1' }]
    : [{ type: 'text', content: tool }] } as ChatMsg;
}

for (const tool of ['skill__release-process', 'mcp__docs__search']) {
  for (const scope of ['current', 'other']) {
    for (const called of [false, true]) {
      test(`usage: ${tool}/${scope}/${called ? 'called' : 'not-called'}`, () => {
        const conversations = { current: [] as ChatMsg[], other: [] as ChatMsg[] };
        conversations[scope as keyof typeof conversations].push(message(tool, called));
        const names = projectUsedMonitorCapabilities(conversations.current);
        assert.equal(names.length, scope === 'current' && called ? 1 : 0);
      });
    }
  }
}

test('structured usage ignores prose, synthetic records, user messages, and ordinary tools', () => {
  const synthetic = message('skill__release-process', true);
  synthetic.segments = [{ type: 'tool-call', tool: 'skill__release-process', toolCallId: 'fake', synthetic: true }];
  assert.deepEqual(projectUsedMonitorCapabilities([
    message('skill__release-process', false), synthetic,
    { ...message('skill__release-process', true), role: 'user' }, message('bash', true),
  ]), []);
});

test('usage updates immediately, deduplicates calls, and clears with conversation messages', () => {
  const call = message('skill__release-process', true);
  assert.deepEqual(projectUsedMonitorCapabilities([]), []);
  assert.deepEqual(projectUsedMonitorCapabilities([call, call]), ['release-process']);
  assert.deepEqual(projectUsedMonitorCapabilities([]), []);
  assert.deepEqual(projectUsedMonitorCapabilities([message('mcp__docs__search', true)]), ['docs: search']);
});
