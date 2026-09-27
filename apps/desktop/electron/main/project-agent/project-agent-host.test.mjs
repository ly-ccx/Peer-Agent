import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectAgentHost } from './project-agent-host.mjs';

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
