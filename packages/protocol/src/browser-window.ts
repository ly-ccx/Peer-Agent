/** Native address copies have independent instance identities; never a migrated webview. */
export interface BrowserWindowIdentity {
  readonly viewId: string;
  readonly windowId: string;
  readonly generation: string;
}
export interface BrowserWindowCopyRequest {
  readonly conversationId: string;
  readonly browserTabId: string;
  readonly webContentsId: number;
}
export type BrowserWindowAction = 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'return' | 'close';
export interface BrowserWindowState {
  readonly identity: BrowserWindowIdentity;
  readonly conversationId: string;
  readonly browserTabId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly failure: string | null;
  readonly sequence: number;
  readonly copy: true;
}
export type BrowserWindowResult = { readonly ok: true; readonly state: BrowserWindowState; readonly returnStatus?: 'returned' | 'source_tab_closed' }
  | { readonly ok: false; readonly status: 'invalid_request' | 'scope_denied' | 'source_unavailable' | 'limit_reached' | 'stale_view' | 'cancelled' };
export interface BrowserWindowReturnRequest {
  readonly requestId: string;
  readonly identity: BrowserWindowIdentity;
  readonly conversationId: string;
  readonly workspaceId?: string;
  readonly browserTabId: string;
  readonly expiresAt: number;
}
export interface BrowserWindowReturnAck {
  readonly requestId: string;
  readonly identity: BrowserWindowIdentity;
  readonly status: 'returned' | 'source_tab_closed' | 'cancelled';
}
export function normalizeBrowserWindowUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function normalizeBrowserWindowCopyRequest(raw: unknown): BrowserWindowCopyRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some(k => !['conversationId', 'browserTabId', 'webContentsId'].includes(k))) return null;
  if (![v.conversationId, v.browserTabId].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)) return null;
  if (!Number.isSafeInteger(v.webContentsId) || (v.webContentsId as number) <= 0) return null;
  return { conversationId: v.conversationId as string, browserTabId: v.browserTabId as string, webContentsId: v.webContentsId as number };
}
