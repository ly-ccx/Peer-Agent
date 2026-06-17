import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGoalModeDenial,
  evaluateGoalModeGate,
  resolveGoalPlanGate,
} from './goal-mode-gate.mjs';

describe('evaluateGoalModeGate', () => {
  it('does not gate non-goal modes', () => {
    const r = evaluateGoalModeGate({
      mode: 'chat',
      toolName: 'bash',
      riskLevel: 'L4_privileged',
      planGate: { hasPlan: false, hasApprovedPlan: false },
    });
    assert.equal(r.allowed, true);
  });

  it('always allows planning/interaction tools in goal mode without a plan', () => {
    for (const toolName of ['goal_create_plan', 'goal_update_task', 'request_user_input']) {
      const r = evaluateGoalModeGate({
        mode: 'goal',
        toolName,
        riskLevel: 'L2_local_write',
        planGate: { hasPlan: false, hasApprovedPlan: false },
      });
      assert.equal(r.allowed, true, `${toolName} should be allowed`);
    }
  });

  it('allows inert/read-only tools before approval', () => {
    for (const riskLevel of ['L0_inert', 'L1_local_read']) {
      const r = evaluateGoalModeGate({
        mode: 'goal',
        toolName: 'read_file',
        riskLevel,
        planGate: { hasPlan: false, hasApprovedPlan: false },
      });
      assert.equal(r.allowed, true, `${riskLevel} should be allowed`);
    }
  });

  it('blocks side-effecting tools when no plan exists', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      planGate: { hasPlan: false, hasApprovedPlan: false },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_plan_required');
  });

  it('blocks side-effecting tools when a plan exists but is not approved', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'bash',
      riskLevel: 'L4_privileged',
      planGate: { hasPlan: true, hasApprovedPlan: false },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_plan_not_approved');
  });

  it('allows side-effecting tools once a plan is approved', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
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
