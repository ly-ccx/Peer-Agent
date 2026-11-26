import type { I18nRuntime } from '@peer-agent/i18n';
import { processDuration, processSeconds } from './processDuration.ts';

export interface TaskExecutionTiming {
  readonly status: string;
  readonly spawnedAt?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export function isExecutionTicking(timing: TaskExecutionTiming): boolean {
  return timing.status === 'running' && !timing.endedAt && Number.isFinite(Date.parse(timing.startedAt ?? ''));
}

const pad = (n: number) => String(n).padStart(2, '0');

export function stopwatchDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:` : ''}${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`;
}

export function coarseDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (!minutes) return '<1m';
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export function taskExecutionLabel(timing: TaskExecutionTiming, surface: 'header' | 'sidebar', now: number, i18n: I18nRuntime): string | null {
  if (timing.status === 'queued' || timing.status === 'starting') return null;
  const ticking = isExecutionTicking(timing);
  if (!ticking && surface === 'sidebar') return null;
  const seconds = processSeconds(timing.startedAt, timing.endedAt, now, !ticking);
  if (seconds === null) return null;
  if (!ticking) return processDuration(seconds, i18n);
  return surface === 'sidebar' ? coarseDuration(seconds) : stopwatchDuration(seconds);
}

export function taskExecutionTitle(timing: TaskExecutionTiming, i18n: I18nRuntime): string | undefined {
  const lines: string[] = [];
  for (const [key, value] of [
    ['projectAgent.taskTiming.spawned', timing.spawnedAt],
    ['projectAgent.taskTiming.started', timing.startedAt],
    ['projectAgent.taskTiming.ended', timing.endedAt],
  ] as const) {
    const ms = Date.parse(value ?? '');
    if (Number.isFinite(ms)) {
      lines.push(i18n.t(key, { time: new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(ms) }));
    }
  }
  const queued = processSeconds(timing.spawnedAt, timing.startedAt, 0, true);
  if (queued !== null && queued >= 1) lines.push(i18n.t('projectAgent.taskTiming.queuedFor', { duration: processDuration(queued, i18n) }));
  return lines.join('\n') || undefined;
}
