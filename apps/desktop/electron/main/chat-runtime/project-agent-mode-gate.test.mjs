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
import { createMemoryStore, createSnapshot } from '@peer-agent/runtime-node';
import { buildRuntimeTools, createLlmChatService, projectTurnSystemContext } from '../llm-chat-service.mjs';
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
    assert.deepEqual(agentNames, [
      'list_files', 'read_file', 'search_files', 'batch_search',
      'spawn_session', 'list_sessions', 'get_session', 'cancel_session', 'message_session', 'get_verification_detail', 'verify_session', 'set_proactivity', 'post_reply',
      'memory_search', 'memory_remember', 'memory_forget',
    ]);
    const chatNames = chat.tools.map((tool) => tool.function?.name ?? tool.name);
    assert.ok(chatNames.includes('bash'));
    assert.ok(chatNames.includes('write_file'));
    assert.equal(chatNames.includes('memory_remember'), false);
    assert.equal(chatNames.includes('memory_search'), false);
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

  it('passes turnProfile context into the system prompt without a new sendMessage parameter', async () => {
    const dir = tempDir();
    const previousHome = process.env.PEER_AGENT_HOME;
    process.env.PEER_AGENT_HOME = dir;
    const store = createMemoryStore({ rootDir: dir });
    const frozen = store.writeVerified({
      workspaceId: 'ws-b211',
      kind: 'fact',
      text: 'frozen login fact',
      sourceRefs: ['evidence-frozen'],
    });
    assert.equal(frozen.ok, true);
    const snapshot = createSnapshot('ws-b211', { store });
    assert.equal(snapshot.ok, true);
    assert.equal(store.forget({
      id: frozen.item.id,
      reason: 'later',
      workspaceId: 'ws-b211',
    }).ok, true);
    const live = store.writeVerified({
      workspaceId: 'ws-b211',
      kind: 'responsibility',
      text: 'owns the login boundary',
      sourceRefs: ['evidence-live'],
    });
    assert.equal(live.ok, true);

    const previousFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { status: 200 });
    };
    const llmConfigStore = {
      listProviders: () => [{
        id: 'p1',
        provider: 'openai',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        isDefault: true,
        apiKeyConfigured: true,
      }],
      getDecryptedApiKey: () => 'test-key',
    };
    try {
      const service = createLlmChatService({ llmConfigStore });
      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's-context',
        conversationId: 'c-context',
        mode: 'chat',
        webContents: { send: () => {} },
        turnProfile: {
          role: 'project_agent',
          workspaceId: 'ws-b211',
          context: {
            roster: [{
              sessionId: 'sess-1',
              title: 'Fix login',
              status: 'running',
              latestEvent: 'started',
              needsUser: true,
            }],
            events: [{ kind: 'result', sessionId: 'sess-1', summary: 'tests passed' }],
          },
        },
      });
      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's-plain',
        conversationId: 'c-plain',
        mode: 'chat',
        webContents: { send: () => {} },
      });
      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's-task',
        conversationId: 'c-task',
        mode: 'goal',
        webContents: { send: () => {} },
        turnProfile: {
          role: 'work_session',
          workspaceId: 'ws-b211',
          memorySnapshotId: snapshot.snapshotId,
          context: {
            workSessionOrigin: {
              summary: 'Fix login',
              anchorText: 'please fix login',
              readOnly: true,
            },
          },
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
      else process.env.PEER_AGENT_HOME = previousHome;
    }

    assert.equal(bodies.length, 3);
    const agent = JSON.stringify(bodies[0]);
    const plain = JSON.stringify(bodies[1]);
    const task = JSON.stringify(bodies[2]);
    assert.match(agent, /owns the login boundary/);
    assert.match(agent, /Hand code changes and other workspace writes to a work session/);
    assert.match(agent, /sess-1 \[running\] Fix login; needs you/);
    assert.match(agent, /tests passed/);
    assert.doesNotMatch(agent, /frozen login fact/);
    assert.doesNotMatch(plain, /owns the login boundary|Hand code changes|sess-1/);
    assert.match(task, /please fix login/);
    assert.match(task, /Read-only constraint:/);
    assert.match(task, new RegExp(snapshot.snapshotId));
    assert.match(task, /frozen login fact/);
    assert.match(task, /forgotten/);
    assert.match(task, /Mode: agent \(default\)/);
    assert.doesNotMatch(task, /Mode: project_agent/);
    assert.doesNotMatch(task, /Hand code changes/);
    assert.doesNotMatch(task, /owns the login boundary/);
  });
});

it('其他角色不会把 turnProfile.context 送进系统上下文', () => {
  assert.deepEqual(projectTurnSystemContext({
    role: 'goal_runner',
    workspaceId: 'ws-1',
    context: { roster: [{ sessionId: 'sess-x', title: 'nope' }] },
  }), {});
  assert.deepEqual(projectTurnSystemContext(null), {});
});
