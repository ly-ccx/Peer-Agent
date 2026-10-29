import assert from 'node:assert/strict';
import test from 'node:test';
import { decideFollowUp, decideLifecycle, type LifecycleFacts } from './task-overview.ts';

function followUp(
  status: string,
  facts: LifecycleFacts = {},
  ownership: 'live' | 'ended' | 'unknown' = 'ended',
) {
  return decideFollowUp({ status: status as never }, facts, ownership);
}

test('user withdrawal ends task responsibility without claiming an unknown historical outcome', () => {
 assert.deepEqual(followUp('cancelled',{cancellationPhase:'completed',cancellationDisposition:'user_withdrawn'},'unknown'),{
  owner:'none',inCurrentList:false,reason:'user_withdrawn',
 });
 assert.equal(followUp('cancelled',{cancellationPhase:'completed',cancellationDisposition:'user_withdrawn'},'live').inCurrentList,true);
 assert.equal(followUp('awaiting_outcome',{cancellationPhase:'awaiting_outcome',cancellationDisposition:'user_withdrawn'},'unknown').inCurrentList,true);
});

test('普通结果（技术门槛）仍由主 Bot 跟进，不显示需要用户确认', () => {
  assert.deepEqual(followUp('result_ready', { delegated: true, acceptance: 'auto' }), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'awaiting_acceptance_technical',
  });
});

test('只有宿主确认过的真实人工/策略门槛才换到用户', () => {
  // 宿主 close gate 已放行 → 真的需要用户确认。
  assert.deepEqual(followUp('result_ready', { delegated: true, humanGate: true }), {
    owner: 'user',
    inCurrentList: true,
    reason: 'awaiting_human_gate',
  });
  assert.equal(followUp('waiting_user').owner, 'user');
  assert.equal(followUp('waiting_user').inCurrentList, true);
});

test('验收模式常量 confirm 不等于人工门槛（宿主对全部会话都传 confirm）', () => {
  // 回归：projectWorkSession 的 acceptance 恒为 'confirm'，不得据此显示“需要你确认”。
  assert.deepEqual(followUp('result_ready', { delegated: true, acceptance: 'confirm' }), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'awaiting_acceptance_technical',
  });
});

test('真实人工门未放行（close gate 未过）由主 Bot 先补齐', () => {
  assert.equal(followUp('result_ready', { delegated: true, acceptance: 'confirm', humanGate: false }).owner, 'bot');
});

test('核验失败/缺证据保持 Bot 责任，不伪造 accepted', () => {
  const result = followUp('failed', { delegated: true });
  assert.deepEqual(result, { owner: 'bot', inCurrentList: true, reason: 'verification_failed' });
  assert.notEqual(result.reason, 'settled');
});

test('技术阻塞（父代理等待）留在 Bot 责任，不当人工门槛', () => {
  assert.deepEqual(followUp('waiting_agent'), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'technical_block',
  });
});

test('已被完成替换承接的旧阶段退出当前待办', () => {
  assert.deepEqual(followUp('superseded', { superseded: true }), {
    owner: 'none',
    inCurrentList: false,
    reason: 'superseded',
  });
  assert.deepEqual(followUp('running', { superseded: true }), {
    owner: 'none',
    inCurrentList: false,
    reason: 'superseded',
  });
});

test('替换尚未完成时后续阶段保留责任', () => {
  const old = followUp('superseded', { superseded: true });
  const successor = followUp('running', { delegated: true }, 'live');
  assert.equal(old.inCurrentList, false);
  assert.equal(successor.owner, 'bot');
  assert.equal(successor.inCurrentList, true);
});

test('用户停止只有已确认停止回执才退出列表', () => {
  assert.deepEqual(followUp('cancelled', { cancellationPhase: 'completed' }), {
    owner: 'none',
    inCurrentList: false,
    reason: 'stop_confirmed',
  });
});

test('未决停止回执仍在列表（不按文案推断已停止）', () => {
  for (const status of ['cancelled', 'stopping', 'awaiting_outcome']) {
    const result = followUp(status);
    assert.equal(result.owner, 'bot', status);
    assert.equal(result.reason, 'stop_unconfirmed', status);
    assert.equal(result.inCurrentList, true, status);
  }
  // 停止回执已完成但仍有活体执行：不许当已结束隐藏。
  assert.equal(followUp('cancelled', { cancellationPhase: 'completed' }, 'live').inCurrentList, true);
});

test('活动执行与核验不会误隐藏', () => {
  for (const status of ['running', 'starting', 'queued', 'verifying']) {
    const result = followUp(status, {}, 'live');
    assert.equal(result.owner, 'bot', status);
    assert.equal(result.inCurrentList, true, status);
  }
});

test('未知结果与事实缺失 fail closed', () => {
  for (const status of ['unknown_result_state', 'unknown']) {
    const result = followUp(status, { delegated: true });
    assert.deepEqual(result, { owner: 'bot', inCurrentList: true, reason: 'unknown_facts' }, status);
  }
});

test('真实签收事实退出当前列表，但不由状态文本冒充', () => {
  assert.equal(followUp('accepted').owner, 'none');
  assert.deepEqual(followUp('result_ready', { accepted: true }), {
    owner: 'none',
    inCurrentList: false,
    reason: 'settled',
  });
});

test('同一事实重放两次判定一致（重载投影稳定）', () => {
  const facts: LifecycleFacts = { delegated: true, acceptance: 'confirm' };
  assert.deepEqual(followUp('result_ready', facts), followUp('result_ready', facts));
  assert.deepEqual(followUp('cancelled'), followUp('cancelled'));
});

test('交叉事实：承接/签收不能盖掉活动执行', () => {
  // 旧阶段已被承接，但执行体仍在跑：先保留在当前列表，不许当“已结束”隐藏。
  assert.deepEqual(followUp('running', { superseded: true }, 'live'), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'live_execution',
  });
  assert.deepEqual(followUp('running', { accepted: true }, 'live'), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'live_execution',
  });
});

test('交叉事实：承接不能盖掉真实人工请求', () => {
  assert.deepEqual(followUp('waiting_user', { superseded: true }), {
    owner: 'user',
    inCurrentList: true,
    reason: 'human_request',
  });
  assert.deepEqual(followUp('result_ready', { superseded: true, humanGate: true }), {
    owner: 'user',
    inCurrentList: true,
    reason: 'awaiting_human_gate',
  });
});

test('交叉事实：历史签收不掩盖新的核验失败', () => {
  assert.deepEqual(followUp('failed', { accepted: true }), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'verification_failed',
  });
});

test('交叉事实：停止以回执为准，未知执行体不冒充结束', () => {
  // 回执 completed 由宿主在 abort + waitForIdle 之后写入：这是已确认停止。
  assert.deepEqual(followUp('cancelled', { cancellationPhase: 'completed' }, 'unknown'), {
    owner: 'none',
    inCurrentList: false,
    reason: 'stop_confirmed',
  });
  // 没有完成回执（含 awaiting_outcome）：执行体未知也留在列表，不能凭 unknown 当结束。
  assert.deepEqual(followUp('cancelled', {}, 'unknown'), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'stop_unconfirmed',
  });
  assert.deepEqual(followUp('awaiting_outcome', { cancellationPhase: 'awaiting_outcome' }, 'unknown'), {
    owner: 'bot',
    inCurrentList: true,
    reason: 'stop_unconfirmed',
  });
});

// Historical interruption and takeover remain evidence, not a new execution owner.
test('completed cancellation dominates stale recovery and takeover without hiding live execution', () => {
 for(const takeoverPhase of ['stopping','awaiting_outcome'] as const){
  const snapshot={planId:'withdrawn',title:'Withdrawn task',status:'interrupted' as const,runnerStatus:'paused' as const,interrupted:true};
  const facts:LifecycleFacts={delegated:true,cancellationPhase:'completed',cancellationDisposition:'user_withdrawn',takeoverPhase};
  for(const executionOwnership of ['ended','unknown'] as const){
   const row=decideLifecycle(snapshot,{...facts,executionOwnership});
   assert.equal(row.status,'cancelled');assert.equal(row.followUp.inCurrentList,false);
   assert.equal(row.followUp.reason,'user_withdrawn');assert.equal(row.cancelable,false);
  }
  assert.equal(decideLifecycle(snapshot,{...facts,executionOwnership:'live'}).followUp.inCurrentList,true);
 }
});
