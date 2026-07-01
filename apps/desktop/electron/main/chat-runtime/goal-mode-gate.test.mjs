import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGoalModeDenial,
  evaluateGoalModeGate,
  resolveGoalPlanGate,
} from './goal-mode-gate.mjs';

// wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档十一章）:审批门归 plan
// 模式独占;goal 是自驱目标模式,不施加「计划审批门」——有副作用能力由 Runner 托管、高风险
// 动作走逐动作 hooks 确认,故在本闸门直接放行。
describe('evaluateGoalModeGate', () => {
  it('does not gate chat mode', () => {
    const r = evaluateGoalModeGate({
      mode: 'chat',
      toolName: 'bash',
      riskLevel: 'L4_privileged',
      planGate: { hasPlan: false, hasApprovedPlan: false },
    });
    assert.equal(r.allowed, true);
  });

  it('does not gate goal mode (self-driven): side-effecting tools allowed without an approved plan', () => {
    for (const [toolName, riskLevel] of [
      ['write_file', 'L2_local_write'],
      ['bash', 'L4_privileged'],
    ]) {
      const r = evaluateGoalModeGate({
        mode: 'goal',
        toolName,
        riskLevel,
        planGate: { hasPlan: false, hasApprovedPlan: false },
      });
      assert.equal(r.allowed, true, `${toolName} should be allowed in goal mode`);
    }
  });

  it('always allows planning/interaction tools in plan mode without a plan', () => {
    for (const toolName of ['goal_create_plan', 'goal_update_task', 'request_user_input']) {
      const r = evaluateGoalModeGate({
        mode: 'plan',
        toolName,
        riskLevel: 'L2_local_write',
        planGate: { hasPlan: false, hasApprovedPlan: false },
      });
      assert.equal(r.allowed, true, `${toolName} should be allowed`);
    }
  });

  it('allows inert/read-only tools before approval in plan mode', () => {
    for (const riskLevel of ['L0_inert', 'L1_local_read']) {
      const r = evaluateGoalModeGate({
        mode: 'plan',
        toolName: 'read_file',
        riskLevel,
        planGate: { hasPlan: false, hasApprovedPlan: false },
      });
      assert.equal(r.allowed, true, `${riskLevel} should be allowed`);
    }
  });

  it('blocks side-effecting tools in plan mode when no plan exists', () => {
    const r = evaluateGoalModeGate({
      mode: 'plan',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      planGate: { hasPlan: false, hasApprovedPlan: false },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_plan_required');
  });

  it('blocks side-effecting tools in plan mode when a plan exists but is not approved', () => {
    const r = evaluateGoalModeGate({
      mode: 'plan',
      toolName: 'bash',
      riskLevel: 'L4_privileged',
      planGate: { hasPlan: true, hasApprovedPlan: false },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_plan_not_approved');
  });

  it('allows side-effecting tools in plan mode once a plan is approved', () => {
    const r = evaluateGoalModeGate({
      mode: 'plan',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      planGate: { hasPlan: true, hasApprovedPlan: true },
    });
    assert.equal(r.allowed, true);
  });
});

describe('resolveGoalPlanGate', () => {
  it('returns no-plan facts when conversationId is missing', () => {
    assert.deepEqual(resolveGoalPlanGate(null, {}), {
      hasPlan: false,
      hasApprovedPlan: false,
    });
  });

  it('reads plan facts from the store by conversation', () => {
    const fakeStore = {
      listPlansByConversation: (id) =>
        id === 'c1'
          ? [{ status: 'awaiting_approval' }, { status: 'approved' }]
          : [],
    };
    assert.deepEqual(resolveGoalPlanGate('c1', fakeStore), {
      hasPlan: true,
      hasApprovedPlan: true,
    });
    assert.deepEqual(resolveGoalPlanGate('c2', fakeStore), {
      hasPlan: false,
      hasApprovedPlan: false,
    });
  });

  it('treats only drafting/awaiting plans as not-yet-approved', () => {
    const fakeStore = {
      listPlansByConversation: () => [{ status: 'awaiting_approval' }],
    };
    assert.deepEqual(resolveGoalPlanGate('c1', fakeStore), {
      hasPlan: true,
      hasApprovedPlan: false,
    });
  });
});

describe('buildGoalModeDenial', () => {
  it('produces a structured, unsuccessful tool result', () => {
    const denial = buildGoalModeDenial({ name: 'write_file', reason: 'goal_plan_required', locale: 'zh-CN' });
    assert.equal(denial.success, false);
    assert.equal(denial.goalModeDenied, true);
    const parsed = JSON.parse(denial.output);
    assert.equal(parsed.kind, 'goal_mode_gate_denied');
    assert.equal(parsed.tool, 'write_file');
    assert.equal(parsed.reason, 'goal_plan_required');
  });
});
