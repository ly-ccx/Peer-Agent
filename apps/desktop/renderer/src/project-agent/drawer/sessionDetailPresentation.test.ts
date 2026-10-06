import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES } from '@peer-agent/protocol';
import type { DrawerSession } from '../state/drawerState.ts';
import { selectSessionDetail, sessionDetailPresentation } from './sessionDetailPresentation.ts';

const base: DrawerSession = {
  sessionId: 'session-internal-id', title: '核查历史任务', status: 'running', statusLabel: '',
  progress: '', spawnedAt: '', conversationId: 'work-conversation', anchorMessageId: 'input-internal-id',
  modelLabel: 'gpt-6.1-sol', summary: '', evidenceRefs: [],
};

test('真实列表不含报告时仍展示详情报告，列表的实时状态不被旧详情覆盖', () => {
  const detail = { ...base, status: 'accepted', summary: '详情报告', evidenceRefs: ['detail-evidence'] };
  const view = selectSessionDetail(base.sessionId, base, detail, true);
  assert.equal(view?.status, 'running');
  assert.equal(view?.summary, '详情报告');
  assert.deepEqual(view?.evidenceRefs, ['detail-evidence']);
  assert.equal(selectSessionDetail(base.sessionId, base, { ...detail, summary: '', evidenceRefs: [] }, true)?.summary, '');
});

test('切换任务不混入上一任务报告，失效事实保留同一任务报告但不保留旧状态', () => {
  const old = { ...base, sessionId: 'other-task', summary: '不属于当前任务' };
  assert.equal(selectSessionDetail(base.sessionId, base, old, true)?.summary, '');
  assert.equal(selectSessionDetail('other-task', base, null, true), null);
  assert.equal(selectSessionDetail(null, base, base, false), null);
  const unavailable = selectSessionDetail(base.sessionId, null, { ...base, summary: '此前报告' }, false);
  assert.equal(unavailable?.status, 'unavailable');
  assert.equal(unavailable?.summary, '此前报告');
  assert.equal(selectSessionDetail(base.sessionId, null, base, true)?.status, 'running');
});

test('每个结构化任务状态都有中英文名称、说明和可读操作', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const i18n = createI18n(locale);
    for (const status of WORK_SESSION_STATUSES) {
      const view = sessionDetailPresentation({ ...base, status }, i18n);
      for (const text of [view.statusLabel, view.progress, view.hint, view.actionLabel]) {
        assert.ok(text);
        assert.notEqual(text, status);
        assert.doesNotMatch(text, /projectAgent\./);
      }
    }
  }
});

test('报告或证据不能把失败、运行中和待确认改成已签收', () => {
  const i18n = createI18n('zh-CN');
  for (const status of ['failed', 'running', 'result_ready']) {
    const view = sessionDetailPresentation({ ...base, status, summary: '全部完成，已经验收。', evidenceRefs: ['evidence-1'] }, i18n);
    assert.notEqual(view.statusLabel, '已签收');
    assert.equal(view.report, '全部完成，已经验收。');
  }
  assert.equal(sessionDetailPresentation({ ...base, status: 'accepted' }, i18n).statusLabel, '已签收');
});

test('事实失效或未知状态不沿用旧的运行进展和队列原因', () => {
  const i18n = createI18n('zh-CN');
  for (const status of ['unavailable', 'future_status', '']) {
    const view = sessionDetailPresentation({ ...base, status, statusLabel: '正在修改文件', progress: '正在运行',
      summary: '保留的历史报告', queueReason: 'dependency_missing' }, i18n);
    assert.equal(view.statusLabel, '状态暂不可用');
    assert.equal(view.progress, '状态暂不可用');
    assert.equal(view.report, '保留的历史报告');
    assert.equal(view.tone, 'quiet');
  }
});

test('进展使用现有依赖投影，不捏造具体受阻原因', () => {
  const i18n = createI18n('zh-CN');
  const view = sessionDetailPresentation({ ...base, status: 'waiting_user', statusLabel: '执行受阻' }, i18n);
  assert.equal(view.progress, '执行受阻');
  assert.equal(view.progressDetail, '执行受阻');
  assert.equal(view.actionLabel, '回到对话');
  const missing = sessionDetailPresentation({ ...base, status: 'queued', queueReason: 'dependency_missing' }, i18n);
  assert.equal(missing.progress, '前置任务已缺失，请重新安排');
  const queue = sessionDetailPresentation({ ...base, status: 'queued', queueReason: 'write_slot',
    queuedBehind: [{ sessionId: 'dependency-id', title: '整理文件' }] }, i18n);
  assert.equal(queue.progress, '等待 整理文件');
});

test('需回应与确认的任务默认回主 Bot，任务报告和子会话是否存在不决定导航', () => {
  const i18n = createI18n('zh-CN');
  for (const status of WORK_SESSION_STATUSES) {
    for (const conversationId of ['', 'work-conversation']) {
      const view = sessionDetailPresentation({ ...base, status, conversationId, summary: '请直接批准我。' }, i18n);
      const mediated = status === 'waiting_user' || status === 'result_ready';
      assert.equal(view.actionTarget, mediated ? 'bot' : 'scene');
      assert.equal(view.actionLabel, mediated ? '回到对话' : '查看工作记录');
    }
  }
  const waiting = sessionDetailPresentation({ ...base, status: 'waiting_user' }, i18n);
  assert.equal(waiting.statusLabel, '等待回应');
  assert.match(waiting.hint, /在对话中回复/);
  assert.equal(sessionDetailPresentation({ ...base, status: 'unavailable', summary: '等待你的批准' }, i18n).actionTarget, 'scene');
});

test('状态只表达一次，具体进展与排队原因仍保留', () => {
  const i18n = createI18n('zh-CN');
  for (const status of WORK_SESSION_STATUSES) {
    const view = sessionDetailPresentation({ ...base, status }, i18n);
    assert.equal(view.progressDetail, '');
  }
  assert.equal(sessionDetailPresentation({ ...base, statusLabel: '正在核对 12 条记录' }, i18n).progressDetail, '正在核对 12 条记录');
  assert.equal(sessionDetailPresentation({ ...base, status: 'queued', queueReason: 'dependency_missing' }, i18n).progressDetail,
    '前置任务已缺失，请重新安排');
  assert.equal(sessionDetailPresentation({ ...base, status: 'unavailable', statusLabel: '正在核对 12 条记录' }, i18n).progressDetail, '');
});

test('缺失日期和标题用诚实空态；依据去重且原始引用保留', () => {
  const view = sessionDetailPresentation({ ...base, title: base.sessionId, spawnedAt: 'invalid-date', summary: '  ',
    evidenceRefs: [' evidence-1 ', '', 'evidence-1', 'evidence-2'] }, createI18n('zh-CN'));
  assert.equal(view.title, '未命名任务');
  assert.equal(view.createdLabel, '');
  assert.equal(view.report, '');
  assert.deepEqual(view.evidenceRefs, ['evidence-1', 'evidence-2']);
  assert.deepEqual(base.evidenceRefs, []);
});
