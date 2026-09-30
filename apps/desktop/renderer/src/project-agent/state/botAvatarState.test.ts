import assert from 'node:assert/strict';
import test from 'node:test';
import { botAvatarMood } from './botAvatarState.ts';

const idle = { needsYou: 0, unread: 0, running: 0 };

test('头像表情按真实代理状态与需要用户处理投影', () => {
  assert.equal(botAvatarMood(idle), 'idle');
  assert.equal(botAvatarMood({ ...idle, running: 1 }), 'working');
  assert.equal(botAvatarMood({ ...idle, agentStatus: 'thinking' }), 'thinking');
  assert.equal(botAvatarMood({ ...idle, agentStatus: 'waiting_provider' }), 'waiting_provider');
  assert.equal(botAvatarMood({ ...idle, agentStatus: 'error' }), 'error');
  assert.equal(botAvatarMood({ ...idle, agentStatus: 'thinking', needsYou: 1 }), 'needs_you');
  assert.equal(botAvatarMood({ ...idle, running: 2, agentStatus: 'idle' }), 'working');
});
