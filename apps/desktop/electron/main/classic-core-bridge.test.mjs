import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPeerCoreClient } from './peer-core-client.mjs';
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
    assert.equal(bridge.canHandleChatSend({ mode: 'chat', hasActiveGoal: false }), true);
    assert.equal(bridge.canHandleChatSend({ mode: 'plan', hasActiveGoal: false }), true);
    assert.equal(bridge.canHandleChatSend({ mode: 'goal', hasActiveGoal: false }), false);
    assert.equal(bridge.canHandleChatSend({ mode: 'chat', hasActiveGoal: true }), false);

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
