import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDigestQueue } from '../../../../../packages/runtime-node/src/project-agent/digest.mjs';
import { createProjectAgentHost, messagesFromUserInputs } from './project-agent-host.mjs';

const provider = {
  id: 'text-default',
  provider: 'openai',
  groupId: 'openai-group',
  model: 'text',
  enabled: true,
  apiKeyConfigured: true,
  supportsVision: false,
  contextWindow: 32_000,
  isDefault: true,
};

test('只有持有租约且已有对话的项目会跑代理回合', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b2-07-host-'));
  const messages = [];
  const calls = [];
  const sent = [];
  let hold = true;
  try {
    const host = createProjectAgentHost({
      rootDir: root,
      holdsLease: (workspaceId) => hold && workspaceId === 'ws-leased',
      listWorkspaceIds: () => ['ws-leased', 'ws-client'],
      resolveConversationId: (workspaceId) => (workspaceId === 'ws-leased' ? 'conv-leased' : ''),
      hasMessage: (conversationId, messageId) => messages.some((message) => (
        message.conversationId === conversationId && message.id === messageId
      )),
      appendMessage(conversationId, message) {
        messages.push({ ...message, conversationId });
      },
      getWindows: () => [{ send(channel, payload) { sent.push({ channel, payload }); } }],
      routing: { providers: [provider] },
      resolveContext: () => ({ sources: [] }),
      retryDelays: [0, 0, 0],
      async executeTurn({ mode, turnProfile, plan, sink, modelProviderId }) {
        calls.push({
          mode,
          role: turnProfile.role,
          modelProviderId,
          context: turnProfile.context,
          workspaceId: turnProfile.workspaceId,
          kind: plan.kind,
        });
        sink.send('chat:stream:delta', { content: 'hi' });
        return { text: 'hi' };
      },
    });
    host.inputQueue.submitInput({
      inputId: randomUUID(),
      workspaceId: 'ws-leased',
      surface: 'desktop',
      text: '你好',
    });
    host.inputQueue.submitInput({
      inputId: randomUUID(),
      workspaceId: 'ws-client',
      surface: 'desktop',
      text: '别跑',
    });
    await host.sync();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'project_agent');
    assert.equal(calls[0].role, 'project_agent');
    assert.equal(calls[0].kind, 'user');
    assert.equal(calls[0].workspaceId, 'ws-leased');
    assert.equal(calls[0].modelProviderId, 'text-default');
    assert.deepEqual(calls[0].context, { sources: [] });
    assert.equal(host.runnerFor('ws-client'), null);
    assert.equal(host.runnerFor('ws-leased')?.conversationId, 'conv-leased');
    assert.deepEqual(sent, [{ channel: 'chat:stream:delta', payload: { content: 'hi' } }]);
    assert.deepEqual(messages.filter((message) => message.role === 'user').map((message) => message.content), ['你好']);
    assert.equal(host.inputQueue.cursor('ws-client'), null);

    await host.sync();
    assert.equal(calls.length, 1);

    hold = false;
    await host.sync();
    assert.equal(host.runnerFor('ws-leased'), null);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('到了小结时间即使没有新输入也会写入分隔消息', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-05-digest-host-'));
  const messages = [];
  const calls = [];
  const digests = createDigestQueue();
  digests.hold('ws-leased', { id: 'a', text: '登录修好了' });
  let pending = null;
  const host = createProjectAgentHost({
    rootDir: root,
    holdsLease: (workspaceId) => workspaceId === 'ws-leased',
    listWorkspaceIds: () => ['ws-leased'],
    resolveConversationId: () => 'conv-leased',
    hasMessage: () => false,
    appendMessage(_conversationId, message) {
      messages.push(message);
    },
    getWindows: () => [],
    readSettings: () => ({ projectAgent: { digestTime: '09:00', proactivity: 'standard' } }),
    now: () => new Date(2026, 8, 27, 9, 5),
    digestQueue: digests,
    schedule(fn, delay) {
      pending = { fn, delay };
      return pending;
    },
    clearSchedule() {
      pending = null;
    },
    async executeTurn() {
      calls.push('model');
      return { text: '不该跑模型' };
    },
  });
  try {
    assert.equal(pending.delay, 0);
    assert.equal(calls.length, 0);
    await pending.fn();
    assert.equal(calls.length, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].separatorLabel, '今天 09:00 · 今日小结');
    assert.equal(messages[0].content, '登录修好了');
    assert.equal(digests.pending('ws-leased'), 0);
    assert.ok(pending.delay >= 60 * 60 * 1000);
  } finally {
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('安静满 10 分钟会唤醒代理，同一原因第三次失败要求问用户', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-08-watch-host-'));
  const calls = [];
  const timers = [];
  const startedAt = '2026-09-27T00:00:00.000Z';
  let facts = {
    sessions: [{
      sessionId: 'session-1',
      workspaceId: 'ws-leased',
      planId: 'plan-1',
      status: 'running',
      startedAt,
      version: 1,
    }],
  };
  const host = createProjectAgentHost({
    rootDir: root,
    holdsLease: (workspaceId) => workspaceId === 'ws-leased',
    listWorkspaceIds: () => ['ws-leased'],
    resolveConversationId: () => 'conv-leased',
    hasMessage: () => false,
    appendMessage() {},
    getWindows: () => [],
    routing: { providers: [provider] },
    now: () => '2026-09-27T00:10:00.000Z',
    retryDelays: [0, 0, 0],
    readFacts: () => facts,
    schedule(fn, delay) {
      const handle = { fn, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearSchedule(handle) {
      if (handle) handle.cleared = true;
    },
    async executeTurn({ plan }) {
      calls.push(plan.events.map((event) => ({
        kind: event.kind,
        summary: event.payload?.summary,
        askUser: event.payload?.askUser,
        stopAutoRetry: event.payload?.stopAutoRetry,
      })));
      return { text: '' };
    },
  });
  try {
    const first = timers.find((timer) => timer.delay === 0 && !timer.cleared);
    await first.fn();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].some((event) => event.kind === 'stalled'), true);

    const quiet = timers.filter((timer) => !timer.cleared).at(-1);
    await quiet.fn();
    assert.equal(calls.length, 1);

    facts = {
      sessions: [{
        sessionId: 'session-1',
        workspaceId: 'ws-leased',
        planId: 'plan-1',
        taskId: 'task-login',
        status: 'interrupted',
        startedAt,
        version: 2,
        runner: {
          lastError: 'boom',
          interruption: { reason: 'boom' },
        },
        runTrace: {
          events: [
            { type: 'step_failed', payload: { reason: 'boom' } },
            { type: 'step_failed', payload: { reason: 'boom' } },
          ],
        },
      }],
    };
    const failed = timers.filter((timer) => !timer.cleared).at(-1);
    await failed.fn();
    const failure = calls.at(-1).find((event) => event.kind === 'interrupted');
    assert.equal(failure.summary, 'boom');
    assert.equal(failure.askUser, true);
    assert.equal(failure.stopAutoRetry, true);
    assert.equal(calls.at(-1).some((event) => event.kind === 'stalled'), false);
  } finally {
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('用户回合把缩略图放进模型能看的消息', () => {
  const messages = messagesFromUserInputs({
    userInputs: [{
      text: 'Appshot — TextEdit',
      attachments: [{
        kind: 'image',
        dataUrl: 'data:image/png;base64,AA==',
        artifactRef: 'local-appshot-artifact://abc',
      }],
    }],
  });
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content[1].type, 'image_url');
  assert.equal(messages[0].content[1].image_url.url, 'data:image/png;base64,AA==');
  assert.equal(messagesFromUserInputs({ userInputs: [] }), null);
});
