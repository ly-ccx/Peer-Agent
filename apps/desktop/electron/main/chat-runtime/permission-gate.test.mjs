import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
});
