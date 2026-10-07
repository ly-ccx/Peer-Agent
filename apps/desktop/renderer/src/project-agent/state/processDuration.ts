import type { I18nRuntime } from '@peer-agent/i18n';

export function processSeconds(start: string | undefined, end: string | undefined, now: number, finished = false): number | null {
  if (finished && !end) return null;
  const first = Date.parse(start ?? ''), last = end ? Date.parse(end) : now;
  return Number.isFinite(first) && Number.isFinite(last) && last >= first ? (last - first) / 1000 : null;
}

export function processDuration(seconds: number, i18n: I18nRuntime): string {
  if (seconds < 1) return i18n.t('projectAgent.process.lessThanSecond');
  const whole = Math.floor(seconds);
  return i18n.t(whole < 60 ? 'projectAgent.process.seconds' : 'projectAgent.process.minutes', { seconds: whole % 60, minutes: Math.floor(whole / 60) });
}
