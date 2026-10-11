import assert from 'node:assert/strict';
import test from 'node:test';

import { roundsForReply } from '../state/botConversationState.ts';
import { agentProcessEntries, toolPreviewText, toolStepStatus } from './agentProcess.ts';
import { normalizeBotMessage } from '../state/botConversationState.ts';

test('过程按回复 turnId 精确关联，包括回复先于 agent_turn 落库的顺序', () => {
  const old = normalizeBotMessage({ id: 'old', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'post_reply', input: { text: '旧回复' } }] }] })!;
  const reply = normalizeBotMessage({ id: 'new-reply', kind: 'agent_reply', turnId: 'new', content: '本轮回复' })!;
  const current = normalizeBotMessage({ id: 'new', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'list_sessions', result: { ok: true, sessions: [] } }] }] })!;
  assert.deepEqual(roundsForReply([old, reply, current], reply.id), current.rounds);
  assert.deepEqual(roundsForReply([old, reply], reply.id), []);
});

test('post_reply 显示发送操作，嵌套拒绝与静默不能显示为发送成功', () => {
  const entries = agentProcessEntries([{ text: '', toolCalls: [
    { name: 'post_reply', input: { text: '回复正文' }, result: { ok: true, output: { ok: true } } },
    { name: 'post_reply', input: {}, result: { ok: true, output: { ok: false, error: 'denied' } } },
    { name: 'post_reply', input: {}, result: { ok: true, output: { suppressed: true } } },
    { name: 'external_extension', input: {}, result: null },
  ] }]);
  assert.equal(entries[0]?.labelKey, 'projectAgent.process.reply');
  assert.deepEqual(entries.map(entry => entry.status), ['done', 'failed', 'suppressed', 'unknown']);
  assert.equal(entries[0]?.summary, '');
  assert.equal(entries[3]?.labelKey, 'projectAgent.process.tool');
});

test('代理过程只列出回复前面那一轮的工具调用和结果', () => {
  const rounds = [{
    text: '',
    toolCalls: [
      { name: 'get_verification_detail', input: { sessionId: 's-1' }, result: { outcome: 'passed' } },
    ],
  }];
  const messages = [
    { id: 'turn', kind: 'agent_turn', role: 'assistant', content: '', createdAt: '', replyTo: [], sources: [], marks: [], dispositions: [], rounds, meta: {}, proactive: false, cards: [], quoteRefs: [], separatorLabel: '' },
    { id: 'reply', kind: 'agent_reply', role: 'assistant', content: '好了', createdAt: '', replyTo: [], sources: [], marks: [], dispositions: [], rounds: [], meta: {}, proactive: false, cards: [], quoteRefs: [], separatorLabel: '' },
  ];
  assert.equal(roundsForReply(messages, 'reply'), rounds);
  const [entry] = agentProcessEntries(roundsForReply(messages, 'reply'));
  assert.equal(entry?.name, 'get_verification_detail');
  assert.deepEqual(JSON.parse(entry!.input), { sessionId: 's-1' });
  assert.deepEqual(JSON.parse(entry!.result), { outcome: 'passed' });
  assert.deepEqual(agentProcessEntries([]), []);
});


test('历史过程复用有界脱敏预览，保留事实状态且不泄露私有字段', () => {
  const entries = agentProcessEntries([{ text: '', toolCalls: Array.from({ length: 110 }, (_, index) => ({
    name: 'read_file', input: { path: 'README.md', token: 'PRIVATE_PARAMETER' },
    result: { ok: true, output: 'read-' + index + 'x'.repeat(5000), nested: { reasoning: 'PRIVATE_REASONING', apiKey: 'PRIVATE_KEY' } },
  })) }]);
  assert.equal(entries.length, 100);
  assert.ok(entries.reduce((sum, entry) => sum + entry.input.length + entry.result.length, 0) <= 32000);
  assert.equal(entries[0]?.status, 'done');
  assert.equal(entries[0]?.summary, 'README.md');
  assert.equal(entries[0]?.inputPreview.redacted, true);
  assert.equal(entries[0]?.resultPreview.redacted, true);
  assert.equal(entries[0]?.resultPreview.truncated, true);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_/);
  assert.equal(entries.at(-1)?.resultPreview.truncated, true);
});

test('取消时缺失的 read_file 结果不是字面量 null，真实失败仍显示未完成', () => {
  const [missing, failed] = agentProcessEntries([{ text: '', toolCalls: [
    { name: 'read_file', input: { path: 'apps/desktop/renderer/src/styles/inputs.css', start_line: 1, end_line: 95 }, result: null },
    { name: 'read_file', input: { path: 'README.md' }, result: { status: 'failed', reason: 'start_line_out_of_range' } },
  ] }]);
  assert.equal(missing?.status, 'unknown');
  assert.equal(missing?.result, '');
  assert.notEqual(missing?.result, 'null');
  assert.equal(missing?.input.includes('inputs.css'), true);
  assert.equal(toolStepStatus(missing!.status, missing!.resultPreview, 'error'), 'cancelled');
  assert.equal(toolStepStatus(missing!.status, missing!.resultPreview, 'stopped'), 'stopped');
  assert.equal(toolStepStatus('error', { text: '' }, 'error'), 'cancelled');
  assert.equal(toolStepStatus('stopped', undefined), 'stopped');
  assert.equal(toolStepStatus('running', undefined), 'running');
  assert.equal(failed?.status, 'failed');
  assert.equal(toolStepStatus(failed!.status, failed!.resultPreview, 'error'), 'failed');
  assert.match(failed!.result, /start_line_out_of_range/);
  assert.equal(toolPreviewText(missing!.resultPreview, { empty: '没有返回内容。', limit: '内容超出预览上限' }), '没有返回内容。');
  assert.equal(toolPreviewText({ text: '', truncated: true }, { empty: '没有返回内容。', limit: '内容超出预览上限' }), '内容超出预览上限');
  assert.equal(toolPreviewText(undefined, { empty: '没有返回内容。', limit: '内容超出预览上限' }), null);
});
