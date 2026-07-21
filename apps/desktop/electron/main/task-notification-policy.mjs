/**
 * 任务完成系统通知 —— 纯决策层。
 *
 * 输入：计划状态跃迁 + 前台上下文 + 回执 / 设置
 * 输出：是否弹通知、文案、attentionVersion 推进
 *
 * 不依赖 Electron，便于 node:test 覆盖。
 */

export const NOTIFIABLE_STATUSES = Object.freeze(['completed', 'failed', 'waiting_user']);

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: true,
  completed: true,
  failed: true,
  waitingUser: true,
  suppressWhenViewingSameConversation: true,
});

/**
 * @param {unknown} value
 * @returns {typeof DEFAULT_NOTIFICATION_SETTINGS}
 */
export function normalizeNotificationSettings(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    enabled: raw.enabled !== false,
    completed: raw.completed !== false,
    failed: raw.failed !== false,
    waitingUser: raw.waitingUser !== false,
    suppressWhenViewingSameConversation: raw.suppressWhenViewingSameConversation !== false,
  };
}

/**
 * 是否属于可通知终态 / 阻塞态。
 * @param {string|null|undefined} status
 */
export function isNotifiableStatus(status) {
  return NOTIFIABLE_STATUSES.includes(String(status || ''));
}

/**
 * 状态是否发生「关注跃迁」。
 * - completed / failed：从非该状态进入
 * - waiting_user：从非 waiting_user 进入（同态重入不重复）
 * - cancelled / 进度类：否
 *
 * @param {string|null|undefined} previousStatus
 * @param {string|null|undefined} nextStatus
 */
export function isAttentionTransition(previousStatus, nextStatus) {
  const prev = String(previousStatus || '');
  const next = String(nextStatus || '');
  if (!isNotifiableStatus(next)) return false;
  if (prev === next) return false;
  return true;
}

/**
 * 为一次关注跃迁计算 attentionVersion。
 * 规则：每次进入 completed / failed / waiting_user 且相对上次状态变化时 +1。
 *
 * @param {number|null|undefined} previousVersion
 * @param {string|null|undefined} previousStatus
 * @param {string|null|undefined} nextStatus
 */
export function nextAttentionVersion(previousVersion, previousStatus, nextStatus) {
  const base = Number.isFinite(previousVersion) ? Math.max(0, Math.trunc(previousVersion)) : 0;
  if (!isAttentionTransition(previousStatus, nextStatus)) return base;
  return base + 1;
}

/**
 * 组装 dedupe key。
 * @param {string} taskId
 * @param {number} attentionVersion
 */
export function buildDedupeKey(taskId, attentionVersion) {
  return `${String(taskId || '')}#${Math.max(0, Math.trunc(attentionVersion || 0))}`;
}

/**
 * @param {object} input
 * @param {boolean} input.isAppForeground
 * @param {string|null|undefined} input.activeConversationId
 * @param {string|null|undefined} input.taskConversationId
 * @param {boolean} [input.suppressWhenViewingSameConversation]
 */
export function shouldSuppressForForeground(input = {}) {
  const suppressSame = input.suppressWhenViewingSameConversation !== false;
  if (!suppressSame) return false;
  if (!input.isAppForeground) return false;
  const active = String(input.activeConversationId || '');
  const taskConversation = String(input.taskConversationId || '');
  if (!active || !taskConversation) return false;
  return active === taskConversation;
}

/**
 * 截断展示文案。
 * @param {unknown} value
 * @param {number} max
 */
export function truncateText(value, max = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

/**
 * waiting_user 子原因 → 标题。
 * @param {string|null|undefined} reason
 */
export function waitingTitleForReason(reason) {
  switch (String(reason || '')) {
    case 'permission':
      return '需要你的授权';
    case 'confirmation':
      return '需要你的确认';
    case 'input':
    default:
      return '需要你的回复';
  }
}

/**
 * 从计划对象提取等待子原因（若有）。
 * @param {object|null|undefined} plan
 */
export function extractWaitingReason(plan) {
  if (!plan || typeof plan !== 'object') return 'input';
  const runner = plan.runner && typeof plan.runner === 'object' ? plan.runner : null;
  const candidates = [
    plan.waitingReason,
    plan.blockedReason,
    runner?.waitingReason,
    runner?.blockedReason,
    runner?.intent,
  ];
  for (const raw of candidates) {
    const value = String(raw || '').toLowerCase();
    if (value.includes('permission') || value.includes('授权')) return 'permission';
    if (value.includes('confirm') || value.includes('确认') || value.includes('approval')) return 'confirmation';
    if (value.includes('input') || value.includes('reply') || value.includes('回复')) return 'input';
  }
  // awaiting_approval 计划态在产品上等价于「需要确认」
  if (String(plan.status || '') === 'awaiting_approval') return 'confirmation';
  return 'input';
}

/**
 * 从计划提取失败短摘要。
 * @param {object|null|undefined} plan
 */
export function extractShortError(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const runner = plan.runner && typeof plan.runner === 'object' ? plan.runner : null;
  const candidates = [
    plan.failureReason,
    plan.error,
    plan.lastError,
    runner?.failureReason,
    runner?.lastError,
    runner?.error,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return truncateText(raw, 80);
    if (raw && typeof raw === 'object' && typeof raw.message === 'string' && raw.message.trim()) {
      return truncateText(raw.message, 80);
    }
  }
  return '';
}

/**
 * 构建通知 title / body。
 * @param {object} input
 * @param {string} input.status
 * @param {string} [input.title]
 * @param {string} [input.shortError]
 * @param {string} [input.waitingReason]
 */
export function buildNotificationCopy(input = {}) {
  const status = String(input.status || '');
  const taskTitle = truncateText(input.title || '未命名任务', 60) || '未命名任务';
  if (status === 'completed') {
    return { title: '任务已完成', body: taskTitle };
  }
  if (status === 'failed') {
    const shortError = truncateText(input.shortError || '', 80);
    return {
      title: '任务失败',
      body: shortError ? `${taskTitle}: ${shortError}` : taskTitle,
    };
  }
  if (status === 'waiting_user') {
    return {
      title: waitingTitleForReason(input.waitingReason),
      body: taskTitle,
    };
  }
  return { title: '任务更新', body: taskTitle };
}

/**
 * 核心决策：给定跃迁与上下文，返回动作。
 *
 * @param {object} input
 * @returns {{
 *   action: 'notify' | 'skip',
 *   reason: string,
 *   attentionVersion: number,
 *   dedupeKey: string|null,
 *   copy: {title:string, body:string}|null,
 * }}
 */
export function decideTaskNotification(input = {}) {
  const taskId = String(input.taskId || '').trim();
  const previousStatus = input.previousStatus ?? null;
  const nextStatus = input.nextStatus ?? null;
  const previousVersion = Number.isFinite(input.previousAttentionVersion)
    ? Math.max(0, Math.trunc(input.previousAttentionVersion))
    : 0;
  const lastNotifiedVersion = Number.isFinite(input.lastNotifiedAttentionVersion)
    ? Math.max(0, Math.trunc(input.lastNotifiedAttentionVersion))
    : 0;
  const lastReadVersion = Number.isFinite(input.lastReadAttentionVersion)
    ? Math.max(0, Math.trunc(input.lastReadAttentionVersion))
    : 0;
  const settings = normalizeNotificationSettings(input.settings);
  const attentionVersion = nextAttentionVersion(previousVersion, previousStatus, nextStatus);

  const base = {
    attentionVersion,
    dedupeKey: null,
    copy: null,
  };

  if (!taskId) {
    return { ...base, action: 'skip', reason: 'missing_task_id' };
  }
  if (!settings.enabled) {
    return { ...base, action: 'skip', reason: 'settings_disabled' };
  }
  if (!isAttentionTransition(previousStatus, nextStatus)) {
    return { ...base, action: 'skip', reason: 'not_attention_transition' };
  }

  const status = String(nextStatus || '');
  if (status === 'completed' && !settings.completed) {
    return { ...base, action: 'skip', reason: 'settings_completed_disabled' };
  }
  if (status === 'failed' && !settings.failed) {
    return { ...base, action: 'skip', reason: 'settings_failed_disabled' };
  }
  if (status === 'waiting_user' && !settings.waitingUser) {
    return { ...base, action: 'skip', reason: 'settings_waiting_user_disabled' };
  }

  if (attentionVersion <= lastNotifiedVersion) {
    return { ...base, action: 'skip', reason: 'already_notified_version' };
  }
  if (attentionVersion <= lastReadVersion) {
    return { ...base, action: 'skip', reason: 'already_read_version' };
  }

  if (
    shouldSuppressForForeground({
      isAppForeground: Boolean(input.isAppForeground),
      activeConversationId: input.activeConversationId,
      taskConversationId: input.conversationId,
      suppressWhenViewingSameConversation: settings.suppressWhenViewingSameConversation,
    })
  ) {
    return { ...base, action: 'skip', reason: 'foreground_same_conversation' };
  }

  if (input.notificationSupported === false) {
    return { ...base, action: 'skip', reason: 'notification_unsupported' };
  }

  const copy = buildNotificationCopy({
    status,
    title: input.title,
    shortError: input.shortError,
    waitingReason: input.waitingReason,
  });

  return {
    action: 'notify',
    reason: 'attention_event',
    attentionVersion,
    dedupeKey: buildDedupeKey(taskId, attentionVersion),
    copy,
  };
}

/**
 * 从 Goal Plan 归一为通知任务快照。
 * MVP：taskId = planId。
 *
 * @param {object|null|undefined} plan
 */
export function projectPlanToNotificationTask(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const planId = String(plan.planId || '').trim();
  if (!planId) return null;

  let status = String(plan.status || '').trim();
  // awaiting_approval 在通知语义上归为 waiting_user / confirmation
  if (status === 'awaiting_approval') status = 'waiting_user';

  const title =
    (typeof plan.title === 'string' && plan.title.trim()) ||
    (typeof plan.goal === 'string' && plan.goal.trim()) ||
    '未命名任务';

  const workspacePath =
    (typeof plan.targetWorkspacePath === 'string' && plan.targetWorkspacePath) ||
    (typeof plan.originWorkspacePath === 'string' && plan.originWorkspacePath) ||
    (typeof plan.workspacePath === 'string' && plan.workspacePath) ||
    null;

  return {
    taskId: planId,
    planId,
    conversationId: plan.conversationId ?? null,
    workspacePath,
    status,
    title,
    shortError: extractShortError(plan),
    waitingReason: extractWaitingReason(plan),
    updatedAt: plan.updatedAt ?? null,
  };
}
