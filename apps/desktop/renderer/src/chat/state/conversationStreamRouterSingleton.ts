/**
 * 流路由器模块级单例占用判断。
 *
 * App 可能同时挂载多个 ChatSurface，但 chatStream 订阅只能有一份，
 * 否则同一条 delta 会被多个打字机各自 append 一次。
 * 这里只判断「谁占着坑」，不碰 React / IPC。
 */

export interface StreamRouterLease {
  occupiedBy: string;
  acquired: boolean;
}

export function acquireStreamRouterLease(
  occupiedBy: string | null,
  candidateId: string,
): StreamRouterLease {
  if (occupiedBy && occupiedBy !== candidateId) {
    return { occupiedBy, acquired: false };
  }
  return { occupiedBy: candidateId, acquired: true };
}

export function releaseStreamRouterLease(
  occupiedBy: string | null,
  ownerId: string,
): string | null {
  if (occupiedBy !== ownerId) return occupiedBy;
  return null;
}
