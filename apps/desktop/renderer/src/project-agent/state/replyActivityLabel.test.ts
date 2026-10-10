import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import type { ProjectAgentActivity, ProjectAgentToolActivity } from '@peer-agent/protocol';
import { replyActivityLabel } from './replyActivityLabel.ts';

const zh = createI18n('zh-CN'), en = createI18n('en-US');
const base: ProjectAgentActivity = { workspaceId: 'w', conversationId: 'c', turnId: 't', revision: 1,
  startedAt: '2026-10-10T00:00:00Z', replyTo: [], phase: 'tool', replyText: '', segments: [] };
const tool = (name: string, status: ProjectAgentToolActivity['status'] = 'running', summary?: string): ProjectAgentToolActivity =>
  ({ kind: 'tool', id: name, name, status, summary });
const label = (segments: ProjectAgentActivity['segments'], phase = base.phase) => replyActivityLabel({ ...base, phase, segments }, zh);

test('activity distinguishes preparing, executing, and completed reads', () => {
  assert.equal(label([tool('read_file', 'preparing', '/Users/private/project/README.md')]), '准备阅读 README.md');
  assert.equal(label([tool('read_file', 'running', '/Users/private/project/README.md')]), '正在阅读 README.md');
  for (const status of ['done', 'error', 'stopped'] as const) {
    assert.equal(label([tool('read_file', status, 'README.md')]), '正在整理思路');
  }
});
test('uses the latest active operation without reusing a completed predecessor', () => {
  assert.equal(label([tool('read_file', 'done', 'README.md'), tool('list_sessions')]), '正在查看工作进展');
  assert.equal(label([tool('read_file'), tool('bash')]), '正在执行命令');
  assert.equal(label([tool('read_file'), { kind: 'text', id: 'public', text: 'PRIVATE_REASONING' }], 'thinking'), '正在整理思路');
  assert.equal(label([tool('read_file')], 'responding'), '正在整理回复');
});
test('only structured tool facts select action language', () => {
  const cases = [['search_files', '正在查找相关内容'], ['edit_file', '正在调整内容'], ['view_image', '正在查看图片'],
    ['verify_session', '正在核对结果'], ['spawn_session', '正在安排执行'], ['memory_search', '正在查阅项目记忆'],
    ['memory_remember', '正在更新项目记忆'], ['memory_forget', '正在更新项目记忆'], ['list_directory', '正在查看文件目录'],
    ['unrecognized_tool', '正在一点一点推进']] as const;
  for (const [name, expected] of cases) {
    assert.equal(label([tool(name)]), expected);
    assert.equal(label([tool(name, 'preparing')]), '正在准备下一步');
  }
});
test('file captions keep only bounded safe names, never paths or diagnostic text', () => {
  assert.equal(label([tool('read_file', 'running', 'C:\\private\\项目\\设计说明.md')]), '正在阅读 设计说明.md');
  for (const summary of ['token=[redacted]', '/private/[redacted].md', 'https://private.example/secret',
    '/private/file\nPRIVATE_TOKEN', '/private/\u202econfig.md', 'x'.repeat(161)]) {
    assert.equal(label([tool('read_file', 'running', summary)]), '正在阅读文件');
  }
  assert.equal(label([tool('bash', 'running', 'curl -H token=PRIVATE_PARAMETER')]), '正在执行命令');
});
test('terminal turns have no running message even with stale active tools', () => {
  for (const phase of ['done', 'error', 'stopped', 'disposed'] as const) assert.equal(label([tool('bash')], phase), null);
  assert.equal(replyActivityLabel(undefined, zh), null);
});
test('phase fallbacks do not manufacture execution and translations remain natural', () => {
  assert.equal(label([], 'waiting'), '正在准备下一步');
  assert.equal(label([], 'thinking'), '正在整理思路');
  assert.equal(label([], 'responding'), '正在整理回复');
  assert.equal(label([], 'settling'), '正在整理结果');
  assert.equal(replyActivityLabel({ ...base, segments: [tool('read_file', 'running', '/tmp/README.md')] }, en), 'Reading README.md');
});
