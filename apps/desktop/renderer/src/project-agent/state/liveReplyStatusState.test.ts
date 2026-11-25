import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import type { ProjectAgentActivity, ProjectAgentToolActivity } from '@peer-agent/protocol';
import type { BotReplyRow } from './botReplyContinuity';
import {
  SLOW_TOOL_REVEAL_DELAY_MS,
  activeToolRevealPlan,
  stableReplyPresenceState,
} from './liveReplyStatusState.ts';

const zh = createI18n('zh-CN');
const en = createI18n('en-US');

const T0 = Date.parse('2026-11-25T15:00:00.000Z');
const isoAt = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const baseActivity: ProjectAgentActivity = {
  workspaceId: 'w',
  conversationId: 'c',
  turnId: 't',
  revision: 1,
  startedAt: isoAt(0),
  replyTo: ['input-1'],
  phase: 'thinking',
  replyText: '',
  segments: [],
};

function tool(
  id: string,
  name: string,
  status: ProjectAgentToolActivity['status'],
  startedOffsetMs: number,
  summary?: string,
): ProjectAgentToolActivity {
  return {
    kind: 'tool',
    id,
    name,
    status,
    startedAt: isoAt(startedOffsetMs),
    ...(summary ? { summary } : {}),
  };
}

function replyRow(activity: ProjectAgentActivity): BotReplyRow {
  return {
    type: 'reply',
    id: 'reply-1',
    replyTo: ['input-1'],
    aliases: ['t'],
    messages: [],
    paragraphs: [],
    activity,
  };
}

test('fast local tools under threshold never flash and advance monotonically with step count', () => {
  // 1. Initial thinking before any tool
  const initial = stableReplyPresenceState(replyRow(baseActivity), zh, T0 + 100);
  assert.equal(initial.label, '正在整理思路');
  assert.equal(initial.revealActiveTool, false);
  assert.equal(initial.waitMs, 0);

  // 2. Fast read_file running for 12ms (< 350ms): stays on thinking, schedules remaining wait
  const fastReadRunning = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'tool',
      segments: [tool('tc-1', 'read_file', 'running', 100, 'README.md')],
    }),
    zh,
    T0 + 112,
  );
  assert.equal(fastReadRunning.label, '正在整理思路');
  assert.equal(fastReadRunning.revealActiveTool, false);
  assert.equal(fastReadRunning.waitMs, SLOW_TOOL_REVEAL_DELAY_MS - 12);

  // 3. First tool finishes, second fast tool starts: monotonically shows 1 step done (no flash)
  const secondFastRunning = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'tool',
      segments: [
        tool('tc-1', 'read_file', 'done', 100, 'README.md'),
        tool('tc-2', 'search_files', 'running', 120, 'acp'),
      ],
    }),
    zh,
    T0 + 130,
  );
  assert.equal(secondFastRunning.label, '正在整理思路 · 已推进 1 步');
  assert.equal(secondFastRunning.revealActiveTool, false);

  // 4. All 5 fast tools complete and phase returns to thinking: stays at 5 steps instead of snapping back
  const afterFive = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'thinking',
      segments: [
        tool('tc-1', 'read_file', 'done', 100, 'a.md'),
        tool('tc-2', 'read_file', 'done', 105, 'b.md'),
        tool('tc-3', 'search_files', 'done', 110, 'acp'),
        tool('tc-4', 'list_files', 'done', 115, '.'),
        tool('tc-5', 'read_file', 'done', 120, 'c.md'),
      ],
    }),
    zh,
    T0 + 200,
  );
  assert.equal(afterFive.label, '正在整理思路 · 已推进 5 步');
  assert.equal(afterFive.waitMs, 0);

  const afterFiveEn = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'thinking',
      segments: [
        tool('tc-1', 'read_file', 'done', 100, 'a.md'),
        tool('tc-2', 'read_file', 'done', 105, 'b.md'),
      ],
    }),
    en,
    T0 + 200,
  );
  assert.equal(afterFiveEn.label, 'Thinking it through · 2 steps');
});

test('slow tools running past threshold reveal specific action and advance monotonically on finish', () => {
  const slowWebSearch = replyRow({
    ...baseActivity,
    phase: 'tool',
    segments: [
      tool('tc-1', 'read_file', 'done', 100, 'a.md'),
      tool('tc-2', 'web_search', 'running', 200, 'acp spec'),
    ],
  });

  // Before threshold (200ms elapsed): stays calm on 1 step progress
  const before = stableReplyPresenceState(slowWebSearch, zh, T0 + 400);
  assert.equal(before.label, '正在整理思路 · 已推进 1 步');
  assert.equal(before.revealActiveTool, false);
  assert.equal(before.waitMs, SLOW_TOOL_REVEAL_DELAY_MS - 200);

  // At/after threshold (350ms elapsed): reveals concrete slow tool caption
  const revealed = stableReplyPresenceState(slowWebSearch, zh, T0 + 200 + SLOW_TOOL_REVEAL_DELAY_MS);
  assert.equal(revealed.label, '正在联网搜索');
  assert.equal(revealed.revealActiveTool, true);
  assert.equal(revealed.waitMs, 0);

  // After slow tool completes: moves forward to 2 steps
  const finished = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'thinking',
      segments: [
        tool('tc-1', 'read_file', 'done', 100, 'a.md'),
        tool('tc-2', 'web_search', 'done', 200, 'acp spec'),
      ],
    }),
    zh,
    T0 + 2000,
  );
  assert.equal(finished.label, '正在整理思路 · 已推进 2 步');
});

test('permission, post_reply, and wait_for_sessions reveal immediately with zero delay', () => {
  const postReply = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'tool',
      segments: [tool('tc-reply', 'post_reply', 'running', 500)],
    }),
    zh,
    T0 + 501,
  );
  assert.equal(postReply.label, '正在整理回复');
  assert.equal(postReply.revealActiveTool, true);
  assert.equal(postReply.waitMs, 0);

  const waitSessions = stableReplyPresenceState(
    replyRow({
      ...baseActivity,
      phase: 'tool',
      segments: [tool('tc-wait', 'wait_for_sessions', 'running', 500)],
    }),
    zh,
    T0 + 501,
  );
  assert.equal(waitSessions.label, '等待子任务完成');
  assert.equal(waitSessions.revealActiveTool, true);
  assert.equal(waitSessions.waitMs, 0);

  const permPlan = activeToolRevealPlan(
    { ...baseActivity, phase: 'awaiting_permission', segments: [tool('tc-cmd', 'bash', 'running', 500)] },
    T0 + 501,
  );
  assert.equal(permPlan.waitMs, 0);
  const permState = stableReplyPresenceState(
    replyRow({ ...baseActivity, phase: 'awaiting_permission', segments: [tool('tc-cmd', 'bash', 'running', 500)] }),
    zh,
    T0 + 501,
  );
  assert.equal(permState.label, '等待你的授权');
});
