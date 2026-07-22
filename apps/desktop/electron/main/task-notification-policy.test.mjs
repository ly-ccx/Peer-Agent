import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDedupeKey,
  buildNotificationCopy,
  decideTaskNotification,
  isAttentionTransition,
  nextAttentionVersion,
  projectPlanToNotificationTask,
  shouldSuppressForForeground,
  truncateText,
} from './task-notification-policy.mjs';

describe('task-notification-policy transitions', () => {
  it('detects completed / failed / waiting_user attention transitions', () => {
    assert.equal(isAttentionTransition('executing', 'completed'), true);
    assert.equal(isAttentionTransition('executing', 'failed'), true);
    assert.equal(isAttentionTransition('executing', 'waiting_user'), true);
    assert.equal(isAttentionTransition('waiting_user', 'waiting_user'), false);
    assert.equal(isAttentionTransition('executing', 'cancelled'), false);
    assert.equal(isAttentionTransition('executing', 'executing'), false);
    assert.equal(isAttentionTransition(null, 'completed'), true);
  });

  it('increments attentionVersion only on attention transitions', () => {
    assert.equal(nextAttentionVersion(0, 'executing', 'completed'), 1);
    assert.equal(nextAttentionVersion(1, 'completed', 'completed'), 1);
    assert.equal(nextAttentionVersion(1, 'waiting_user', 'executing'), 1);
    assert.equal(nextAttentionVersion(1, 'executing', 'waiting_user'), 2);
    assert.equal(nextAttentionVersion(2, 'waiting_user', 'failed'), 3);
  });
});

describe('task-notification-policy decide', () => {
  const base = {
    taskId: 'plan-1',
    previousStatus: 'executing',
    nextStatus: 'completed',
    previousAttentionVersion: 0,
    lastNotifiedAttentionVersion: 0,
    lastReadAttentionVersion: 0,
    title: '给登录页加暗色模式',
    conversationId: 'c1',
    activeConversationId: 'c2',
    isAppForeground: false,
    settings: { enabled: true, completed: true, failed: true, waitingUser: true },
    notificationSupported: true,
  };

  it('notifies on completed when background', () => {
    const d = decideTaskNotification(base);
    assert.equal(d.action, 'notify');
    assert.equal(d.attentionVersion, 1);
    assert.equal(d.dedupeKey, 'plan-1#1');
    assert.equal(d.copy.title, '任务已完成');
    assert.equal(d.copy.body, '给登录页加暗色模式');
  });

  it('notifies on failed with short error body', () => {
    const d = decideTaskNotification({
      ...base,
      nextStatus: 'failed',
      shortError: 'npm install 失败',
    });
    assert.equal(d.action, 'notify');
    assert.equal(d.copy.title, '任务失败');
    assert.match(d.copy.body, /npm install 失败/);
  });

  it('notifies on waiting_user with confirmation title', () => {
    const d = decideTaskNotification({
      ...base,
      nextStatus: 'waiting_user',
      waitingReason: 'confirmation',
    });
    assert.equal(d.action, 'notify');
    assert.equal(d.copy.title, '需要你的确认');
  });

  it('suppresses when foreground same conversation', () => {
    const d = decideTaskNotification({
      ...base,
      isAppForeground: true,
      activeConversationId: 'c1',
      conversationId: 'c1',
    });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'foreground_same_conversation');
  });

  it('does not suppress when foreground but different conversation', () => {
    const d = decideTaskNotification({
      ...base,
      isAppForeground: true,
      activeConversationId: 'other',
      conversationId: 'c1',
    });
    assert.equal(d.action, 'notify');
  });

  it('dedupes by attentionVersion already notified', () => {
    const d = decideTaskNotification({
      ...base,
      previousAttentionVersion: 1,
      lastNotifiedAttentionVersion: 1,
      // same status re-entry is already not a transition; force version check via transition
      previousStatus: 'executing',
      nextStatus: 'completed',
    });
    // transition still bumps 1->2 if previousAttentionVersion is 1? previousVersion=1, transition -> 2
    // lastNotified=1, so version 2 > 1 should notify
    assert.equal(d.action, 'notify');
    assert.equal(d.attentionVersion, 2);

    const d2 = decideTaskNotification({
      ...base,
      previousAttentionVersion: 1,
      lastNotifiedAttentionVersion: 2,
      previousStatus: 'executing',
      nextStatus: 'completed',
    });
    // attention becomes 2, already notified 2
    assert.equal(d2.action, 'skip');
    assert.equal(d2.reason, 'already_notified_version');
  });

  it('skips when already read at version', () => {
    const d = decideTaskNotification({
      ...base,
      previousAttentionVersion: 0,
      lastReadAttentionVersion: 1,
      previousStatus: 'executing',
      nextStatus: 'completed',
    });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'already_read_version');
  });

  it('skips when master switch off', () => {
    const d = decideTaskNotification({
      ...base,
      settings: { enabled: false },
    });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'settings_disabled');
  });

  it('skips cancelled and progress non-transitions', () => {
    assert.equal(
      decideTaskNotification({ ...base, nextStatus: 'cancelled' }).reason,
      'not_attention_transition',
    );
    assert.equal(
      decideTaskNotification({ ...base, previousStatus: 'completed', nextStatus: 'completed' }).reason,
      'not_attention_transition',
    );
  });
});

describe('task-notification-policy helpers', () => {
  it('builds dedupe key and truncates text', () => {
    assert.equal(buildDedupeKey('t1', 3), 't1#3');
    assert.equal(truncateText('abcdefghij', 5), 'abcd…');
    assert.equal(
      shouldSuppressForForeground({
        isAppForeground: true,
        activeConversationId: 'a',
        taskConversationId: 'a',
      }),
      true,
    );
  });

  it('projects plan to notification task', () => {
    const task = projectPlanToNotificationTask({
      planId: 'p1',
      status: 'awaiting_approval',
      title: '发布预发',
      conversationId: 'c1',
      activation: { sourceMessageId: 'assistant-message-1' },
      targetWorkspacePath: '/tmp/ws',
      failureReason: 'x',
    });
    assert.equal(task.taskId, 'p1');
    assert.equal(task.status, 'waiting_user');
    assert.equal(task.workspacePath, '/tmp/ws');
    assert.equal(task.sourceMessageId, 'assistant-message-1');
    assert.equal(task.waitingReason, 'confirmation');
  });

  it('builds waiting permission copy', () => {
    const copy = buildNotificationCopy({
      status: 'waiting_user',
      title: '安装依赖',
      waitingReason: 'permission',
    });
    assert.equal(copy.title, '需要你的授权');
    assert.equal(copy.body, '安装依赖');
  });
});
