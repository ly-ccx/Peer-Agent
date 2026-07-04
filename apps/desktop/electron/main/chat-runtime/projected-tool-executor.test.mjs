import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  executeProjectedModelTool,
  resolveProjectedModelToolCall,
} from './projected-tool-executor.mjs';

let tmpDir;

describe('projected model tool executor', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'projected-model-tool-'));
    process.env.PEER_AGENT_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.PEER_AGENT_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves model-visible read_file through Runtime Projection to local.file.read', () => {
    const projection = resolveProjectedModelToolCall({
      name: 'read_file',
      args: { path: 'note.txt' },
      toolCallId: 'tc_read',
    });

    assert.equal(projection.ok, true);
    assert.equal(projection.capability.capabilityId, 'local.file.read');
    assert.equal(projection.call.toolCallId, 'tc_read');
    assert.equal(projection.call.capabilityId, 'local.file.read');
    assert.deepEqual(projection.call.arguments, { path: 'note.txt' });
  });

  it('executes projected read_file through Local Tool Host and returns model-compatible output', async () => {
    const filePath = path.join(tmpDir, 'note.txt');
    writeFileSync(filePath, 'hello projection\n', 'utf8');

    const result = await executeProjectedModelTool({
      name: 'read_file',
      args: { path: filePath },
      workspacePath: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      toolCallId: 'tc_read',
    });

    assert.equal(result.success, true);
    assert.equal(result.execution.call.capabilityId, 'local.file.read');
    assert.equal(result.execution.grant.granted, true);
    assert.equal(result.projectionCapability.capabilityId, 'local.file.read');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.kind, 'local_file_ref');
    assert.equal(parsed.tool, 'read_file');
    assert.equal(parsed.path, filePath);
    assert.match(parsed.preview, /hello projection/);
  });

  it('requires Goal scope expansion confirmation before projected writes outside inScope', async () => {
    const permissionRequests = [];
    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: 'tests/new.test.ts', content: 'test' },
      workspacePath: tmpDir,
      toolContext: { mode: 'goal', conversationId: 'c-scope' },
      toolCallId: 'tc_scope_expansion',
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'accepted' }],
        getActivePlanByConversation: () => ({
          boundaries: { inScope: ['src/*'], outOfScope: [] },
        }),
      },
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { granted: false };
      },
    });

    assert.equal(result.success, false);
    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].reason, 'goal_scope_expansion_confirmation');
    assert.equal(permissionRequests[0].confirmation.kind, 'scope_expansion');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.reason, 'goal_scope_expansion_denied');
    assert.equal(existsSync(path.join(tmpDir, 'tests', 'new.test.ts')), false);
  });

  it('requires Goal irreversible confirmation with a dedicated capability id', async () => {
    const permissionRequests = [];
    const result = await executeProjectedModelTool({
      name: 'bash',
      args: { command: 'git push origin dev' },
      workspacePath: tmpDir,
      toolContext: { mode: 'goal', conversationId: 'c-irreversible' },
      toolCallId: 'tc_irreversible',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { granted: false };
      },
    });

    assert.equal(result.success, false);
    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].capabilityId, 'goal.irreversible.action');
    assert.equal(permissionRequests[0].reason, 'goal_irreversible_action');
    assert.equal(permissionRequests[0].confirmation.kind, 'git_push');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.reason, 'goal_irreversible_denied');
  });

  it('requires Goal high-risk confirmation with a dedicated capability id', async () => {
    const permissionRequests = [];
    const result = await executeProjectedModelTool({
      name: 'bash',
      args: { command: 'node build.js' },
      workspacePath: tmpDir,
      toolContext: { mode: 'goal', conversationId: 'c-high-risk' },
      toolCallId: 'tc_high_risk',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { granted: false };
      },
    });

    assert.equal(result.success, false);
    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].capabilityId, 'goal.high_risk.action');
    assert.equal(permissionRequests[0].reason, 'goal_high_risk_confirmation');
    assert.equal(permissionRequests[0].confirmation.kind, 'high_risk');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.reason, 'goal_high_risk_denied');
  });

  it('propagates abort signals to projected shell execution', async () => {
    const markerPath = path.join(tmpDir, 'late.txt');
    const command = [
      'node -e',
      JSON.stringify(
        "setTimeout(()=>require('fs').writeFileSync('late.txt','late'),300); setTimeout(()=>{},1000);"
      ),
    ].join(' ');
    const controller = new AbortController();

    const run = executeProjectedModelTool({
      name: 'bash',
      args: { command, timeoutMs: 5000 },
      workspacePath: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      toolCallId: 'tc_shell_abort',
      shellApprovalDecider: async () => ({ granted: true, reason: 'test_approved' }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await run;

    assert.equal(result.success, false);
    assert.equal(result.execution.result.status, 'cancelled');
    assert.equal(result.execution.result.outputPreview.interrupted, true);
    assert.equal(existsSync(markerPath), false);
  });
});
