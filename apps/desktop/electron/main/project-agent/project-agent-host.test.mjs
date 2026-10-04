import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectInbox } from '../../../../../packages/runtime-node/src/project-agent/project-inbox.mjs';
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
  const statuses = [];
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
      broadcast: (channel, payload) => sent.push({ channel, payload }),
      onStatus: (workspaceId, status) => statuses.push({ workspaceId, status }),
      routing: { providers: [provider] },
      resolveContext: () => ({ sources: [] }),
      retryDelays: [0, 0, 0],
      async executeTurn({ mode, turnProfile, plan, sink, modelProviderId, streamId }) {
        calls.push({
          mode,
          role: turnProfile.role,
          modelProviderId,
          context: turnProfile.context,
          workspaceId: turnProfile.workspaceId,
          kind: plan.kind,
        });
        sink.send('chat:stream:delta', { streamId, content: 'hi' });
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
    assert.deepEqual(calls[0].context.sources, []);
    assert.equal(calls[0].context.inputAnchors[0].text, '你好');
    assert.match(calls[0].context.inputAnchors[0].messageId, /^input-/);
    assert.equal(host.runnerFor('ws-client'), null);
    assert.equal(host.runnerFor('ws-leased')?.conversationId, 'conv-leased');
    assert.deepEqual(statuses.map((item) => item.status), ['thinking', 'waiting_provider', 'thinking', 'idle']);
    assert.ok(statuses.every((item) => item.workspaceId === 'ws-leased'));
    assert.ok(sent.length > 0);
    assert.ok(sent.every(event => event.channel === 'project-agent:activity' && event.payload.workspaceId === 'ws-leased'));
    assert.equal(sent.at(-1).payload.phase, 'done');
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

test('后台巡检在取得租约后恢复提前入队的输入，并且不重复消费', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-agent-queued-recovery-'));
  const timers = [];
  const messages = [];
  const turns = [];
  const consumedInputs = [];
  let leased = false;
  const host = createProjectAgentHost({
    rootDir: root,
    holdsLease: () => leased,
    listWorkspaceIds: () => ['ws-recovery'],
    resolveConversationId: () => 'conv-recovery',
    hasMessage: (_, id) => messages.some(message => message.id === id),
    appendMessage: (_, message) => messages.push(message),
    onInputsConsumed: (_, inputs) => consumedInputs.push(...inputs),
    readFacts: () => ({ sessions: [] }),
    routing: { providers: [provider] },
    schedule(fn, delay) {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearSchedule(timer) { timer.cleared = true; },
    async executeTurn({ plan }) {
      turns.push(plan);
      return { text: '收到' };
    },
  });
  try {
    host.inputQueue.submitInput({ inputId: 'early-input', workspaceId: 'ws-recovery', surface: 'desktop', text: '提前提交' });
    await host.sync();
    await timers.at(-1).fn();
    assert.equal(turns.length, 0);
    assert.equal(host.inputQueue.cursor('ws-recovery'), null);
    leased = true;
    await timers.at(-1).fn();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].userInputs[0].text, '提前提交');
    assert.equal(consumedInputs.length, 1);
    assert.equal(host.inputQueue.cursor('ws-recovery'), 'early-input');
    await timers.at(-1).fn();
    await host.sync();
    assert.equal(turns.length, 1);
    assert.equal(messages.filter(message => message.role === 'user').length, 1);
    assert.equal(consumedInputs.length, 1);
  } finally {
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});


test('periodic lease recovery drains an existing inbox once without fresh watch events', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inbox-recovery-host-'));
  const timers = [];
  const calls = [];
  let hold = false;
  const inbox = createProjectInbox({ rootDir: root, mergeWindowMs: 0 });
  inbox.append('ws-leased', [{ eventId: 'persisted-verified', kind: 'session_verified',
    sessionId: 'session-old', workspaceId: 'ws-leased', payload: { summary: 'Verified' } }]);
  const host = createProjectAgentHost({
    rootDir: root, inbox, holdsLease: () => hold,
    listWorkspaceIds: () => ['ws-leased'], resolveConversationId: () => 'conv-leased',
    hasMessage: () => false, appendMessage() {}, getWindows: () => [],
    routing: { providers: [provider] }, readFacts: () => ({ sessions: [] }),
    retryDelays: [0, 0, 0],
    schedule(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearSchedule(timer) { timer.cleared = true; },
    async executeTurn({ plan }) { calls.push(plan.events); return { text: '' }; },
  });
  try {
    await timers.find(timer => timer.delay === 0).fn();
    assert.equal(calls.length, 0);
    hold = true;
    await timers.filter(timer => !timer.cleared).at(-1).fn();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].eventId, 'persisted-verified');
    assert.equal(inbox.takeBatch('ws-leased').events.length, 0);
    await timers.filter(timer => !timer.cleared).at(-1).fn();
    assert.equal(calls.length, 1);
  } finally { host.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('one project recovery failure never runs its model or blocks another owned project', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-host-recovery-')); const messages = [], calls = [], phases = [];
  const host = createProjectAgentHost({ rootDir: root, holdsLease: () => true, listWorkspaceIds: () => ['bad', 'good'], resolveConversationId: id => `c-${id}`,
    hasMessage: (_id, messageId) => messages.some(message => message.id === messageId), appendMessage: (_id, message) => messages.push(message),
    recoverTasks: id => { if (id === 'bad') throw new Error('broken checkpoint'); }, onRecoveryPhase: item => phases.push(`${item.workspaceId}:${item.phase}`),
    resolveModel: () => ({ modelProviderId: 'model' }), executeTurn: async input => { calls.push(input.workspaceId); return { text: 'done' }; } });
  try {
    for (const workspaceId of ['bad', 'good']) host.inputQueue.submitInput({ workspaceId, inputId: `${workspaceId}-input`, surface: 'desktop', text: 'do it' });
    const result = await host.sync();
    assert.equal(result.outcomes.find(item => item.workspaceId === 'bad').phase, 'tasks');
    assert.equal(host.isReady('bad'), false); assert.equal(host.isReady('good'), true); assert.deepEqual(calls, ['good']);
    assert.deepEqual(phases.filter(item => item.startsWith('good:')), ['lease', 'inputs', 'inbox', 'queue', 'tasks', 'watch', 'digest'].map(phase => `good:${phase}`));
  } finally { host.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('digest maintenance runs under recovery lease even with no inbox, and never runs for an unowned or stopped project', async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'memory-clock-'));const maintenance=[];let modelCalls=0;let owned=true;
  const host=createProjectAgentHost({rootDir:root,holdsLease:()=>owned,listWorkspaceIds:()=>['ws'],resolveConversationId:()=> 'conv',executeTurn:async()=>{modelCalls++;return {text:'unexpected'};},readSettings:()=>({projectAgent:{digestTime:'00:00'}}),now:()=>new Date(),onMaintenance:info=>maintenance.push(info),schedule:()=>null});
  try {
    await host.sync();assert.ok(maintenance.length>=1);assert.equal(modelCalls,0);
    const count=maintenance.length;owned=false;await host.sync();assert.equal(maintenance.length,count);
    owned=true;host.stop('ws');await host.sync();assert.equal(maintenance.length,count);
  } finally {host.dispose();rmSync(root,{recursive:true,force:true});}
});

test('uploaded text and images enter canonical user content; unsupported files admit metadata only', () => {
  const projected = messagesFromUserInputs({ userInputs: [{ text: '', attachments: [
    { id: 't', kind: 'text', name: 'brief.md', mimeType: 'text/markdown', size: 6, text: '用户文件事实' },
    { id: 'p', kind: 'unsupported', name: 'brief.pdf', mimeType: 'application/pdf', size: 10, text: 'NOT_ADMITTED' },
    { id: 'i', kind: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,AA==' },
  ] }] });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].role, 'user');
  assert.match(projected[0].content[0].text, /brief.md/);
  assert.match(projected[0].content[0].text, /用户文件事实/);
  assert.match(projected[0].content[0].text, /not supported yet/);
  assert.doesNotMatch(projected[0].content[0].text, /NOT_ADMITTED/);
  assert.equal(projected[0].content[1].type, 'image_url');
});
