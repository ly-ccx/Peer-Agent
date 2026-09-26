import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { evaluateGoalModeGate } from './goal-mode-gate.mjs';
import { executeProjectedModelTool } from './projected-tool-executor.mjs';
import {
  buildProjectAgentModeDenial,
  evaluateProjectAgentModeGate,
  restrictProjectAgentPermission,
} from './project-agent-mode-gate.mjs';
import { buildRuntimeTools, createLlmChatService } from '../llm-chat-service.mjs';
import { createToolRegistry } from '../tools/tool-registry.mjs';
import {
  createRuntimeProjectionFromToolRegistry,
  createRuntimeToolRegistry,
} from '../tools/index.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'project-agent-gate-'));
  tempDirs.push(dir);
  process.env.PEER_AGENT_HOME = dir;
  return dir;
}

describe('project agent mode gate', () => {
  it('denies a write tool that was temporarily projected into project_agent', async () => {
    const dir = tempDir();
    const leakedWrite = {
      name: 'write_file',
      capabilityId: 'legacy.local.file.write',
      availableInModes: ['project_agent'],
      prompt: () => 'write',
      runtime: { executorCapabilityId: 'local.file.write' },
      permissionPolicy: { kind: 'file-write' },
      inputSchema: { type: 'object', additionalProperties: true },
    };
    const registry = createToolRegistry({ tools: [leakedWrite] });
    const runtimeProjection = createRuntimeProjectionFromToolRegistry(registry, {
      mode: 'project_agent',
    });
    const target = path.join(dir, 'leaked.txt');
    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: target, content: 'nope' },
      workspacePath: dir,
      toolContext: { mode: 'project_agent', conversationId: 'agent', readFiles: new Map() },
      registry,
      runtimeProjection,
      toolCallId: 'tc-leak',
    });

    assert.equal(result.success, false);
    assert.equal(result.projectAgentDenied, true);
    assert.equal(JSON.parse(result.output).reason, 'project_agent_capability_denied');
    assert.equal(result.execution.result.status, 'denied');
    assert.equal(result.execution.result.evidence.toolCallId, 'tc-leak');
    assert.match(result.execution.result.evidence.summary, /project_agent_capability_denied/);
    assert.equal(existsSync(target), false);
  });

  it('denies the same write when only the turn role is project_agent', async () => {
    const dir = tempDir();
    const registry = createRuntimeToolRegistry();
    const runtimeProjection = createRuntimeProjectionFromToolRegistry(registry, { mode: 'chat' });
    const target = path.join(dir, 'role.txt');
    const result = await executeProjectedModelTool({
      name: 'write_file',
      args: { path: target, content: 'nope' },
      workspacePath: dir,
      toolContext: {
        mode: 'chat',
        turnRole: 'project_agent',
        conversationId: 'agent',
        readFiles: new Map(),
      },
      registry,
      runtimeProjection,
      toolCallId: 'tc-role',
    });
    assert.equal(result.projectAgentDenied, true);
    assert.equal(existsSync(target), false);
  });

  it('executes a projected read in project_agent mode', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'note.txt');
    writeFileSync(filePath, 'readable\n', 'utf8');
    const registry = createRuntimeToolRegistry();
    const runtimeProjection = createRuntimeProjectionFromToolRegistry(registry, {
      mode: 'project_agent',
    });
    const result = await executeProjectedModelTool({
      name: 'read_file',
      args: { path: filePath },
      workspacePath: dir,
      toolContext: { mode: 'project_agent', conversationId: 'agent', readFiles: new Map() },
      registry,
      runtimeProjection,
      toolCallId: 'tc-read',
    });
    assert.equal(result.success, true);
    assert.equal(result.execution.call.capabilityId, 'local.file.read');
    assert.match(result.output, /readable/);
  });

  it('denies a whitelisted capability id when the permission kind is shell', () => {
    const decision = evaluateProjectAgentModeGate({
      mode: 'project_agent',
      capabilityId: 'local.file.read',
      permissionKind: 'browser-control',
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.detail, 'permission_kind');
    const denial = buildProjectAgentModeDenial({
      call: { toolCallId: 'tc-kind', capabilityId: 'local.file.read' },
      toolName: 'read_file',
      capabilityId: 'local.file.read',
      detail: decision.detail,
    });
    assert.equal(JSON.parse(denial.output).reason, 'project_agent_capability_denied');
    assert.equal(denial.execution.result.evidence.returnedToCloud, false);
  });

  it('denies project_agent side effects and still allows inert reads', () => {
    const write = evaluateGoalModeGate({
      mode: 'project_agent',
      toolName: 'write_file',
      riskLevel: 'L2_local_write',
    });
    assert.equal(write.allowed, false);
    assert.equal(write.reason, 'project_agent_side_effect_denied');
    const browser = evaluateGoalModeGate({
      mode: 'project_agent',
      toolName: 'browser_open_panel',
      riskLevel: 'L1_local_read',
    });
    assert.equal(browser.reason, 'project_agent_side_effect_denied');
    const read = evaluateGoalModeGate({
      mode: 'project_agent',
      toolName: 'read_file',
      riskLevel: 'L1_local_read',
    });
    assert.deepEqual(read, { allowed: true });
    assert.deepEqual(
      evaluateGoalModeGate({ mode: 'explorer', toolName: 'write_file', riskLevel: 'L2_local_write' }),
      { allowed: true },
    );
  });

  it('stamps restricted_local only on the project_agent projection', () => {
    const agent = buildRuntimeTools({ mode: 'project_agent' });
    const chat = buildRuntimeTools({ mode: 'chat' });
    assert.equal(agent.runtimeProjection.accessLevel, 'restricted_local');
    assert.equal(chat.runtimeProjection.accessLevel, 'ask_before_local');
    const agentNames = agent.tools.map((tool) => tool.function?.name ?? tool.name);
    assert.deepEqual(agentNames, ['list_files', 'read_file', 'search_files', 'batch_search']);
    const chatNames = chat.tools.map((tool) => tool.function?.name ?? tool.name);
    assert.ok(chatNames.includes('bash'));
    assert.ok(chatNames.includes('write_file'));
  });

  it('does not keep a global full or session auto-grant on a project agent turn', async () => {
    const wrapped = restrictProjectAgentPermission(async () => ({
      granted: true,
      reason: 'local_access_level_full',
      grant: { grantId: 'g1', granted: true, duration: 'once' },
    }));
    const decision = await wrapped({ tool: 'read_file' });
    assert.equal(decision.granted, false);
    assert.equal(decision.reason, 'project_agent_capability_denied');
    assert.equal(decision.grant.granted, false);
    const asked = restrictProjectAgentPermission(async () => ({ granted: true, reason: 'local_user_approved_scope' }));
    assert.equal((await asked({})).granted, true);
  });

  it('accepts project_agent on the existing turnProfile without a new sendMessage parameter', async () => {
    const previousFetch = globalThis.fetch;
    const snapshots = [];
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200 });
    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
        broadcast: (channel, payload) => {
          if (channel === 'chat:stream:active-changed') snapshots.push(payload.streams);
        },
      });
      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's-project-agent',
        conversationId: 'c-project-agent',
        mode: 'chat',
        webContents: { send: () => {} },
        turnProfile: { role: 'project_agent' },
      });
      assert.equal(snapshots[0]?.[0]?.role, 'project_agent');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
