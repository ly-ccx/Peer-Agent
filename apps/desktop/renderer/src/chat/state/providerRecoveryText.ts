import type { ProviderRecoveryNotice } from "./types";

// 重试倒计时文案：归零后说「正在重连」，避免本地倒计时钳在 0 时
// 长时间显示「约 0s 后重试」让用户误以为卡死。
export function formatRetryCountdownLabel(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return '正在重连…';
  return `约 ${remainingSeconds}s 后重试`;
}

export function formatRetryCountdownLabelEn(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return 'reconnecting…';
  return `in about ${remainingSeconds}s`;
}

// 排队等待时长文案：秒级显示 s，分钟级显示 m，避免长等待显示成一大串秒。
function formatQueueDurationLabel(ms: number): string {
  const value = Number(ms) || 0;
  if (value <= 0) return '';
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`;
  return `${Math.max(1, Math.round(value / 60_000))}m`;
}

export function formatQueueNoticeText(notice: ProviderRecoveryNotice, isZh: boolean): string {
  const count = typeof notice.queueCount === 'number' && notice.queueCount > 0
    ? (isZh ? `，前方约 ${notice.queueCount} 人` : `, ~${notice.queueCount} ahead`)
    : '';
  const upstream = formatQueueDurationLabel(notice.upstreamWaitTimeMs ?? 0);
  const upstreamLabel = upstream
    ? (isZh ? `，上游预计等待 ~${upstream}` : `, upstream est. ~${upstream}`)
    : '';
  const waited = formatQueueDurationLabel(notice.waitedMs ?? 0);
  const waitedLabel = waited
    ? (isZh ? `，已等待 ${waited}` : `, waited ${waited}`)
    : '';
  const poll = formatQueueDurationLabel(notice.waitMs ?? 0);
  const pollLabel = poll
    ? (isZh ? `；每 ${poll} 查询一次队列` : `; polling every ${poll}`)
    : '';
  return isZh
    ? `Qoder 上游排队中${count}${upstreamLabel}${waitedLabel}${pollLabel}，正在按队列节奏等待…`
    : `Queued upstream at Qoder${count}${upstreamLabel}${waitedLabel}${pollLabel}; waiting on the queue cadence…`;
}
