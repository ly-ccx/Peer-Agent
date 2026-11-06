import type { UpdaterPhase } from '@peer-agent/protocol';

/**
 * 用户停在下载进度弹窗时，下载完成就应收起。
 * 安装交给版本徽标旁的按钮；弹窗不再停在满格进度上。
 * 正在关闭的更新说明弹窗不在这里处理，避免打断收向徽标的退场。
 */
export function shouldDismissUpdateProgress(input: {
  readonly open: boolean;
  readonly trackingProgress: boolean;
  readonly closing: boolean;
  readonly phase: UpdaterPhase | undefined;
}): boolean {
  return input.open && input.trackingProgress && !input.closing && input.phase === 'downloaded';
}
