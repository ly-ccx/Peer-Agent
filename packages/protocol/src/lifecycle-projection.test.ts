import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSessionFacts } from './session-facts.ts';

test('compatibility facts preserve an unconsumed interruption before completed', () => {
  const interrupted = deriveSessionFacts({status:'completed', runnerStatus:'completed', interrupted:true});
  assert.equal(interrupted.status, 'paused');
  assert.equal(interrupted.needsUser, false);
});

test('an ended delegated failure belongs to the parent without reopening user pauses or unknown outcomes', () => {
  const snapshot: GoalPlanProjectionSnapshot = { conversationId: 'c', planId: 'p', title: 'Retained work', status: 'interrupted',
    runnerStatus: 'failed', interrupted: true, delegated: true };
  const facts = decideLifecycle(snapshot, { executionOwnership: 'ended' });
  assert.equal(facts.status, 'waiting_agent'); assert.equal(facts.needsUser, false);
  assert.equal(facts.actionRight, 'peer_advancing'); assert.equal(facts.nextAction, 'none');
  assert.equal(facts.statusLabel, '由主 Bot 跟进');
  assert.equal(deriveSessionFacts({ ...snapshot }).status, 'waiting_agent');
  assert.equal(decideLifecycle({ ...snapshot, delegated: false }).status, 'paused');
  assert.equal(decideLifecycle(snapshot, { phase: 'paused' }).status, 'paused');
  assert.equal(decideLifecycle({ ...snapshot, status: 'cancelled' }).status, 'cancelled');
  assert.equal(decideLifecycle(snapshot, { takeoverPhase: 'awaiting_outcome' }).status, 'awaiting_outcome');
  assert.equal(decideLifecycle(snapshot, { accepted: true }).status, 'accepted');
});

import {
  projectWorkSession,
  type WorkSessionConversationMeta,
} from './delegation.ts';
import {
  decideLifecycle,
  projectGoalPlan,
  type GoalPlanProjectionSnapshot,
} from './task-overview.ts';

/**
 * 回归矩阵 R1–R9（协议层）。
 * 修复前实际输出见 ADR 102 §1.2：completed + 持久化 runner=running 会得到
 * { status: 'running', statusLabel: '已完成', actionRight: 'terminal' }，
 * 即同一快照同时说"运行中"和"已完成"，且终态还带取消入口。
 */

const ORIGIN = {
  anchorMessageId: 'anchor',
  inputId: 'input-1',
  surface: 'desktop',
  memorySnapshotId: 'snap-1',
  depth: 1,
};

function snapshot(overrides: Partial<GoalPlanProjectionSnapshot> = {}): GoalPlanProjectionSnapshot {
  return {
    conversationId: 'conv-1',
    title: '任务',
    planId: 'plan-1',
    status: 'completed',
    updatedAt: '2026-09-26T01:00:00.000Z',
    ...overrides,
  } as GoalPlanProjectionSnapshot;
}

function meta(overrides: Record<string, unknown> = {}): WorkSessionConversationMeta {
  return {
    workspaceId: 'ws-1',
    origin: ORIGIN as WorkSessionConversationMeta['origin'],
    spawnedAt: '2026-09-26T00:30:00.000Z',
    acceptance: 'confirm',
    accepted: false,
    ...overrides,
  } as unknown as WorkSessionConversationMeta;
}

test('R1 计划已结束但本进程仍有活执行：运行中 + 可取消，绝不显示已完成', () => {
  const plan = snapshot({
    runnerStatus: 'running',
    executionOwnership: 'live',
    accepted: false,
  });
  const session = projectWorkSession(plan, meta({ executionOwnership: 'live', accepted: false }));

  assert.equal(session.status, 'running');
  assert.equal(session.statusLabel, 'Peer 正在推进');
  assert.equal(session.actionRight, 'peer_advancing');
  assert.equal(session.nextAction, 'none');
  assert.equal(session.cancelable, true);
});

test('R2 重启遗留的 runner.running 不是活体：不再投影运行中，也没有取消入口', () => {
  const plan = snapshot({
    runnerStatus: 'running',
    executionOwnership: 'unknown',
    accepted: false,
  });
  const session = projectWorkSession(plan, meta({ executionOwnership: 'unknown', accepted: false }));

  assert.notEqual(session.status, 'running');
  assert.equal(session.status, 'result_ready');
  assert.equal(session.cancelable, false);
  // 既有产品契约（rule 6）：计划 completed 的展示结论仍是已完成/终态，不被未知 token 推翻。
  assert.equal(session.actionRight, 'terminal');

  const item = projectGoalPlan(plan);
  assert.equal(item.actionRight, 'terminal');
  assert.equal(item.cancelable, false);
});

test('R4 核验进行中优先于活执行：verifying，不能 accepted', () => {
  const plan = snapshot({
    status: 'executing',
    runnerStatus: 'running',
    executionOwnership: 'live',
  });
  const session = projectWorkSession(
    plan,
    meta({ executionOwnership: 'live', verifying: true, accepted: false }),
  );

  assert.equal(session.status, 'verifying');
  assert.equal(session.actionRight, 'peer_advancing');
  assert.equal(session.cancelable, true);
});

test('R6 替换受阻但旧执行仍活：按运行中判定，不因 goalRevision 增长伪造停止或完成', () => {
  const plan = snapshot({
    runnerStatus: 'running',
    executionOwnership: 'live',
    accepted: false,
  });
  const session = projectWorkSession(
    plan,
    meta({
      executionOwnership: 'live',
      accepted: false,
      coordination: { phase: 'blocked' },
    }),
  );

  assert.equal(session.status, 'running');
  assert.notEqual(session.actionRight, 'terminal');
  assert.equal(session.cancelable, true);
});

test('R6b 等父代理的技术阻塞不是人类决定', () => {
  const plan = snapshot({
    status: 'executing',
    runnerStatus: 'blocked',
    agentWaiting: true,
  });
  const session = projectWorkSession(plan, meta({}));

  assert.equal(session.status, 'waiting_agent');
  assert.notEqual(session.actionRight, 'needs_you');
  // 未完成的技术阻塞仍可取消（评审 Q4：保留合法取消），但它不是人类待办。
  assert.equal(session.cancelable, true);
  assert.equal(decideLifecycle(plan).needsUser, false);
});

test('R3a 计划已完成 + 未消费的 waiting_user：问题优先于 completed（协议契约）', () => {
  const plan = snapshot({
    status: 'completed',
    runnerStatus: 'waiting_user',
    executionOwnership: 'unknown',
    accepted: true,
  });
  const item = projectGoalPlan(plan);

  // ADR 100：request_user_input 是当前行动权事实，旧记录里 completed 先落盘也不能吞掉问题。
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
  assert.notEqual(item.statusLabel, '已完成');
});

test('R3b 计划已完成 + 真实活体 waiting_user：仍然需要人来回答', () => {
  const plan = snapshot({
    status: 'completed',
    runnerStatus: 'waiting_user',
    executionOwnership: 'live',
    accepted: false,
  });
  const session = projectWorkSession(plan, meta({ executionOwnership: 'live', accepted: false }));

  assert.equal(session.status, 'waiting_user');
  assert.equal(session.actionRight, 'needs_you');
  assert.equal(session.cancelable, true);
});

test('R7 同一事实快照幂等，且任务卡与会话投影字段一致', () => {
  const plan = snapshot({
    runnerStatus: 'running',
    executionOwnership: 'live',
    accepted: false,
  });

  assert.deepEqual(decideLifecycle(plan), decideLifecycle(plan));

  const session = projectWorkSession(plan, meta({ executionOwnership: 'live', accepted: false }));
  const item = projectGoalPlan(plan);
  const decision = decideLifecycle(plan);

  assert.equal(session.status, decision.status);
  assert.equal(session.statusLabel, item.statusLabel);
  assert.equal(session.actionRight, item.actionRight);
  assert.equal(session.nextAction, item.nextAction);
  assert.equal(session.cancelable, item.cancelable);
});

test('R8 已验收终态不可取消，展示已完成', () => {
  const session = projectWorkSession(snapshot({ accepted: true }), meta({ accepted: true }));

  assert.equal(session.status, 'accepted');
  assert.equal(session.statusLabel, '已完成');
  assert.equal(session.actionRight, 'terminal');
  assert.equal(session.cancelable, false);
});

test('R9 历史非委派 completed 无验收字段：既有完成契约不退化', () => {
  const item = projectGoalPlan(snapshot({ accepted: true }));

  assert.equal(item.statusLabel, '已完成');
  assert.equal(item.actionRight, 'terminal');
  assert.equal(item.cancelable, false);
});

type FiveFields = {
  readonly status: string;
  readonly statusLabel: string;
  readonly actionRight: string;
  readonly nextAction: string;
  readonly cancelable?: boolean;
};

function five(fields: FiveFields): FiveFields & { readonly cancelable: boolean } {
  return {
    status: fields.status,
    statusLabel: fields.statusLabel,
    actionRight: fields.actionRight,
    nextAction: fields.nextAction,
    cancelable: fields.cancelable === true,
  };
}

/** ADR 102 §4 的最小不变量：五个字段必须落在同一行语义上。 */
function assertCoherent(fields: FiveFields): void {
  const terminalStatuses = new Set(['accepted', 'failed', 'cancelled', 'superseded', 'result_ready']);
  if (fields.actionRight === 'terminal') {
    assert.equal(terminalStatuses.has(fields.status), true, `${fields.status} 不配 terminal`);
  }
  if (['running', 'starting', 'verifying'].includes(fields.status)) {
    assert.equal(fields.actionRight, 'peer_advancing', `${fields.status} 必须 peer_advancing`);
  }
  if (fields.actionRight === 'peer_advancing') {
    assert.notEqual(fields.statusLabel, '已完成');
  }
  if (fields.cancelable) {
    assert.notEqual(fields.actionRight, 'terminal', 'terminal 不能可取消');
  } else {
    assert.equal(
      ['accepted', 'failed', 'cancelled', 'superseded', 'result_ready', 'stopping', 'awaiting_outcome'].includes(fields.status),
      true,
      `${fields.status} 不在不可取消集合内却被判不可取消`,
    );
  }
}

test('R10 计划已完成但核验进行中：状态、文案、行动权同源为核验', () => {
  const plan = snapshot({
    status: 'completed',
    executionOwnership: 'ended',
    accepted: false,
  });
  const session = projectWorkSession(
    plan,
    meta({ executionOwnership: 'ended', verifying: true, accepted: false }),
  );
  const decision = decideLifecycle(plan, {
    executionOwnership: 'ended',
    verificationActive: true,
  });

  for (const projected of [session, decision]) {
    assert.equal(projected.status, 'verifying');
    assert.equal(projected.statusLabel, '核验中');
    assert.equal(projected.actionRight, 'peer_advancing');
    assert.equal(projected.nextAction, 'none');
    assert.equal(projected.cancelable, true);
    assertCoherent(five(projected));
  }
  // 核验 ≠ 完成：核验进行中不得继续宣称已完成。
  assert.notEqual(session.statusLabel, '已完成');
  assert.equal(five(session).statusLabel, five(decision).statusLabel);
});

test('R11 计划已完成但有未消费中断：中断优先于完成，不能冒充结果就绪', () => {
  const plan = snapshot({
    status: 'completed',
    interrupted: true,
    runnerStatus: 'running',
    executionOwnership: 'ended',
    accepted: false,
  });
  const item = projectGoalPlan(plan);
  const decision = decideLifecycle(plan, { executionOwnership: 'ended' });
  const session = projectWorkSession(
    plan,
    meta({ executionOwnership: 'ended', accepted: false }),
  );

  for (const projected of [decision, session]) {
    assert.equal(projected.status, 'paused');
    assert.equal(projected.statusLabel, '执行中断');
    assert.equal(projected.actionRight, 'paused');
    assert.equal(projected.nextAction, 'resume');
    assert.equal(projected.cancelable, true);
    assertCoherent(five(projected));
  }
  // 任务卡没有 status 字段，只能核对用户可见四字段；它必须与决策同源。
  assert.equal(item.statusLabel, '执行中断');
  assert.equal(item.actionRight, 'paused');
  assert.equal(item.nextAction, 'resume');
  assert.equal(item.cancelable, true);
});

test('R12 执行已结束但残留持久化 running：不冒充活体，也不冒充已完成可操作', () => {
  const plan = snapshot({
    status: 'completed',
    runnerStatus: 'running',
    executionOwnership: 'ended',
    accepted: false,
  });
  const item = projectGoalPlan(plan);
  const decision = decideLifecycle(plan, { executionOwnership: 'ended' });
  const session = projectWorkSession(
    plan,
    meta({ executionOwnership: 'ended', accepted: false }),
  );

  for (const projected of [decision, session]) {
    assert.equal(projected.status, 'result_ready');
    assert.equal(projected.statusLabel, '已完成');
    assert.equal(projected.actionRight, 'terminal');
    assert.equal(projected.nextAction, 'none');
    assert.equal(projected.cancelable, false);
    assertCoherent(five(projected));
  }
  assert.equal(decision.status, 'result_ready');
  assert.equal(item.statusLabel, '已完成');
  assert.equal(item.actionRight, 'terminal');
  assert.equal(item.nextAction, 'none');
  assert.equal(item.cancelable, false);
});

test('R13 委派计划已完成但无验收事实：停在等待验收，而不是已完成', () => {
  const plan = snapshot({
    status: 'completed',
    delegated: true,
    executionOwnership: 'ended',
    accepted: false,
  });
  const item = projectGoalPlan(plan);
  const decision = decideLifecycle(plan, { executionOwnership: 'ended', delegated: true });
  const session = projectWorkSession(plan, meta({ executionOwnership: 'ended' }));

  for (const projected of [decision, session]) {
    assert.equal(projected.status, 'result_ready');
    assert.equal(projected.statusLabel, '等待验收');
    assert.equal(projected.actionRight, 'result_ready');
    assert.equal(projected.nextAction, 'review_result');
    assert.equal(projected.cancelable, false);
    assertCoherent(five(projected));
  }
  // 任务卡四字段与决策同源；完成 ≠ 已验收。
  assert.equal(item.statusLabel, '等待验收');
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.nextAction, 'review_result');
  assert.equal(item.cancelable, false);
  // 验收只能来自真实验收事实，不能被投影制造。
  assert.notEqual(session.status, 'accepted');
});

test('R14 预算耗尽：真实人类决策门，状态不得同时宣称运行中', () => {
  // 真实 runtime 事实：needsUser 不含 budget_exhausted（session-facts.mjs），
  // 只有 runner.status 这一个来源，所以状态与行动权必须由同一判定推出来。
  const plan = snapshot({
    status: 'executing',
    runnerStatus: 'budget_exhausted',
    executionOwnership: 'ended',
  });
  const item = projectGoalPlan(plan);
  const decision = decideLifecycle(plan, { executionOwnership: 'ended' });
  const session = projectWorkSession(plan, meta({ executionOwnership: 'ended', accepted: false }));

  for (const projected of [decision, session]) {
    assert.equal(projected.status, 'waiting_user');
    assert.equal(projected.statusLabel, '预算已耗尽');
    assert.equal(projected.actionRight, 'needs_you');
    assert.equal(projected.nextAction, 'decide_blocked');
    // 预算/范围是真实人类决策，不能因为"还在跑"就变成 Peer 自己推进。
    assert.equal(projected.cancelable, true);
    assertCoherent(five(projected));
  }
  // 任务卡四字段与决策同源。
  assert.equal(item.statusLabel, '预算已耗尽');
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.nextAction, 'decide_blocked');
  // 预算门不可被"运行中"吞掉，也不可被伪造成已完成。
  assert.notEqual(decision.status, 'running');
  assert.notEqual(session.status, 'accepted');
});

test('R15 计划已 completed + 预算耗尽：五字段必须同源为人类决策，不能是「已完成」', () => {
  // 真实反例（独立核验，不是网络失败）：plan.status=completed、delegated=true、
  // runner.status=budget_exhausted、executionOwnership=unknown。
  // 修复前：status=waiting_user，但 statusLabel='已完成' / actionRight='terminal' /
  // nextAction='none' / cancelable=false —— 同一行既说需要你决定又说已完成。
  for (const ownership of ['unknown', 'ended'] as const) {
    const plan = snapshot({
      status: 'completed',
      delegated: true,
      runnerStatus: 'budget_exhausted',
      executionOwnership: ownership,
      accepted: false,
    });
    const decision = decideLifecycle(plan, { executionOwnership: ownership, delegated: true });
    const session = projectWorkSession(
      plan,
      meta({ executionOwnership: ownership, accepted: false }),
    );
    const item = projectGoalPlan(plan);

    for (const projected of [decision, session]) {
      assert.equal(projected.status, 'waiting_user');
      assert.equal(projected.statusLabel, '预算已耗尽');
      assert.equal(projected.actionRight, 'needs_you');
      assert.equal(projected.nextAction, 'decide_blocked');
      assert.equal(projected.cancelable, true);
      assertCoherent(five(projected));
    }
    // 任务卡与决策同源：文案/行动权/下一步/按钮缺一即分叉。
    assert.equal(item.statusLabel, '预算已耗尽');
    assert.equal(item.actionRight, 'needs_you');
    assert.equal(item.nextAction, 'decide_blocked');
    assert.equal(item.cancelable, true);
    // 真实预算门不能把计划伪造成已验收。
    assert.notEqual(decision.status, 'accepted');
    assert.notEqual(decision.statusLabel, '已完成');
  }
});

test('R16 计划已 completed + 真实待确认事实：人类门不被 completed 吞掉', () => {
  // runtime 事实来自 session-facts.mjs 的 needsUser（不在 plan.status 里），
  // 所以旧规则表按 completed 命中 rule 16 先，会给出「已完成 / terminal」。
  const plan = snapshot({
    status: 'completed',
    delegated: true,
    executionOwnership: 'unknown',
    accepted: false,
  });
  const decision = decideLifecycle(plan, {
    executionOwnership: 'unknown',
    delegated: true,
    accepted: false,
    needsUser: true,
    phase: 'awaiting_approval',
  });

  assert.equal(decision.status, 'waiting_user');
  assert.equal(decision.statusLabel, '等待你的选择');
  assert.equal(decision.actionRight, 'needs_you');
  assert.equal(decision.nextAction, 'answer_question');
  assert.equal(decision.cancelable, true);
  assertCoherent(five(decision));
});

test('R17 计划已 completed + 技术阻塞残留：仍是父代理跟进项，不伪造人类门', () => {
  // 检查同类组合：技术阻塞（父代理/普通 blocked）是 Bot 的工作，不是人类待办。
  // 这里钉住决策层不变式：不论哪种所有权/父代理等待标记，
  // 技术残留都不得变成 needs_you，也不得凭空产生 needsUser / accepted。
  for (const ownership of ['unknown', 'ended'] as const) {
    const plan = snapshot({
      status: 'completed',
      delegated: true,
      runnerStatus: 'blocked',
      executionOwnership: ownership,
      accepted: false,
    });
    for (const decision of [
      decideLifecycle(plan, { executionOwnership: ownership }),
      decideLifecycle(plan, { executionOwnership: ownership, blockedReason: 'waiting_parent_agent' }),
    ]) {
      assert.notEqual(decision.actionRight, 'needs_you');
      assert.equal(decision.needsUser, false);
      assert.equal(decision.needsYouReason, undefined);
      // 技术残留不能把计划伪造成已验收。
      assert.notEqual(decision.status, 'accepted');
    }
  }
});

test('R18 预算门优先于父代理等待标记：人类决策不会被技术阻塞吞掉', () => {
  // 同一 runner 同时有预算耗尽和残留 agentWait 标记时，稳定排序必须选真实人类门。
  const plan = snapshot({
    status: 'completed',
    delegated: true,
    runnerStatus: 'budget_exhausted',
    executionOwnership: 'unknown',
    accepted: false,
  });
  const decision = decideLifecycle(plan, {
    executionOwnership: 'unknown',
    delegated: true,
    blockedReason: 'waiting_parent_agent',
  });

  assert.equal(decision.status, 'waiting_user');
  assert.equal(decision.statusLabel, '预算已耗尽');
  assert.equal(decision.actionRight, 'needs_you');
  assert.equal(decision.nextAction, 'decide_blocked');
  assert.equal(decision.cancelable, true);
  assertCoherent(five(decision));
});

test('R19 活体执行不吞真实人类门，也不放大技术阻塞', () => {
  // 活体 + 待确认：人必须能回答，不能被「运行中」盖住。
  const liveWithGate = snapshot({
    status: 'completed',
    delegated: true,
    executionOwnership: 'live',
    accepted: false,
  });
  const gateDecision = decideLifecycle(liveWithGate, {
    executionOwnership: 'live',
    delegated: true,
    needsUser: true,
  });
  assert.equal(gateDecision.status, 'waiting_user');
  assert.equal(gateDecision.actionRight, 'needs_you');
  assertCoherent(five(gateDecision));

  // 活体 + 父代理等待：技术阻塞不构成人类门，活流说明阻塞已过期。
  const liveWithBlock = snapshot({
    status: 'completed',
    delegated: true,
    executionOwnership: 'live',
    accepted: false,
  });
  const blockDecision = decideLifecycle(liveWithBlock, {
    executionOwnership: 'live',
    blockedReason: 'waiting_parent_agent',
  });
  assert.notEqual(blockDecision.actionRight, 'needs_you');
  assertCoherent(five(blockDecision));
});
