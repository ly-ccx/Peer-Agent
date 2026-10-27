import type { BrowserWindowState } from '@peer-agent/protocol';
import { activateBrowserTab, type BrowserSessionState } from './browserSessionState.ts';
/** Bootstrap/action replies can arrive behind live events. Never roll back or rebind a native view. */
export function acceptNativeBrowserState(current: BrowserWindowState | null, next: BrowserWindowState): BrowserWindowState {
  if (!current) return next;
  const same = current.identity.viewId === next.identity.viewId && current.identity.windowId === next.identity.windowId && current.identity.generation === next.identity.generation;
  return same && next.sequence >= current.sequence ? next : current;
}
/** A return selects only the captured original tab. It never navigates or recreates a closed page. */
export function returnBrowserSource(session: BrowserSessionState, browserTabId: string): { readonly session: BrowserSessionState; readonly status: 'returned' | 'source_tab_closed' } {
  return session.tabs.some(tab => tab.id === browserTabId) ? { session: activateBrowserTab(session, browserTabId), status: 'returned' }
    : { session, status: 'source_tab_closed' };
}
