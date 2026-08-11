import type {
  AutomationDefinition,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationSummary,
} from '@peer-agent/protocol';
import type { AutomationLocale } from './automationI18n';

const ATTENTION_STATUSES = new Set<AutomationRunStatus>([
  'waiting_permission', 'waiting_user', 'failed', 'timed_out', 'blocked',
]);

const RUN_STATUS_LABELS: Record<AutomationLocale, Record<AutomationRunStatus, string>> = {
  en: {
    scheduled: 'Scheduled', preparing: 'Preparing', queued: 'Queued', running: 'Running', waiting_permission: 'Waiting for permission', waiting_user: 'Waiting for input',
    succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', timed_out: 'Timed out', blocked: 'Blocked',
  },
  zh: {
    scheduled: '已计划', preparing: '准备中', queued: '排队中', running: '运行中', waiting_permission: '等待授权', waiting_user: '等待输入',
    succeeded: '已成功', failed: '已失败', cancelled: '已取消', skipped: '已跳过', timed_out: '已超时', blocked: '已阻止',
  },
};

export function automationCounts(items: readonly AutomationSummary[]) {
  return items.reduce((counts, item) => ({
    total: counts.total + 1,
    active: counts.active + (item.definition.status === 'active' ? 1 : 0),
    running: counts.running + (item.activeRun ? 1 : 0),
    attention: counts.attention + (item.needsAttention || (item.latestRun ? ATTENTION_STATUSES.has(item.latestRun.status) : false) ? 1 : 0),
  }), { total: 0, active: 0, running: 0, attention: 0 });
}

export function scheduleLabel(schedule: AutomationSchedule, locale: AutomationLocale = 'en'): string {
  const minute = String(schedule.minute ?? 0).padStart(2, '0');
  const time = `${String(schedule.hour ?? 9).padStart(2, '0')}:${minute}`;
  if (locale === 'zh') {
    switch (schedule.kind) {
      case 'once': return schedule.onceAt ? `单次 · ${formatDateTime(schedule.onceAt, locale)}` : '单次';
      case 'hourly': return `每 ${schedule.everyHours ?? 1} 小时`;
      case 'daily': return `每天 · ${time}`;
      case 'weekdays': return `工作日 · ${time}`;
      case 'weekly': return `每周 · ${time}`;
      case 'monthly': return `每月 ${schedule.dayOfMonth ?? 1} 日 · ${time}`;
      case 'custom_cron': return `Cron · ${schedule.cron ?? '—'}`;
    }
  }
  switch (schedule.kind) {
    case 'once': return schedule.onceAt ? `Once · ${formatDateTime(schedule.onceAt, locale)}` : 'Once';
    case 'hourly': return `Every ${schedule.everyHours ?? 1} hour${schedule.everyHours === 1 ? '' : 's'}`;
    case 'daily': return `Daily · ${time}`;
    case 'weekdays': return `Weekdays · ${time}`;
    case 'weekly': return `Weekly · ${time}`;
    case 'monthly': return `Monthly on day ${schedule.dayOfMonth ?? 1} · ${time}`;
    case 'custom_cron': return `Cron · ${schedule.cron ?? '—'}`;
  }
}

export function formatDateTime(value?: string, locale: AutomationLocale = 'en'): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

export function runStatusLabel(status: AutomationRunStatus, locale: AutomationLocale = 'en'): string {
  return RUN_STATUS_LABELS[locale][status];
}

export function runNeedsAttention(run: AutomationRun): boolean {
  return ATTENTION_STATUSES.has(run.status);
}

export function definitionSubtitle(definition: AutomationDefinition, locale: AutomationLocale = 'en'): string {
  return `${scheduleLabel(definition.schedule, locale)} · ${definition.schedule.timezone}`;
}

export function terminalRun(status: AutomationRunStatus): boolean {
  return ['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out', 'blocked'].includes(status);
}

export function nextThreePreview(schedule: AutomationSchedule, now = new Date(), locale: AutomationLocale = 'en'): readonly string[] {
  if (schedule.kind === 'once') return schedule.onceAt ? [formatDateTime(schedule.onceAt, locale)] : [];
  const cursor = new Date(now);
  const values: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    if (schedule.kind === 'hourly') cursor.setHours(cursor.getHours() + (schedule.everyHours ?? 1));
    else if (schedule.kind === 'monthly') cursor.setMonth(cursor.getMonth() + 1, schedule.dayOfMonth ?? 1);
    else {
      cursor.setDate(cursor.getDate() + (schedule.kind === 'weekly' ? 7 : 1));
      if (schedule.kind === 'weekdays') while ([0, 6].includes(cursor.getDay())) cursor.setDate(cursor.getDate() + 1);
    }
    if (schedule.kind !== 'hourly') cursor.setHours(schedule.hour ?? 9, schedule.minute ?? 0, 0, 0);
    values.push(formatDateTime(cursor.toISOString(), locale));
  }
  return values;
}
