import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { visibleBotActivity } from '../state/botActivityState.ts';

test('quiet marker streaming has no visible text and leaves no finished bubble', () => {
  const activity: ProjectAgentActivity = {
    workspaceId: 'w', turnId: 'turn', conversationId: 'c', workId: 'work',
    revision: 0, startedAt: '2026-11-26T00:00:00Z', phase: 'responding',
    replyTo: [], segments: [], replyText: '',
  };
  for (const replyText of ['N', 'NO', 'NO_', 'NO_R', 'NO_RE', 'NO_REP', 'NO_REPL', 'NO_REPLY']) {
    const projected = visibleBotActivity({ ...activity, replyText }, []);
    assert.equal(projected?.replyText, '');
    assert.equal(projected?.phase, 'thinking');
  }
  assert.equal(visibleBotActivity({ ...activity, replyText: 'NO_REPLY NO_' }, [])?.replyText, '');
  assert.equal(visibleBotActivity({ ...activity, phase: 'done', replyText: '**NO_REPLY**.' }, []), null);
  assert.equal(visibleBotActivity({ ...activity, replyText: '请输出 `NO_REPLY`' }, [])?.replyText, '请输出 `NO_REPLY`');
});
