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

test('an old start time never overrides a real provider or tool stage', () => {
  assert.deepEqual(state({ activity }), { label: '等待模型响应', busy: true, refresh: false });
  assert.equal(state({ activity: { ...activity, phase: 'tool', segments: [
    { kind: 'tool', id: 'read', name: 'read_file', status: 'running', summary: 'README.md' },
  ] } }).label, '正在阅读 README.md');
});

test('public progress stays quiet while decisions and recovery remain visible', () => {
  const paragraphs = [{ id: 'public', text: '我先核对这份文件。' }];
  assert.deepEqual(state({ activity, paragraphs }), { label: null, busy: false, refresh: false });
  assert.equal(state({ activity: { ...activity, phase: 'awaiting_permission' }, paragraphs }).label, '等待你的授权');
  assert.equal(state({ activity: { ...activity, recovery: 'connection' }, paragraphs }).label, '正在恢复这次回复');
  assert.equal(state({ activity, stopping: true, paragraphs }).label, i18n.t('projectAgent.chat.stopping'));
});

test('receipt alone is not running cognition; refresh only reads current status', () => {
  const pending = { since: '2000-01-01T00:00:00Z', sending: false, restored: false };
  assert.deepEqual(state({ pending }), { label: '消息已收到，等待处理进展', busy: false, refresh: true });
  assert.deepEqual(state({ pending: { ...pending, sending: true } }), { label: i18n.t('projectAgent.chat.sending'), busy: true, refresh: false });
  assert.equal(state({ pending: { ...pending, restored: true } }).label, '尚未确认这条消息的回复状态');
  assert.equal(state({ pending: { ...pending, deliveryIssue: true } }).label, '消息已保存，后续处理尚未完成');
});

test('terminal activity stops the spinner and delivered cards own their feedback', () => {
  for (const [phase, key] of [['error', 'projectAgent.chat.reply.interrupted'], ['stopped', 'projectAgent.chat.stopped'],
    ['done', 'projectAgent.chat.reply.synchronizing']] as const) {
    assert.deepEqual(state({ activity: { ...activity, phase }, paragraphs: [{ id: 'p', text: '已生成内容' }] }),
      { label: i18n.t(key), busy: false, refresh: true });
  }
  const message = normalizeBotMessage({ id: 'failure', kind: 'system_card', content: '',
    cards: [{ cardId: 'failed', kind: 'agent_unavailable', content: '原始报错' }] })!;
  assert.deepEqual(state({ activity: { ...activity, phase: 'error' }, message }), { label: null, busy: false, refresh: false });
});
