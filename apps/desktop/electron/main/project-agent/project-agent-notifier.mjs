/**
 * 项目代理的系统通知。
 *
 * 只在 decideSurfacing 给出 interrupt 时弹出。前台抑制是单独一步：
 * 送达策略不看 foreground。B3-05 之前，没写明的主动性按标准档。
 * 回执沿用任务通知的存储，键是 eventId，版本固定为 1。
 */
import { decideSurfacing } from '@peer-agent/protocol';

import { createTaskNotificationReceiptStore } from '../task-notification-receipt-store.mjs';

export const NOTIFICATION_BODY_MAX = 60;
const STORED_DECISIONS = new Set(['interrupt', 'message', 'digest', 'silent']);
const ATTENTION_VERSION = 1;

/**
 * 回复首句，否则用卡片摘要。按码点截到 60 字。
 * @param {unknown} text
 * @param {unknown} [cardSummary]
 */
export function notificationBody(text, cardSummary = '') {
  const reply = typeof text === 'string' ? text : '';
  const summary = typeof cardSummary === 'string' ? cardSummary : '';
  const raw = reply.trim() ? reply : summary;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return Array.from(firstSentence(flat)).slice(0, NOTIFICATION_BODY_MAX).join('');
}

function firstSentence(flat) {
  const chars = Array.from(flat);
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      return chars.slice(0, index + 1).join('');
    }
    if (ch === '.' && (index === chars.length - 1 || chars[index + 1] === ' ')) {
      return chars.slice(0, index + 1).join('');
    }
  }
  return flat;
}

/**
 * @param {object} input
 * @param {{ get: (id: string) => ({ lastNotifiedAttentionVersion?: number }|null) }} [receiptStore]
 */
export function considerProjectAgentNotification(input = {}, receiptStore = null) {
  if (input.enabled !== true) {
    return { action: 'skip', reason: 'project_agent_disabled' };
  }
  const surfacing = resolveSurfacing(input);
  if (!surfacing) return { action: 'skip', reason: 'missing_surfacing' };
  if (surfacing.decision !== 'interrupt') {
    return { action: 'skip', reason: 'not_interrupt', surfacing };
  }
  if (input.foregroundSameBot === true) {
    return { action: 'skip', reason: 'foreground_same_bot', surfacing };
  }
  const eventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  if (!eventId) return { action: 'skip', reason: 'missing_event', surfacing };
  const receipt = typeof receiptStore?.get === 'function' ? receiptStore.get(eventId) : null;
  if ((receipt?.lastNotifiedAttentionVersion || 0) >= ATTENTION_VERSION) {
    return { action: 'skip', reason: 'duplicate', surfacing };
  }
  const botName = typeof input.botName === 'string' ? input.botName.trim() : '';
  return {
    action: 'notify',
    reason: surfacing.reason,
    surfacing,
    eventId,
    title: botName || 'Peer Agent',
    body: notificationBody(input.text, input.cardSummary),
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : '',
    messageId: typeof input.messageId === 'string' ? input.messageId : '',
  };
}

function resolveSurfacing(input) {
  if (input.event && typeof input.event === 'object' && !Array.isArray(input.event)) {
    return decideSurfacing({
      event: input.event,
      proactivity: input.proactivity === 'off' || input.proactivity === 'low' || input.proactivity === 'high'
        ? input.proactivity
        : 'normal',
      foreground: input.foreground === true,
      quietHours: input.quietHours === true,
      needsYou: input.needsYou === true,
    });
  }
  if (typeof input.decision === 'string' && STORED_DECISIONS.has(input.decision)) {
    return { decision: input.decision, reason: 'stored_surfacing' };
  }
  return null;
}

/**
 * @param {object} deps
 */
export function createProjectAgentNotifier(deps = {}) {
  const receiptStore = deps.receiptStore || createTaskNotificationReceiptStore(
    deps.receiptFile ? { receiptFile: deps.receiptFile } : {},
  );
  const logWarn = typeof deps.logWarn === 'function' ? deps.logWarn : () => {};

  function enabled() {
    if (typeof deps.isEnabled === 'function') return deps.isEnabled() === true;
    return false;
  }

  function consider(input = {}) {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
    const foregroundSameBot = input.foregroundSameBot === true
      || (typeof deps.isForegroundSameBot === 'function' && deps.isForegroundSameBot(workspaceId) === true);
    const decision = considerProjectAgentNotification({
      ...input,
      enabled: enabled(),
      foregroundSameBot,
      proactivity: input.proactivity ?? 'normal',
    }, receiptStore);
    if (decision.action !== 'notify') return decision;

    let shown = false;
    try {
      shown = Boolean(deps.showNotification?.({
        title: decision.title,
        body: decision.body,
        onClick: () => {
          try {
            deps.openBot?.({
              workspaceId: decision.workspaceId,
              messageId: decision.messageId,
            });
            receiptStore.markRead(decision.eventId, ATTENTION_VERSION);
          } catch (error) {
            logWarn('[project-agent-notifier] openBot failed', error);
          }
        },
      }));
    } catch (error) {
      logWarn('[project-agent-notifier] showNotification failed', error);
      shown = false;
    }
    if (!shown) return { ...decision, action: 'skip', reason: 'show_failed', shown: false };
    receiptStore.markNotified(decision.eventId, ATTENTION_VERSION);
    return { ...decision, shown: true };
  }

  /**
   * 对话写入后的入口。没有送达事实或已算出的 decideSurfacing 结果时不弹。
   * @param {{ conversationId?: string, message?: object }} payload
   */
  function handleAppended(payload = {}) {
    if (!enabled()) return { action: 'skip', reason: 'project_agent_disabled' };
    const message = payload?.message;
    if (!message || typeof message !== 'object') {
      return { action: 'skip', reason: 'missing_surfacing' };
    }
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
    const workspaceId = typeof deps.workspaceIdForConversation === 'function'
      ? deps.workspaceIdForConversation(conversationId)
      : '';
    if (!workspaceId) return { action: 'skip', reason: 'not_bot' };
    const facts = message.meta?.surfacingFacts;
    const stored = message.meta?.surfacing;
    const card = message.kind === 'system_card';
    const content = typeof message.content === 'string' ? message.content : '';
    return consider({
      eventId: typeof message.eventId === 'string' && message.eventId
        ? message.eventId
        : message.id,
      workspaceId,
      botName: typeof deps.botNameForWorkspace === 'function' ? deps.botNameForWorkspace(workspaceId) : '',
      messageId: typeof message.id === 'string' ? message.id : '',
      text: card ? '' : content,
      cardSummary: card ? content : (typeof message.cardSummary === 'string' ? message.cardSummary : ''),
      event: facts?.event,
      needsYou: facts?.needsYou === true,
      quietHours: facts?.quietHours === true,
      foreground: typeof deps.isForegroundSameBot === 'function'
        ? deps.isForegroundSameBot(workspaceId) === true
        : false,
      decision: typeof stored === 'string' ? stored : undefined,
      proactivity: 'normal',
    });
  }

  return {
    consider,
    handleAppended,
    getReceiptStore: () => receiptStore,
  };
}
