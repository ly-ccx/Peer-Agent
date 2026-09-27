import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createTaskNotificationReceiptStore } from '../task-notification-receipt-store.mjs';
import {
  createProjectAgentNotifier,
  notificationBody,
} from './project-agent-notifier.mjs';

let tmpRoot;
let receiptFile;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'bot-notif-'));
  process.env.PEER_AGENT_HOME = path.join(tmpRoot, '.peer-agent');
  receiptFile = path.join(process.env.PEER_AGENT_HOME, 'task-notification-receipts.json');
});

afterEach(() => {
  delete process.env.PEER_AGENT_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const interruptEvent = {
  origin: 'user_request',
  kind: 'result',
  novelty: true,
  severity: 'info',
};

function createHarness({ enabled = true, foregroundSameBot = false } = {}) {
  const shown = [];
  const opened = [];
  const receiptStore = createTaskNotificationReceiptStore({ receiptFile });
  const notifier = createProjectAgentNotifier({
    isEnabled: () => enabled,
    isForegroundSameBot: () => foregroundSameBot,
    showNotification: ({ title, body, onClick }) => {
      shown.push({ title, body, onClick });
      return true;
    },
    openBot: (payload) => {
      opened.push(payload);
    },
    receiptStore,
    workspaceIdForConversation: (conversationId) => (
      conversationId === 'conv-bot' ? 'ws-1' : ''
    ),
    botNameForWorkspace: () => '笔记',
  });
  return { shown, opened, receiptStore, notifier };
}

describe('project-agent-notifier', () => {
  it('notifies once for interrupt and dedupes the same event', () => {
    const h = createHarness();
    const input = {
      eventId: 'evt-1',
      workspaceId: 'ws-1',
      botName: '笔记',
      messageId: 'msg-1',
      text: '第一句已经做完。后面这句不要进通知。',
      event: interruptEvent,
      foreground: true,
    };
    const first = h.notifier.consider(input);
    assert.equal(first.action, 'notify');
    assert.equal(first.surfacing.decision, 'interrupt');
    assert.equal(first.surfacing.reason, 'user_result');
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].title, '笔记');
    assert.equal(h.shown[0].body, '第一句已经做完。');

    const second = h.notifier.consider(input);
    assert.equal(second.action, 'skip');
    assert.equal(second.reason, 'duplicate');
    assert.equal(h.shown.length, 1);
    assert.equal(h.receiptStore.get('evt-1').lastNotifiedAttentionVersion, 1);

    h.shown[0].onClick();
    assert.deepEqual(h.opened, [{ workspaceId: 'ws-1', messageId: 'msg-1' }]);
    assert.equal(h.receiptStore.get('evt-1').lastReadAttentionVersion, 1);
  });

  it('suppresses interrupt while the user is looking at that bot', () => {
    const h = createHarness({ foregroundSameBot: true });
    const decision = h.notifier.consider({
      eventId: 'evt-2',
      workspaceId: 'ws-1',
      botName: '笔记',
      messageId: 'msg-2',
      text: '需要你看一眼。',
      event: interruptEvent,
      foreground: true,
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'foreground_same_bot');
    assert.equal(decision.surfacing.decision, 'interrupt');
    assert.equal(h.shown.length, 0);
    assert.equal(h.receiptStore.get('evt-2'), null);
  });

  it('still notifies when a needs-you event arrives while the bot is muted', () => {
    const h = createHarness();
    const decision = h.notifier.consider({
      eventId: 'evt-mute',
      workspaceId: 'ws-1',
      botName: '笔记',
      messageId: 'msg-mute',
      text: '需要你批准。',
      proactivity: 'off',
      event: { origin: 'user_request', kind: 'needs_user', novelty: true, severity: 'info' },
    });
    assert.equal(decision.action, 'notify');
    assert.equal(decision.surfacing.decision, 'interrupt');
    assert.equal(h.shown.length, 1);
  });

  it('stays quiet when the developer switch is off', () => {
    const h = createHarness({ enabled: false });
    const decision = h.notifier.consider({
      eventId: 'evt-3',
      workspaceId: 'ws-1',
      botName: '笔记',
      messageId: 'msg-3',
      text: '开关关着不该弹。',
      event: interruptEvent,
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'project_agent_disabled');
    assert.equal(h.shown.length, 0);

    const appended = h.notifier.handleAppended({
      conversationId: 'conv-bot',
      message: {
        id: 'msg-4',
        kind: 'agent_reply',
        content: '已写好。',
        meta: { surfacing: 'interrupt' },
      },
    });
    assert.equal(appended.reason, 'project_agent_disabled');
    assert.equal(h.shown.length, 0);
  });

  it('uses a stored interrupt once, and ignores a card without surfacing', () => {
    const h = createHarness();
    const notified = h.notifier.handleAppended({
      conversationId: 'conv-bot',
      message: {
        id: 'msg-5',
        eventId: 'evt-5',
        kind: 'agent_reply',
        content: '摘要在后。首句在前。',
        meta: { surfacing: 'interrupt' },
      },
    });
    assert.equal(notified.action, 'notify');
    assert.equal(h.shown[0].title, '笔记');
    assert.equal(h.shown[0].body, '摘要在后。');

    const again = h.notifier.handleAppended({
      conversationId: 'conv-bot',
      message: {
        id: 'msg-5',
        eventId: 'evt-5',
        kind: 'agent_reply',
        content: '摘要在后。首句在前。',
        meta: { surfacing: 'interrupt' },
      },
    });
    assert.equal(again.reason, 'duplicate');
    assert.equal(h.shown.length, 1);

    const card = h.notifier.handleAppended({
      conversationId: 'conv-bot',
      message: { id: 'card-1', kind: 'system_card', content: '需要你批准' },
    });
    assert.equal(card.reason, 'missing_surfacing');
    assert.equal(h.shown.length, 1);
  });

  it('keeps a low-tier user result in the conversation', () => {
    const h = createHarness();
    const decision = h.notifier.consider({
      eventId: 'evt-low',
      workspaceId: 'ws-1',
      botName: '笔记',
      messageId: 'msg-low',
      text: '只留在对话里。',
      event: interruptEvent,
      proactivity: 'low',
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'not_interrupt');
    assert.equal(decision.surfacing.decision, 'message');
    assert.equal(h.shown.length, 0);
  });

  it('clips the body to 60 code points and prefers the reply over a card summary', () => {
    const sentence = `${'字'.repeat(80)}。后面不要。`;
    assert.equal(notificationBody(sentence).length, 60);
    assert.equal(notificationBody('', '卡片摘要。回复没有。'), '卡片摘要。');
    assert.equal(notificationBody('回复首句。', '卡片摘要。'), '回复首句。');
    assert.equal(Array.from(notificationBody(`好${'🎉'.repeat(70)}`)).length, 60);
  });
});
