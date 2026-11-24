import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPeerCoreClient } from './peer-core-client.mjs';
import { setupRemoteAccess } from './runtime-gateway/setup-remote-access.mjs';
import { createAutomationRunner } from './automation-runner.mjs';
import { createAutomationStore } from './automation-store.mjs';
import { createConversationStore } from './conversation-store.mjs';
import {
  createBotProfileStore,
  createHostLease,
  createMemoryStore,
  createObjectiveStore,
  createProjectInputDraftStore,
  listBotWorkspaceIds,
} from '@peer-agent/runtime-node';
import { createApprovalStore, createGoalPlanStore } from '@peer-agent/runtime-node/storage';
import { createProjectRegistry } from '@peer-agent/runtime-node/providers';
import {
  createBotAccessPolicyAuthority,
  createBotDirectory,
  createInputQueue,
  createProjectInbox,
} from '@peer-agent/runtime-node/project-agent';
import { createProjectMemoryService } from './project-agent/project-memory-service.mjs';
import { createProjectObjectivesService } from './project-agent/project-objectives-service.mjs';
import { createProjectAgentApplicationService } from './project-agent/project-agent-application-service.mjs';
import { createDiagnosticsExport } from './project-agent/diagnostics-export.mjs';
import { createEvidenceReader } from './project-agent/evidence-reader.mjs';
import {
  createEvidenceDeliveryProjection,
  createScopedExternalEvidenceReader,
} from './project-agent/evidence-deliveries.mjs';
import {
  beginCompaction,
  endCompaction,
  failCompaction,
  getCompaction,
  updateCompactionProgress,
  __resetCompactionRegistry,
} from './compaction-registry.mjs';
import {
  DESKTOP_EXTERNAL_CAPABILITY_PREFIXES,
  collectDesktopExternalCapabilities,
  createClassicCoreBridge,
} from './classic-core-bridge.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolveTestBinary() {
  const filename = process.platform === 'win32' ? 'peer-native.exe' : 'peer-native';
  const candidates = [
    process.env.PEER_CORE_BINARY_PATH?.trim(),
    path.join(REPO_ROOT, 'target/debug', filename),
    path.join(REPO_ROOT, 'target/release', filename),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `Expected built peer-native binary in one of: ${candidates.join(', ')}`);
  return found;
}

function makeTempDirs() {
  const root = mkdtempSync(path.join(tmpdir(), 'classic-core-bridge-e2e-'));
  const dataHome = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  mkdirSync(path.join(dataHome, 'conversations'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    dataHome,
    workspace,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedPreparedConversation({ dataHome, workspace, conversationId, userText, assistantMessageId, mode = 'chat' }) {
  const convDir = path.join(dataHome, 'conversations');
  const now = new Date().toISOString();
  const userMsg = {
    id: `msg-user-${conversationId}`,
    role: 'user',
    content: userText,
    createdAt: now,
  };
  const assistantMsg = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    segments: [],
    createdAt: now,
  };
  const jsonlPath = path.join(convDir, `${conversationId}.jsonl`);
  writeFileSync(jsonlPath, `${JSON.stringify(userMsg)}\n${JSON.stringify(assistantMsg)}\n`, 'utf8');

  const indexPath = path.join(convDir, 'index.jsonl');
  const meta = {
    id: conversationId,
    title: userText.slice(0, 40),
    workspacePath: workspace,
    mode,
    fastMode: false,
    preferredExecutionIsolation: 'none',
    effort: 'default',
    modelProviderId: null,
    status: 'active',
    archivedAt: null,
    lastReadAt: now,
    pinnedAt: null,
    pinnedOrder: null,
    messageCount: 2,
    contentRevision: 2,
    contextSnapshot: null,
    createdAt: now,
    updatedAt: now,
  };
  const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  writeFileSync(indexPath, `${existingIndex}${JSON.stringify(meta)}\n`, 'utf8');
}

function sseText(thinking, content) {
  return [
    `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: thinking }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function sseToolCall(callId, name, args) {
  return [
    `data: ${JSON.stringify({ id: 'c-tool', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'c-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

async function startMockSseServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // ignore non-json
      }
      requests.push({ url: req.url, body });
      handler({ req, body, res, index: requests.length - 1 });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('collectDesktopExternalCapabilities excludes search aggregate and includes modeScopes', () => {
  const caps = collectDesktopExternalCapabilities();
  assert.ok(caps.length > 0);
  const byId = new Map(caps.map((c) => [c.capabilityId, c]));
  assert.equal(byId.has('local.search.aggregate'), false);
  for (const cap of caps) {
    assert.ok(
      DESKTOP_EXTERNAL_CAPABILITY_PREFIXES.some((prefix) => cap.capabilityId.startsWith(prefix)),
    );
    assert.ok(Array.isArray(cap.manifest.modeScopes) && cap.manifest.modeScopes.length > 0);
  }
  const viewImage = byId.get('local.image.read');
  assert.ok(viewImage);
  assert.equal(viewImage.alias, 'view_image');
  assert.ok(viewImage.manifest.modeScopes.includes('chat'));
  assert.ok(viewImage.manifest.modeScopes.includes('plan'));

  const automation = byId.get('local.automation.propose');
  assert.ok(automation);
  assert.deepEqual(automation.manifest.modeScopes, ['chat']);
});

test('E2E: Node bridge <-> peer-native core --stdio executes chat streaming, permissions, external capabilities, abort, and reattach', async () => {
  const { dataHome, workspace, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();

  let slowResRef = null;
  const mockServer = await startMockSseServer(({ body, res, index }) => {
    const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const lastTool = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'tool');

    if (prompt.includes('abort_me')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write(`data: ${JSON.stringify({ id: 'slow', choices: [{ index: 0, delta: { role: 'assistant', content: 'working slowly...' }, finish_reason: null }] })}\n\n`);
      slowResRef = res;
      return;
    }

    if (prompt.includes('write_file_test')) {
      if (!lastTool) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseToolCall('call-w1', 'write_file', { path: 'e2e.txt', content: 'node-rust-e2e' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseText('', 'Wrote e2e.txt cleanly.'));
      return;
    }

    if (prompt.includes('external_tool_test')) {
      if (!lastTool) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseToolCall('call-ext', 'browser_open_panel', { url: 'https://example.org' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseText('', 'Browser panel opened via reverse host RPC.'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseText(`plan step ${index}`, 'Simple stream reply ok.'));
  });

  const sentEvents = [];
  const broadcasts = [];
  const mockWebContents = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      sentEvents.push({ channel, payload });
    },
  };
  const externalExecutions = [];
  const mockLocalToolHost = {
    execute: async (request, context) => {
      externalExecutions.push({ request, context });
      return {
        ok: true,
        result: {
          status: 'success',
          output: { openedUrl: request.call?.arguments?.url, via: 'mock-desktop-host' },
          evidence: { artifactRefs: ['artifact://browser-panel-1'] },
        },
      };
    },
  };

  let client = null;
  let bridge = null;
  bridge = createClassicCoreBridge({
    getClient: () => client,
    getLocalToolHost: () => mockLocalToolHost,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    logger: { info() {}, warn() {}, error() {} },
  });

  const externalCapabilities = collectDesktopExternalCapabilities();
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    env: {
      PEER_MODEL_API_KEY: 'test-key-123',
      PEER_MODEL_ID: 'e2e-mock-gpt',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-e2e', version: '0.1.0-test' },
    externalCapabilities,
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    assert.equal(bridge.isAvailable(), true);
    assert.equal(bridge.canHandleChatSend({ mode: 'chat' }), true);
    assert.equal(bridge.canHandleChatSend({ mode: 'plan' }), true);
    assert.equal(bridge.canHandleChatSend({ mode: 'goal' }), true);
    assert.equal(bridge.canHandleGoalPlan({ planId: 'p1', delegationOrigin: null }), true);
    assert.equal(bridge.canHandleGoalPlan({ planId: 'p2', delegationOrigin: { sessionId: 'bot-1' } }), false);
    assert.equal(bridge.canHandleGoalPlan({ planId: 'p3', parentPlanId: 'parent-1' }), false);

    // 1. Streaming chat turn + single-row JSONL persistence
    seedPreparedConversation({
      dataHome,
      workspace,
      conversationId: 'conv-e2e-1',
      userText: 'hello plain',
      assistantMessageId: 'msg-a-1',
    });
    const out1 = await bridge.send({
      conversationId: 'conv-e2e-1',
      streamId: 'stream-e2e-1',
      assistantMessageId: 'msg-a-1',
      workspacePath: workspace,
      mode: 'chat',
    }, mockWebContents);

    assert.equal(out1.ok, true);
    assert.equal(out1.status, 'completed');
    assert.equal(out1.text, 'Simple stream reply ok.');
    assert.ok(sentEvents.some((e) => e.channel === 'chat:stream:thinking'));
    assert.ok(sentEvents.some((e) => e.channel === 'chat:stream:delta'));
    assert.ok(sentEvents.some((e) => e.channel === 'chat:stream:done'));
    const jsonl1 = readFileSync(path.join(dataHome, 'conversations', 'conv-e2e-1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(jsonl1.length, 2);
    assert.equal(jsonl1[1].id, 'msg-a-1');
    assert.equal(jsonl1[1].content, 'Simple stream reply ok.');

    // 2. Built-in Rust tool call (write_file) with permission approval via bridge
    sentEvents.length = 0;
    seedPreparedConversation({
      dataHome,
      workspace,
      conversationId: 'conv-e2e-2',
      userText: 'write_file_test',
      assistantMessageId: 'msg-a-2',
    });
    const writePromise = bridge.send({
      conversationId: 'conv-e2e-2',
      streamId: 'stream-e2e-2',
      assistantMessageId: 'msg-a-2',
      workspacePath: workspace,
      mode: 'chat',
    }, {
      isDestroyed: () => false,
      send: (channel, payload) => {
        sentEvents.push({ channel, payload });
        if (channel === 'chat:stream:permission-request') {
          const toolCallId = payload?.call?.toolCallId;
          assert.equal(bridge.ownsPermission(toolCallId), true);
          const handled = bridge.resolvePermissionGrant(toolCallId, {
            granted: true,
            duration: 'once',
          });
          assert.equal(handled, true);
        }
      },
    });
    const out2 = await writePromise;
    assert.equal(out2.ok, true);
    assert.equal(out2.text, 'Wrote e2e.txt cleanly.');
    assert.equal(readFileSync(path.join(workspace, 'e2e.txt'), 'utf8'), 'node-rust-e2e');

    // 3. External Desktop capability round-trip via host.capability.execute
    sentEvents.length = 0;
    await bridge.setLocalAccessLevel('session_local');
    seedPreparedConversation({
      dataHome,
      workspace,
      conversationId: 'conv-e2e-3',
      userText: 'external_tool_test',
      assistantMessageId: 'msg-a-3',
    });
    const out3 = await bridge.send({
      conversationId: 'conv-e2e-3',
      streamId: 'stream-e2e-3',
      assistantMessageId: 'msg-a-3',
      workspacePath: workspace,
      mode: 'chat',
    }, {
      isDestroyed: () => false,
      send: (channel, payload) => {
        sentEvents.push({ channel, payload });
        if (channel === 'chat:stream:permission-request') {
          bridge.resolvePermissionGrant(payload.call.toolCallId, { granted: true, duration: 'once' });
        }
      },
    });
    assert.equal(out3.ok, true);
    assert.equal(out3.text, 'Browser panel opened via reverse host RPC.');
    assert.equal(externalExecutions.length, 1);
    assert.equal(externalExecutions[0].request.call.capabilityId, 'local.web.control.openPanel');
    assert.equal(externalExecutions[0].request.call.arguments.url, 'https://example.org');

    // 4. Reattach + abort
    seedPreparedConversation({
      dataHome,
      workspace,
      conversationId: 'conv-e2e-4',
      userText: 'abort_me',
      assistantMessageId: 'msg-a-4',
    });
    let sawFirstDelta;
    const firstDeltaPromise = new Promise((resolve) => {
      sawFirstDelta = resolve;
    });
    const abortPromise = bridge.send({
      conversationId: 'conv-e2e-4',
      streamId: 'stream-e2e-4',
      assistantMessageId: 'msg-a-4',
      workspacePath: workspace,
      mode: 'chat',
    }, {
      isDestroyed: () => false,
      send: (channel, payload) => {
        if (channel === 'chat:stream:delta' && payload.content === 'working slowly...') {
          sawFirstDelta();
        }
      },
    });
    await firstDeltaPromise;
    assert.equal(bridge.ownsStream('stream-e2e-4'), true);
    assert.deepEqual(bridge.listActiveSync().conversationIds, ['conv-e2e-4']);

    const snap = await bridge.reattach({ streamId: 'stream-e2e-4' });
    assert.equal(snap.isStreaming, true);
    assert.equal(snap.accumulatedText, 'working slowly...');

    const abortRes = await bridge.abort('stream-e2e-4');
    assert.equal(abortRes.aborted, true);
    const out4 = await abortPromise;
    assert.equal(out4.aborted, true);
    assert.equal(out4.status, 'aborted');

    try {
      slowResRef?.end();
    } catch {
      // ignore if already closed
    }
  } finally {
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});

function seedGoalPlanFile({ dataHome, plan }) {
  const goalDir = path.join(dataHome, 'goal-plans');
  mkdirSync(goalDir, { recursive: true });
  writeFileSync(path.join(goalDir, `${plan.planId}.json`), JSON.stringify(plan, null, 2), 'utf8');
  const indexPath = path.join(goalDir, 'index.jsonl');
  const row = {
    planId: plan.planId,
    title: plan.title,
    status: plan.status,
    workflowKind: plan.workflowKind,
    conversationId: plan.conversationId,
    originWorkspacePath: plan.originWorkspacePath,
    targetWorkspacePath: plan.targetWorkspacePath,
    version: plan.version,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    percent: 0,
  };
  const prev = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  writeFileSync(indexPath, `${prev}${JSON.stringify(row)}\n`, 'utf8');
}

function extractLastToolEvidenceRef(body) {
  for (const msg of [...(body?.messages ?? [])].reverse()) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed?.evidenceRefs) && parsed.evidenceRefs[0]) {
        return parsed.evidenceRefs[0];
      }
    } catch {
      // ignore non-json tool content
    }
  }
  return null;
}

test('E2E: Node bridge <-> peer-native core --stdio drives Goal Runner with worktree, visual repair, pause, resume, and clear', async () => {
  const { root, dataHome, workspace: originWorkspace, cleanup } = makeTempDirs();
  const worktreeWorkspace = path.join(root, 'worktree-ws');
  mkdirSync(worktreeWorkspace, { recursive: true });
  const binaryPath = resolveTestBinary();
  const planId = 'e2e-goal-visual-1';
  const convId = 'conv-goal-e2e-1';
  const now = new Date().toISOString();

  seedPreparedConversation({
    dataHome,
    workspace: originWorkspace,
    conversationId: convId,
    userText: 'Build feature in worktree',
    assistantMessageId: 'msg-init-asst',
    mode: 'goal',
  });
  seedGoalPlanFile({
    dataHome,
    plan: {
      planId,
      conversationId: convId,
      originWorkspacePath: originWorkspace,
      targetWorkspacePath: originWorkspace,
      title: 'Worktree Visual Goal',
      goal: 'Create widget.txt in isolated worktree',
      tasks: [{
        taskId: 't1',
        title: 'Write widget.txt',
        status: 'pending',
        involvedFiles: ['widget.txt'],
      }],
      successCriteria: [{ id: 'c1', kind: 'model_review', description: 'widget.txt exists' }],
      status: 'accepted',
      workflowKind: 'goal_self_driven',
      activation: { kind: 'accepted_goal', acceptedAt: now, acceptedBy: 'user' },
      version: 1,
      createdAt: now,
      updatedAt: now,
      progress: { total: 1, completed: 0, failed: 0, blocked: 0, percent: 0 },
    },
  });

  let llmCallIndex = 0;
  let releasePausedTurn = null;
  let onPauseTurnStarted;
  const pauseTurnStarted = new Promise((resolve) => {
    onPauseTurnStarted = resolve;
  });

  const mockServer = await startMockSseServer(({ body, res }) => {
    const step = llmCallIndex++;
    if (step === 0) {
      // First start -> pause mid-flight test
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'g-p', choices: [{ index: 0, delta: { role: 'assistant', content: 'starting...' }, finish_reason: null }] })}\n\n`);
      releasePausedTurn = () => {
        try {
          res.end(sseText('', ' paused chunk'));
        } catch {
          // socket already closed
        }
      };
      onPauseTurnStarted();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step === 1) {
      res.end(sseToolCall('call-w1', 'write_file', { path: 'widget.txt', content: 'draft-v1' }));
      return;
    }
    if (step === 2) {
      const evRef = extractLastToolEvidenceRef(body);
      assert.ok(evRef);
      res.end(sseToolCall('call-u1', 'goal_update_task', {
        planId,
        taskId: 't1',
        status: 'completed',
        evidenceRefs: [evRef],
        result: 'Wrote draft-v1',
      }));
      return;
    }
    if (step === 3) {
      res.end(sseText('', 'Draft v1 complete.'));
      return;
    }
    if (step === 4) {
      res.end(sseToolCall('call-ver-1', 'read_file', { path: 'widget.txt' }));
      return;
    }
    if (step === 5) {
      const evRef = extractLastToolEvidenceRef(body);
      res.end(sseText('', JSON.stringify({
        passed: true,
        failedCriteria: [],
        missingEvidence: [],
        risks: [],
        evidenceRefs: [evRef],
        summary: 'Verifier 1 passed',
        recommendedNextAction: 'complete',
      })));
      return;
    }
    if (step === 6) {
      res.end(sseToolCall('call-r2', 'read_file', { path: 'widget.txt' }));
      return;
    }
    if (step === 7) {
      res.end(sseToolCall('call-w2', 'write_file', { path: 'widget.txt', content: 'final-v2', allow_overwrite: true }));
      return;
    }
    if (step === 8) {
      const evRef = extractLastToolEvidenceRef(body);
      res.end(sseToolCall('call-u2', 'goal_update_task', {
        planId,
        taskId: 't1',
        status: 'completed',
        evidenceRefs: [evRef],
        result: 'Fixed visual defect in final-v2',
      }));
      return;
    }
    if (step === 9) {
      res.end(sseText('', 'Applied visual fix.'));
      return;
    }
    if (step === 10) {
      res.end(sseToolCall('call-ver-2', 'read_file', { path: 'widget.txt' }));
      return;
    }
    const evRef = extractLastToolEvidenceRef(body);
    res.end(sseText('', JSON.stringify({
      passed: true,
      failedCriteria: [],
      missingEvidence: [],
      risks: [],
      evidenceRefs: [evRef],
      summary: 'Verifier 2 passed',
      recommendedNextAction: 'complete',
    })));
  });

  const planChanges = [];
  const runnerChanges = [];
  let prepareCalls = 0;
  let visualCalls = 0;
  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    broadcast: (channel, payload) => {
      if (channel === 'goalRunner:changed') runnerChanges.push(payload);
    },
    onGoalPlanChanged: (payload) => planChanges.push(payload),
    prepareGoalWorkspace: async ({ planId: targetPlanId }) => {
      prepareCalls += 1;
      const planFile = path.join(dataHome, 'goal-plans', `${targetPlanId}.json`);
      const plan = JSON.parse(readFileSync(planFile, 'utf8'));
      plan.deliveryBinding = {
        executionIsolation: 'worktree',
        worktreePath: worktreeWorkspace,
        targetWorkspacePath: originWorkspace,
      };
      writeFileSync(planFile, JSON.stringify(plan, null, 2), 'utf8');
      return { workspacePath: worktreeWorkspace };
    },
    runVisualVerification: async ({ workspacePath }) => {
      visualCalls += 1;
      assert.ok(workspacePath.includes('worktree-ws'));
      if (visualCalls === 1) {
        return {
          required: true,
          passed: false,
          report: {
            passed: false,
            summary: 'Button overlaps label',
            findings: [{ summary: 'Button overlaps label' }],
            evidenceRefs: ['desktop-preview://e2e-1'],
          },
        };
      }
      return {
        required: true,
        passed: true,
        report: {
          passed: true,
          summary: 'Visual layout ok',
          evidenceRefs: ['desktop-preview://e2e-2'],
        },
      };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    env: {
      PEER_MODEL_API_KEY: 'test-key-goal',
      PEER_MODEL_ID: 'e2e-mock-gpt',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-goal-e2e', version: '0.1.0-test' },
    externalCapabilities: [],
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    await bridge.setLocalAccessLevel('full_local');

    // Start + Pause mid-flight
    const started = await bridge.startGoalRunner(planId);
    assert.equal(started.runner.status, 'running');
    await pauseTurnStarted;
    const paused = await bridge.pauseGoalRunner(planId, 'paused');
    assert.equal(paused.planStatus, 'paused');
    assert.equal(paused.runner.status, 'paused');
    releasePausedTurn?.();

    // Resume -> runs to completion through worktree + text verifier + visual fail/repair/pass
    const completed = await bridge.resumeGoalRunner(planId, { awaitIdle: true });
    assert.equal(completed.planStatus, 'completed');
    assert.equal(completed.runner.status, 'completed');
    assert.equal(completed.runner.visualVerification.passed, true);
    assert.equal(readFileSync(path.join(worktreeWorkspace, 'widget.txt'), 'utf8'), 'final-v2');
    assert.equal(existsSync(path.join(originWorkspace, 'widget.txt')), false);
    assert.equal(prepareCalls, 2);
    assert.equal(visualCalls, 2);
    assert.ok(planChanges.length > 0);
    assert.ok(runnerChanges.some((e) => e.type === 'goalRunner:streamStarted' && e.streamId && e.assistantMessageId));
    assert.ok(runnerChanges.some((e) => e.type === 'goalRunner:visualRepairStarted'));
    assert.ok(runnerChanges.some((e) => e.type === 'goalRunner:completed'));

    // getState + clear
    const state = await bridge.getGoalRunnerState(planId);
    assert.equal(state.planStatus, 'completed');
    const cleared = await bridge.clearGoalRunner(planId, 'cleared');
    assert.equal(cleared.planStatus, 'cancelled');
    assert.equal(cleared.runner.status, 'idle');
  } finally {
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});

test('E2E: Node bridge <-> peer-native core --stdio handles Classic peripheral domains (conversations, usage, skills, mcp, llm)', async () => {
  const { root, dataHome, workspace, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();
  const borrowRoot = path.join(root, 'borrow-skills');
  mkdirSync(path.join(dataHome, 'usage'), { recursive: true });
  mkdirSync(path.join(dataHome, 'skills', 'global-s'), { recursive: true });
  mkdirSync(path.join(workspace, 'skills', 'ws-s'), { recursive: true });
  mkdirSync(path.join(borrowRoot, 'borrowed-s'), { recursive: true });

  writeFileSync(
    path.join(dataHome, 'skills', 'global-s', 'SKILL.md'),
    '---\ndescription: Global skill\n---\nGlobal skill body\n',
    'utf8',
  );
  writeFileSync(
    path.join(workspace, 'skills', 'ws-s', 'SKILL.md'),
    '---\ndescription: Workspace skill\n---\nWorkspace skill body\n',
    'utf8',
  );
  writeFileSync(
    path.join(borrowRoot, 'borrowed-s', 'SKILL.md'),
    '---\ndescription: Borrowed skill\n---\nBorrowed skill body\n',
    'utf8',
  );

  writeFileSync(
    path.join(dataHome, 'usage', 'requests.jsonl'),
    `${JSON.stringify({
      id: 'req-e2e-1',
      at: '2026-11-21T02:00:00Z',
      conversationId: 'conv-e2e-u',
      modelProviderId: 'env-mock',
      model: 'e2e-mock-gpt',
      providerName: 'OpenAI',
      inputTokens: 400,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.04,
      pricingSource: 'manual',
    })}\n${JSON.stringify({
      id: 'req-e2e-2',
      at: '2026-11-21T02:02:00Z',
      conversationId: 'conv-e2e-u',
      modelProviderId: 'env-mock',
      model: 'e2e-mock-gpt',
      providerName: 'OpenAI',
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.01,
      pricingSource: 'manual',
    })}\n`,
    'utf8',
  );

  const mockServer = await startMockSseServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseText('', 'Domain LLM completion ok.'));
  });

  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });

  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    env: {
      PEER_MODEL_API_KEY: 'test-key-domains',
      PEER_MODEL_ID: 'e2e-mock-gpt',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-domains-e2e', version: '0.1.0-test' },
    externalCapabilities: [],
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();

    // 1. Conversations
    const conv = await bridge.createConversation({
      title: '',
      workspacePath: workspace,
      mode: 'chat',
    });
    assert.ok(conv?.id);
    const appended = await bridge.appendConversationMessage({
      id: conv.id,
      message: { id: 'u-1', role: 'user', content: 'Review deployment configuration' },
    });
    assert.equal(appended.messageCount, 1);
    assert.equal('messages' in appended, false);

    const listed = await bridge.listConversations({ workspacePath: workspace });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, conv.id);

    const search = await bridge.searchConversations({ query: 'Review' });
    assert.equal(search.length, 1);

    const page = await bridge.getConversation({ id: conv.id, limit: 10 });
    assert.equal(page.window.length, 1);
    assert.equal(page.meta.id, conv.id);

    const pinned = await bridge.pinConversation({ id: conv.id });
    assert.ok(pinned.pinnedAt);
    const archived = await bridge.archiveConversation({ id: conv.id });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.pinnedAt, null);
    await bridge.restoreConversation({ id: conv.id });
    await bridge.addConversationUsage({ id: conv.id, usage: { inputTokens: 10, outputTokens: 5 } });
    const remainingAfterDelete = await bridge.deleteConversation({ id: conv.id });
    assert.deepEqual(remainingAfterDelete, []);

    // 2. Usage
    const stats = await bridge.getUsageStats();
    assert.equal(stats.notes.scope, 'request_snapshot');
    assert.equal(stats.totals.inputTokens, 500);
    const daily = await bridge.getUsageDaily({ range: '7d', now: '2026-11-21T03:00:00Z', localOffsetMinutes: 0 });
    assert.equal(daily.totals.activeDayCount, 1);
    const day = await bridge.getUsageDay({ date: '2026-11-21', now: '2026-11-21T03:00:00Z', localOffsetMinutes: 0 });
    assert.equal(day.hours[2].requestCount, 2);
    const cache = await bridge.getUsageCacheHitRate();
    assert.equal(cache.byForm.first.count, 1);
    assert.equal(cache.byForm.steady.count, 1);

    // 3. Skills
    const skills = await bridge.listSkills(undefined, { activeWorkspace: workspace });
    assert.equal(skills.length, 2);
    const disabled = await bridge.disableSkill('ws-s', workspace, { activeWorkspace: workspace });
    assert.equal(disabled.find((s) => s.skillId === 'ws-s').enabled, false);
    const avail = await bridge.listAvailableSkills({ sourceRoots: [borrowRoot] });
    assert.equal(avail.length, 1);
    const linkRes = await bridge.linkSkill('borrowed-s', { sourceRoots: [borrowRoot] });
    assert.equal(linkRes.ok, true);
    const skillDetail = await bridge.getSkillDetail('borrowed-s', undefined, { activeWorkspace: workspace });
    assert.equal(skillDetail.instructions, 'Borrowed skill body\n');
    const unlinkRes = await bridge.unlinkSkill('borrowed-s');
    assert.equal(unlinkRes.ok, true);

    // 4. MCP
    const server = await bridge.upsertMcpServer({
      displayName: 'E2E MCP',
      url: 'https://mcp.invalid/v1',
      headers: { Authorization: 'Bearer secret-value' },
      auth: { mode: 'http_bearer', credentialRef: 'e2e-cred' },
      tools: [{ name: 'echo', description: 'Echo tool' }],
    });
    assert.equal('headers' in server, false);
    const installed = await bridge.listInstalledMcp();
    assert.equal(installed.length, 1);
    const mcpCaps = await bridge.listMcpCapabilities();
    assert.equal(mcpCaps.length, 1);
    await bridge.setMcpToolVisibility(server.id, 'echo', false);
    assert.deepEqual(await bridge.listMcpCapabilities(), []);
    const uninstallRes = await bridge.uninstallMcpServer(server.id);
    assert.deepEqual(uninstallRes.servers, []);
    assert.equal(uninstallRes.boundCredentialRef, 'mcp-cred:e2e-cred');

    // 5. LLM
    const catalog = await bridge.listLlmCatalog();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].modelId, 'e2e-mock-gpt');
    const completion = await bridge.completeLlmPrompt({ prompt: 'Hello from Node E2E', maxTokens: 100 });
    assert.equal(completion.success, true);
    assert.equal(completion.text, 'Domain LLM completion ok.');
  } finally {
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});

test('bridge syncs compaction registry, rejects resourceFeedback chat, and tracks active assistantMessageId', async () => {
  __resetCompactionRegistry();
  const broadcasts = [];
  const sent = [];
  const fakeClient = {
    isReady: () => true,
    request: async (method, params) => {
      sent.push({ method, params });
      return { accepted: true };
    },
  };
  const bridge = createClassicCoreBridge({
    getClient: () => fakeClient,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    compactionRegistry: {
      beginCompaction,
      updateCompactionProgress,
      failCompaction,
      endCompaction,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(bridge.canHandleChatSend({ mode: 'chat' }), true);
  assert.equal(bridge.canHandleChatSend({ mode: 'chat', hasResourceFeedback: true }), false);

  bridge.handleNotification('chat:stream:compaction', {
    conversationId: 'c-1',
    streamId: 's-compact-1',
    stage: 'start',
  });
  assert.deepEqual(getCompaction('c-1'), {
    compacting: true,
    streamId: 's-compact-1',
    percent: null,
    manual: true,
  });
  bridge.handleNotification('chat:stream:compaction', {
    conversationId: 'c-1',
    streamId: 's-compact-1',
    stage: 'progress',
    percent: 55,
  });
  assert.equal(getCompaction('c-1').percent, 55);
  bridge.handleNotification('chat:stream:compaction', {
    conversationId: 'c-1',
    streamId: 's-compact-1',
    stage: 'done',
  });
  assert.equal(getCompaction('c-1'), null);
  assert.ok(broadcasts.every((e) => e.channel === 'chat:compaction'));

  // Failed state is preserved in compactionRegistry, and unexpected exit clears running state.
  bridge.handleNotification('chat:stream:compaction', {
    conversationId: 'c-2',
    streamId: 's-compact-2',
    stage: 'start',
  });
  bridge.handleNotification('chat:stream:compaction', {
    conversationId: 'c-2',
    streamId: 's-compact-2',
    stage: 'failed',
    errorCode: 'COMPACT_ERR',
    message: 'boom',
  });
  assert.equal(getCompaction('c-2').phase, 'failed');

  bridge.handleNotification('chat:stream:compaction', {
    conversationId: 'c-3',
    streamId: 's-compact-3',
    stage: 'start',
  });
  bridge.handleUnexpectedExit();
  assert.equal(getCompaction('c-3'), null);

  // Active stream tracking exposes assistantMessageId for selection runtime state.
  const turnPromise = bridge.send({
    streamId: 'stream-sel-1',
    conversationId: 'c-sel',
    assistantMessageId: 'msg-assistant-sel',
    workspacePath: '/tmp/ws',
    mode: 'chat',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const active = bridge.getActiveStreamsForConversation('c-sel');
  assert.equal(active.length, 1);
  assert.equal(active[0].assistantMessageId, 'msg-assistant-sel');
  bridge.handleNotification('chat:stream:done', { streamId: 'stream-sel-1', conversationId: 'c-sel' });
  const outcome = await turnPromise;
  assert.equal(outcome.terminalStatus, 'done');
  assert.deepEqual(bridge.getActiveStreamsForConversation('c-sel'), []);
});

test('E2E: Node bridge <-> peer-native handles Desktop settings, configInstructions, attachments, extensions, and compact', async () => {
  const { dataHome, workspace, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();
  writeFileSync(
    path.join(dataHome, 'settings.json'),
    JSON.stringify({
      schemaVersion: 3,
      projectAgent: { shell: 'classic', interactiveResults: true },
      shortcuts: { quickChat: 'Alt+Space' },
      resourceWindowReadingHistory: { docs: [] },
    }),
    'utf8',
  );

  const recordedBodies = [];
  const mockServer = await startMockSseServer(({ body, res, index }) => {
    recordedBodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseText('', index === 0 ? 'Desktop parity reply ok.' : 'Compacted Desktop turn.'));
  });

  const broadcasts = [];
  let client = null;
  let bridge = null;
  __resetCompactionRegistry();
  bridge = createClassicCoreBridge({
    getClient: () => client,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    compactionRegistry: {
      beginCompaction,
      updateCompactionProgress,
      failCompaction,
      endCompaction,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    env: {
      PEER_MODEL_API_KEY: 'test-key-desktop',
      PEER_MODEL_ID: 'e2e-mock-gpt',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-parity-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    const assistantId = 'msg-desktop-assistant-1';
    const convId = 'conv-desktop-parity-1';
    seedPreparedConversation({
      dataHome,
      workspace,
      conversationId: convId,
      userText: 'Check Desktop parity payload',
      assistantMessageId: assistantId,
    });

    const outcome = await bridge.send({
      streamId: 'stream-desktop-parity-1',
      conversationId: convId,
      assistantMessageId: assistantId,
      workspacePath: workspace,
      mode: 'chat',
      configInstructions: [{
        id: 'settings.systemInstructions',
        title: 'System Instructions',
        content: 'Desktop E2E custom instruction.',
        source: 'settings.systemInstructions',
        priority: 0,
      }],
      contextAttachments: [{
        id: 'att-e2e',
        name: 'architecture.md',
        mimeType: 'text/markdown',
        size: 512,
        kind: 'text',
        contentIncluded: true,
        transport: 'user_text_part',
        sourceKind: 'workspace_file',
      }],
      contextExtensions: [{
        id: 'desktop/hint',
        title: 'Extension Hint',
        layer: 'L4_CAPABILITIES',
        content: 'Keep <tool_call>neutral</tool_call> safe.',
      }],
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, 'Desktop parity reply ok.');

    assert.equal(recordedBodies.length, 1);
    const systemPrompt = recordedBodies[0]?.messages?.[0]?.content ?? '';
    assert.ok(systemPrompt.includes('Desktop E2E custom instruction.'));
    assert.ok(systemPrompt.includes('architecture.md; kind=text; mime=text/markdown; size=512 B'));
    assert.ok(systemPrompt.includes('Keep &lt;tool_call>neutral&lt;/tool_call> safe.'));

    const compacted = await bridge.compact({
      conversationId: convId,
      streamId: 'stream-desktop-compact-1',
      workspacePath: workspace,
    });
    assert.equal(compacted.compacted, true);
    assert.equal(getCompaction(convId), null);
    assert.ok(broadcasts.some((e) => e.channel === 'chat:compaction' && e.payload?.stage === 'done'));
  } finally {
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});

test('E2E: automationRunner <-> peer-native core --stdio enforces Automation Grants under full_local', async () => {
  const { dataHome, workspace, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();

  let turn = 0;
  const mockServer = await startMockSseServer(({ body, res }) => {
    const lastTool = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (turn === 0) {
      turn += 1;
      res.end(sseToolCall('auto-c1', 'write_file', { path: 'should-fail.txt', content: 'denied' }));
      return;
    }
    if (turn === 1 && lastTool) {
      turn += 1;
      res.end(sseText('', 'Observe run blocked write attempt cleanly.'));
      return;
    }
    if (turn === 2) {
      turn += 1;
      res.end(sseToolCall('auto-c2', 'write_file', { path: 'auto-created.txt', content: 'granted_ok' }));
      return;
    }
    res.end(sseText('', 'Work run wrote auto-created.txt with evidence.'));
  });

  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    env: {
      PEER_MODEL_API_KEY: 'test-key-auto',
      PEER_MODEL_ID: 'e2e-mock-gpt',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-auto-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    await bridge.setLocalAccessLevel('full_local');

    const automationStore = createAutomationStore({ storeDir: path.join(dataHome, 'automations') });
    const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
    const def = automationStore.createDefinition({
      name: 'Rust Automation E2E',
      prompt: 'Attempt write',
      workspacePath: workspace,
      schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
      grant: {
        preset: 'observe',
        workspacePath: workspace,
        allowedCapabilityIds: ['local.file.read'],
        askCapabilityIds: [],
        blockedCapabilityIds: [],
        confirmedAt: '2026-11-21T00:00:00.000Z',
        version: 1,
      },
      notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
      budget: { timeoutMs: 60_000 },
      missedRunPolicy: 'run_latest',
      overlapPolicy: 'skip',
      status: 'active',
    }, { automationId: 'auto-e2e-1', now: '2026-11-21T00:00:00.000Z' });

    const bgEvents = [];
    const runner = createAutomationRunner({
      store: automationStore,
      conversationStore,
      classicCoreBridge: bridge,
      onBackgroundEvent: (evt) => bgEvents.push(evt),
      logger: { info() {}, warn() {}, error() {} },
    });

    // 1. Observe preset blocks write_file even under full_local.
    const observeRun = automationStore.createRun({
      automationId: def.automationId,
      idempotencyKey: 'auto-e2e-1:observe',
      triggerSource: 'manual',
      status: 'scheduled',
      scheduledAt: '2026-11-21T00:01:00.000Z',
      snapshot: {
        definitionVersion: def.version,
        name: def.name,
        prompt: def.prompt,
        workspacePath: def.workspacePath,
        schedule: def.schedule,
        grant: def.grant,
        budget: def.budget,
      },
    }, { runId: 'run-observe-1', now: '2026-11-21T00:01:00.000Z' });
    const res1 = await runner.run(observeRun);
    assert.equal(res1.status, 'succeeded');
    assert.equal(existsSync(path.join(workspace, 'should-fail.txt')), false);
    assert.equal(res1.receipt.summary, 'Observe run blocked write attempt cleanly.');
    assert.ok(bgEvents.some((e) => e.channel === 'chat:stream:tool-result' && String(e.payload?.result).includes('automation_observe_read_only')));

    // 2. work_in_workspace preset permits local.file.write and records evidenceRefs in receipt.
    const workRun = automationStore.createRun({
      automationId: def.automationId,
      idempotencyKey: 'auto-e2e-1:work',
      triggerSource: 'manual',
      status: 'scheduled',
      scheduledAt: '2026-11-21T00:02:00.000Z',
      snapshot: {
        definitionVersion: def.version,
        name: def.name,
        prompt: def.prompt,
        workspacePath: def.workspacePath,
        schedule: def.schedule,
        grant: {
          preset: 'work_in_workspace',
          workspacePath: workspace,
          allowedCapabilityIds: ['local.file.write'],
          askCapabilityIds: [],
          blockedCapabilityIds: [],
          confirmedAt: '2026-11-21T00:00:00.000Z',
          version: 1,
        },
        budget: def.budget,
      },
    }, { runId: 'run-work-1', now: '2026-11-21T00:02:00.000Z' });
    const res2 = await runner.run(workRun);
    assert.equal(res2.status, 'succeeded');
    assert.equal(readFileSync(path.join(workspace, 'auto-created.txt'), 'utf8'), 'granted_ok');
    assert.equal(res2.receipt.summary, 'Work run wrote auto-created.txt with evidence.');
    assert.ok(Array.isArray(res2.receipt.evidenceRefs) && res2.receipt.evidenceRefs.length > 0);
  } finally {
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});

test('E2E: project-memory, project-objectives, and unknown-outcome policy run through peer-native core --stdio', async () => {
  const binaryPath = resolveTestBinary();
  const { root, dataHome, cleanup } = makeTempDirs();
  const workspaceId = 'ws-project-e2e';

  const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const conv = conversationStore.createConversation({
    title: '项目助理',
    role: 'project_agent',
    workspaceId,
    mode: 'chat',
  });
  const profileStore = createBotProfileStore({ rootDir: dataHome });
  profileStore.create({
    workspaceId,
    displayName: '登录助手',
    agentConversationId: conv.id,
  });

  // Seed a stated memory and a TS-conflicted pair on disk.
  const seedMemoryStore = createMemoryStore({
    rootDir: dataHome,
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  });
  const stated = seedMemoryStore.rememberStated({
    workspaceId,
    kind: 'fact',
    text: '登录页在 src/login.tsx',
    anchorMessageId: 'u-mem-1',
    messages: [{ id: 'u-mem-1', kind: 'user_input', content: '记住' }],
  }).item;
  const confA = seedMemoryStore.writeVerified({
    workspaceId,
    kind: 'fact',
    text: 'Choice A',
    sourceRefs: ['ev-a'],
    topicKey: 'choice',
    topicValue: 'a',
  }).item;
  const confB = seedMemoryStore.writeVerified({
    workspaceId,
    kind: 'fact',
    text: 'Choice B',
    sourceRefs: ['ev-b'],
    topicKey: 'choice',
    topicValue: 'b',
  }).item;

  // Seed an active objective on disk.
  const seedObjectiveStore = createObjectiveStore({ rootDir: dataHome });
  const createdObjective = seedObjectiveStore.create({
    workspaceId,
    projectAgentConversationId: conv.id,
    originMessageId: 'u-obj-0',
    title: '守护登录回归',
    outcome: '保持 auth 测试全部通过',
    autonomy: 'propose',
    createdBy: 'user_request',
  });
  assert.equal(createdObjective.ok, true);
  const objectiveId = createdObjective.item.objectiveId;

  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    clientInfo: { name: 'peer-desktop-project-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();

    // 1. project-memory service via Rust core RPC
    let settings = { memory: { enabled: true, learnPreferences: true } };
    const memChanged = [];
    const exportPath = path.join(root, 'exported-memory.json');
    const memoryService = createProjectMemoryService({
      classicCoreBridge: bridge,
      getSettings: () => settings,
      mergeSettings(patch) {
        settings.memory = { ...settings.memory, ...patch.memory };
      },
      showSaveDialog: async () => ({ canceled: false, filePath: exportPath }),
      onChanged: (ws) => memChanged.push(ws),
    });

    const memList = await memoryService.list({ workspaceId });
    assert.equal(memList.ok, true);
    assert.equal(memList.switches.memoryEnabled, true);
    assert.ok(memList.items.some((item) => item.id === stated.id));

    const pinned = await memoryService.pin({ workspaceId, id: stated.id, pinned: true });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.item.pinned, true);

    const forgot = await memoryService.forget({ workspaceId, id: stated.id, reason: '暂不需要' });
    assert.equal(forgot.ok, true);
    assert.equal(forgot.item.status, 'forgotten');

    const restored = await memoryService.restore({ workspaceId, id: stated.id });
    assert.equal(restored.ok, true);
    assert.equal(restored.item.status, 'active');

    const needChoice = await memoryService.restore({ workspaceId, id: confA.id });
    assert.equal(needChoice.ok, false);
    assert.equal(needChoice.code, 'CONFLICT_CHOICE_REQUIRED');

    const resolved = await memoryService.restore({ workspaceId, id: confB.id, resolveConflict: true });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.item.status, 'active');
    assert.equal(seedMemoryStore.get(confA.id).status, 'forgotten');

    const edited = await memoryService.edit({ workspaceId, id: stated.id, text: '登录页在 src/auth/login.tsx' });
    assert.equal(edited.ok, true);
    assert.equal(edited.revokedId, stated.id);
    assert.equal(edited.item.text, '登录页在 src/auth/login.tsx');

    const exported = await memoryService.exportMemory({ workspaceId, format: 'json' });
    assert.equal(exported.ok, true);
    assert.match(readFileSync(exportPath, 'utf8'), /src\/auth\/login\.tsx/);

    const sw = await memoryService.setSwitches({
      workspaceId,
      memoryEnabled: false,
      useMemory: false,
    });
    assert.equal(sw.ok, true);
    assert.deepEqual(sw.switches, {
      memoryEnabled: false,
      useMemory: false,
      learnPreferences: true,
    });
    assert.equal(profileStore.read(workspaceId).memoryEnabled, false);
    assert.ok(memChanged.length >= 5);

    // 2. project-objectives service via Rust core RPC
    const objAppended = [];
    const objChanged = [];
    const objectivesService = createProjectObjectivesService({
      classicCoreBridge: bridge,
      enabled: () => true,
      holdsLease: () => true,
      onAppendedMessage: (ev) => objAppended.push(ev),
      onChanged: (ws) => objChanged.push(ws),
    });

    const objListed = await objectivesService.list({ workspaceId });
    assert.equal(objListed.ok, true);
    assert.equal(objListed.items.length, 1);
    assert.equal(objListed.items[0].objectiveId, objectiveId);

    const updated = await objectivesService.update({
      workspaceId,
      objectiveId,
      requestId: 'req-e2e-upd',
      expectedVersion: 1,
      patch: { autonomy: 'act', autoAccept: true },
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.item.autonomy, 'act');
    assert.equal(updated.item.autoAccept, true);
    assert.equal(updated.item.version, 2);
    assert.equal(objAppended.length, 1);
    assert.equal(objAppended[0].conversationId, conv.id);

    const replayed = await objectivesService.update({
      workspaceId,
      objectiveId,
      requestId: 'req-e2e-upd',
      patch: { autonomy: 'act', autoAccept: true },
    });
    assert.equal(replayed.ok, true);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.item.version, 2);

    const reused = await objectivesService.update({
      workspaceId,
      objectiveId,
      requestId: 'req-e2e-upd',
      patch: { autonomy: 'report_only' },
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.code, 'REQUEST_ID_REUSED');

    const paused = await objectivesService.pause({ workspaceId, objectiveId, requestId: 'req-e2e-pause' });
    assert.equal(paused.ok, true);
    assert.equal(paused.item.status, 'paused');

    const resumed = await objectivesService.resume({ workspaceId, objectiveId, requestId: 'req-e2e-resume' });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.item.status, 'active');

    const closed = await objectivesService.delete({ workspaceId, objectiveId, requestId: 'req-e2e-del' });
    assert.equal(closed.ok, true);
    assert.equal(closed.item.status, 'abandoned');
    assert.equal(objChanged.length, 5);

    // 3. Bot unknown-outcome policy via Rust core RPC
    const appService = createProjectAgentApplicationService({
      enabled: () => true,
      classicCoreBridge: bridge,
    });
    const pol1 = await appService.readUnknownOutcomePolicy({ workspaceId });
    assert.equal(pol1.ok, true);
    assert.equal(pol1.policy.tier, 'ask');

    const pol2 = await appService.setUnknownOutcomePolicy({ workspaceId, tier: 'bot_verified' });
    assert.equal(pol2.ok, true);
    assert.equal(pol2.policy.tier, 'bot_verified');
    assert.equal(pol2.policy.revision, 1);

    const pol3 = await appService.readUnknownOutcomePolicy({ workspaceId });
    assert.equal(pol3.ok, true);
    assert.equal(pol3.policy.tier, 'bot_verified');
    assert.equal(pol3.policy.revision, 1);

    const pol4 = await appService.setUnknownOutcomePolicy({ workspaceId, tier: 'ask' });
    assert.equal(pol4.ok, true);
    assert.equal(pol4.policy.tier, 'ask');
    assert.equal(pol4.policy.revision, 2);
  } finally {
    await client.dispose();
    cleanup();
  }
});

test('E2E: bot profile/avatar, access policy, markRead, approvals, history, and search run through peer-native core --stdio', async () => {
  const binaryPath = resolveTestBinary();
  const { root, dataHome, workspace, cleanup } = makeTempDirs();
  const runtimeRoot = path.join(dataHome, 'project-runtime');

  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const reg = registry.ensureForPath(workspace);
  const workspaceId = reg.workspaceId;
  const wsPath = reg.path || workspace;

  const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const botConv = conversationStore.createConversation({
    title: 'Bot E2E',
    role: 'project_agent',
    workspaceId,
    workspacePath: wsPath,
    mode: 'chat',
  });
  conversationStore.appendMessage(botConv.id, {
    id: 'anchor-e2e',
    role: 'user',
    kind: 'user_input',
    content: 'Audit Stripe webhook secret rotation',
    createdAt: '2026-11-21T07:59:00.000Z',
  });
  conversationStore.appendMessage(botConv.id, {
    id: 'bot-e2e-msg-1',
    role: 'assistant',
    kind: 'agent_reply',
    content: 'Implemented webhook signature verification',
    createdAt: '2026-11-21T08:00:00.000Z',
  });
  const botHistory = conversationStore.getPersistedConversationHistory(botConv.id);
  const childConv = conversationStore.createChildConversation({
    parentConversationId: botConv.id,
    role: 'work_session',
    anchorMessageId: 'anchor-e2e',
    delegation: { sessionId: 'sess-e2e-1', anchorMessageId: 'anchor-e2e', inputId: 'input-e2e-1' },
    runtimeState: {
      conversationId: botConv.id,
      contentRevision: botHistory.contentRevision,
      status: 'idle',
    },
    capturedAt: '2026-11-21T08:01:00.000Z',
    backgroundMessageIds: ['anchor-e2e'],
    confirmMissing: true,
    title: 'Delegated worker',
    workspaceId,
    workspacePath: wsPath,
  });
  const ordConv = conversationStore.createConversation({
    title: 'Classic Workspace Thread',
    workspacePath: wsPath,
  });
  const unscopedConv = conversationStore.createConversation({
    title: 'Classic Unscoped Thread',
  });

  const profileStore = createBotProfileStore({ rootDir: dataHome });
  profileStore.create({
    workspaceId,
    displayName: 'Webhook Bot',
    agentConversationId: botConv.id,
  });

  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const stubModel = {
    modelProviderId: 'anthropic:claude-sonnet-4-5',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    family: 'claude',
  };
  goalPlanStore.createPlan({
    planId: 'plan-del-e2e',
    conversationId: childConv.id,
    title: 'Audit Stripe webhook secret rotation',
    goal: 'Audit webhooks',
    status: 'executing',
    delegationOrigin: {
      workspaceId,
      sessionId: 'sess-e2e-1',
      parentConversationId: botConv.id,
      anchorMessageId: 'anchor-e2e',
      inputId: 'input-e2e-1',
      modelSelection: {
        worker: stubModel,
        explorer: stubModel,
        verifier: stubModel,
        resolvedAt: '2026-11-21T08:01:00.000Z',
      },
    },
  });
  goalPlanStore.createPlan({
    planId: 'plan-classic-e2e',
    conversationId: ordConv.id,
    title: 'Release Classic Goal',
    goal: 'Release',
    status: 'executing',
    originWorkspacePath: wsPath,
    tasks: [],
  });
  goalPlanStore.setRunnerState('plan-classic-e2e', { status: 'waiting_user' });

  const approvalStore = createApprovalStore({ rootDir: runtimeRoot });
  approvalStore.append({
    approvalId: 'appr-stale-e2e',
    workspaceId,
    conversationId: childConv.id,
    planId: 'plan-del-e2e',
    streamId: 's-e2e-1',
    capabilityId: 'local.file.write',
    summary: 'write file',
    state: 'stale',
  });
  approvalStore.append({
    approvalId: 'appr-ord-e2e',
    workspaceId,
    conversationId: ordConv.id,
    streamId: 's-e2e-2',
    capabilityId: 'local.file.write',
    summary: 'ordinary file write',
    state: 'open',
  });

  const accessAuthority = createBotAccessPolicyAuthority({
    dataHome,
    profileStore,
    conversationStore,
    goalPlanStore,
    legacyAccessLevel: 'ask_before_local',
  });
  accessAuthority.initialize();

  const memoryStore = createMemoryStore({ rootDir: dataHome });
  memoryStore.rememberStated({
    workspaceId,
    kind: 'fact',
    text: 'Webhook endpoints always validate Stripe HMAC headers',
    anchorMessageId: 'u-e2e-1',
    messages: [{ id: 'u-e2e-1', kind: 'user_input', content: 'remember' }],
  });

  const directory = createBotDirectory({
    rootDir: dataHome,
    registry,
    readMessages: (id) => conversationStore.getPersistedConversationHistory(id)?.messages || [],
    listSessions: () => [],
    listApprovals: (id) => approvalStore.list({ workspaceId: id }),
  });

  const customPngPath = path.join(root, 'avatar.png');
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
  writeFileSync(customPngPath, pngBytes);

  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    clientInfo: { name: 'peer-desktop-bot-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  const changedEvents = [];
  const viewedIds = [];
  const testModels = [{
    id: 'anthropic:claude-sonnet-4-5',
    provider: 'anthropic',
    name: 'Anthropic',
    model: 'claude-sonnet-4-5',
    enabled: true,
    apiKeyConfigured: true,
    supportsTools: true,
    supportsReasoning: true,
    reasoningEffortLevels: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  }];

  const appService = createProjectAgentApplicationService({
    enabled: () => true,
    classicCoreBridge: bridge,
    directory,
    profileStore,
    approvals: approvalStore,
    accessAuthority,
    listModels: () => testModels,
    chooseAvatar: async () => customPngPath,
    onViewing: (id) => viewedIds.push(id),
    broadcast: (channel, payload) => {
      if (channel === 'project-agent:changed') changedEvents.push(payload);
    },
    debounceMs: 5,
  });

  try {
    await client.start();

    // 1. updateProfile (displayName + avatarColor + modelSelection) & chooseAvatar + readAvatar
    const updated = await appService.updateProfile({
      workspaceId,
      displayName: 'Stripe Guard Bot',
      avatarColor: '#61b68c',
      proactivity: 'standard',
      autoHandoffOnPolicyAccept: true,
      planApproval: 'always',
      acceptancePolicy: 'confirm',
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.profile.displayName, 'Stripe Guard Bot');
    assert.equal(updated.profile.avatar.color, '#61b68c');
    assert.equal(updated.profile.autoHandoffOnPolicyAccept, true);
    assert.equal(updated.profile.planApproval, 'always');
    assert.equal(updated.profile.acceptancePolicy, 'confirm');

    const modelUpdated = await appService.updateModelSelection({
      workspaceId,
      modelProviderId: 'anthropic:claude-sonnet-4-5',
      reasoningEffort: 'high',
    });
    assert.equal(modelUpdated.ok, true);
    assert.equal(modelUpdated.profile.modelPolicy.overrides.project_agent.modelProviderId, 'anthropic:claude-sonnet-4-5');
    assert.equal(modelUpdated.profile.modelPolicy.overrides.project_agent.reasoningEffort, 'high');

    const imgUploaded = await appService.updateProfile({ workspaceId, chooseAvatar: true });
    assert.equal(imgUploaded.ok, true);
    assert.equal(imgUploaded.profile.avatar.kind, 'image');

    const avatarRead = await appService.readAvatar({ workspaceId });
    assert.equal(avatarRead.ok, true);
    assert.equal(avatarRead.dataUrl, `data:image/png;base64,${pngBytes.toString('base64')}`);

    // 2. readAccessPolicy & updateAccessPolicy (including stale child approval retirement)
    const access1 = await appService.readAccessPolicy({ workspaceId });
    assert.equal(access1.ok, true);
    assert.equal(access1.policy.revision, 1);
    assert.equal(access1.policy.accessLevel, 'ask_before_local');

    const inheritedRead = await appService.readAccessPolicy({ conversationId: childConv.id });
    assert.equal(inheritedRead.ok, true);
    assert.equal(inheritedRead.inherited, true);

    const ordRead = await appService.readAccessPolicy({ conversationId: ordConv.id });
    assert.equal(ordRead.ok, true);
    assert.equal(ordRead.policy, null);

    const access2 = await appService.updateAccessPolicy({
      workspaceId,
      expectedRevision: 1,
      accessLevel: 'full_local',
    });
    assert.equal(access2.ok, true);
    assert.equal(access2.policy.revision, 2);
    assert.equal(access2.policy.accessLevel, 'full_local');

    const conflict = await appService.updateAccessPolicy({
      workspaceId,
      expectedRevision: 1,
      accessLevel: 'restricted_local',
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'POLICY_CONFLICT');
    assert.equal(conflict.policy.revision, 2);

    // 3. listApprovals (stale child approval retired by updateAccessPolicy, ordConv remains open)
    const listedApprovals = await appService.listApprovals({ workspaceId });
    assert.equal(listedApprovals.ok, true);
    const retiredRow = listedApprovals.approvals.find((a) => a.approvalId === 'appr-stale-e2e');
    const ordRow = listedApprovals.approvals.find((a) => a.approvalId === 'appr-ord-e2e');
    assert.equal(retiredRow.state, 'expired');
    assert.equal(retiredRow.decisionReason, 'permission_policy_changed');
    assert.equal(ordRow.state, 'open');

    // 4. markRead (first change emits queueChanged + onViewing; repeat does not mark changed; viewing:false clears)
    const mr1 = await appService.markRead({ workspaceId });
    assert.equal(mr1.ok, true);
    assert.equal(mr1.messageId, 'bot-e2e-msg-1');
    const mr2 = await appService.markRead({ workspaceId });
    assert.equal(mr2.ok, true);
    const mrOff = appService.markRead({ viewing: false });
    assert.deepEqual(mrOff, { ok: true, viewing: false });
    assert.deepEqual(viewedIds, [workspaceId, workspaceId, null]);

    // 5. listHistory (workspaceId + unscoped)
    const histWs = await appService.listHistory({ workspaceId });
    assert.equal(histWs.ok, true);
    assert.equal(histWs.history.length, 1);
    assert.equal(histWs.history[0].id, ordConv.id);
    assert.equal(histWs.goals.length, 1);
    assert.equal(histWs.goals[0].planId, 'plan-classic-e2e');
    assert.equal(histWs.goals[0].waitingUser, true);

    const histUnscoped = await appService.listHistory({ unscoped: true });
    assert.equal(histUnscoped.ok, true);
    assert.equal(histUnscoped.history.length, 1);
    assert.equal(histUnscoped.history[0].id, unscopedConv.id);
    assert.equal(histUnscoped.goals.length, 0);

    // 6. search (items + Rust FTS5 hits across task & memory & message)
    const searched = await appService.search({ query: 'Stripe' });
    assert.equal(searched.ok, true);
    assert.ok(searched.items.some((item) => item.workspaceId === workspaceId));
    assert.ok(searched.hits.some((hit) => hit.kind === 'task' && hit.sessionId === 'sess-e2e-1'));
    assert.ok(searched.hits.some((hit) => hit.kind === 'memory' && hit.text.includes('HMAC')));

    await new Promise((r) => setTimeout(r, 30));
    assert.ok(changedEvents.some((ev) => Array.isArray(ev.workspaceIds) && ev.workspaceIds.includes(workspaceId)));
  } finally {
    appService.dispose();
    accessAuthority.close();
    await client.dispose();
    cleanup();
  }
});

test('E2E: bot diagnostics, continueHistory, input drafts, and readEvidence run through peer-native core --stdio', async () => {
  const binaryPath = resolveTestBinary();
  const { root, dataHome, workspace, cleanup } = makeTempDirs();
  const runtimeRoot = path.join(dataHome, 'project-runtime');

  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const reg = registry.ensureForPath(workspace);
  const workspaceId = reg.workspaceId;
  const wsPath = reg.path || workspace;

  const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const botConv = conversationStore.createConversation({
    title: 'Bot Ops E2E',
    role: 'project_agent',
    workspaceId,
    workspacePath: wsPath,
    mode: 'chat',
  });
  conversationStore.appendMessage(botConv.id, {
    id: 'turn-e2e-1',
    role: 'assistant',
    kind: 'agent_turn',
    content: 'checked',
    createdAt: '2026-11-21T09:00:00.000Z',
    meta: {
      diagnosticTiming: {
        startedAt: '2026-11-21T09:00:00.000Z',
        finishedAt: '2026-11-21T09:00:02.000Z',
        durationMs: 2000,
        outcome: 'done',
      },
    },
    rounds: [{
      toolCalls: [{
        name: 'get_session',
        result: {
          ok: true,
          title: 'Deploy Bearer topsecret123',
          statusLabel: 'Done',
          evidenceRefs: ['tool-result://q-e2e'],
        },
      }],
    }],
  });

  const childConv = conversationStore.createChildConversation({
    parentConversationId: botConv.id,
    role: 'work_session',
    anchorMessageId: 'turn-e2e-1',
    delegation: { sessionId: 'sess-ops-e2e', anchorMessageId: 'turn-e2e-1', inputId: 'in-ops-e2e' },
    runtimeState: {
      conversationId: botConv.id,
      contentRevision: conversationStore.getPersistedConversationHistory(botConv.id).contentRevision,
      status: 'idle',
    },
    capturedAt: '2026-11-21T09:00:30.000Z',
    backgroundMessageIds: ['turn-e2e-1'],
    confirmMissing: true,
    title: 'Child worker',
    workspaceId,
    workspacePath: wsPath,
  });

  const histFull = conversationStore.createConversation({ title: 'Clean History', workspacePath: wsPath });
  conversationStore.appendMessage(histFull.id, { id: 'h-u-1', role: 'user', content: 'Inspect billing' });
  conversationStore.appendMessage(histFull.id, { id: 'h-a-1', role: 'assistant', content: 'Looked at billing' });

  const histPartial = conversationStore.createConversation({ title: 'Tool History', workspacePath: wsPath });
  conversationStore.appendMessage(histPartial.id, {
    id: 'hp-a-1',
    role: 'assistant',
    content: 'Executed check',
    tool_calls: [{ id: 'tc-e2e' }],
  });

  const profileStore = createBotProfileStore({ rootDir: dataHome });
  profileStore.create({
    workspaceId,
    displayName: 'Ops E2E Bot',
    agentConversationId: botConv.id,
  });

  const inputQueue = createInputQueue({ rootDir: runtimeRoot });
  inputQueue.submitInput({
    workspaceId,
    inputId: 'queued-e2e-1',
    surface: 'desktop',
    text: 'Check queue',
  });
  const inbox = createProjectInbox({ rootDir: runtimeRoot });
  inbox.append(workspaceId, [{ eventId: 'ev-e2e-1', kind: 'needs_user', at: '2026-11-21T09:01:00.000Z' }]);

  const objectiveStore = createObjectiveStore({ rootDir: dataHome });
  const objective = objectiveStore.create({
    workspaceId,
    projectAgentConversationId: botConv.id,
    originMessageId: 'turn-e2e-1',
    title: 'Health Watch',
    outcome: 'Green',
    autonomy: 'propose',
    createdBy: 'user_request',
    watches: [{
      watchId: 'w-e2e',
      kind: 'event',
      source: { type: 'files', paths: ['src/index.ts', 'token=abcd', 'sk-secretkeyvalue123'] },
    }],
  }).item;

  const execKey = 'exec-e2e-key';
  const execHash = createHash('sha256').update(execKey).digest('hex');
  const watchRef = `objective-probe:${workspaceId}:${execHash}`;
  const objRtDir = path.join(runtimeRoot, workspaceId, 'objectives');
  mkdirSync(path.join(objRtDir, 'probe-evidence'), { recursive: true });
  writeFileSync(
    path.join(objRtDir, 'watch-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      watches: {
        [createHash('sha256').update(`${objective.objectiveId}:w-e2e`).digest('hex')]: {
          lastObservationAt: '2026-11-21T09:02:00.000Z',
          pendingExecutionKey: 'pending-1',
        },
      },
      reservations: {},
    }),
  );
  writeFileSync(
    path.join(objRtDir, 'probe-evidence', `${execHash}.json`),
    JSON.stringify({
      workspaceId,
      executionKey: execKey,
      evidenceRef: watchRef,
      observation: { summary: 'probe drift ok', severity: 'info', observedAt: '2026-11-21T09:02:00.000Z' },
      execution: { call: { toolName: 'git_status' }, grant: { granted: true }, result: { status: 'success' } },
    }),
  );

  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const stubModel = {
    modelProviderId: 'anthropic:claude-sonnet-4-5',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    family: 'claude',
  };
  goalPlanStore.createPlan({
    planId: 'plan-ops-e2e',
    conversationId: childConv.id,
    title: 'Ops delegation',
    goal: 'Run check',
    status: 'executing',
    delegationOrigin: {
      workspaceId,
      sessionId: 'sess-ops-e2e',
      parentConversationId: botConv.id,
      anchorMessageId: 'turn-e2e-1',
      inputId: 'in-ops-e2e',
      modelSelection: {
        worker: stubModel,
        explorer: stubModel,
        verifier: stubModel,
        resolvedAt: '2026-11-21T09:00:30.000Z',
      },
    },
  });

  mkdirSync(path.join(dataHome, 'shell-artifacts', '2026-11-21', 'sh-e2e'), { recursive: true });
  writeFileSync(path.join(dataHome, 'shell-artifacts', '2026-11-21', 'sh-e2e', 'stdout.txt'), 'e2e stdout ok\n');
  writeFileSync(
    path.join(dataHome, 'goal-plans', 'evidence-index.jsonl'),
    `${[
      JSON.stringify({
        evidenceRef: 'tool-result://q-e2e',
        conversationId: botConv.id,
        streamId: 'turn-e2e-1',
        toolName: 'get_session',
        capabilityId: 'local.delegation.get_session',
        createdAt: '2026-11-21T09:00:00.000Z',
      }),
      JSON.stringify({
        evidenceRef: 'local-shell-artifact://sh-e2e/stdout',
        conversationId: childConv.id,
        planId: 'plan-ops-e2e',
        toolName: 'shell_exec',
        createdAt: '2026-11-21T09:01:00.000Z',
        artifactRefs: ['local-shell-artifact://sh-e2e/stdout'],
        userArtifacts: [{
          kind: 'code-change',
          ref: `file://${path.join(wsPath, 'index.ts')}`,
          label: 'index.ts',
          preview: { kind: 'code', diffLines: ['-a', '+b'] },
        }],
      }),
    ].join('\n')}\n`,
  );

  // Exercise real JS inputDrafts store + fallback on resourceFeedback
  const inputDrafts = createProjectInputDraftStore({
    rootDir: runtimeRoot,
    validateInteractiveFeedback: () => true,
  });

  // Exercise local readEvidence fallback (e.g. if interactive ref delegates back to JS)
  const localEvidenceReader = createEvidenceReader({
    findRecords: (refs) => goalPlanStore.findEvidenceIndexRecords(refs),
    readMessages: (id) => conversationStore.getPersistedConversationHistory(id)?.messages ?? [],
    readArtifact: () => '',
    readScopedExternal: createScopedExternalEvidenceReader({
      findWatch: () => null,
      readWatchBody: () => null,
    }),
    projectDeliveries: createEvidenceDeliveryProjection({
      getConversationId: () => botConv.id,
      getPlan: (id) => goalPlanStore.getPlan(id),
      getSession: (id) => ({ sessionId: id, workspaceId, report: { planId: 'plan-ops-e2e' } }),
    }),
  });

  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    clientInfo: { name: 'peer-desktop-bot-ops-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  const directory = createBotDirectory({
    rootDir: dataHome,
    registry,
    readMessages: (id) => conversationStore.getPersistedConversationHistory(id)?.messages || [],
    listSessions: () => [],
    listApprovals: () => [],
  });
  const woken = [];
  const changed = [];
  const convChanged = [];
  const appService = createProjectAgentApplicationService({
    enabled: () => true,
    classicCoreBridge: bridge,
    directory,
    profileStore,
    inputDrafts,
    readEvidenceBody: localEvidenceReader,
    wake: (ws) => woken.push(ws),
    broadcast: (ch, payload) => {
      if (ch === 'project-agent:changed') changed.push(payload);
      if (ch === 'project-agent:conversation-changed') convChanged.push(payload);
    },
    debounceMs: 5,
  });

  const exportFile = path.join(root, 'exported-diagnostics.json');
  const diagnosticsExporter = createDiagnosticsExport({
    readReport: () => bridge.projectBotDiagnostics({
      scheduler: {
        stats: { active: 1, waiting: 0, limit: 2 },
        queue: [],
        projects: [{ workspaceId, slots: { read: 1, write: 0, isolated: 0 }, queue: [] }],
      },
      schedulerUnavailable: false,
    }).then((res) => {
      if (res?.ok && res.report) return res.report;
      throw new Error(res?.code || 'DIAGNOSTICS_UNAVAILABLE');
    }),
    chooseTarget: async () => ({ canceled: false, filePath: exportFile }),
  });

  try {
    await client.start();

    // 1. Diagnostics read + atomic export
    const diagRead = await diagnosticsExporter.execute({ action: 'read' });
    assert.equal(diagRead.ok, true);
    assert.equal(diagRead.report.schemaVersion, 1);
    assert.equal(diagRead.report.bots.length, 1);
    assert.equal(diagRead.report.bots[0].input.depth, 1);
    assert.deepEqual(diagRead.report.bots[0].objectives[0].watches[0].paths, ['src/index.ts']);
    assert.equal(diagRead.report.bots[0].turns[0].outcome, 'done');

    const diagSaved = await diagnosticsExporter.execute({ action: 'export' });
    assert.equal(diagSaved.ok, true);
    assert.equal(diagSaved.saved, true);
    assert.equal(JSON.parse(readFileSync(exportFile, 'utf8')).schemaVersion, 1);

    // 2. continueHistory: confirmation gate -> confirmed -> cross-check Rust snapshot with JS store!
    const contNeedConfirm = await appService.continueHistory({
      workspaceId,
      conversationId: histPartial.id,
    });
    assert.equal(contNeedConfirm.ok, false);
    assert.equal(contNeedConfirm.code, 'BACKGROUND_CONFIRMATION_REQUIRED');
    // JS conversationStore.readInheritedBackground verifies Rust's contentHash + key order bit-for-bit!
    const verifiedByJs = conversationStore.readInheritedBackground(contNeedConfirm.snapshot.snapshotId);
    assert.equal(verifiedByJs.status, 'partial');
    assert.equal(verifiedByJs.contentHash, contNeedConfirm.snapshot.snapshotId);

    const contConfirmed = await appService.continueHistory({
      workspaceId,
      conversationId: histPartial.id,
      confirmMissing: true,
      inputId: 'cont-e2e-partial',
    });
    assert.equal(contConfirmed.ok, true);
    assert.equal(contConfirmed.input.historyConfirmed, true);

    const contClean = await appService.continueHistory({
      workspaceId,
      conversationId: histFull.id,
      inputId: 'cont-e2e-clean',
    });
    assert.equal(contClean.ok, true);
    assert.equal(contClean.input.text, '继续：Clean History');
    assert.equal(conversationStore.readInheritedBackground(contClean.snapshot.snapshotId).status, 'full');
    assert.deepEqual(woken, [workspaceId, workspaceId]);

    // 3. InputDrafts: write via Rust -> read & verify via JS store -> rewrite same upload via Rust (SHA-256 parity) -> conflict
    const writeRust = await appService.writeInputDraft({
      workspaceId,
      surface: 'desktop',
      revision: 0,
      uploads: [{
        id: 'u-e2e-1',
        name: 'spec.txt',
        mimeType: 'text/plain',
        size: 7,
        kind: 'text',
        text: 'content',
      }],
      draft: { text: 'hello draft', quote: { messageId: 'm1', text: 'q1' }, attachmentIds: ['u-e2e-1'] },
      pending: [],
    });
    assert.deepEqual(writeRust, { ok: true, revision: 1 });

    // JS store verifies SHA-256 digest of blob written by Rust
    const readByJs = inputDrafts.read({ workspaceId, surface: 'desktop' }, true);
    assert.equal(readByJs.ok, true);
    assert.equal(readByJs.snapshot.revision, 1);
    assert.equal(readByJs.snapshot.draft.attachments[0].text, 'content');

    // Re-writing same upload through Rust matches stored SHA-256 (no DRAFT_ATTACHMENT_CONFLICT)
    const writeRust2 = await appService.writeInputDraft({
      workspaceId,
      surface: 'desktop',
      revision: 1,
      uploads: [{
        id: 'u-e2e-1',
        name: 'spec.txt',
        mimeType: 'text/plain',
        size: 7,
        kind: 'text',
        text: 'content',
      }],
      draft: { text: 'hello draft v2', quote: null, attachmentIds: ['u-e2e-1'] },
      pending: [],
    });
    assert.deepEqual(writeRust2, { ok: true, revision: 2 });
    const conflictRust = await appService.writeInputDraft({
      workspaceId,
      surface: 'desktop',
      revision: 1,
      uploads: [],
      draft: { text: 'stale', quote: null, attachmentIds: [] },
      pending: [],
    });
    assert.deepEqual(conflictRust, { ok: false, code: 'DRAFT_CONFLICT' });

    // Non-empty resourceFeedback falls back cleanly to local inputDrafts without throwing
    const badFeedbackWrite = await appService.writeInputDraft({
      workspaceId,
      surface: 'desktop',
      revision: 2,
      uploads: [],
      draft: { text: 'fb', quote: null, resourceFeedback: [{ bad: true }], attachmentIds: [] },
      pending: [],
    });
    assert.deepEqual(badFeedbackWrite, { ok: false, code: 'INVALID_DRAFT' });

    // 4. readEvidence: batch, query redaction, shell artifact + scoped delivery, watch evidence + scope denied
    const evBatch = await appService.readEvidence({
      evidenceRefs: ['tool-result://q-e2e', 'local-shell-artifact://sh-e2e/stdout', 'tool-result://q-e2e'],
    });
    assert.equal(evBatch.ok, true);
    assert.equal(evBatch.items.length, 2);

    const evQuery = await appService.readEvidence({ evidenceRef: 'tool-result://q-e2e' });
    assert.equal(evQuery.ok, true);
    assert.equal(evQuery.summary, 'Deploy Bearer [REDACTED_TOKEN]\nDone');

    const evShell = await appService.readEvidence({
      evidenceRef: 'local-shell-artifact://sh-e2e/stdout',
      context: { workspaceId, task: { sessionId: 'sess-ops-e2e', planId: 'plan-ops-e2e' } },
    });
    assert.equal(evShell.ok, true);
    assert.equal(evShell.deliveryStatus, 'available');
    assert.equal(evShell.deliveries[0].reference.task.sessionId, 'sess-ops-e2e');

    const evWatch = await appService.readEvidence({
      evidenceRef: watchRef,
      context: { workspaceId },
    });
    assert.equal(evWatch.ok, true);
    assert.ok(evWatch.summary.includes('probe drift ok'));

    const evWatchDenied = await appService.readEvidence({
      evidenceRef: watchRef,
      context: { workspaceId: 'other-bot' },
    });
    assert.equal(evWatchDenied.code, 'SCOPE_DENIED');

    await new Promise((r) => setTimeout(r, 30));
    assert.ok(changed.length >= 1);
    assert.ok(convChanged.length >= 1);
  } finally {
    appService.dispose();
    await client.dispose();
    cleanup();
  }
});

test('E2E: project-agent list, listAttention, get, search items+hits, and listObligationGrants run through peer-native core --stdio', async () => {
  const binaryPath = resolveTestBinary();
  const { root, dataHome, workspace, cleanup } = makeTempDirs();
  const wsBetaDir = path.join(root, 'workspace-beta');
  const wsArchDir = path.join(root, 'workspace-archived');
  mkdirSync(wsBetaDir, { recursive: true });
  mkdirSync(wsArchDir, { recursive: true });

  const runtimeRoot = path.join(dataHome, 'project-runtime');
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const wsAlpha = registry.ensureForPath(workspace).workspaceId;
  const wsBeta = registry.ensureForPath(wsBetaDir).workspaceId;
  const wsArchived = registry.ensureForPath(wsArchDir).workspaceId;

  const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const convAlpha = conversationStore.createConversation({
    title: 'Alpha Bot',
    role: 'project_agent',
    workspaceId: wsAlpha,
    workspacePath: workspace,
    mode: 'project_agent',
  });
  const convBeta = conversationStore.createConversation({
    title: 'Beta Bot',
    role: 'project_agent',
    workspaceId: wsBeta,
    workspacePath: wsBetaDir,
    mode: 'project_agent',
  });
  const convArch = conversationStore.createConversation({
    title: 'Archived Bot',
    role: 'project_agent',
    workspaceId: wsArchived,
    workspacePath: wsArchDir,
    mode: 'project_agent',
  });

  conversationStore.appendMessage(convAlpha.id, {
    id: 'msg-alpha-e2e-1',
    role: 'user',
    kind: 'user_input',
    content: 'Check OAuth Callback handler',
    createdAt: '2099-01-01T00:00:00.000Z',
  });
  conversationStore.appendMessage(convAlpha.id, {
    id: 'msg-alpha-e2e-2',
    role: 'assistant',
    kind: 'agent_reply',
    content: 'OAuth Callback ready for verification',
    createdAt: '2099-01-01T00:00:00.500Z',
  });
  conversationStore.appendMessage(convBeta.id, {
    id: 'msg-beta-e2e-1',
    role: 'assistant',
    kind: 'agent_reply',
    content: 'Idle heartbeat',
    createdAt: '2026-11-21T00:00:00.000Z',
  });

  const alphaHistory = conversationStore.getPersistedConversationHistory(convAlpha.id);
  const childAlpha = conversationStore.createChildConversation({
    parentConversationId: convAlpha.id,
    role: 'work_session',
    anchorMessageId: 'msg-alpha-e2e-1',
    delegation: { sessionId: 'sess-read-e2e', anchorMessageId: 'msg-alpha-e2e-1', inputId: 'in-read-e2e' },
    runtimeState: {
      conversationId: convAlpha.id,
      contentRevision: alphaHistory.contentRevision,
      status: 'idle',
    },
    capturedAt: '2026-11-22T01:00:00.000Z',
    backgroundMessageIds: ['msg-alpha-e2e-1'],
    confirmMissing: true,
    title: 'Migrate SAML Handshake',
    workspaceId: wsAlpha,
    workspacePath: workspace,
  });

  const profileStore = createBotProfileStore({ rootDir: dataHome });
  profileStore.create({ workspaceId: wsAlpha, displayName: 'Alpha Bot', agentConversationId: convAlpha.id });
  profileStore.create({ workspaceId: wsBeta, displayName: 'Beta Bot', agentConversationId: convBeta.id });
  profileStore.create({ workspaceId: wsArchived, displayName: 'Archived Bot', agentConversationId: convArch.id });
  profileStore.save({ workspaceId: wsArchived, status: 'archived' });

  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const stubModel = {
    modelProviderId: 'anthropic:claude-sonnet-4-5',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    family: 'claude',
  };
  goalPlanStore.createPlan({
    planId: 'plan-read-e2e',
    conversationId: childAlpha.id,
    title: 'Migrate SAML Handshake',
    goal: 'Migrate SAML',
    status: 'executing',
    updatedAt: '2099-01-01T00:00:01.000Z',
    delegationOrigin: {
      workspaceId: wsAlpha,
      sessionId: 'sess-read-e2e',
      parentConversationId: convAlpha.id,
      anchorMessageId: 'msg-alpha-e2e-1',
      inputId: 'in-read-e2e',
      modelSelection: {
        worker: stubModel,
        explorer: stubModel,
        verifier: stubModel,
        resolvedAt: '2026-11-22T01:00:00.000Z',
      },
    },
  });

  const approvalStore = createApprovalStore({ rootDir: runtimeRoot });
  approvalStore.append({
    approvalId: 'appr-read-e2e',
    workspaceId: wsAlpha,
    conversationId: convAlpha.id,
    streamId: 'stream-read-e2e',
    capabilityId: 'local.file.write',
    summary: 'Write auth config',
    state: 'open',
    createdAt: '2026-11-22T01:05:00.000Z',
  });

  // Seed SQLite coordination read-model under <dataHome>/project-runtime/<wsAlpha>/.read-models/
  const uuidDb = '11111111-2222-3333-4444-555555555555';
  const uuidSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dbName = `coordination-${uuidDb}.sqlite`;
  const readModelsDir = path.join(runtimeRoot, wsAlpha, '.read-models');
  const pointerFile = path.join(readModelsDir, 'coordination-current.json');
  mkdirSync(readModelsDir, { recursive: true });
  mkdirSync(path.join(runtimeRoot, wsAlpha, 'coordination-v2'), { recursive: true });
  writeFileSync(pointerFile, JSON.stringify({ schemaVersion: 1, file: dbName }), 'utf8');
  const db = new DatabaseSync(path.join(readModelsDir, dbName));
  db.exec('CREATE TABLE objects (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (bucket, id))');
  const insertGrant = db.prepare("INSERT INTO objects (bucket, id, value) VALUES ('obligationGrants', ?, ?)");
  for (const grant of [
    {
      grantId: 'g-match',
      status: 'pending',
      principal: { workspaceId: wsAlpha, parentConversationId: convAlpha.id },
      items: [{
        obligationId: 'obl-match',
        sessionId: 'sess-read-e2e',
        operationId: 'op-match',
        actions: ['retire_follow_up'],
      }],
    },
    {
      grantId: 'g-legacy',
      status: 'pending',
      principal: { workspaceId: wsAlpha },
      items: [
        {
          obligationId: 'obl-leg-owner',
          sessionId: 'sess-read-e2e',
          actions: ['retire_follow_up'],
        },
        {
          obligationId: 'obl-leg-uuid',
          sessionId: uuidSid,
          title: uuidSid,
          actions: ['retire_follow_up'],
        },
      ],
    },
    {
      grantId: 'g-other',
      status: 'pending',
      principal: { workspaceId: wsAlpha, parentConversationId: 'other-conv' },
      items: [{
        obligationId: 'obl-other',
        sessionId: uuidSid,
        actions: ['retire_follow_up'],
      }],
    },
  ]) {
    insertGrant.run(grant.grantId, JSON.stringify(grant));
  }
  db.close();

  // Stub JS BotDirectory to prove none of its read methods are called when Rust bridge is active.
  const directoryMustNotBeCalled = () => {
    throw new Error('JS BotDirectory must not be called when Rust bridge is active');
  };
  const stubDirectory = {
    list: directoryMustNotBeCalled,
    search: directoryMustNotBeCalled,
    query: directoryMustNotBeCalled,
    get: directoryMustNotBeCalled,
    attention: directoryMustNotBeCalled,
  };

  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    clientInfo: { name: 'peer-desktop-bot-read-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  const testModels = [{
    id: 'anthropic:claude-sonnet-4-5',
    provider: 'anthropic',
    name: 'Anthropic',
    model: 'claude-sonnet-4-5',
    enabled: true,
    apiKeyConfigured: true,
    supportsTools: true,
    supportsReasoning: true,
    reasoningEffortLevels: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  }];
  let currentRecovery = { status: 'ready' };

  const appService = createProjectAgentApplicationService({
    enabled: () => true,
    classicCoreBridge: bridge,
    directory: stubDirectory,
    profileStore,
    listModels: () => testModels,
    readModelRouting: () => ({}),
    readAgentStatus: (wsId) => (wsId === wsAlpha ? 'thinking' : undefined),
    readRecovery: () => currentRecovery,
    debounceMs: 5,
  });

  try {
    await client.start();

    // 1. list (all active + agentStatus decoration, needsYouOnly, query via session title)
    const listedAll = await appService.list({});
    assert.equal(listedAll.ok, true);
    assert.equal(listedAll.items.length, 2);
    assert.equal(listedAll.items[0].workspaceId, wsAlpha);
    assert.equal(listedAll.items[0].state.agentStatus, 'thinking');
    assert.equal(listedAll.items[1].workspaceId, wsBeta);
    assert.equal('agentStatus' in listedAll.items[1].state, false);

    const listedNeeds = await appService.list({ needsYouOnly: true });
    assert.equal(listedNeeds.ok, true);
    assert.equal(listedNeeds.items.length, 1);
    assert.equal(listedNeeds.items[0].workspaceId, wsAlpha);

    const listedQuery = await appService.list({ query: 'SAML Handshake' });
    assert.equal(listedQuery.ok, true);
    assert.equal(listedQuery.items.length, 1);
    assert.equal(listedQuery.items[0].workspaceId, wsAlpha);

    // 2. listAttention (cards, scoped, error cases)
    const attAll = await appService.listAttention({});
    assert.equal(attAll.ok, true);
    assert.ok(attAll.items.some((item) => (
      item.workspaceId === wsAlpha
      && item.card
      && item.id === item.card.cardId
      && !('approvalId' in item)
    )));
    const attScoped = await appService.listAttention({ workspaceId: wsAlpha });
    assert.equal(attScoped.ok, true);
    assert.ok(attScoped.items.length >= 1 && attScoped.items.every((item) => item.workspaceId === wsAlpha));
    for (const badWs of [123, null, 'ws-missing', wsArchived]) {
      assert.deepEqual(await appService.listAttention({ workspaceId: badWs }), { ok: false, code: 'NOT_FOUND' });
    }

    // 3. get (decorated with agentStatus, modelOptions, modelViews + error codes)
    const gotAlpha = await appService.get({ workspaceId: wsAlpha });
    assert.equal(gotAlpha.ok, true);
    assert.equal(gotAlpha.item.workspaceId, wsAlpha);
    assert.equal(gotAlpha.item.state.agentStatus, 'thinking');
    assert.equal(gotAlpha.profile.displayName, 'Alpha Bot');
    assert.equal(gotAlpha.path, workspace);
    assert.ok(Array.isArray(gotAlpha.modelOptions) && gotAlpha.modelOptions.length === 1);
    assert.ok(gotAlpha.modelViews && typeof gotAlpha.modelViews === 'object');
    assert.deepEqual(await appService.get({ workspaceId: '../bad' }), { ok: false, code: 'INVALID_WORKSPACE' });
    assert.deepEqual(await appService.get({ workspaceId: 'ws-missing' }), { ok: false, code: 'NOT_FOUND' });
    assert.deepEqual(await appService.get({ workspaceId: wsArchived }), { ok: false, code: 'ARCHIVED' });

    // 4. search returns both items (from Rust session-title match) and hits without touching directory.query
    const searchSaml = await appService.search({ query: 'SAML Handshake' });
    assert.equal(searchSaml.ok, true);
    assert.equal(searchSaml.items.length, 1);
    assert.equal(searchSaml.items[0].workspaceId, wsAlpha);
    assert.ok(searchSaml.hits.some((h) => h.kind === 'task' && h.sessionId === 'sess-read-e2e'));

    const searchOauth = await appService.search({ query: 'OAuth Callback' });
    assert.equal(searchOauth.ok, true);
    assert.ok(searchOauth.hits.some((h) => h.kind === 'message' && h.workspaceId === wsAlpha));

    // 5. listObligationGrants: SQLite read-model, scoping, displayTitle/shortId, writer recovery, error cases
    const oblOk = await appService.listObligationGrants({
      workspaceId: wsAlpha,
      parentConversationId: convAlpha.id,
    });
    assert.equal(oblOk.ok, true);
    assert.deepEqual(oblOk.writer, { ok: true });
    assert.equal('rawCount' in oblOk, false);
    assert.equal('reasons' in oblOk, false);
    assert.equal(oblOk.grants.length, 2);
    const gMatch = oblOk.grants.find((g) => g.grantId === 'g-match');
    const gLegacy = oblOk.grants.find((g) => g.grantId === 'g-legacy');
    assert.ok(gMatch && gLegacy);
    assert.equal(gMatch.items[0].displayTitle, 'Migrate SAML Handshake');
    assert.equal(gMatch.items[0].shortId, null);
    assert.equal(gLegacy.items[0].displayTitle, 'Migrate SAML Handshake');
    assert.equal(gLegacy.items[1].displayTitle, null);
    assert.equal(gLegacy.items[1].shortId, 'aaaaaaaa');

    // Degraded recovery surfaces writer metadata alongside grants
    currentRecovery = {
      error: 'recovery_needed',
      phase: 'inputs',
      legacy: {
        check: 'seal_mismatch',
        seal: 'absent',
        change: 'hash',
        file: 'baseline',
      },
    };
    const oblDegraded = await appService.listObligationGrants({
      workspaceId: wsAlpha,
      parentConversationId: convAlpha.id,
    });
    assert.equal(oblDegraded.ok, true);
    assert.deepEqual(oblDegraded.writer, {
      ok: false,
      code: 'recovery_needed',
      check: 'seal_mismatch',
      seal: 'absent',
      change: 'hash',
      file: 'baseline',
    });

    // Corrupt pointer -> { ok: false, code: 'obligation_store_unreadable' } with no leaked cause
    writeFileSync(pointerFile, JSON.stringify({ schemaVersion: 1, file: '../evil.sqlite' }), 'utf8');
    const oblCorrupt = await appService.listObligationGrants({ workspaceId: wsAlpha });
    assert.deepEqual(oblCorrupt, { ok: false, code: 'obligation_store_unreadable' });
    assert.equal('cause' in oblCorrupt, false);

    // Missing pointer with coordination-v2 present -> { ok: false, code: 'obligation_store_unreadable' }
    rmSync(pointerFile);
    const oblMissingPtr = await appService.listObligationGrants({ workspaceId: wsAlpha });
    assert.deepEqual(oblMissingPtr, { ok: false, code: 'obligation_store_unreadable' });
    assert.equal('cause' in oblMissingPtr, false);
  } finally {
    appService.dispose();
    await client.dispose();
    cleanup();
  }
});

test('C4b-2b-2b-1 readConversation (4 modes + cards), listSessions, and getSession route through Rust peer-native binary', async () => {
  const binaryPath = resolveTestBinary();
  assert.equal(existsSync(binaryPath), true, `expected peer-native binary at ${binaryPath}`);

  const { dataHome, workspace, cleanup } = makeTempDirs();
  const runtimeRoot = path.join(dataHome, 'project-runtime');
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const ws = registry.ensureForPath(workspace).workspaceId;

  const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const conv = conversationStore.createConversation({
    title: 'Projection Bot',
    role: 'project_agent',
    workspaceId: ws,
    workspacePath: workspace,
    mode: 'project_agent',
  });
  conversationStore.appendMessage(conv.id, {
    id: 'm-user-1',
    role: 'user',
    kind: 'user_input',
    content: 'Implement feature X',
    createdAt: '2026-11-22T01:00:00.000Z',
  });
  conversationStore.appendMessage(conv.id, {
    id: 'm-turn-1',
    role: 'assistant',
    kind: 'agent_turn',
    turnKind: 'user',
    content: '',
    meta: { workId: 'work-conv-e2e' },
    createdAt: '2026-11-22T01:00:10.000Z',
  });
  conversationStore.appendMessage(conv.id, {
    id: 'm-reply-1',
    role: 'assistant',
    kind: 'agent_reply',
    turnId: 'm-turn-1',
    sources: ['sess-conv-e2e'],
    content: 'Working on manual verification',
    question: { prompt: 'Approve deploy?', options: ['Ship', 'Hold'] },
    cards: [{ cardId: 'card:question:reply:m-reply-1', resolvedState: 'open' }],
    createdAt: '2026-11-22T01:00:20.000Z',
  });
  conversationStore.appendMessage(conv.id, {
    id: 'm-unavail-1',
    role: 'assistant',
    kind: 'system_card',
    card: 'agent_unavailable',
    turnId: 'm-turn-fail-1',
    content: '代理暂时不可用：上游连接重置',
    meta: { workId: 'work-unavail-e2e' },
    createdAt: '2026-11-22T01:00:30.000Z',
  });
  conversationStore.appendMessage(conv.id, {
    id: 'm-stop-1',
    role: 'assistant',
    kind: 'system_card',
    card: 'agent_stopped',
    turnId: 'm-turn-stop-1',
    content: '用户暂停',
    createdAt: '2026-11-22T01:00:40.000Z',
  });

  const parentHist = conversationStore.getPersistedConversationHistory(conv.id);
  const childConv = conversationStore.createChildConversation({
    parentConversationId: conv.id,
    role: 'work_session',
    anchorMessageId: 'm-user-1',
    delegation: { sessionId: 'sess-conv-e2e', anchorMessageId: 'm-user-1', inputId: 'in-conv-e2e' },
    runtimeState: {
      conversationId: conv.id,
      contentRevision: parentHist.contentRevision,
      status: 'idle',
    },
    capturedAt: '2026-11-22T01:00:05.000Z',
    backgroundMessageIds: ['m-user-1'],
    confirmMissing: true,
    title: 'Verify Feature X',
    workspaceId: ws,
    workspacePath: workspace,
  });
  conversationStore.appendMessage(childConv.id, {
    id: 'child-msg-1',
    role: 'assistant',
    kind: 'agent_reply',
    content: 'Feature X report ready for manual DoD signoff.',
    createdAt: '2026-11-22T01:00:15.000Z',
  });

  const profileStore = createBotProfileStore({ rootDir: dataHome });
  profileStore.create({ workspaceId: ws, displayName: 'Projection Bot', agentConversationId: conv.id });
  profileStore.save({ workspaceId: ws, readmeOffer: { offered: true } });

  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const stubModel = {
    modelProviderId: 'anthropic:claude-sonnet-4-5',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    family: 'claude',
  };
  goalPlanStore.createPlan({
    planId: 'plan-conv-e2e',
    conversationId: childConv.id,
    title: 'Verify Feature X',
    goal: 'Manual verification flow',
    status: 'executing',
    updatedAt: '2099-01-01T00:00:01.000Z',
    successCriteria: [{ id: 'c-man-1', kind: 'manual', description: 'Check screenshot visually' }],
    delegationOrigin: {
      workspaceId: ws,
      sessionId: 'sess-conv-e2e',
      workId: 'work-conv-e2e',
      parentConversationId: conv.id,
      anchorMessageId: 'm-user-1',
      inputId: 'in-conv-e2e',
      phase: 'running',
      independentVerifier: 'passed',
      verifierModel: 'openai:gpt-5',
      sameFamilyAsWorker: false,
      modelSelection: {
        worker: stubModel,
        explorer: stubModel,
        verifier: stubModel,
        resolvedAt: '2026-11-22T01:00:00.000Z',
      },
    },
    tasks: [{ taskId: 't-1', title: 'Implement', status: 'completed', result: 'Done', evidenceRefs: ['ev-1'] }],
  });
  goalPlanStore.setRunnerState('plan-conv-e2e', {
    enabled: true,
    status: 'blocked',
    blockedReason: 'manual_dod_confirmation_required',
  });
  goalPlanStore.revisePlan(
    'plan-conv-e2e',
    { hostVerification: { verdictRef: 'verdict:sess-conv-e2e:passed', outcome: 'passed', checks: [] } },
    { reason: 'test verification', changedBy: 'system' },
  );

  // Conflicted memories
  const memDir = path.join(dataHome, 'projects', ws, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    path.join(memDir, 'items.jsonl'),
    [
      JSON.stringify({
        id: 'mem-a',
        scope: 'project',
        kind: 'fact',
        text: 'Prefer port 3000',
        trust: 'stated',
        sourceRefs: ['r1'],
        pinned: false,
        status: 'conflicted',
        confirmedCount: 1,
        createdAt: '2026-11-22T01:00:00Z',
        updatedAt: '2026-11-22T01:00:00Z',
        workspaceId: ws,
        conflictId: 'conf-port',
      }),
      JSON.stringify({
        id: 'mem-b',
        scope: 'project',
        kind: 'fact',
        text: 'Prefer port 4000',
        trust: 'stated',
        sourceRefs: ['r2'],
        pinned: false,
        status: 'conflicted',
        confirmedCount: 1,
        createdAt: '2026-11-22T01:00:01Z',
        updatedAt: '2026-11-22T01:00:01Z',
        workspaceId: ws,
        conflictId: 'conf-port',
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  // Checkpoint + SQLite coordination read-model
  const ckptRef = `${'c'.repeat(64)}.json`;
  const ckptDir = path.join(runtimeRoot, ws, 'checkpoints');
  mkdirSync(ckptDir, { recursive: true });
  writeFileSync(
    path.join(ckptDir, ckptRef),
    JSON.stringify({
      job: { workId: 'work-unavail-e2e' },
      outcome: { rounds: [], providerCheckpoint: { id: 'cp-1' } },
    }),
    'utf8',
  );

  const uuidDb = '22222222-3333-4444-5555-666666666666';
  const dbName = `coordination-${uuidDb}.sqlite`;
  const rmDir = path.join(runtimeRoot, ws, '.read-models');
  const pointerFile = path.join(rmDir, 'coordination-current.json');
  mkdirSync(rmDir, { recursive: true });
  mkdirSync(path.join(runtimeRoot, ws, 'coordination-v2'), { recursive: true });
  writeFileSync(pointerFile, JSON.stringify({ schemaVersion: 1, file: dbName }), 'utf8');
  const db = new DatabaseSync(path.join(rmDir, dbName));
  db.exec('CREATE TABLE objects (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (bucket, id))');
  const insertObj = db.prepare('INSERT INTO objects (bucket, id, value) VALUES (?, ?, ?)');
  insertObj.run('works', 'work-unavail-e2e', JSON.stringify({
    workId: 'work-unavail-e2e',
    workspaceId: ws,
    state: 'blocked_system',
    checkpointRef: ckptRef,
    recovery: {
      failedTurnId: 'm-turn-fail-1',
      failureKind: 'transient',
      deadlineAt: '2099-01-01T00:05:00Z',
    },
  }));
  insertObj.run('agentRequests', 'req-e2e-1', JSON.stringify({
    requestId: 'req-e2e-1',
    sessionId: 'sess-conv-e2e',
    status: 'open',
    sequence: 1,
    kind: 'question',
  }));
  db.close();

  const mustNotBeCalled = () => {
    throw new Error('JS BotDirectory / sessions fallback must not be called when Rust bridge is active');
  };
  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    logger: { info() {}, warn() {}, error() {} },
  });
  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    clientInfo: { name: 'peer-desktop-bot-conv-sessions-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  const appService = createProjectAgentApplicationService({
    enabled: () => true,
    classicCoreBridge: bridge,
    directory: {
      readConversation: mustNotBeCalled,
      readInteractions: mustNotBeCalled,
      readProcess: mustNotBeCalled,
    },
    sessions: {
      list: mustNotBeCalled,
      get: mustNotBeCalled,
    },
    profileStore,
    recoveryControl: { needsAttention: (wsId) => wsId === ws },
    readRecovery: () => ({ status: 'ready' }),
    readActivity: (wsId) => ({ phase: 'idle', workspaceId: wsId }),
    debounceMs: 5,
  });

  try {
    await client.start();

    // 1. Default readConversation (decorated with recoveryAttention + activity)
    const convDefault = await appService.readConversation({ workspaceId: ws });
    assert.equal(convDefault.ok, true);
    assert.equal(convDefault.recoveryAttention, true);
    assert.deepEqual(convDefault.activity, { phase: 'idle', workspaceId: ws });
    assert.equal(convDefault.activeReplyQuestionId, 'm-reply-1');
    assert.ok(convDefault.familiarizeOffer);
    const replyMsg = convDefault.messages.find((m) => m.id === 'm-reply-1');
    assert.ok(replyMsg);
    assert.equal(replyMsg.meta.sessionStates[0].sessionId, 'sess-conv-e2e');
    const sysCards = convDefault.messages.filter((m) => m.kind === 'system_card').flatMap((m) => m.cards || []);
    const unavailCard = sysCards.find((c) => c.kind === 'agent_unavailable');
    assert.ok(unavailCard && unavailCard.recoveryAction.canContinue === true);
    assert.ok(sysCards.some((c) => c.kind === 'agent_stopped'));
    assert.ok(sysCards.some((c) => c.kind === 'readme_offer'));
    assert.ok(sysCards.some((c) => c.kind === 'memory_conflict'));
    assert.ok(sysCards.some((c) => c.kind === 'completion_review'));

    // 2. view: 'cards'
    const convCards = await appService.readConversation({ workspaceId: ws, view: 'cards' });
    assert.equal(convCards.ok, true);
    assert.ok(convCards.cards.length >= 6);

    // 3. processFor
    const convProc = await appService.readConversation({ workspaceId: ws, processFor: 'm-reply-1' });
    assert.equal(convProc.ok, true);
    assert.equal(convProc.processMessageId, 'm-reply-1');
    assert.deepEqual(convProc.messages.map((m) => m.id), ['m-turn-1', 'm-reply-1']);

    // 4. listSessions
    const sessionsByWork = await appService.listSessions({ workspaceId: ws, workId: 'work-conv-e2e' });
    assert.equal(sessionsByWork.ok, true);
    assert.equal(sessionsByWork.sessions.length, 1);
    assert.equal(sessionsByWork.sessions[0].sessionId, 'sess-conv-e2e');
    const sessionsEmpty = await appService.listSessions({ workspaceId: ws, status: 'accepted' });
    assert.deepEqual(sessionsEmpty, { ok: true, sessions: [], totalCount: 0, nextCursor: null });
    const sessionsActive = await appService.listSessions({ workspaceId: ws, scope: 'active', limit: 5 });
    assert.equal(sessionsActive.ok, true);
    assert.equal(sessionsActive.totalCount, 1);
    assert.equal(sessionsActive.nextCursor, null);
    assert.equal(sessionsActive.sessions[0].sessionId, 'sess-conv-e2e');

    // 5. getSession (summary + detail: 'report' + NOT_FOUND)
    const gotSession = await appService.getSession({ sessionId: 'sess-conv-e2e', detail: 'report' });
    assert.equal(gotSession.ok, true);
    assert.equal(gotSession.session.sessionId, 'sess-conv-e2e');
    assert.equal(gotSession.session.completionReviewRequired, true);
    assert.ok(gotSession.session.report);
    assert.ok(gotSession.session.report.verification);
    assert.equal(gotSession.session.report.agentSupervision.requests.length, 1);
    assert.equal(gotSession.session.report.agentSupervision.requests[0].requestId, 'req-e2e-1');
    assert.deepEqual(await appService.getSession({ sessionId: 'does-not-exist' }), {
      ok: false,
      code: 'NOT_FOUND',
    });

    // 6. Missing coordination pointer breaks cards view (and decorates recovery), while interactions stays isolated!
    rmSync(pointerFile);
    const brokenCards = await appService.readConversation({ workspaceId: ws, view: 'cards' });
    assert.equal(brokenCards.ok, false);
    assert.equal(brokenCards.code, 'coordination_index_missing');
    assert.ok(brokenCards.recovery && brokenCards.recovery.code === 'coordination_index_missing');

    const isolatedInteractions = await appService.readConversation({ workspaceId: ws, view: 'interactions' });
    assert.equal(isolatedInteractions.ok, true);
    assert.ok(typeof isolatedInteractions.sourceVersion === 'string' && isolatedInteractions.sourceVersion.length > 0);
    assert.ok(isolatedInteractions.messages.some((m) => m.id === 'm-reply-1'));
    assert.equal(isolatedInteractions.messages.some((m) => m.id === 'm-turn-1'), false);
  } finally {
    appService.dispose();
    await client.dispose();
    cleanup();
  }
});

test('E2E: C4b-2b-2b-2b Desktop cutover owns leases exclusively in Rust, routes all mutations + 4 push streams, and completes create -> chat -> stop/retry -> recovery -> delete', async () => {
  const { root, dataHome, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();
  const runtimeRoot = path.join(dataHome, 'project-runtime');
  const profileStore = createBotProfileStore({ rootDir: dataHome });
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });

  let slowRes = null;
  let slowHangRemaining = true;
  let resolveSlowArrived = null;
  const slowArrived = new Promise((resolve) => { resolveSlowArrived = resolve; });
  const mockServer = await startMockSseServer(({ body, res }) => {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const joined = JSON.stringify(messages);
    if (joined.includes('slow_stop_turn') && slowHangRemaining) {
      slowHangRemaining = false;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write(`data: ${JSON.stringify({
        id: 'bot-slow',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'working before stop...' }, finish_reason: null }],
      })}\n\n`);
      slowRes = res;
      resolveSlowArrived?.();
      res.on('close', () => {
        if (slowRes === res) slowRes = null;
      });
      return;
    }
    if (joined.includes('slow_stop_turn')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseText('retried', 'Retried reply ok.'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseText('thinking cutover', 'Reply from Rust Bot Host.'));
  });

  const broadcasts = [];
  const notifierHooks = [];
  const hostStateEvents = [];
  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    onProjectBotConversationChanged: (payload) => notifierHooks.push(payload),
    onProjectBotHostStateChanged: (payload) => hostStateEvents.push(payload),
    logger: { info() {}, warn() {}, error() {} },
  });

  // JS hostLeases gated identically to main.mjs — must hold zero leases while Rust Bot Host is active.
  const jsHostLeases = createHostLease({
    rootDir: runtimeRoot,
    hostId: 'js-desktop-cutover-test',
    surface: 'desktop',
    pid: process.pid,
    heartbeatMs: 60_000,
    projectAgentEnabled: () => !bridge.isProjectBotHostOwnedOrPending(),
    botWorkspaceIds: () => listBotWorkspaceIds(path.join(dataHome, 'projects')),
  });

  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    env: {
      PEER_MODEL_API_KEY: 'test-key-cutover',
      PEER_MODEL_ID: 'e2e-mock-cutover',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-cutover-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  const mustNotBeCalled = (label) => () => {
    throw new Error(`JS fallback ${label} must not be called when Rust ProjectHostRuntime is active`);
  };
  const trashedPaths = [];
  const removedPaths = [];
  const remembered = [];

  const appService = createProjectAgentApplicationService({
    enabled: () => true,
    classicCoreBridge: bridge,
    directory: {
      list: mustNotBeCalled('directory.list'),
      get: mustNotBeCalled('directory.get'),
      readConversation: mustNotBeCalled('directory.readConversation'),
      hasActiveBot: mustNotBeCalled('directory.hasActiveBot'),
    },
    lifecycle: {
      ensureBot: mustNotBeCalled('lifecycle.ensureBot'),
      startFamiliarize: mustNotBeCalled('lifecycle.startFamiliarize'),
      acceptReadme: mustNotBeCalled('lifecycle.acceptReadme'),
      deleteBot: mustNotBeCalled('lifecycle.deleteBot'),
    },
    inputQueue: {
      submitInput: mustNotBeCalled('inputQueue.submitInput'),
    },
    sessions: {
      list: mustNotBeCalled('sessions.list'),
      get: mustNotBeCalled('sessions.get'),
      cancel: mustNotBeCalled('sessions.cancel'),
      resume: mustNotBeCalled('sessions.resume'),
      confirmResult: mustNotBeCalled('sessions.confirmResult'),
      confirmCompletion: mustNotBeCalled('sessions.confirmCompletion'),
      inspectExecutionObligations: mustNotBeCalled('sessions.inspectExecutionObligations'),
      requestObligationAuthorization: mustNotBeCalled('sessions.requestObligationAuthorization'),
      confirmObligationGrant: mustNotBeCalled('sessions.confirmObligationGrant'),
      revokeObligationGrant: mustNotBeCalled('sessions.revokeObligationGrant'),
    },
    approvals: {
      list: mustNotBeCalled('approvals.list'),
      append: mustNotBeCalled('approvals.append'),
    },
    stopResponseTurn: mustNotBeCalled('stopResponseTurn'),
    retryTurn: mustNotBeCalled('retryTurn'),
    requestTakeover: mustNotBeCalled('requestTakeover'),
    recoveryControl: {
      needsAttention: () => false,
      execute: mustNotBeCalled('recoveryControl.execute'),
    },
    readActivity: (wsId) => bridge.readProjectBotActivity(wsId),
    readRecovery: (wsId) => bridge.readProjectBotRecovery(wsId),
    agentOnline: (wsId) => bridge.isProjectBotWorkspaceOnline(wsId),
    readAgentStatus: (wsId) => bridge.readProjectBotAgentStatus(wsId),
    createManaged: (name) => {
      const folder = path.join(root, 'managed', name);
      mkdirSync(folder, { recursive: true });
      const entry = registry.ensureForPath(folder);
      return { ok: true, workspace: entry, path: folder, name };
    },
    rememberWorkspace: (info) => remembered.push(info),
    moveToTrash: async (folder) => {
      trashedPaths.push(folder);
      rmSync(folder, { recursive: true, force: true });
      return { ok: true };
    },
    removeWorkspace: async (folder) => {
      removedPaths.push(folder);
      return { ok: true };
    },
    debounceMs: 5,
  });

  async function waitUntil(predicate, label, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await predicate();
      if (val) return val;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  try {
    await client.start();
    const configured = await bridge.configureProjectBotHost({
      enabled: true,
      proactivity: 'standard',
      learnPreferences: true,
      heartbeatIntervalMs: 100,
    });
    assert.equal(configured.ok, true);
    assert.equal(configured.enabled, true);
    assert.equal(bridge.isProjectBotHostActive(), true);
    assert.equal(hostStateEvents.some((e) => e.active === true && e.reason === 'configure'), true);

    jsHostLeases.pulse();
    assert.deepEqual(jsHostLeases.heldWorkspaceIds(), []);

    // 1. Create managed bot via Rust (blank repo -> synchronous RESPONSIBILITY_QUESTION)
    const created = await appService.create({ kind: 'managed', name: 'Cutover Bot' });
    assert.equal(created.ok, true);
    const ws = created.workspaceId;
    assert.ok(ws);
    assert.equal(created.profile.managed, true);
    assert.equal(created.familiarize.kind, 'blank');
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0].workspaceId, ws);
    assert.equal(bridge.isProjectBotWorkspaceOnline(ws), true);

    // JS hostLeases still holds ZERO leases while Rust holds host.lease on disk
    jsHostLeases.pulse();
    assert.deepEqual(jsHostLeases.heldWorkspaceIds(), []);
    const leaseOnDisk = JSON.parse(readFileSync(path.join(runtimeRoot, ws, 'host.lease'), 'utf8'));
    assert.equal(leaseOnDisk.surface, 'desktop');
    assert.equal(leaseOnDisk.hostId, configured.hostId);

    // 2. Submit input -> live SSE bot reply -> push streams (activity unwrapped + conversationChanged wrapped)
    const sent = await appService.submitInput({
      workspaceId: ws,
      inputId: 'in-cutover-1',
      text: 'hello rust cutover',
    });
    assert.equal(sent.ok, true);

    await waitUntil(async () => {
      const conv = await appService.readConversation({ workspaceId: ws });
      return conv.ok && conv.messages.some((m) => String(m.content || '').includes('Reply from Rust Bot Host.')) ? conv : null;
    }, 'bot reply persisted via Rust');

    const activityEvents = broadcasts.filter((e) => e.channel === 'project-agent:activity');
    assert.ok(activityEvents.length >= 1);
    assert.equal(activityEvents[0].payload.workspaceId, ws);
    assert.equal(typeof activityEvents[0].payload.turnId, 'string');
    assert.equal(Number.isFinite(activityEvents[0].payload.revision), true);

    const convEvents = broadcasts.filter((e) => e.channel === 'project-agent:conversation-changed');
    assert.ok(convEvents.some((e) => Array.isArray(e.payload?.workspaceIds) && e.payload.workspaceIds.includes(ws)));
    assert.ok(notifierHooks.some((n) => n.workspaceId === ws));

    const convSnap = await appService.readConversation({ workspaceId: ws });
    assert.ok(convSnap.activity && convSnap.activity.workspaceId === ws);
    const listed = await appService.list();
    assert.equal(listed.ok, true);
    const botRow = listed.items.find((item) => item.workspaceId === ws);
    assert.ok(botRow && ['idle', 'thinking', 'waiting_provider', 'error'].includes(botRow.state.agentStatus));

    const firstTurnId = await waitUntil(() => {
      const act = bridge.readProjectBotActivity(ws);
      return act && act.turnId && Boolean(act.finishedAt) ? act.turnId : null;
    }, 'first turn activity finished');

    // 3. Stop in-flight turn -> Retry turn end-to-end
    const slowSubmit = await appService.submitInput({
      workspaceId: ws,
      inputId: 'in-cutover-slow',
      text: 'slow_stop_turn please',
    });
    assert.equal(slowSubmit.ok, true);

    await slowArrived;
    const activeTurnId = await waitUntil(() => {
      const act = bridge.readProjectBotActivity(ws);
      return act && !act.finishedAt && act.turnId && act.turnId !== firstTurnId && act.phase !== 'done'
        ? act.turnId
        : null;
    }, 'active streaming turnId');

    const stopped = await appService.stopResponse({ workspaceId: ws, turnId: activeTurnId });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopping, true);

    await waitUntil(() => {
      const act = bridge.readProjectBotActivity(ws);
      return act && act.turnId === activeTurnId && Boolean(act.finishedAt);
    }, 'stopped turn finished');

    const retried = await appService.retry({ workspaceId: ws, turnId: activeTurnId });
    assert.equal(retried.ok, true);

    await waitUntil(async () => {
      const conv = await appService.readConversation({ workspaceId: ws });
      return conv.ok && conv.messages.some((m) => String(m.content || '').includes('Retried reply ok.'));
    }, 'retried turn reply persisted');

    // 4. Takeover (alreadyHost) + Recovery inspect (fresh workspace with no coordination-v2/fork yet)
    const takeover = await appService.takeoverHost({ workspaceId: ws });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.alreadyHost, true);

    const rec = await appService.controlRecovery({ workspaceId: ws, action: 'inspect' });
    assert.equal(rec.ok, false);
    assert.ok(['coordination_repair_no_fork', 'coordination_repair_path_invalid'].includes(rec.code));

    // 5. Two-phase Delete (confirmManaged required -> moveToTrash + removeWorkspace -> Rust finalize + lease release)
    const needConfirm = await appService.deleteBot({ workspaceId: ws, confirmManaged: false });
    assert.equal(needConfirm.ok, false);
    assert.equal(needConfirm.code, 'CONFIRM_REQUIRED');

    const deleted = await appService.deleteBot({ workspaceId: ws, confirmManaged: true });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.archived, true);
    assert.deepEqual(trashedPaths, [created.path]);
    assert.deepEqual(removedPaths, [created.path]);
    assert.equal(existsSync(created.path), false);
    assert.equal(bridge.isProjectBotWorkspaceOnline(ws), false);
    assert.equal(existsSync(path.join(runtimeRoot, ws, 'host.lease')), false);
    const archivedProfile = profileStore.read(ws);
    assert.equal(archivedProfile.status, 'archived');
    assert.equal(archivedProfile.deletionCleanup ?? null, null);
  } finally {
    if (slowRes) {
      try {
        slowRes.end();
        slowRes.destroy();
      } catch {}
    }
    jsHostLeases.close();
    appService.dispose();
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});

test('E2E: C4b-2b-2b-2b hostConfigure(enabled:false), obligationGrants push, and unexpected exit TS fallback release', async () => {
  const { dataHome, workspace, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();
  const runtimeRoot = path.join(dataHome, 'project-runtime');
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const ws = registry.ensureForPath(workspace).workspaceId;

  const broadcasts = [];
  const stateChanges = [];
  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    onProjectBotHostStateChanged: (payload) => stateChanges.push(payload),
    logger: { info() {}, warn() {}, error() {} },
  });

  const jsHostLeases = createHostLease({
    rootDir: runtimeRoot,
    hostId: 'js-desktop-fallback-test',
    surface: 'desktop',
    pid: process.pid,
    heartbeatMs: 60_000,
    projectAgentEnabled: () => !bridge.isProjectBotHostOwnedOrPending(),
    botWorkspaceIds: () => listBotWorkspaceIds(path.join(dataHome, 'projects')),
  });

  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    clientInfo: { name: 'peer-desktop-fallback-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: () => {
      bridge.handleUnexpectedExit();
      jsHostLeases.pulse();
    },
    maxRestarts: 0,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    await bridge.configureProjectBotHost({
      enabled: true,
      heartbeatIntervalMs: 100,
      workspaces: [{ path: workspace, name: 'Fallback Bot' }],
    });
    assert.equal(bridge.isProjectBotHostActive(), true);
    assert.equal(bridge.isProjectBotWorkspaceOnline(ws), true);
    jsHostLeases.pulse();
    assert.deepEqual(jsHostLeases.heldWorkspaceIds(), []);

    // Verify project.bot.obligationGrants push translation
    bridge.handleNotification('project.bot.obligationGrants', { workspaceId: ws, grantId: 'g-1', decision: 'confirm' });
    assert.deepEqual(
      broadcasts.find((b) => b.channel === 'project-agent:obligation-grants')?.payload,
      { workspaceId: ws, grantId: 'g-1', decision: 'confirm' },
    );

    // Disable host cleanly -> Rust releases lease, JS can acquire via TS fallback
    const disabled = await bridge.configureProjectBotHost({ enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(bridge.isProjectBotHostActive(), false);
    assert.equal(bridge.isProjectBotWorkspaceOnline(ws), false);
    jsHostLeases.pulse();
    assert.deepEqual(jsHostLeases.heldWorkspaceIds(), [ws]);
    jsHostLeases.release(ws);

    // Re-enable in Rust, then simulate unexpected exit reset
    await bridge.configureProjectBotHost({ enabled: true, heartbeatIntervalMs: 100 });
    assert.equal(bridge.isProjectBotWorkspaceOnline(ws), true);
    bridge.handleNotification('project.bot.activity', {
      workspaceId: ws,
      activity: { workspaceId: ws, conversationId: 'c1', turnId: 't1', revision: 1, startedAt: '2026-11-22T00:00:00.000Z', phase: 'thinking' },
      status: 'thinking',
    });
    assert.equal(bridge.readProjectBotAgentStatus(ws), 'thinking');
    assert.deepEqual(bridge.readProjectBotActivity(ws), {
      workspaceId: ws,
      conversationId: 'c1',
      turnId: 't1',
      revision: 1,
      startedAt: '2026-11-22T00:00:00.000Z',
      phase: 'thinking',
      replyTo: [],
      replyText: '',
      segments: [],
    });
    const lastActivityEvent = broadcasts.filter((e) => e.channel === 'project-agent:activity').at(-1);
    assert.deepEqual(lastActivityEvent?.payload?.segments, []);
    assert.deepEqual(lastActivityEvent?.payload?.replyTo, []);
    assert.equal(lastActivityEvent?.payload?.replyText, '');

    bridge.handleNotification('project.bot.activity', {
      workspaceId: ws,
      activity: { workspaceId: ws, conversationId: 'c1', turnId: 't1', revision: 2, startedAt: '2026-11-22T00:00:00.000Z', phase: 'disposed', replyTo: [], replyText: '', segments: [] },
      status: 'idle',
    });
    assert.equal(bridge.readProjectBotAgentStatus(ws), 'idle');
    assert.equal(bridge.readProjectBotActivity(ws), null);
    assert.equal(broadcasts.filter((e) => e.channel === 'project-agent:activity').at(-1)?.payload?.phase, 'disposed');

    bridge.handleUnexpectedExit();
    assert.equal(bridge.isProjectBotHostActive(), false);
    assert.equal(bridge.isProjectBotHostOwnedOrPending(), false);
    assert.equal(bridge.isProjectBotWorkspaceOnline(ws), false);
    assert.equal(bridge.readProjectBotActivity(ws), null);
    assert.equal(bridge.readProjectBotAgentStatus(ws), undefined);
    assert.ok(stateChanges.some((e) => e.active === false && e.reason === 'unexpected_exit'));
  } finally {
    jsHostLeases.close();
    await client.dispose();
    cleanup();
  }
});

test('E2E: remote-device-connector (setupRemoteAccess + createRemoteProjectAccess) runs against peer-native core --daemon', async () => {
  const { root, dataHome, workspace, cleanup } = makeTempDirs();
  const binaryPath = resolveTestBinary();

  const mockServer = await startMockSseServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseText('remote daemon thoughts', 'Remote ack from Rust daemon.'));
  });

  const notifications = [];
  let client = null;
  const bridge = createClassicCoreBridge({
    getClient: () => client,
    broadcast: (channel, payload) => notifications.push({ channel, payload }),
    logger: { info() {}, warn() {}, error() {} },
  });

  client = createPeerCoreClient({
    binaryPath,
    dataHome,
    transport: 'daemon',
    shutdownDaemonOnDispose: true,
    env: {
      PEER_MODEL_API_KEY: 'test-key-remote-daemon',
      PEER_MODEL_ID: 'e2e-mock-remote-daemon',
      PEER_MODEL_BASE_URL: mockServer.baseUrl,
    },
    clientInfo: { name: 'peer-desktop-remote-daemon-e2e', version: '0.1.0-test' },
    onNotification: bridge.handleNotification,
    hostHandlers: bridge.createHostHandlers(),
    onUnexpectedExit: bridge.handleUnexpectedExit,
    logger: { info() {}, warn() {}, error() {} },
  });

  const conversationStore = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const goalPlanStore = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const directory = createBotDirectory({
    rootDir: dataHome,
    registry,
    readMessages: (id) => conversationStore.getPersistedConversationHistory(id)?.messages ?? [],
  });

  let capturedConnector = null;
  let remote = null;

  try {
    await client.start();
    assert.equal(client.status().transport, 'daemon');
    await bridge.configureProjectBotHost({
      enabled: true,
      heartbeatIntervalMs: 100,
    });

    const created = await bridge.projectBotCreate({
      workspacePath: workspace,
      name: 'Remote Daemon Bot',
      startFamiliarize: false,
    });
    assert.equal(created.ok, true);
    const workspaceId = created.workspaceId;

    const projectAccess = {
      directory: {
        get: (ws) => directory.get(ws),
        workspaceIds: () => directory.workspaceIds(),
        conversationId: (ws) => directory.conversationId(ws),
        list: async () => {
          const res = await bridge.projectBotList({});
          return res?.ok && Array.isArray(res.items) ? res.items : directory.list();
        },
        readConversation: async (ws, opts = {}) => bridge.projectBotReadConversation({ workspaceId: ws, ...opts }),
        listSessions: async (ws) => (await bridge.projectBotListSessions({ workspaceId: ws }))?.sessions ?? [],
        listApprovals: async (ws) => (await bridge.projectBotListApprovals({ workspaceId: ws }))?.approvals ?? [],
      },
      inputQueue: {
        submitInput: async (input) => {
          const res = await bridge.projectBotSubmitInput({
            workspaceId: input.workspaceId,
            inputId: input.inputId,
            surface: input.surface || 'remote',
            text: typeof input.text === 'string' ? input.text.trim() : '',
          });
          if (res?.ok && res.input) return res.input;
          throw new Error(res?.code || 'INPUT_SUBMIT_FAILED');
        },
      },
      getSession: () => null,
      getSessionAsync: async (sessionId) => {
        const res = await bridge.projectBotGetSession({ sessionId, detail: 'report' });
        return res?.ok && res.session ? res.session : null;
      },
      wake: (ws) => {
        void bridge.projectBotWake(ws).catch(() => {});
      },
    };

    const userDataPath = path.join(root, 'remote-user-data');
    mkdirSync(userDataPath, { recursive: true });
    let identitySecret = null;
    remote = setupRemoteAccess({
      userDataPath,
      gatewayOrigin: 'https://peer.example',
      deviceName: 'desktop-daemon-e2e',
      workspaceId,
      goalPlanStore,
      sessionStore: { getSession: () => ({ sessionId: 'sess-main', locale: 'en-US' }) },
      buildProjection: () => ({ projectionId: 'proj-1', sessionId: 'sess-main', capabilities: [] }),
      host: { async execute() { return { grant: {}, result: {} }; } },
      connectorFactory(options) {
        capturedConnector = options;
        return { stop() {}, closed: Promise.resolve({ reason: 'stopped' }) };
      },
      identityStore: {
        isSupported: () => true,
        async loadSecret() { return identitySecret; },
        async saveSecret(next) { identitySecret = next; },
        async deleteSecret() { identitySecret = null; return true; },
      },
      registryFile: path.join(dataHome, 'projects', 'registry.json'),
      projectGrants: [{ workspaceId, allowProjectRead: true, allowProjectMessage: true }],
      getProjectAccess: () => projectAccess,
    });
    await remote.start();
    remote.bindingStore.save({
      origin: 'https://peer.example',
      deviceId: 'phone-1',
      ownerId: 'owner-1',
      bindingVersion: 1,
    });
    capturedConnector.onState({ status: 'online', connectionEpoch: 9 });

    const mkReq = (operation, extra = {}) => ({
      protocolVersion: 1,
      type: 'project.submit',
      requestId: `req-${operation}-${Math.random().toString(16).slice(2)}`,
      ownerId: 'owner-1',
      deviceId: 'phone-1',
      bindingVersion: 1,
      connectionEpoch: 9,
      delegationVersion: 1,
      expiresAt: Date.now() + 10_000,
      operation,
      ...extra,
    });

    // 1. project.list via shared Rust Core daemon
    const listOut = await capturedConnector.onProjectAccess(mkReq('project.list'));
    assert.equal(listOut.status, 'ok', `listOut failed: ${JSON.stringify(listOut)}`);
    assert.equal(listOut.result.projects.length, 1);
    assert.equal(listOut.result.projects[0].workspaceId, workspaceId);
    assert.equal(listOut.result.projects[0].canMessage, true);

    // 2. project.input.submit with padded whitespace (trim + conflict guard + idempotency)
    const submitReq = mkReq('project.input.submit', {
      requestId: 'req-remote-msg-1',
      workspaceId,
      text: '  hello from phone  ',
    });
    const submitOut = await capturedConnector.onProjectAccess(submitReq);
    assert.equal(submitOut.status, 'ok');
    assert.equal(submitOut.result.status, 'received');
    const replayOut = await capturedConnector.onProjectAccess({
      ...submitReq,
      text: 'hello from phone',
    });
    assert.deepEqual(replayOut, submitOut);
    const conflictOut = await capturedConnector.onProjectAccess({
      ...submitReq,
      text: 'tampered text',
    });
    assert.equal(conflictOut.status, 'rejected');
    assert.equal(conflictOut.code, 'REQUEST_CONFLICT');

    // 3. Wait for live Rust ProjectHostRuntime to wake & produce assistant reply, then read via project.conversation.read
    let convOut = null;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const readRes = await capturedConnector.onProjectAccess(mkReq('project.conversation.read', {
        workspaceId,
        limit: 20,
        before: null,
      }));
      if (readRes.status === 'ok' && readRes.result.messages.some((m) => m.kind === 'agent_reply' && m.content.includes('Remote ack from Rust daemon.'))) {
        convOut = readRes;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(convOut, 'expected live Rust reply in remote project.conversation.read');
    assert.ok(convOut.result.messages.some((m) => m.kind === 'user_input' && m.content === 'hello from phone'));
    assert.equal(JSON.stringify(convOut).includes(workspace), false, 'private local workspace path must be redacted');

    // 4. project.session.read via async Rust lookup cleanly rejects missing session without error
    const missingSess = await capturedConnector.onProjectAccess(mkReq('project.session.read', {
      workspaceId,
      sessionId: 'nonexistent-session-id',
    }));
    assert.equal(missingSess.status, 'rejected');
    assert.equal(missingSess.code, 'TASK_DENIED');

    // 5. project.bot.rebindFolder updates registry path and reports pathExists: true via Rust daemon
    const movedWorkspace = path.join(root, 'workspace-moved');
    mkdirSync(movedWorkspace, { recursive: true });
    const rebound = await bridge.projectBotRebindFolder({
      workspaceId,
      workspacePath: movedWorkspace,
    });
    assert.equal(rebound.ok, true, `rebind failed: ${JSON.stringify(rebound)}`);
    assert.equal(rebound.path, movedWorkspace);
    assert.equal(rebound.previousPath, workspace);
    assert.equal(rebound.pathExists, true);
    assert.equal(rebound.unchanged, false);

    const detailAfterRebind = await bridge.projectBotGet({ workspaceId });
    assert.equal(detailAfterRebind.ok, true);
    assert.equal(detailAfterRebind.path, movedWorkspace);
    assert.equal(detailAfterRebind.pathExists, true);
  } finally {
    remote?.stop();
    await client.dispose();
    await mockServer.close();
    cleanup();
  }
});
