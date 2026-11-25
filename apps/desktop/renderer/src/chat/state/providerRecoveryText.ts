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
