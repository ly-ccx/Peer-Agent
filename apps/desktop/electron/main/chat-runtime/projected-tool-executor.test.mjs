import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  executeProjectedModelTool,
  resolveProjectedModelToolCall,
} from './projected-tool-executor.mjs';
import {
  createRuntimeProjectionFromToolRegistry,
  createRuntimeToolRegistry,
} from '../tools/index.mjs';

let tmpDir;
let browserToolRegistry;
let browserRuntimeProjection;

describe('projected model tool executor', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'projected-model-tool-'));
    process.env.PEER_AGENT_HOME = tmpDir;
    browserToolRegistry = createRuntimeToolRegistry();
    browserRuntimeProjection = createRuntimeProjectionFromToolRegistry(browserToolRegistry, {
      mode: 'chat',
      workspacePath: tmpDir,
    });
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

  it('blocks projected Agent writes until the conversation has an active GoalPlan', async () => {
    const outputPath = path.join(tmpDir, 'untracked.txt');
    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: outputPath, content: 'must not write' },
      workspacePath: tmpDir,
      toolContext: { mode: 'chat', conversationId: 'c-untracked' },
      toolCallId: 'tc_goal_plan_required',
      goalPlanStore: {
        listPlansByConversation: () => [],
      },
    });

    assert.equal(result.success, false);
    assert.equal(existsSync(outputPath), false);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.reason, 'goal_plan_required_for_side_effect');
    assert.match(parsed.message, /goal_create_plan|可追踪任务/);
  });

  it('blocks projected Agent writes when the conversation only has terminal plan history', async () => {
    const outputPath = path.join(tmpDir, 'after-completed.txt');
    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: outputPath, content: 'must reopen first' },
      workspacePath: tmpDir,
      toolContext: { mode: 'chat', conversationId: 'c-terminal' },
      toolCallId: 'tc_terminal_plan_history',
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'completed' }],
      },
    });

    assert.equal(result.success, false);
    assert.equal(existsSync(outputPath), false);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.reason, 'goal_plan_required_for_side_effect');
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

  it('writes inside the active Goal target workspace even when the conversation originated elsewhere', async () => {
    const originDir = path.join(tmpDir, 'peer-knowledge');
    const targetDir = path.join(tmpDir, 'peer_agent');
    mkdirSync(originDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const outputPath = path.join(targetDir, 'src', 'goal-target.txt');

    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: outputPath, content: 'target write' },
      workspacePath: originDir,
      toolContext: { mode: 'goal', conversationId: 'c-target', workspacePath: originDir },
      toolCallId: 'tc_target_write',
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'accepted' }],
        getActivePlanByConversation: () => ({
          planId: 'plan-target',
          originWorkspacePath: originDir,
          targetWorkspacePath: targetDir,
          boundaries: { inScope: ['src/*'], outOfScope: [] },
        }),
      },
    });

    assert.equal(result.success, true);
    assert.equal(readFileSync(outputPath, 'utf8'), 'target write');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.path, outputPath);
  });

  it('still denies Goal writes outside the active target workspace', async () => {
    const originDir = path.join(tmpDir, 'peer-knowledge');
    const targetDir = path.join(tmpDir, 'peer_agent');
    const outsidePath = path.join(tmpDir, 'other', 'x.txt');
    mkdirSync(originDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: outsidePath, content: 'nope' },
      workspacePath: originDir,
      toolContext: { mode: 'goal', conversationId: 'c-target', workspacePath: originDir },
      toolCallId: 'tc_target_denied',
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'accepted' }],
        getActivePlanByConversation: () => ({
          planId: 'plan-target',
          originWorkspacePath: originDir,
          targetWorkspacePath: targetDir,
          boundaries: { inScope: ['src/*'], outOfScope: [] },
        }),
      },
    });

    assert.equal(result.success, false);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.reason, 'goal_scope_expansion_denied');
    assert.equal(existsSync(outsidePath), false);
  });

  it('requires Goal irreversible confirmation with a dedicated capability id', async () => {
    const permissionRequests = [];
    const result = await executeProjectedModelTool({
      name: 'bash',
      args: { command: 'git push origin dev' },
      workspacePath: tmpDir,
      toolContext: { mode: 'goal', conversationId: 'c-irreversible' },
      toolCallId: 'tc_irreversible',
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'executing' }],
      },
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
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'executing' }],
      },
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
      toolContext: { mode: 'chat', readFiles: new Map(), conversationId: 'c1' },
      toolCallId: 'tc_shell_abort',
      goalPlanStore: {
        listPlansByConversation: () => [{ status: 'executing' }],
      },
      requestPermission: async () => ({ granted: true }),
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

  it('fails browser_open_panel when ensureBrowserReady is not injected', async () => {
    const result = await executeProjectedModelTool({
      name: 'browser_open_panel',
      args: { focus: true },
      workspacePath: tmpDir,
      toolContext: { conversationId: 'conversation-browser' },
      toolCallId: 'tc_browser_open_missing',
      locale: 'zh-CN',
      registry: browserToolRegistry,
      runtimeProjection: browserRuntimeProjection,
    });

    assert.equal(result.success, false);
    assert.equal(result.execution.result.status, 'failed');
    assert.match(
      String(result.execution.result.outputPreview?.reason || result.output || ''),
      /启动服务尚未就绪|reveal service is unavailable/i,
    );
  });

  it('passes ensureBrowserReady into projected browser_open_panel execution', async () => {
    const revealRequests = [];
    const result = await executeProjectedModelTool({
      name: 'browser_open_panel',
      args: { focus: true },
      workspacePath: tmpDir,
      toolContext: { conversationId: 'conversation-browser' },
      toolCallId: 'tc_browser_open_ready',
      locale: 'en-US',
      registry: browserToolRegistry,
      runtimeProjection: browserRuntimeProjection,
      ensureBrowserReady: async (request) => {
        revealRequests.push(request);
        return {
          status: 'activated',
          sessionId: 'conversation-browser',
          focused: true,
        };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.execution.result.status, 'success');
    assert.equal(revealRequests.length, 1);
    assert.equal(revealRequests[0].conversationId, 'conversation-browser');
    assert.equal(revealRequests[0].focus, true);
  });
});
