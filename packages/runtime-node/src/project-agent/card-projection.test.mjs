import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCardProjection, projectCards } from './card-projection.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-08-cards-'));
}

function facts() {
  return {
    approvals: [
      { approvalId: 'ap-1', state: 'open', summary: '写文件', sessionId: 'sess-1' },
      { approvalId: 'ap-1', state: 'open', summary: '重复的同一事实' },
    ],
    questions: [{ sessionId: 'sess-1', questionId: 'q1', prompt: '用哪种方案', options: ['A', 'B'] }],
    confirmations: [{ sessionId: 'sess-1', summary: '结果待确认' }],
    readmeOffer: true,
    unavailable: { turnId: 'turn-1', reason: '超时' },
    cards: [{ type: 'approval', cardId: 'card:approval:forged' }],
    modelCards: [{ kind: 'confirm_result' }],
  };
}

test('同一事实只生成一张卡，重复投影得到相同 cardId', () => {
  const first = projectCards('ws-1', facts());
  const second = projectCards('ws-1', facts());
  assert.deepEqual(second, first);
  const ids = first.map((card) => card.cardId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    'card:agent_unavailable:turn-1',
    'card:approval:ap-1',
    'card:confirm_result:sess-1',
    'card:question:sess-1:q1',
    'card:readme_offer:ws-1',
  ]);
  assert.equal(first.find((card) => card.kind === 'approval').content, '写文件');
});

test('卡片动作通过统一应用服务通道', () => {
  const cards = Object.fromEntries(projectCards('ws-1', facts()).map((card) => [card.kind, card]));

  assert.deepEqual(cards.approval.actions, [
    {
      id: 'allow',
      channel: 'project-agent:decide-approval',
      payload: { approvalId: 'ap-1', decision: 'approve', duration: 'once' },
    },
    {
      id: 'allow_task',
      channel: 'project-agent:decide-approval',
      payload: { approvalId: 'ap-1', decision: 'approve', duration: 'task' },
    },
    {
      id: 'reject',
      channel: 'project-agent:decide-approval',
      payload: { approvalId: 'ap-1', decision: 'reject', duration: 'denied' },
    },
  ]);
  assert.deepEqual(cards.question.actions.map((item) => item.channel), [
    'project-agent:submit-input',
    'project-agent:submit-input',
  ]);
  assert.deepEqual(cards.question.actions[0].payload, {
    answerTo: 'card:question:sess-1:q1',
    text: 'A',
  });
  assert.equal(cards.confirm_result.actions[0].id, 'confirm');
  assert.equal(cards.confirm_result.actions[0].channel, 'project-agent:confirm-result');
  assert.deepEqual(cards.confirm_result.actions[0].payload, {
    sessionId: 'sess-1',
    cardId: 'card:confirm_result:sess-1',
    acceptedBy: 'user',
  });
  assert.equal(cards.agent_unavailable.content, '代理暂时不可用：超时');
  assert.equal(cards.agent_unavailable.actions[0].id, 'retry');
  assert.equal(cards.agent_unavailable.actions[0].channel, 'project-agent:retry');
  assert.equal(cards.readme_offer.actions[0].channel, 'project-agent:accept-readme');
});

test('宿主已经终态的事实直接投影为已解决，不必另写', () => {
  const root = tempRoot();
  try {
    const store = createCardProjection({ rootDir: root });
    const cards = store.project('ws-1', {
      approvals: [{ approvalId: 'ap-1', state: 'approved', summary: '写文件' }],
      questions: [{ sessionId: 'sess-1', questionId: 'q1', prompt: '用哪种方案', answered: true }],
      confirmations: [{ sessionId: 'sess-1', accepted: true }],
    });
    assert.deepEqual(cards.map((card) => [card.cardId, card.resolvedState, card.resolution.source]), [
      ['card:approval:ap-1', 'resolved', 'fact'],
      ['card:confirm_result:sess-1', 'resolved', 'fact'],
      ['card:question:sess-1:q1', 'resolved', 'fact'],
    ]);
    assert.deepEqual(cards.map((card) => card.actions), [[], [], []]);
    assert.equal(readdirSync(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('卡片解决后重开存储，事实仍在时状态还在', () => {
  const root = tempRoot();
  try {
    const first = createCardProjection({
      rootDir: root,
      now: () => new Date('2026-09-27T03:00:00.000Z'),
    });
    const open = first.project('ws-1', {
      approvals: [{ approvalId: 'ap-1', state: 'open', summary: '写文件' }],
    });
    assert.equal(open.length, 1);
    assert.equal(open[0].resolvedState, 'open');
    assert.equal(open[0].resolution, undefined);

    first.resolve('ws-1', open[0].cardId, { resolution: 'approved' });
    const lines = readFileSync(path.join(root, 'ws-1', 'cards.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const reopened = createCardProjection({ rootDir: root });
    const again = reopened.project('ws-1', {
      approvals: [{ approvalId: 'ap-1', state: 'open', summary: '写文件' }],
    });
    assert.equal(again.length, 1);
    assert.equal(again[0].cardId, 'card:approval:ap-1');
    assert.equal(again[0].resolvedState, 'resolved');
    assert.deepEqual(again[0].resolution, {
      source: 'store',
      state: 'approved',
      at: '2026-09-27T03:00:00.000Z',
    });
    assert.deepEqual(again[0].actions, []);
    assert.deepEqual(reopened.project('ws-1', {
      approvals: [{ approvalId: 'ap-1', state: 'open', summary: '写文件' }],
    }), again);

    reopened.resolve('ws-1', 'card:approval:ap-1', { resolvedState: 'open', resolution: 'reopened' });
    const stillOpen = reopened.project('ws-1', {
      approvals: [{ approvalId: 'ap-1', state: 'open', summary: '写文件' }],
    });
    assert.equal(stillOpen[0].resolvedState, 'open');
    const decided = reopened.project('ws-1', {
      approvals: [{ approvalId: 'ap-1', state: 'denied', summary: '写文件' }],
    });
    assert.equal(decided[0].resolvedState, 'resolved');
    assert.equal(decided[0].resolution.source, 'fact');
    assert.equal(decided[0].resolution.state, 'denied');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('批准、提问和计划批准各生成一张卡', () => {
  const cards = projectCards('ws-1', {
    approvals: [
      {
        approvalId: 'ap-1',
        state: 'open',
        summary: '写文件',
        capabilityId: 'local.file.write',
        riskLevel: 'L2_local_write',
        taskName: '修好登录',
        sessionId: 'sess-1',
      },
      {
        approvalId: 'plan:sess-2',
        kind: 'plan_approval',
        state: 'open',
        capabilityId: 'goal.plan',
        summary: '修好登录；登录请求返回成功',
        sessionId: 'sess-2',
        taskName: '修好登录',
      },
    ],
    questions: [{ sessionId: 'sess-1', questionId: 'q1', prompt: '用哪种方案', options: ['A', 'B'] }],
  });
  const byKind = Object.fromEntries(cards.map((card) => [card.kind, card]));
  assert.equal(byKind.approval.content, '写文件 · local.file.write · L2_local_write · 修好登录');
  assert.equal(byKind.approval.refs.capabilityId, 'local.file.write');
  assert.equal(byKind.approval.refs.taskName, '修好登录');
  assert.equal(byKind.question.kind, 'question');
  assert.match(byKind.plan_approval.content, /登录请求返回成功/);
  assert.equal(byKind.plan_approval.actions[0].payload.decision, 'approve');
  assert.equal(byKind.plan_approval.cardId, 'card:plan_approval:plan:sess-2');
});

test('stale 批准保留批准并继续，已拒绝的不再给按钮', () => {
  const cards = projectCards('ws-1', {
    approvals: [
      { approvalId: 'old', state: 'stale', summary: '执行命令', capabilityId: 'local.shell.exec' },
      { approvalId: 'done', state: 'denied', summary: '已经拒绝' },
    ],
  });
  const stale = cards.find((card) => card.cardId === 'card:approval:old');
  const denied = cards.find((card) => card.cardId === 'card:approval:done');
  assert.equal(stale.resolvedState, 'open');
  assert.deepEqual(stale.actions, [{
    id: 'continue',
    channel: 'project-agent:decide-approval',
    payload: { approvalId: 'old', decision: 'approve', duration: 'once' },
  }]);
  assert.equal(denied.resolvedState, 'resolved');
  assert.deepEqual(denied.actions, []);
});

test('非法 workspace 不写文件', () => {
  const root = tempRoot();
  try {
    const store = createCardProjection({ rootDir: root });
    assert.throws(() => store.project('..', facts()), /invalid_workspace/);
    assert.throws(() => store.resolve('ws/nested', 'card:approval:ap-1'), /invalid_workspace/);
    assert.throws(() => store.resolve('ws-1', 'bad\ncard'), /invalid_card/);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
