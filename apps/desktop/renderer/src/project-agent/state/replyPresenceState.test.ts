import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import type { BotReplyRow } from './botReplyContinuity';
import { normalizeBotMessage } from './botConversationState.ts';
import { replyPresenceState } from './replyPresenceState.ts';

const i18n = createI18n('zh-CN');
const activity: ProjectAgentActivity = { workspaceId: 'w', conversationId: 'c', turnId: 't', revision: 1,
  startedAt: '2000-01-01T00:00:00Z', replyTo: ['input-i'], phase: 'waiting', replyText: '', segments: [] };
const row = (patch: Partial<BotReplyRow> = {}): BotReplyRow => ({ type: 'reply', id: 'reply:i',
  replyTo: ['input-i'], aliases: ['t'], messages: [], paragraphs: [], ...patch });
const state = (patch: Partial<BotReplyRow>) => replyPresenceState(row(patch), i18n);

test('normal provider and tool stages share a stable replying cue regardless of start time', () => {
  assert.deepEqual(state({ activity }), { label: '正在回复', busy: true, refresh: false, replying: true });
  assert.equal(state({ activity: { ...activity, phase: 'tool', segments: [
    { kind: 'tool', id: 'read', name: 'read_file', status: 'running', summary: 'README.md' },
  ] } }).label, '正在回复');
});

test('public progress keeps the replying cue while decisions and recovery retain their own labels', () => {
  const paragraphs = [{ id: 'public', text: '我先核对这份文件。' }];
  assert.deepEqual(state({ activity, paragraphs }), { label: '正在回复', busy: true, refresh: false, replying: true });
  assert.equal(state({ activity: { ...activity, phase: 'awaiting_permission' }, paragraphs }).label, '等待你的授权');
  assert.equal(state({ activity: { ...activity, recovery: 'connection' }, paragraphs }).label, '正在恢复这次回复');
  assert.equal(state({ activity, stopping: true, paragraphs }).label, i18n.t('projectAgent.chat.stopping'));
});

test('receipt alone is not running cognition; refresh only reads current status', () => {
  const pending = { since: '2000-01-01T00:00:00Z', sending: false, restored: false };
  assert.deepEqual(state({ pending }), { label: null, busy: false, refresh: false });
  assert.deepEqual(state({ pending: { ...pending, sending: true } }), { label: i18n.t('projectAgent.chat.sending'), busy: true, refresh: false });
  assert.equal(state({ pending: { ...pending, restored: true } }).label, '尚未确认这条消息的回复状态');
  assert.equal(state({ pending: { ...pending, deliveryIssue: true } }).label, '消息已保存，后续处理尚未完成');
  assert.deepEqual(state({ pending, paragraphs: [{ id: 'progress', text: '已开始核对。' }] }),
    { label: null, busy: false, refresh: false });
  assert.equal(state({ pending: { ...pending, restored: true }, paragraphs: [{ id: 'progress', text: '历史进展' }] }).label,
    '尚未确认这条消息的回复状态');
});

test('terminal activity stops the spinner and delivered cards own their feedback', () => {
  for (const [phase, key] of [['error', 'projectAgent.chat.reply.interrupted'], ['stopped', 'projectAgent.chat.stopped']] as const) {
    assert.deepEqual(state({ activity: { ...activity, phase }, paragraphs: [{ id: 'p', text: '已生成内容' }] }),
      { label: i18n.t(key), busy: false, refresh: true });
  }
  const message = normalizeBotMessage({ id: 'failure', kind: 'system_card', content: '',
    cards: [{ cardId: 'failed', kind: 'agent_unavailable', content: '原始报错' }] })!;
  assert.deepEqual(state({ activity: { ...activity, phase: 'error' }, message }), { label: null, busy: false, refresh: false });
});

test('finished execution keeps the same reply cue until the canonical message arrives without claiming live execution', () => {
  const done = { ...activity, phase: 'done' as const, replyText: '最终答复' };
  assert.deepEqual(state({ activity: done, paragraphs: [{ id: 'draft', text: '最终答复' }] }),
    { label: '正在回复', busy: false, refresh: false, replying: true });
  const message = normalizeBotMessage({ id: 'final', turnId: done.turnId, kind: 'agent_reply', content: done.replyText })!;
  assert.deepEqual(state({ activity: done, message }), { label: null, busy: false, refresh: false });
});
