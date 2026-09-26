import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApprovalStore } from '@peer-agent/runtime-node';

import { createChatPermissionGate } from './permission-gate.mjs';

function createWebContents(events) {
  return {
    send(channel, payload) {
      events.push({ channel, payload });
    },
  };
}

describe('chat permission gate', () => {
  it('stores scope grants in main runtime and reuses them for file writes', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    const firstPromise = gate.createFilePermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'tool-1',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/one.txt', content: 'one' },
      filePath: '/outside/one.txt',
      workspacePath: '/workspace',
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].payload.call.capabilityId, 'local.file.write');
    assert.equal(activeStreams.get('s1').permissionIds.has(events[0].payload.call.toolCallId), true);

    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g1',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'scope',
      scope: 'local.file.write',
      decidedAt: new Date().toISOString(),
    });

    const first = await firstPromise;
    assert.equal(first.granted, true);
    assert.equal(first.reason, 'local_user_approved_scope');

    const second = await gate.createFilePermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'tool-2',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/two.txt', content: 'two' },
      filePath: '/outside/two.txt',
      workspacePath: '/workspace',
    });

    assert.equal(second.granted, true);
    assert.equal(second.reason, 'local_user_approved_scope');
    assert.equal(events.length, 1);
  });

  it('reuses a once-allow for later file writes of the same type', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    const firstPromise = gate.createFilePermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'write-once-1',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/one.txt', content: 'one' },
      filePath: '/outside/one.txt',
      workspacePath: '/workspace',
    });

    assert.equal(events.length, 1);
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-write-once',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await firstPromise).granted, true);

    const second = await gate.createFilePermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'write-once-2',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/two.txt', content: 'two' },
      filePath: '/outside/two.txt',
      workspacePath: '/workspace',
    });

    assert.equal(second.granted, true);
    assert.equal(second.reason, 'local_user_approved_scope');
    assert.equal(events.filter((event) => event.channel === 'chat:stream:permission-request').length, 1);
  });

  it('scopes shell always-allow by normalized command family', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);
    const baseContext = {
      webContents,
      streamId: 's1',
      conversationId: 'c1',
      workspacePath: '/workspace',
    };

    const firstPromise = gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'shell-1' })({
      call: { toolCallId: 'local-shell-1' },
      classification: {
        command: 'pnpm test -- foo',
        cwd: '/workspace',
        category: 'process-control',
        riskLevel: 'L4_privileged',
        dataLevel: 'D2_sensitive',
        reason: 'pnpm_project_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].payload.call.capabilityId, 'local.shell.exec');
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-shell',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'scope',
      scope: 'local.shell.exec',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await firstPromise).granted, true);

    const second = await gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'shell-2' })({
      call: { toolCallId: 'local-shell-2' },
      classification: {
        command: 'pnpm test -- bar',
        cwd: '/workspace',
        category: 'process-control',
        riskLevel: 'L4_privileged',
        dataLevel: 'D2_sensitive',
        reason: 'pnpm_project_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(second.granted, true);
    assert.equal(second.reason, 'local_user_approved_scope');
    assert.equal(events.length, 1);
  });

  it('reuses a once-allow for the same shell command family instead of asking again', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);
    const baseContext = {
      webContents,
      streamId: 's1',
      conversationId: 'c1',
      workspacePath: '/workspace',
    };

    const firstPromise = gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'echo-1' })({
      call: { toolCallId: 'local-echo-1' },
      classification: {
        command: 'echo one',
        cwd: '/workspace',
        category: 'read',
        riskLevel: 'L1_local_read',
        dataLevel: 'D0_public',
        reason: 'echo_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(events.length, 1);
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-echo-once',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await firstPromise).granted, true);

    const second = await gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'echo-2' })({
      call: { toolCallId: 'local-echo-2' },
      classification: {
        command: 'echo two',
        cwd: '/workspace',
        category: 'read',
        riskLevel: 'L1_local_read',
        dataLevel: 'D0_public',
        reason: 'echo_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(second.granted, true);
    assert.equal(second.reason, 'local_user_approved_scope');
    assert.equal(events.filter((event) => event.channel === 'chat:stream:permission-request').length, 1);

    const other = gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'git-1' })({
      call: { toolCallId: 'local-git-1' },
      classification: {
        command: 'git status',
        cwd: '/workspace',
        category: 'read',
        riskLevel: 'L1_local_read',
        dataLevel: 'D0_public',
        reason: 'git_status',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });
    assert.equal(events.filter((event) => event.channel === 'chat:stream:permission-request').length, 2);
    gate.settlePermissionRequest(events.at(-1).payload.call.toolCallId, {
      grantId: 'g-git-once',
      toolCallId: events.at(-1).payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await other).granted, true);
  });

  it('settles queued same-type shell asks together after one allow', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);
    const baseContext = {
      webContents,
      streamId: 's1',
      conversationId: 'c1',
      workspacePath: '/workspace',
    };

    const firstPromise = gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'echo-queue-1' })({
      call: { toolCallId: 'local-echo-queue-1' },
      classification: {
        command: 'echo one',
        cwd: '/workspace',
        category: 'read',
        riskLevel: 'L1_local_read',
        dataLevel: 'D0_public',
        reason: 'echo_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });
    const secondPromise = gate.createShellApprovalDecider({ ...baseContext, toolCallId: 'echo-queue-2' })({
      call: { toolCallId: 'local-echo-queue-2' },
      classification: {
        command: 'echo two',
        cwd: '/workspace',
        category: 'read',
        riskLevel: 'L1_local_read',
        dataLevel: 'D0_public',
        reason: 'echo_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    const requestEvents = events.filter((event) => event.channel === 'chat:stream:permission-request');
    assert.equal(requestEvents.length, 2);
    gate.settlePermissionRequest(requestEvents[0].payload.call.toolCallId, {
      grantId: 'g-echo-queue',
      toolCallId: requestEvents[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });

    const first = await firstPromise;
    const second = await secondPromise;
    assert.equal(first.granted, true);
    assert.equal(second.granted, true);
    assert.equal(second.reason, 'local_user_approved_scope');
    const settled = events.filter((event) => event.channel === 'chat:stream:permission-settled');
    assert.equal(settled.length, 1);
    assert.deepEqual(settled[0].payload.toolCallIds, [requestEvents[1].payload.call.toolCallId]);
  });

  it('still asks each Goal confirmation even after a same-capability allow', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    const first = gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'goal-confirm-1',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'local.goal.confirm',
      toolName: 'goal_confirm',
      scope: { kind: 'goal-confirmation', confirmationKind: 'high_risk', tool: 'bash' },
      riskLevel: 'L4_privileged',
    });
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-goal-1',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await first).granted, true);

    const second = gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'goal-confirm-2',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'local.goal.confirm',
      toolName: 'goal_confirm',
      scope: { kind: 'goal-confirmation', confirmationKind: 'high_risk', tool: 'bash' },
      riskLevel: 'L4_privileged',
    });
    assert.equal(events.filter((event) => event.channel === 'chat:stream:permission-request').length, 2);
    gate.settlePermissionRequest(events.at(-1).payload.call.toolCallId, {
      grantId: 'g-goal-2',
      toolCallId: events.at(-1).payload.call.toolCallId,
      granted: false,
      duration: 'denied',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await second).granted, false);
  });

  it('uses session local mode to auto-approve low and medium risk shell approvals only', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams, accessLevel: 'session_local' });
    const webContents = createWebContents(events);
    const decider = gate.createShellApprovalDecider({
      webContents,
      streamId: 's1',
      toolCallId: 'shell-auto',
      conversationId: 'c1',
      workspacePath: '/workspace',
    });

    const lowRisk = await decider({
      call: { toolCallId: 'local-shell-low' },
      classification: {
        command: 'pnpm test',
        cwd: '/workspace',
        category: 'project-command',
        riskLevel: 'L2_local_write',
        dataLevel: 'D1_internal',
        reason: 'pnpm_project_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(lowRisk.granted, true);
    assert.equal(lowRisk.reason, 'local_access_level_session');
    assert.equal(events.length, 0);

    const highRiskPromise = decider({
      call: { toolCallId: 'local-shell-high' },
      classification: {
        command: 'sudo rm -rf /tmp/example',
        cwd: '/workspace',
        category: 'privileged',
        riskLevel: 'L4_privileged',
        dataLevel: 'D2_sensitive',
        reason: 'privileged_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].payload.call.toolCallId, 'chat-permission:shell-auto');
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-high',
      toolCallId: events[0].payload.call.toolCallId,
      granted: false,
      duration: 'denied',
      decidedAt: new Date().toISOString(),
    });
    const highRisk = await highRiskPromise;
    assert.equal(highRisk.granted, false);
    assert.equal(highRisk.reason, 'local_user_denied');
  });

  it('preserves Goal confirmation metadata on local capability permission calls', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    const pending = gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'goal-confirm',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'goal.high_risk.action',
      toolName: 'bash',
      args: { command: 'node build.js' },
      scope: { kind: 'goal-confirmation', confirmationKind: 'high_risk', tool: 'bash' },
      confirmation: {
        kind: 'high_risk',
        detail: 'bash',
        reason: 'goal_high_risk_confirmation',
        riskLevel: 'L4_privileged',
      },
      reason: 'goal_high_risk_confirmation',
      riskLevel: 'L4_privileged',
      dataLevel: 'D2_sensitive',
    });

    assert.equal(events.length, 1);
    const call = events[0].payload.call;
    assert.equal(call.capabilityId, 'goal.high_risk.action');
    assert.equal(call.confirmation.kind, 'high_risk');
    assert.equal(call.confirmation.reason, 'goal_high_risk_confirmation');
    assert.equal(call.arguments.command, 'node build.js');
    assert.equal(call.argumentsPreview.confirmationKind, 'high_risk');

    gate.settlePermissionRequest(call.toolCallId, {
      grantId: 'g-goal-confirm',
      toolCallId: call.toolCallId,
      granted: false,
      duration: 'denied',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await pending).granted, false);
  });

  it('reuses an approved source toolCall instead of asking a second local grant', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    const first = gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'tc_preview',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'goal.high_risk.action',
      toolName: 'desktop_preview',
      args: { action: 'observe', scene: 'background-runtime' },
      riskLevel: 'L4_privileged',
    });

    assert.equal(events.length, 1);
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-preview',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await first).granted, true);

    const second = await gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'tc_preview',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'local.desktop.preview',
      toolName: 'desktop_preview',
      args: { action: 'observe', scene: 'background-runtime' },
      riskLevel: 'L4_privileged',
    });

    assert.equal(events.length, 1);
    assert.equal(second.granted, true);
    assert.equal(second.reason, 'local_user_approved_same_tool_call');
  });

  it('still asks when a later toolCall is a different source id', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    const first = gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'tc_preview_1',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'local.desktop.preview',
      toolName: 'desktop_preview',
      args: { action: 'observe' },
      riskLevel: 'L4_privileged',
    });
    gate.settlePermissionRequest(events[0].payload.call.toolCallId, {
      grantId: 'g-preview-1',
      toolCallId: events[0].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await first).granted, true);

    const second = gate.createLocalCapabilityPermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'tc_preview_2',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      capabilityId: 'local.desktop.preview',
      toolName: 'desktop_preview',
      args: { action: 'observe' },
      riskLevel: 'L4_privileged',
    });
    assert.equal(events.length, 2);
    gate.settlePermissionRequest(events[1].payload.call.toolCallId, {
      grantId: 'g-preview-2',
      toolCallId: events[1].payload.call.toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    });
    assert.equal((await second).granted, true);
  });

  it('uses full local mode to auto-approve file writes and all shell approvals', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams, accessLevel: 'full_local' });
    const webContents = createWebContents(events);

    const fileDecision = await gate.createFilePermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'file-full',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/full.txt', content: 'full' },
      filePath: '/outside/full.txt',
      workspacePath: '/workspace',
    });

    assert.equal(fileDecision.granted, true);
    assert.equal(fileDecision.reason, 'local_access_level_full');
    assert.equal(events.length, 0);

    const highRisk = await gate.createShellApprovalDecider({
      webContents,
      streamId: 's1',
      toolCallId: 'shell-full-high',
      conversationId: 'c1',
      workspacePath: '/workspace',
    })({
      call: { toolCallId: 'local-shell-full-high' },
      classification: {
        command: 'sudo rm -rf /tmp/example',
        cwd: '/workspace',
        category: 'destructive',
        riskLevel: 'L5_destructive',
        dataLevel: 'D2_sensitive',
        reason: 'destructive_command',
      },
      ruleDecision: { behavior: 'ask', reason: 'local_user_approval_required' },
    });

    assert.equal(highRisk.granted, true);
    assert.equal(highRisk.reason, 'local_access_level_full');
    assert.equal(events.length, 0);
  });

  it('updates access level at runtime through the main permission gate seam', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const webContents = createWebContents(events);

    assert.equal(gate.setAccessLevel('full_local'), 'full_local');
    const fileDecision = await gate.createFilePermissionRequester({
      webContents,
      streamId: 's1',
      toolCallId: 'file-runtime',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/runtime.txt', content: 'runtime' },
      filePath: '/outside/runtime.txt',
      workspacePath: '/workspace',
    });

    assert.equal(fileDecision.granted, true);
    assert.equal(fileDecision.reason, 'local_access_level_full');
    assert.equal(events.length, 0);
  });

  it('keeps Automation grants request-scoped and isolated from full chat access', async () => {
    const activeStreams = new Map([
      ['observe', { permissionIds: new Set() }],
      ['writer', { permissionIds: new Set() }],
    ]);
    const gate = createChatPermissionGate({ activeStreams, accessLevel: 'full_local' });
    const webContents = createWebContents([]);
    const observePolicy = {
      kind: 'automation',
      preset: 'observe',
      allowedCapabilityIds: [],
      blockedCapabilityIds: ['local.file.write'],
    };
    const writerPolicy = {
      kind: 'automation',
      preset: 'work_in_workspace',
      allowedCapabilityIds: ['local.file.write', 'local.shell.exec'],
      blockedCapabilityIds: [],
    };

    const observe = await gate.createFilePermissionRequester({
      webContents,
      streamId: 'observe',
      toolCallId: 'observe-write',
      permissionPolicy: observePolicy,
    })({ tool: 'write_file', args: {}, filePath: '/workspace/a', workspacePath: '/workspace' });
    const writer = await gate.createFilePermissionRequester({
      webContents,
      streamId: 'writer',
      toolCallId: 'writer-write',
      permissionPolicy: writerPolicy,
    })({ tool: 'write_file', args: {}, filePath: '/workspace/a', workspacePath: '/workspace' });
    const privileged = await gate.createShellApprovalDecider({
      webContents,
      streamId: 'writer',
      toolCallId: 'writer-sudo',
      permissionPolicy: writerPolicy,
    })({
      call: { command: 'sudo true' },
      classification: { riskLevel: 'L4_privileged', cwd: '/workspace' },
      ruleDecision: null,
    });

    assert.equal(observe.granted, false);
    assert.equal(observe.reason, 'automation_capability_blocked');
    assert.equal(writer.granted, true);
    assert.equal(writer.reason, 'automation_grant_allowed');
    assert.equal(privileged.granted, false);
    assert.equal(privileged.reason, 'automation_high_risk_blocked');
  });

  it('denies a sink with no approver immediately and does not register a pending ask', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const events = [];
    const gate = createChatPermissionGate({ activeStreams });
    const sink = {
      approver: 'none',
      send(channel, payload) {
        events.push({ channel, payload });
      },
    };
    let timer;
    const decision = await Promise.race([
      gate.createFilePermissionRequester({
        webContents: sink,
        streamId: 's1',
        toolCallId: 'tool-ephemeral',
        conversationId: 'c1',
      })({
        tool: 'write_file',
        args: { path: '/outside/secret.txt', content: 'UNIQUE_ARG_SENTINEL' },
        filePath: '/outside/secret.txt',
        workspacePath: '/workspace',
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('permission ask hung')), 500);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(decision.granted, false);
    assert.equal(decision.reason, 'ephemeral_no_approver');
    assert.equal(decision.grant.granted, false);
    assert.equal(events.length, 0);
    assert.deepEqual(gate.listPendingPermissions(), []);
    assert.equal(activeStreams.get('s1').permissionIds.size, 0);
  });

  it('broadcasts permission-settled to every window, including an approval from the other window', async () => {
    const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
    const windowA = [];
    const windowB = [];
    const gate = createChatPermissionGate({
      activeStreams,
      settleNotifier(streamId, toolCallIds) {
        const event = { channel: 'chat:stream:permission-settled', payload: { streamId, toolCallIds } };
        windowA.push(event);
        windowB.push(event);
      },
    });
    const sink = {
      send(channel, payload) {
        windowA.push({ channel, payload });
      },
    };
    const pending = gate.createFilePermissionRequester({
      webContents: sink,
      streamId: 's1',
      toolCallId: 'tool-other-window',
      conversationId: 'c1',
    })({
      tool: 'write_file',
      args: { path: '/outside/a.txt', content: 'one' },
      filePath: '/outside/a.txt',
      workspacePath: '/workspace',
    });
    const request = windowA.find((event) => event.channel === 'chat:stream:permission-request');
    assert.ok(request);
    const toolCallId = request.payload.call.toolCallId;
    assert.equal(gate.settlePermissionRequest(toolCallId, {
      grantId: 'g-other',
      toolCallId,
      granted: true,
      duration: 'once',
      decidedAt: new Date().toISOString(),
    }), true);
    const decision = await pending;
    assert.equal(decision.granted, true);
    const settledA = windowA.filter((event) => event.channel === 'chat:stream:permission-settled');
    const settledB = windowB.filter((event) => event.channel === 'chat:stream:permission-settled');
    assert.equal(settledA.length, 1);
    assert.equal(settledB.length, 1);
    assert.deepEqual(settledA[0].payload.toolCallIds, [toolCallId]);
    assert.deepEqual(settledB[0].payload, settledA[0].payload);
    assert.deepEqual(gate.listPendingPermissions({ streamId: 's1' }), []);
  });

  it('persists an open approval in the workspace file and folds it after settle', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'peer-gate-approvals-'));
    try {
      const workspaceId = '00000000-0000-4000-8000-000000000009';
      const store = createApprovalStore({ rootDir: root });
      const activeStreams = new Map([['s1', { permissionIds: new Set() }]]);
      const events = [];
      const gate = createChatPermissionGate({
        activeStreams,
        approvalStore: store,
        resolveApprovalScope: () => ({ workspaceId, planId: 'plan-9', conversationId: 'c1' }),
      });
      const pending = gate.createFilePermissionRequester({
        webContents: createWebContents(events),
        streamId: 's1',
        toolCallId: 'tool-durable',
        conversationId: 'c1',
      })({
        tool: 'write_file',
        args: { path: '/outside/secret.txt', content: 'UNIQUE_ARG_SENTINEL' },
        filePath: '/outside/secret.txt',
        workspacePath: '/workspace',
      });
      const open = store.list({ state: 'open' });
      assert.equal(open.length, 1);
      assert.equal(open[0].workspaceId, workspaceId);
      assert.equal(open[0].planId, 'plan-9');
      assert.equal(open[0].conversationId, 'c1');
      const file = readFileSync(store.fileFor(workspaceId), 'utf8');
      assert.equal(file.includes('UNIQUE_ARG_SENTINEL'), false);
      assert.equal(gate.listPendingPermissions({ conversationId: 'c1' }).length, 1);
      const toolCallId = events[0].payload.call.toolCallId;
      gate.settlePermissionRequest(toolCallId, {
        grantId: 'g-durable',
        toolCallId,
        granted: true,
        duration: 'once',
        decidedAt: new Date().toISOString(),
      });
      assert.equal((await pending).granted, true);
      assert.deepEqual(gate.listPendingPermissions(), []);
      const folded = store.list();
      assert.equal(folded.length, 1);
      assert.equal(folded[0].state, 'approved');
      assert.equal(folded[0].decidedBy, 'local_ui');
      assert.equal(folded[0].workspaceId, workspaceId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
