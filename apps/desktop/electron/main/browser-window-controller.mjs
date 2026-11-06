import { bindBrowserSelectionFeedback } from './browser-selection-feedback.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeBrowserWindowCopyRequest, normalizeBrowserWindowUrl } from '@peer-agent/protocol';
import { createResourceWindowHandoffs } from './resource-window-handoffs.mjs';

const fail = status => ({ ok: false, status });
const same = (a, b) => a && b && ['viewId', 'windowId', 'generation'].every(k => a[k] === b[k]);
const alive = wc => wc && !wc.isDestroyed();
/** Owns native chrome + one remote instance. No task, permission, filesystem or script port. */
export function createBrowserWindowController({ BrowserWindow, WebContentsView, trustedWindows, rendererLocation, preloadPath,
  getWebContents, getEntry, register, unregister, getOwner, getAppearance = () => ({}), getLocale = () => '',
  prepareFeedback, popupFeedback, getFeedbackRecipient, isZh = () => false,
  canFocus = () => false, rebuildMenu = () => {}, createId = randomUUID }) {
  const records = new Map(), handoffs = createResourceWindowHandoffs(); let disposed = false, preparing = 0;
  const binding = (sender, identity) => {
    const r = records.get(sender);
    return r && !r.closed && same(r.identity, identity) && trustedWindows.getRole(sender) === 'browser-resource' ? r : null;
  };
  const snapshot = r => ({ identity: { ...r.identity }, conversationId: r.owner.conversationId, browserTabId: r.tabId,
    url: r.view.webContents.getURL(), title: r.view.webContents.getTitle().slice(0, 1024), loading: r.view.webContents.isLoading(),
    canBack: r.view.webContents.navigationHistory.canGoBack(), canForward: r.view.webContents.navigationHistory.canGoForward(),
    failure: r.failure, sequence: r.sequence, copy: true });
  const publish = r => {
    if (r.closed || !alive(r.view.webContents) || !alive(r.win.webContents)) return;
    r.sequence += 1; r.win.webContents.send('browser-window:state', snapshot(r));
    // Metadata cannot activate an instance that has since yielded to another tab/window.
    const current = getEntry(r.owner.conversationId);
    register({ webContentsId: r.view.webContents.id, conversationId: r.owner.conversationId, browserTabId: r.tabId,
      active: current?.webContentsId === r.view.webContents.id, claimForeground: false,
      surface: 'native', available: r.failure !== 'page_crashed', windowId: r.identity.windowId, generation: r.identity.generation,
      url: r.view.webContents.getURL(), title: r.view.webContents.getTitle() });
  };
  const activate = r => {
    if (r.closed || !alive(r.view.webContents)) return;
    register({ webContentsId: r.view.webContents.id, conversationId: r.owner.conversationId, browserTabId: r.tabId,
      active: true, claimForeground: true, surface: 'native', available: r.failure !== 'page_crashed', windowId: r.identity.windowId, generation: r.identity.generation,
      url: r.view.webContents.getURL(), title: r.view.webContents.getTitle() }); rebuildMenu();
  };
  const cleanup = r => {
    if (r.closed) return; r.stopFeedback?.(); r.closed = true; records.delete(r.win.webContents); handoffs.release(r.identity);
    const current = getEntry(r.owner.conversationId);
    if (r.retiring && !disposed && current?.webContentsId === r.view.webContents.id) register({ ...current, available: false, active: true, claimForeground: false });
    else unregister({ webContentsId: r.view.webContents.id, conversationId: r.owner.conversationId, browserTabId: r.tabId });
    if (alive(r.view.webContents)) r.view.webContents.close({ waitForBeforeUnload: false }); rebuildMenu();
  };
  async function resolveSource(sender, raw) {
    if (disposed || trustedWindows.getRole(sender) !== 'main' || !alive(sender)) return null;
    const request = normalizeBrowserWindowCopyRequest(raw); if (!request) return null;
    const source = getWebContents(request.webContentsId);
    if (!alive(source) || source.hostWebContents !== sender || source.getType() !== 'webview') return null;
    const owner = await getOwner(request.conversationId);
    const entry = getEntry(request.conversationId, request.browserTabId);
    if (!owner || owner.conversationId !== request.conversationId || disposed || !alive(sender) || !alive(source)
      || source.hostWebContents !== sender || entry?.webContentsId !== source.id) return null;
    const url = normalizeBrowserWindowUrl(source.getURL());
    return url ? { request, owner, source, url } : null;
  }
  async function copy(sender, raw) {
    if (preparing + records.size >= 8) return fail('limit_reached');
    preparing += 1; let r, winCreated, counted = true;
    try {
      const found = await resolveSource(sender, raw); if (!found) return fail('scope_denied');
      const win = winCreated = new BrowserWindow({ width: 1040, height: 780, minWidth: 480, minHeight: 400, show: false, title: 'Peer Browser',
        webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
      const view = new WebContentsView({ webPreferences: { partition: 'persist:peer-browser', sandbox: true,
        contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false } });
      r = { win, view, sourceSender: sender, sourceTabId: found.request.browserTabId, owner: found.owner,
        identity: { viewId: createId(), windowId: createId(), generation: createId() }, tabId: createId(),
        closed: false, presented: false, sequence: 0, failure: null, ready: false };
      records.set(win.webContents, r); preparing -= 1; counted = false;
      trustedWindows.registerWindow({ window: win, role: 'browser-resource', allowedLocations: [rendererLocation] });
      win.contentView.addChildView(view); view.setVisible(false);
      win.once('closed', () => cleanup(r)); win.webContents.once('destroyed', () => cleanup(r));
      win.webContents.on('render-process-gone', () => { r.retiring = true; cleanup(r); if (!win.isDestroyed()) win.destroy(); });
      win.on('focus', () => { if (r.ready) activate(r); });
      const wc = view.webContents;
      if (prepareFeedback && popupFeedback) r.stopFeedback = bindBrowserSelectionFeedback({ contents: wc, isZh,
        getBinding: () => {
          const recipient = getFeedbackRecipient?.(r.owner.conversationId);
          return !r.closed && recipient && (!r.owner.workspaceId || recipient.workspaceId === r.owner.workspaceId) ? { sourceSender: r.sourceSender,
            recipient, conversationId: r.owner.conversationId, browserTabId: r.tabId, identity: r.identity } : null;
        }, prepare: prepareFeedback, popup: item => popupFeedback(r.win, item),
        report: notice => { if (!r.closed && alive(win.webContents)) win.webContents.send('resource-feedback:notice', notice); } });
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, url) => { if (!normalizeBrowserWindowUrl(typeof url === 'string' ? url : event.url)) { event.preventDefault(); r.failure = 'unsupported_address'; publish(r); } };
      wc.on('will-navigate', guard); wc.on('will-redirect', guard);
      wc.on('will-frame-navigate', (event, url) => guard(event, typeof url === 'string' ? url : event.url));
      for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) wc.on(event, () => publish(r));
      wc.on('did-start-loading', () => { r.failure = null; publish(r); });
      wc.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => { if (isMainFrame !== false && code !== -3) { r.failure = 'page_load_failed'; publish(r); } });
      wc.on('render-process-gone', () => { r.failure = 'page_crashed'; publish(r);
        if (alive(win.webContents)) { r.sequence += 1; win.webContents.send('browser-window:state', { ...snapshot(r), failure: r.failure }); } });
      wc.once('destroyed', () => { if (!r.closed) { r.retiring = true; cleanup(r); if (!win.isDestroyed()) win.destroy(); } });
      let timer, onClosed;
      try {
        const retired = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('load_timeout')), 30000); onClosed = () => reject(Error('closed')); win.once('closed', onClosed); });
        const url = new URL(rendererLocation); url.searchParams.set('window', 'browser-resource');
        await Promise.race([win.loadURL(url.href), retired]);
      } finally { clearTimeout(timer); if (onClosed) win.removeListener('closed', onClosed); }
      if (disposed || r.closed || !alive(sender) || !(await getOwner(r.owner.conversationId))) throw Error('source_unavailable');
      r.ready = true; win.show(); win.focus(); activate(r);
      void wc.loadURL(found.url).catch(error => { if (!r.closed && error?.code !== 'ERR_ABORTED' && error?.errno !== -3) { r.failure = 'page_load_failed'; publish(r); } });
      return { ok: true, state: snapshot(r) };
    } catch { if (r) cleanup(r); if (winCreated && !winCreated.isDestroyed()) winCreated.destroy(); return fail('source_unavailable'); }
    finally { if (counted) preparing -= 1; }
  }
  return {
    copy,
    bootstrap(sender) { const r = records.get(sender); return r && !r.closed && trustedWindows.getRole(sender) === 'browser-resource' ? { ok: true, state: snapshot(r) } : fail('stale_view'); },
    appearance(sender) {
      if (!records.has(sender)) return {};
      const raw = getAppearance(); return { locale: getLocale(), appearance: Object.fromEntries(['mode', 'palette', 'density', 'fontScale', 'codeFontSize', 'diffMarkerMode', 'windowMaterial']
        .filter(key => ['string', 'number'].includes(typeof raw?.[key])).map(key => [key, raw[key]])) };
    },
    viewport(sender, payload) {
      const r = binding(sender, payload?.identity); if (!r) return fail('stale_view');
      const raw = payload.rect, scale = r.win.webContents.getZoomFactor?.() || 1;
      const rect = raw && Object.fromEntries(Object.entries(raw).map(([k,v]) => [k, typeof v === 'number' ? v * scale : v]));
      const [width, height] = r.win.getContentSize();
      if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) || rect.x < 0 || rect.y < 40 || rect.width < 0 || rect.height < 0) return fail('invalid_request');
      const x = Math.min(width, Math.round(rect.x)), y = Math.min(height, Math.round(rect.y));
      const bounds = { x, y, width: Math.max(0, Math.min(width - x, Math.round(rect.width))), height: Math.max(0, Math.min(height - y, Math.round(rect.height))) };
      r.view.setBounds(bounds);
      r.presented = bounds.width > 0 && bounds.height > 0; r.view.setVisible(r.presented); return { ok: true, state: snapshot(r) };
    },
    async action(sender, payload) {
      const r = binding(sender, payload?.identity); if (!r) return fail('stale_view');
      const wc = r.view.webContents;
      if (payload.action === 'close') { const state = snapshot(r); r.win.close(); return { ok: true, state }; }
      if (payload.action === 'return') {
        if (!alive(r.sourceSender) || trustedWindows.getRole(r.sourceSender) !== 'main' || !(await getOwner(r.owner.conversationId))) return fail('source_unavailable');
        const status = await handoffs.request(r.sourceSender, r.identity, 'return', requestId => r.sourceSender.send('browser-window:return-target', {
          requestId, identity: r.identity, conversationId: r.owner.conversationId, workspaceId: r.owner.workspaceId, browserTabId: r.sourceTabId, expiresAt: Date.now() + 3000 }));
        if (!binding(sender, payload.identity) || !['returned', 'source_tab_closed'].includes(status)) return fail(status === 'cancelled' ? 'cancelled' : 'source_unavailable');
        const target = BrowserWindow.fromWebContents(r.sourceSender); if (!target || target.isDestroyed()) return fail('source_unavailable');
        if (target.isMinimized()) target.restore(); target.show(); target.focus(); return { ok: true, state: snapshot(r), returnStatus: status };
      }
      if (!alive(wc)) return fail('source_unavailable');
      if (payload.action === 'navigate') { const url = normalizeBrowserWindowUrl(payload.url); if (!url) return fail('invalid_request');
        activate(r); void wc.loadURL(url).catch(error => { if (!r.closed && error?.code !== 'ERR_ABORTED' && error?.errno !== -3) { r.failure = 'page_load_failed'; publish(r); } }); }
      else if (payload.action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (payload.action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (payload.action === 'reload') { activate(r); wc.reload(); }
      else if (payload.action === 'stop') wc.stop();
      else return fail('invalid_request');
      return { ok: true, state: snapshot(r) };
    },
    acknowledgeReturn: (sender, payload) => ({ ok: handoffs.acknowledge(sender, payload, 'return') }),
    reveal({ conversationId, focus = true } = {}) {
      const entry = getEntry(conversationId); if (entry?.surface !== 'native') return null;
      const r = [...records.values()].find(r => r.identity.windowId === entry.windowId && r.identity.generation === entry.generation && r.view.webContents.id === entry.webContentsId && r.ready && r.presented && !r.closed && !r.failure);
      if (!r || !alive(r.view.webContents) || r.win.isDestroyed() || !getOwner(conversationId)) throw Error('native_browser_unavailable');
      const focused = focus !== false && canFocus(conversationId);
      if (focused) { if (r.win.isMinimized()) r.win.restore(); r.win.show(); r.win.focus(); }
      return { status: 'already_active', sessionId: r.tabId, visible: !r.win.isMinimized() && r.win.isVisible(), focused, windowId: r.identity.windowId, generation: r.identity.generation };
    },
    dispose() { disposed = true; handoffs.dispose(); for (const r of [...records.values()]) { cleanup(r); if (!r.win.isDestroyed()) r.win.destroy(); } },
  };
}
