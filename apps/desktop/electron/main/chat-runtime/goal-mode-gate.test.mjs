import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGoalModeDenial,
  detectIrreversibleAction,
  evaluateGoalModeGate,
  evaluateWriteScope,
  resolveActiveGoalExecutionBinding,
  resolveActivePlanBoundaries,
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
      intakeActive: false,
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
      intakeActive: false,
    });
    assert.deepEqual(resolveGoalPlanGate('c2', fakeStore), {
      hasPlan: false,
      hasApprovedPlan: false,
      intakeActive: false,
    });
  });

  it('treats only drafting/awaiting plans as not-yet-approved', () => {
    const fakeStore = {
      listPlansByConversation: () => [{ status: 'awaiting_approval' }],
    };
    assert.deepEqual(resolveGoalPlanGate('c1', fakeStore), {
      hasPlan: true,
      hasApprovedPlan: false,
      intakeActive: false,
    });
  });

  it('flags intakeActive when an active intake contract exists', () => {
    const fakeStore = {
      listPlansByConversation: () => [
        { status: 'executing', activation: { kind: 'intake' } },
      ],
    };
    const gate = resolveGoalPlanGate('c1', fakeStore);
    assert.equal(gate.intakeActive, true);
  });

  it('does not flag intakeActive for a terminal intake contract', () => {
    const fakeStore = {
      listPlansByConversation: () => [
        { status: 'cancelled', activation: { kind: 'intake' } },
      ],
    };
    const gate = resolveGoalPlanGate('c1', fakeStore);
    assert.equal(gate.intakeActive, false);
  });
});

// 方案乙 write-gate：intake 判别阶段禁止一切有副作用能力，只放行只读/提问/规划。
describe('evaluateGoalModeGate · intake write-gate', () => {
  it('blocks side-effecting tools during intake', () => {
    for (const [toolName, riskLevel] of [
      ['write_file', 'L2_local_write'],
      ['bash', 'L4_privileged'],
    ]) {
      const r = evaluateGoalModeGate({
        mode: 'goal',
        toolName,
        riskLevel,
        planGate: { hasPlan: true, hasApprovedPlan: false, intakeActive: true },
      });
      assert.equal(r.allowed, false, `${toolName} should be blocked during intake`);
      assert.equal(r.reason, 'goal_intake_write_blocked');
    }
  });

  it('still allows read-only and planning/interaction tools during intake', () => {
    const readOnly = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'read_file',
      riskLevel: 'L1_local_read',
      planGate: { hasPlan: true, hasApprovedPlan: false, intakeActive: true },
    });
    assert.equal(readOnly.allowed, true);
    for (const toolName of ['goal_create_plan', 'request_user_input']) {
      const r = evaluateGoalModeGate({
        mode: 'goal',
        toolName,
        riskLevel: 'L2_local_write',
        planGate: { hasPlan: true, hasApprovedPlan: false, intakeActive: true },
      });
      assert.equal(r.allowed, true, `${toolName} should be allowed during intake`);
    }
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

  it('carries an optional detail into the structured output', () => {
    const denial = buildGoalModeDenial({
      name: 'write_file',
      reason: 'goal_scope_out_of_workspace',
      locale: 'zh-CN',
      detail: '/etc/passwd',
    });
    const parsed = JSON.parse(denial.output);
    assert.equal(parsed.reason, 'goal_scope_out_of_workspace');
    assert.equal(parsed.detail, '/etc/passwd');
  });

  it('describes goal out-of-scope boundaries without reverting to plan wording', () => {
    const denial = buildGoalModeDenial({
      name: 'write_file',
      reason: 'goal_scope_out_of_bounds',
      locale: 'en-US',
    });
    assert.match(denial.output, /goal's out-of-scope boundary/);
    assert.doesNotMatch(denial.output, /plan's outOfScope boundary/);
  });
});

// ── Slice B：goal 模式确定性 hooks·阶段一（写盘范围守卫 + 不可逆动作确认） ──

describe('evaluateWriteScope', () => {
  const workspacePath = '/ws';

  it('allows writes inside the workspace', () => {
    const r = evaluateWriteScope({ args: { path: 'src/a.ts' }, workspacePath, boundaries: null });
    assert.equal(r.allowed, true);
  });

  it('allows absolute paths inside the workspace', () => {
    const r = evaluateWriteScope({ args: { path: '/ws/src/a.ts' }, workspacePath, boundaries: null });
    assert.equal(r.allowed, true);
  });

  it('allows writes outside the workspace (absolute) after path hard sandbox removal', () => {
    const r = evaluateWriteScope({ args: { path: '/etc/passwd' }, workspacePath, boundaries: null });
    assert.equal(r.allowed, true);
  });

  it('allows writes escaping the workspace via .. after path hard sandbox removal', () => {
    const r = evaluateWriteScope({ args: { path: '../outside/x.ts' }, workspacePath, boundaries: null });
    assert.equal(r.allowed, true);
  });

  it('allows writes inside a Goal target writable root outside the origin workspace', () => {
    const r = evaluateWriteScope({
      args: { path: '/repo/peer_agent/src/a.ts' },
      workspacePath: '/repo/peer-knowledge',
      writableRoots: ['/repo/peer_agent'],
      boundaries: null,
    });
    assert.equal(r.allowed, true);
  });

  it('allows writes outside both origin and Goal target writable roots (permission still applies)', () => {
    const r = evaluateWriteScope({
      args: { path: '/repo/other/src/a.ts' },
      workspacePath: '/repo/peer-knowledge',
      writableRoots: ['/repo/peer_agent'],
      boundaries: null,
    });
    assert.equal(r.allowed, true);
  });

  it('denies paths matching an outOfScope glob', () => {
    const r = evaluateWriteScope({
      args: { path: 'dist/bundle.js' },
      workspacePath,
      boundaries: { outOfScope: ['dist/*'] },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_scope_out_of_bounds');
  });

  it('denies paths matching an outOfScope path segment', () => {
    const r = evaluateWriteScope({
      args: { path: 'packages/secrets/key.pem' },
      workspacePath,
      boundaries: { outOfScope: ['secrets'] },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_scope_out_of_bounds');
  });

  it('ignores purely descriptive (non-path-like) outOfScope entries', () => {
    const r = evaluateWriteScope({
      args: { path: 'src/a.ts' },
      workspacePath,
      boundaries: { outOfScope: ['不改审批语义', 'do not touch chat mode'] },
    });
    assert.equal(r.allowed, true);
  });

  it('is permissive when no path is present', () => {
    assert.equal(evaluateWriteScope({ args: {}, workspacePath }).allowed, true);
  });

  it('requires confirmation when a write expands beyond path-like inScope', () => {
    const r = evaluateWriteScope({
      args: { path: 'tests/a.test.ts' },
      workspacePath,
      boundaries: { inScope: ['src/*'], outOfScope: [] },
    });
    assert.equal(r.allowed, true);
    assert.equal(r.requiresConfirmation, true);
    assert.equal(r.reason, 'goal_scope_expansion_confirmation');
  });

  it('does not require scope expansion confirmation for matching inScope paths', () => {
    const r = evaluateWriteScope({
      args: { path: 'src/a.ts' },
      workspacePath,
      boundaries: { inScope: ['src/*'], outOfScope: [] },
    });
    assert.equal(r.allowed, true);
    assert.notEqual(r.requiresConfirmation, true);
  });

  it('does not require scope expansion confirmation for descriptive inScope entries', () => {
    const r = evaluateWriteScope({
      args: { path: 'src/a.ts' },
      workspacePath,
      boundaries: { inScope: ['只改登录体验', 'do not change billing'], outOfScope: [] },
    });
    assert.equal(r.allowed, true);
    assert.notEqual(r.requiresConfirmation, true);
  });
});

describe('detectIrreversibleAction', () => {
  it('flags write_file overwrite', () => {
    const r = detectIrreversibleAction({ toolName: 'write_file', args: { path: 'a.ts', allow_overwrite: true } });
    assert.equal(r?.kind, 'file_overwrite');
  });

  it('does not flag a plain (non-overwrite) write_file', () => {
    assert.equal(detectIrreversibleAction({ toolName: 'write_file', args: { path: 'a.ts' } }), null);
  });

  it('flags rm -rf', () => {
    assert.equal(detectIrreversibleAction({ toolName: 'bash', args: { command: 'rm -rf build' } })?.kind, 'shell_delete');
  });

  it('flags git push', () => {
    assert.equal(detectIrreversibleAction({ toolName: 'bash', args: { command: 'git push origin main' } })?.kind, 'git_push');
  });

  it('flags git reset --hard', () => {
    assert.equal(detectIrreversibleAction({ toolName: 'bash', args: { command: 'git reset --hard HEAD~1' } })?.kind, 'git_reset_hard');
  });

  it('flags npm publish', () => {
    assert.equal(detectIrreversibleAction({ toolName: 'bash', args: { command: 'npm publish' } })?.kind, 'release_publish');
  });

  it('does not flag a benign read command', () => {
    assert.equal(detectIrreversibleAction({ toolName: 'bash', args: { command: 'ls -la && cat file' } }), null);
  });
});

describe('evaluateGoalModeGate (goal mode, Slice B)', () => {
  it('allows edit_file writing outside the workspace after path hard sandbox removal', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'edit_file',
      riskLevel: 'L2_local_write',
      args: { path: '/etc/hosts' },
      workspacePath: '/ws',
    });
    assert.equal(r.allowed, true);
  });

  it('denies write_file matching outOfScope boundary', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      args: { path: 'dist/x.js' },
      workspacePath: '/ws',
      boundaries: { outOfScope: ['dist/*'] },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'goal_scope_out_of_bounds');
  });

  it('allows in-scope write_file', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      args: { path: 'src/x.ts' },
      workspacePath: '/ws',
      boundaries: { outOfScope: ['dist/*'] },
    });
    assert.equal(r.allowed, true);
    assert.notEqual(r.requiresConfirmation, true);
  });

  it('requires confirmation for scope expansion inside the workspace', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      args: { path: 'tests/x.test.ts' },
      workspacePath: '/ws',
      boundaries: { inScope: ['src/*'], outOfScope: [] },
    });
    assert.equal(r.allowed, true);
    assert.equal(r.requiresConfirmation, true);
    assert.equal(r.confirmation?.kind, 'scope_expansion');
  });

  it('requires confirmation for an irreversible bash action', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'bash',
      riskLevel: 'L4_privileged',
      args: { command: 'git push origin dev' },
      workspacePath: '/ws',
    });
    assert.equal(r.allowed, true);
    assert.equal(r.requiresConfirmation, true);
    assert.equal(r.confirmation?.kind, 'git_push');
  });

  it('requires confirmation for high-risk non-irreversible actions', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'bash',
      riskLevel: 'L4_privileged',
      args: { command: 'node build.js' },
      workspacePath: '/ws',
    });
    assert.equal(r.allowed, true);
    assert.equal(r.requiresConfirmation, true);
    assert.equal(r.confirmation?.kind, 'high_risk');
    assert.equal(r.confirmation?.reason, 'goal_high_risk_confirmation');
  });

  it('does not require high-risk confirmation for medium-risk side effects', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
      args: { path: 'src/x.ts' },
      workspacePath: '/ws',
    });
    assert.equal(r.allowed, true);
    assert.notEqual(r.requiresConfirmation, true);
  });

  it('allows read-only tools without confirmation', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'read_file',
      riskLevel: 'L1_local_read',
      args: { path: '/etc/hosts' },
      workspacePath: '/ws',
    });
    assert.equal(r.allowed, true);
    assert.notEqual(r.requiresConfirmation, true);
  });

  it('does not impose a plan-approval gate in goal mode', () => {
    const r = evaluateGoalModeGate({
      mode: 'goal',
      toolName: 'bash',
      riskLevel: 'L3_external_write',
      args: { command: 'node build.js' },
      planGate: { hasPlan: false, hasApprovedPlan: false },
      workspacePath: '/ws',
    });
    assert.equal(r.allowed, true);
  });
});

describe('resolveActivePlanBoundaries', () => {
  it('returns null when conversationId is missing', () => {
    assert.equal(resolveActivePlanBoundaries(null, {}), null);
  });

  it('reads boundaries from the active plan', () => {
    const store = {
      getActivePlanByConversation: (id) =>
        id === 'c1' ? { boundaries: { inScope: ['x'], outOfScope: ['dist/*'] } } : null,
    };
    assert.deepEqual(resolveActivePlanBoundaries('c1', store), { inScope: ['x'], outOfScope: ['dist/*'] });
    assert.equal(resolveActivePlanBoundaries('c2', store), null);
  });

  it('is resilient when the store throws', () => {
    const store = {
      getActivePlanByConversation() {
        throw new Error('boom');
      },
    };
    assert.equal(resolveActivePlanBoundaries('c1', store), null);
  });
});

describe('resolveActiveGoalExecutionBinding', () => {
  it('uses active plan targetWorkspacePath as the execution and writable root', () => {
    const store = {
      getActivePlanByConversation: (id) =>
        id === 'c1'
          ? {
            planId: 'plan-1',
            originWorkspacePath: '/repo/peer-knowledge',
            targetWorkspacePath: '/repo/peer_agent',
            boundaries: { inScope: ['src/*'], outOfScope: [] },
          }
          : null,
    };
    const binding = resolveActiveGoalExecutionBinding('c1', '/repo/peer-knowledge', store);
    assert.equal(binding.originWorkspacePath, '/repo/peer-knowledge');
    assert.equal(binding.targetWorkspacePath, '/repo/peer_agent');
    assert.equal(binding.executionWorkspacePath, '/repo/peer_agent');
    assert.deepEqual(binding.writableRoots, ['/repo/peer_agent']);
    assert.deepEqual(binding.readableRoots, ['/repo/peer-knowledge', '/repo/peer_agent']);
    assert.deepEqual(binding.boundaries, { inScope: ['src/*'], outOfScope: [] });
  });

  it('falls back to the conversation workspace when no active target is bound', () => {
    const binding = resolveActiveGoalExecutionBinding('c1', '/repo/current', {
      getActivePlanByConversation: () => null,
    });
    assert.equal(binding.originWorkspacePath, '/repo/current');
    assert.equal(binding.targetWorkspacePath, null);
    assert.equal(binding.executionWorkspacePath, '/repo/current');
    assert.deepEqual(binding.writableRoots, ['/repo/current']);
  });
});
