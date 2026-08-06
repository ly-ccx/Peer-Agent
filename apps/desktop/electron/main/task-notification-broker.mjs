/**
 * 任务完成系统通知 Broker（主进程）。
 *
 * 职责：
 * 1. 订阅 goalPlans 变更（由 main 的 onChange 转发）
 * 2. 检测 completed / failed / waiting_user 关注跃迁
 * 3. 去重（taskId + attentionVersion）+ 前台同会话抑制
 * 4. 弹出 Electron Notification
 * 5. 点击回流：激活主窗口并打开对应会话
 *
 * 决策逻辑在 task-notification-policy.mjs；回执在 receipt-store。
 */

import {
  decideTaskNotification,
  isNotifiableStatus,
  normalizeNotificationSettings,
  projectPlanToNotificationTask,
  DEFAULT_NOTIFICATION_SETTINGS,
} from './task-notification-policy.mjs';
import { createTaskNotificationReceiptStore } from './task-notification-receipt-store.mjs';

/**
 * @typedef {object} TaskNotificationBrokerDeps
 * @property {() => object|null} getPlan  // (planId) => plan
 * @property {() => Array<object>} [listPlans]
 * @property {() => object} [getSettings] // settingsStore.getAll
 * @property {() => boolean} isAppForeground
 * @property {() => string|null} getActiveConversationId
 * @property {(payload: object) => void} openConversation
 * @property {(payload: {title:string, body:string, onClick:() => void}) => boolean} showNotification
 * @property {() => boolean} [isNotificationSupported]
 * @property {ReturnType<typeof createTaskNotificationReceiptStore>} [receiptStore]
 * @property {(message: string, err?: unknown) => void} [logWarn]
 */

/**
 * @param {TaskNotificationBrokerDeps} deps
 */
export function createTaskNotificationBroker(deps) {
  const receiptStore = deps.receiptStore || createTaskNotificationReceiptStore();
  const logWarn = typeof deps.logWarn === 'function' ? deps.logWarn : () => {};

  /** @type {Map<string, {status:string|null, attentionVersion:number}>} */
  const memory = new Map();
  let bootstrapped = false;

  function readSettings() {
    try {
      const all = typeof deps.getSettings === 'function' ? deps.getSettings() : {};
      const raw = all && typeof all === 'object' ? all.taskNotifications : null;
      return normalizeNotificationSettings(raw ?? DEFAULT_NOTIFICATION_SETTINGS);
    } catch {
      return normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
    }
  }

  function isSupported() {
    if (typeof deps.isNotificationSupported === 'function') {
      return Boolean(deps.isNotificationSupported());
    }
    return true;
  }

  function snapshotFromPlan(plan) {
    return projectPlanToNotificationTask(plan);
  }

  function loadTracked(taskId) {
    if (memory.has(taskId)) return memory.get(taskId);
    const receipt = receiptStore.get(taskId);
    if (receipt) {
      const snap = {
        status: receipt.lastStatus ?? null,
        attentionVersion: receipt.attentionVersion || 0,
      };
      memory.set(taskId, snap);
      return snap;
    }
    return { status: null, attentionVersion: 0 };
  }

  function remember(taskId, status, attentionVersion) {
    memory.set(taskId, {
      status: status ?? null,
      attentionVersion: Math.max(0, Math.trunc(attentionVersion || 0)),
    });
  }

  /**
   * 冷启动：把当前已存在的可通知态记为已处理，避免回放。
   */
  function bootstrapExisting() {
    if (bootstrapped) return;
    bootstrapped = true;
    const plans = typeof deps.listPlans === 'function' ? deps.listPlans() || [] : [];
    const seeds = [];
    for (const plan of plans) {
      const task = snapshotFromPlan(plan);
      if (!task || !isNotifiableStatus(task.status)) continue;
      const receipt = receiptStore.get(task.taskId);
      const version = receipt?.attentionVersion > 0 ? receipt.attentionVersion : 1;
      seeds.push({
        taskId: task.taskId,
        status: task.status,
        attentionVersion: version,
      });
      remember(task.taskId, task.status, version);
    }
    if (seeds.length > 0) {
      receiptStore.seedFromExistingTasks(seeds);
    }
  }

  /**
   * 处理单个计划快照（通常来自 getPlan）。
   * @param {object|null|undefined} plan
   * @param {{ forceEvaluate?: boolean }} [options]
   */
  function evaluatePlan(plan, options = {}) {
    bootstrapExisting();
    const task = snapshotFromPlan(plan);
    if (!task) return { action: 'skip', reason: 'invalid_plan' };

    const tracked = loadTracked(task.taskId);
    const receipt = receiptStore.get(task.taskId) || {
      attentionVersion: tracked.attentionVersion || 0,
      lastNotifiedAttentionVersion: 0,
      lastReadAttentionVersion: 0,
      lastStatus: tracked.status,
    };

    // 冷启动种子只在 bootstrapExisting 里做；运行时首次见到非通知态→可通知态应允许弹出。
    // previousStatus 优先内存，其次回执 lastStatus。
    const previousStatus = tracked.status ?? receipt.lastStatus ?? null;

    const decision = decideTaskNotification({
      taskId: task.taskId,
      previousStatus,
      nextStatus: task.status,
      previousAttentionVersion: tracked.attentionVersion || receipt.attentionVersion || 0,
      lastNotifiedAttentionVersion: receipt.lastNotifiedAttentionVersion || 0,
      lastReadAttentionVersion: receipt.lastReadAttentionVersion || 0,
      title: task.title,
      shortError: task.shortError,
      waitingReason: task.waitingReason,
      conversationId: task.conversationId,
      activationKind: task.activationKind,
      activeConversationId:
        typeof deps.getActiveConversationId === 'function' ? deps.getActiveConversationId() : null,
      isAppForeground: typeof deps.isAppForeground === 'function' ? deps.isAppForeground() : false,
      settings: readSettings(),
      notificationSupported: isSupported(),
    });

    // 无论是否弹出，推进内存中的状态与版本
    remember(task.taskId, task.status, decision.attentionVersion);
    receiptStore.observe(task.taskId, {
      status: task.status,
      attentionVersion: decision.attentionVersion,
    });

    if (decision.action !== 'notify' || !decision.copy) {
      return decision;
    }

    const clickPayload = {
      taskId: task.taskId,
      planId: task.planId,
      conversationId: task.conversationId,
      workspacePath: task.workspacePath,
      messageId: task.sourceMessageId,
      attentionVersion: decision.attentionVersion,
      source: 'system-notification',
    };

    let shown = false;
    try {
      shown = Boolean(
        deps.showNotification({
          title: decision.copy.title,
          body: decision.copy.body,
          onClick: () => {
            try {
              if (typeof deps.openConversation === 'function') {
                deps.openConversation(clickPayload);
              }
              receiptStore.markRead(task.taskId, decision.attentionVersion);
            } catch (err) {
              logWarn('[task-notification-broker] openConversation failed', err);
            }
          },
        }),
      );
    } catch (err) {
      logWarn('[task-notification-broker] showNotification failed', err);
      shown = false;
    }

    if (shown) {
      receiptStore.markNotified(task.taskId, decision.attentionVersion, { status: task.status });
      return { ...decision, action: 'notify', shown: true };
    }

    return { ...decision, action: 'skip', reason: 'show_failed', shown: false };
  }

  /**
   * goalPlans:changed 入口。
   * @param {{ planId?: string|null, changeKind?: string, reason?: string }} payload
   */
  function handleGoalPlanChanged(payload = {}) {
    bootstrapExisting();
    const changeKind = String(payload.changeKind || payload.reason || 'persist');
    // 进度类变更不评估
    if (changeKind === 'runner-progress') {
      return { action: 'skip', reason: 'runner_progress' };
    }
    if (changeKind === 'delete') {
      return { action: 'skip', reason: 'delete' };
    }
    const planId = payload.planId ? String(payload.planId) : '';
    if (!planId || typeof deps.getPlan !== 'function') {
      return { action: 'skip', reason: 'missing_plan_id' };
    }
    let plan = null;
    try {
      plan = deps.getPlan(planId);
    } catch (err) {
      logWarn('[task-notification-broker] getPlan failed', err);
      return { action: 'skip', reason: 'get_plan_failed' };
    }
    if (!plan) return { action: 'skip', reason: 'plan_not_found' };
    return evaluatePlan(plan);
  }

  /**
   * 用户打开会话 / 阅读任务后标记已读。
   * @param {string} taskId
   * @param {number} [attentionVersion]
   */
  function markTaskRead(taskId, attentionVersion) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    const tracked = loadTracked(id);
    const version = Number.isFinite(attentionVersion)
      ? Math.trunc(attentionVersion)
      : tracked.attentionVersion || 0;
    remember(id, tracked.status, Math.max(tracked.attentionVersion || 0, version));
    return receiptStore.markRead(id, version);
  }

  return {
    bootstrapExisting,
    handleGoalPlanChanged,
    evaluatePlan,
    markTaskRead,
    getReceiptStore: () => receiptStore,
  };
}

export { createTaskNotificationReceiptStore };
