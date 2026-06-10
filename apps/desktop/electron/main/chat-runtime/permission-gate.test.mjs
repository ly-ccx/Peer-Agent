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
});
