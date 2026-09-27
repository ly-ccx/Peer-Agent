/**
 * 主动性档位、安静时段和今日小结。
 * 规则表仍由 decideSurfacing 计算；这里把产品档位映过去，并处理静音、安静时段和暂存。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { decideSurfacing } from '@peer-agent/protocol';

export const GLOBAL_LEVELS = Object.freeze(['quiet', 'low', 'standard', 'high']);
export const BOT_LEVELS = Object.freeze(['inherit', 'quiet', 'low', 'standard', 'high', 'muted']);
export const TOOL_LEVELS = Object.freeze(['quiet', 'low', 'standard', 'high', 'muted']);

const PROTOCOL = {
  quiet: 'off',
  off: 'off',
  low: 'low',
  standard: 'normal',
  normal: 'normal',
  high: 'high',
};

const NEEDS_YOU = new Set(['needs_user', 'confirm', 'failure_needs_decision']);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function defaultProjectAgentSettings() {
  return {
    proactivity: 'standard',
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    digestTime: '09:00',
  };
}

export function normalizeProjectAgentSettings(value) {
  const defaults = defaultProjectAgentSettings();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hours = source.quietHours && typeof source.quietHours === 'object' && !Array.isArray(source.quietHours)
    ? source.quietHours
    : {};
  return {
    proactivity: GLOBAL_LEVELS.includes(source.proactivity) ? source.proactivity : defaults.proactivity,
    quietHours: {
      enabled: hours.enabled === true,
      start: clock(hours.start) || defaults.quietHours.start,
      end: clock(hours.end) || defaults.quietHours.end,
    },
    digestTime: clock(source.digestTime) || defaults.digestTime,
  };
}

export function resolveBotLevel(globalLevel, botLevel) {
  if (botLevel === 'muted') return 'muted';
  if (GLOBAL_LEVELS.includes(botLevel)) return botLevel;
  if (globalLevel === 'off') return 'quiet';
  if (globalLevel === 'normal') return 'standard';
  return GLOBAL_LEVELS.includes(globalLevel) ? globalLevel : 'standard';
}

export function inQuietHours(at, quietHours) {
  const settings = normalizeProjectAgentSettings({ quietHours }).quietHours;
  if (!settings.enabled) return false;
  const parts = localParts(at);
  if (!parts) return false;
  const start = toMinutes(settings.start);
  const end = toMinutes(settings.end);
  if (start === end) return false;
  if (start < end) return parts.minutes >= start && parts.minutes < end;
  return parts.minutes >= start || parts.minutes < end;
}

/**
 * @returns {{ decision: string, reason: string, conversation: boolean, unread: boolean, notify: boolean, hold: boolean }}
 */
export function planDelivery(input = {}) {
  const event = normalizeEvent(input.event);
  const level = effectiveLevel(input);
  const must = mustDeliver(event, input.needsYou === true);
  if (level === 'muted') {
    return effects(must ? 'interrupt' : 'silent', must ? 'needs_you' : 'muted');
  }
  const decision = decideSurfacing({
    event,
    proactivity: PROTOCOL[level] || 'normal',
    foreground: input.foreground === true,
    quietHours: false,
    needsYou: must,
  });
  const quiet = input.quietHours === true || inQuietHours(input.at, input.quietHours);
  if (quiet && decision.decision === 'interrupt' && !must) {
    return effects('message', 'quiet_hours');
  }
  return effects(decision.decision, decision.reason);
}

export function digestSeparator(digestTime = '09:00') {
  const clockTime = clock(digestTime) || '09:00';
  return `今天 ${clockTime} · 今日小结`;
}

export function createDigestQueue({ file = null } = {}) {
  const state = load(file);

  function persist() {
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
  }

  function hold(workspaceId, item) {
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!id || !text) return 0;
    const list = Array.isArray(state.items[id]) ? state.items[id] : [];
    list.push({
      id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : `digest-item-${list.length + 1}`,
      text,
      ...(typeof item?.at === 'string' && item.at ? { at: item.at } : {}),
    });
    state.items[id] = list;
    persist();
    return list.length;
  }

  function consider(workspaceId, at, digestTime = '09:00') {
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    if (!id) return { fire: false, reason: 'missing_workspace' };
    const settingsTime = clock(digestTime) || '09:00';
    const moment = digestMoment(at, settingsTime, state.fired[id]);
    if (!moment) return { fire: false, reason: 'not_due' };
    state.fired[id] = moment.date;
    const items = Array.isArray(state.items[id]) ? state.items[id] : [];
    state.items[id] = [];
    persist();
    if (items.length === 0) return { fire: false, reason: 'empty', date: moment.date };
    const separatorLabel = digestSeparator(settingsTime);
    const message = {
      id: `digest:${id}:${moment.date}`,
      role: 'assistant',
      kind: 'agent_reply',
      proactive: true,
      separatorLabel,
      content: items.map((item) => item.text).join('\n'),
      meta: { surfacing: 'digest' },
    };
    return {
      fire: true,
      date: moment.date,
      items,
      message,
      timer: {
        kind: 'digest_due',
        wake: true,
        id: message.id,
        separatorLabel,
        message,
      },
    };
  }

  return {
    hold,
    consider,
    pending: (workspaceId) => (Array.isArray(state.items[workspaceId]) ? state.items[workspaceId].length : 0),
  };
}

function mustDeliver(event, needsYouFlag) {
  if (needsYouFlag || NEEDS_YOU.has(event.kind)) return true;
  return event.kind === 'objective_risk' && event.deadlineImminent === true;
}

function effects(decision, reason) {
  return {
    decision,
    reason,
    conversation: decision !== 'digest',
    unread: decision === 'interrupt' || decision === 'message',
    notify: decision === 'interrupt',
    hold: decision === 'digest',
  };
}

function effectiveLevel(input) {
  if (input.botLevel === 'muted' || input.proactivity === 'muted') return 'muted';
  if (GLOBAL_LEVELS.includes(input.botLevel)) return input.botLevel;
  const raw = input.proactivity ?? input.globalLevel ?? 'standard';
  if (raw === 'off') return 'quiet';
  if (raw === 'normal') return 'standard';
  if (GLOBAL_LEVELS.includes(raw) || raw === 'low' || raw === 'high') return raw;
  return 'standard';
}

function normalizeEvent(event) {
  const source = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  return {
    origin: source.origin ?? 'user_request',
    kind: source.kind ?? 'result',
    novelty: source.novelty !== false,
    severity: source.severity ?? 'info',
    ...(source.deadlineImminent === true ? { deadlineImminent: true } : {}),
  };
}

function clock(value) {
  return typeof value === 'string' && CLOCK.test(value.trim()) ? value.trim() : '';
}

function toMinutes(value) {
  const [hour, minute] = value.split(':').map((part) => Number(part));
  return hour * 60 + minute;
}

function localParts(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${month}-${day}`,
    minutes: date.getHours() * 60 + date.getMinutes(),
  };
}

function digestMoment(at, digestTime, firedOn) {
  const parts = localParts(at);
  if (!parts) return null;
  if (firedOn === parts.date) return null;
  if (parts.minutes < toMinutes(digestTime)) return null;
  return parts;
}

function load(file) {
  if (!file) return { fired: {}, items: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      fired: parsed?.fired && typeof parsed.fired === 'object' ? parsed.fired : {},
      items: parsed?.items && typeof parsed.items === 'object' ? parsed.items : {},
    };
  } catch {
    return { fired: {}, items: {} };
  }
}
