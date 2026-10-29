import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport } from './session-report.mjs';

const session = { sessionId: 'session', status: 'waiting_user' };
const plan = { planId: 'plan', conversationId: 'worker', goal: 'Instructions, not findings',
  successCriteria: [{ kind: 'manual', description: 'Requirements, not findings' }], tasks: [] };

test('no result does not turn a task goal or acceptance criteria into findings', () => {
  const report = buildSessionReport(plan, session, { messages: [] });
  assert.equal(report.summary, '');
  assert.deepEqual(report.keyFindings, []);
  assert.equal(report.contentSource, undefined);
});

test('persisted final worker text is returned even when verification blocked the runner', () => {
  const fullReport = '只读熟悉完成。\n\n## 目录\napps: 桌面\n## 规则\nCapability Provider\n## 脚本\ndev/build/test\n## 提交\nabc123 修复';
  const history = { messages: [
    { id: 'brief', role: 'user', content: 'task' },
    { id: 'answer', role: 'assistant', interrupted: true, content: 'narration ' + fullReport,
      segments: [{ type: 'text', content: '先调查' }, { type: 'tool-call', result: 'tool secret' },
        { type: 'thinking', content: 'private reasoning' }, { type: 'text', content: fullReport }] },
    { id: 'correction', role: 'user', content: 'repeat the report' },
  ] };
  const report = buildSessionReport(plan, session, history);
  assert.equal(report.summary, fullReport);
  assert.equal(report.status, 'waiting_user');
  assert.deepEqual(report.contentSource, { kind: 'worker_message', conversationId: 'worker', messageId: 'answer', verification: 'unverified' });
  assert.equal(JSON.stringify(report).includes('private reasoning'), false);
  assert.equal(JSON.stringify(report).includes('tool secret'), false);
});

test('completed leaf results and indexed references remain separate from in-progress work', () => {
  const report = buildSessionReport({ ...plan, evidenceRefs: ['ev-1'],
    criterionResults: [{ evidenceRef: 'ev-1' }, { evidenceRef: 'ev-2' }],
    tasks: [{ status: 'completed', result: 'parent aggregate', subtasks: [
      { status: 'completed', result: 'HEAD agrees', evidenceRefs: ['ev-3'] },
      { status: 'executing', result: 'not done' },
    ] }],
  }, session, { messages: [{ role: 'assistant', _compaction: {}, content: 'continuity only' },
    { role: 'assistant', content: 'private', segments: [{ type: 'thinking', content: 'private' }] }] });
  assert.equal(report.summary, 'HEAD agrees');
  assert.deepEqual(report.keyFindings, ['HEAD agrees']);
  assert.deepEqual(report.evidenceRefs, ['ev-1', 'ev-2', 'ev-3']);
  assert.equal(report.contentSource.kind, 'task_results');
});
