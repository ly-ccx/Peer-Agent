import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createTaskNotificationBroker } from './task-notification-broker.mjs';
import { createTaskNotificationReceiptStore } from './task-notification-receipt-store.mjs';

let tmpRoot;
let receiptFile;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'task-notif-'));
  process.env.PEER_AGENT_HOME = path.join(tmpRoot, '.peer-agent');
  receiptFile = path.join(process.env.PEER_AGENT_HOME, 'task-notification-receipts.json');
});

afterEach(() => {
  delete process.env.PEER_AGENT_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function createHarness(overrides = {}) {
  const plans = new Map(overrides.plans || []);
  const shown = [];
  const opened = [];
  let activeConversationId = overrides.activeConversationId ?? null;
  let isAppForeground = overrides.isAppForeground ?? false;
  const settings = overrides.settings || {
    taskNotifications: { enabled: true, completed: true, failed: true, waitingUser: true },
  };

  const receiptStore = createTaskNotificationReceiptStore({ receiptFile });
  const broker = createTaskNotificationBroker({
    getPlan: (planId) => plans.get(planId) || null,
    listPlans: () => Array.from(plans.values()),
    getSettings: () => settings,
    isAppForeground: () => isAppForeground,
    getActiveConversationId: () => activeConversationId,
    openConversation: (payload) => {
      opened.push(payload);
    },
    showNotification: ({ title, body, onClick }) => {
      shown.push({ title, body, onClick });
      return true;
    },
    isNotificationSupported: () => true,
    receiptStore,
  });

  return {
    plans,
    shown,
    opened,
    receiptStore,
    broker,
    setForeground(v) {
      isAppForeground = v;
    },
    setActiveConversation(id) {
      activeConversationId = id;
    },
  };
}

describe('task-notification-broker', () => {
  it('notifies once on executing -> completed and dedupes same version', () => {
    const h = createHarness();
    h.plans.set('p1', {
      planId: 'p1',
      status: 'executing',
      title: '任务 A',
      conversationId: 'c1',
      targetWorkspacePath: '/ws',
    });
    // first observe executing
    h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(h.shown.length, 0);

    h.plans.set('p1', { ...h.plans.get('p1'), status: 'completed' });
    const d1 = h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(d1.action, 'notify');
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].title, '任务已完成');
    assert.equal(h.shown[0].body, '任务 A');

    // same completed again -> no second notification
    const d2 = h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(d2.action, 'skip');
    assert.equal(h.shown.length, 1);

    const receipt = h.receiptStore.get('p1');
    assert.equal(receipt.lastNotifiedAttentionVersion, 1);
  });

  it('suppresses when viewing same conversation in foreground', () => {
    const h = createHarness({ isAppForeground: true, activeConversationId: 'c1' });
    h.plans.set('p1', {
      planId: 'p1',
      status: 'executing',
      title: '前台任务',
      conversationId: 'c1',
    });
    h.broker.evaluatePlan(h.plans.get('p1'));
    h.plans.set('p1', { ...h.plans.get('p1'), status: 'completed' });
    const d = h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'foreground_same_conversation');
    assert.equal(h.shown.length, 0);
  });

  it('does not notify intake contracts that never become real goals', () => {
    const h = createHarness();
    h.plans.set('p-intake', {
      planId: 'p-intake',
      status: 'executing',
      title: '所以我想看执行记录？',
      conversationId: 'c-intake',
      activation: { kind: 'intake', sourceMessageId: 'm1' },
    });
    h.broker.evaluatePlan(h.plans.get('p-intake'));
    h.plans.set('p-intake', { ...h.plans.get('p-intake'), status: 'completed' });
    const d = h.broker.evaluatePlan(h.plans.get('p-intake'));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'intake_contract');
    assert.equal(h.shown.length, 0);
  });

  it('still notifies accepted goals after completion', () => {
    const h = createHarness();
    h.plans.set('p-goal', {
      planId: 'p-goal',
      status: 'executing',
      title: '修复通知过滤',
      conversationId: 'c-goal',
      activation: { kind: 'accepted_goal', sourceMessageId: 'm2' },
    });
    h.broker.evaluatePlan(h.plans.get('p-goal'));
    h.plans.set('p-goal', { ...h.plans.get('p-goal'), status: 'completed' });
    const d = h.broker.evaluatePlan(h.plans.get('p-goal'));
    assert.equal(d.action, 'notify');
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].title, '任务已完成');
  });

  it('notifies waiting_user then failed with increasing attention versions', () => {
    const h = createHarness();
    h.plans.set('p1', {
      planId: 'p1',
      status: 'executing',
      title: '发布预发',
      conversationId: 'c9',
      waitingReason: 'confirmation',
    });
    h.broker.evaluatePlan(h.plans.get('p1'));

    h.plans.set('p1', { ...h.plans.get('p1'), status: 'waiting_user' });
    const w = h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(w.action, 'notify');
    assert.equal(w.attentionVersion, 1);
    assert.equal(h.shown[0].title, '需要你的确认');

    h.plans.set('p1', { ...h.plans.get('p1'), status: 'executing' });
    h.broker.evaluatePlan(h.plans.get('p1'));

    h.plans.set('p1', {
      ...h.plans.get('p1'),
      status: 'failed',
      failureReason: 'timeout',
    });
    const f = h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(f.action, 'notify');
    assert.equal(f.attentionVersion, 2);
    assert.equal(h.shown.length, 2);
    assert.equal(h.shown[1].title, '任务失败');
  });

  it('does not replay existing notifiable plans on bootstrap', () => {
    const h = createHarness({
      plans: [
        [
          'old',
          {
            planId: 'old',
            status: 'completed',
            title: '历史完成',
            conversationId: 'c1',
          },
        ],
      ],
    });
    h.broker.bootstrapExisting();
    assert.equal(h.shown.length, 0);

    // re-evaluate same completed after bootstrap should not notify
    const d = h.broker.evaluatePlan(h.plans.get('old'));
    assert.equal(d.action, 'skip');
    assert.equal(h.shown.length, 0);
  });

  it('click handler opens the conversation in its origin workspace and marks read', () => {
    const h = createHarness();
    h.plans.set('p1', {
      planId: 'p1',
      status: 'executing',
      title: '回流',
      conversationId: 'c42',
      originWorkspacePath: '/ws/conversation',
      targetWorkspacePath: '/repo/execution',
    });
    h.broker.evaluatePlan(h.plans.get('p1'));
    h.plans.set('p1', { ...h.plans.get('p1'), status: 'completed' });
    h.broker.evaluatePlan(h.plans.get('p1'));
    assert.equal(h.shown.length, 1);

    h.shown[0].onClick();
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].conversationId, 'c42');
    assert.equal(h.opened[0].workspacePath, '/ws/conversation');
    assert.equal(h.opened[0].source, 'system-notification');
    assert.equal(h.receiptStore.get('p1').lastReadAttentionVersion, 1);
  });

  it('handleGoalPlanChanged loads plan and ignores runner-progress', () => {
    const h = createHarness();
    h.plans.set('p1', {
      planId: 'p1',
      status: 'executing',
      title: 'IPC 路径',
      conversationId: 'c1',
    });
    h.broker.handleGoalPlanChanged({ planId: 'p1', changeKind: 'persist' });
    h.plans.set('p1', { ...h.plans.get('p1'), status: 'completed' });
    const d = h.broker.handleGoalPlanChanged({ planId: 'p1', changeKind: 'persist' });
    assert.equal(d.action, 'notify');
    assert.equal(h.shown.length, 1);

    const skipped = h.broker.handleGoalPlanChanged({
      planId: 'p1',
      changeKind: 'runner-progress',
    });
    assert.equal(skipped.reason, 'runner_progress');
    assert.equal(h.shown.length, 1);
  });
});

describe('task-notification-receipt-store', () => {
  it('persists notified and read versions across reload', () => {
    const store = createTaskNotificationReceiptStore({ receiptFile });
    store.markNotified('t1', 2, { status: 'completed' });
    store.markRead('t1', 2);

    const store2 = createTaskNotificationReceiptStore({ receiptFile });
    const entry = store2.get('t1');
    assert.equal(entry.lastNotifiedAttentionVersion, 2);
    assert.equal(entry.lastReadAttentionVersion, 2);
    assert.equal(entry.lastStatus, 'completed');
  });

  it('seedFromExistingTasks marks current versions as handled', () => {
    const store = createTaskNotificationReceiptStore({ receiptFile });
    store.seedFromExistingTasks([{ taskId: 't2', status: 'failed', attentionVersion: 1 }]);
    const entry = store.get('t2');
    assert.equal(entry.lastNotifiedAttentionVersion, 1);
    assert.equal(entry.lastReadAttentionVersion, 1);
    assert.equal(entry.lastStatus, 'failed');
  });
});
