import { createResourceWindowEditSource } from './resource-window-edit-source.mjs';
import { createResourceWindowFeedback } from './resource-window-feedback.mjs';
import { createResourceViewRegistry } from './resource-view-registry.mjs';
import { createResourceWindowReader } from './resource-window-reader.mjs';
import { createResourceWindowHistory, resourceWindowSourceBinding } from './resource-window-history.mjs';
import { createResourceWindowHandoffs } from './resource-window-handoffs.mjs';

const fail = status => ({ ok: false, status });
/** Owns only read-only native views. No runtime/task/write port is admitted here. */
export function createResourceWindowController({ BrowserWindow, trustedWindows, rendererLocation, preloadPath, resolveDocument, fileAccess, getOwner, getAppearance = () => ({}), getLocale = () => '', readHistory, writeHistory, prepareFeedback }) {
  const reader = createResourceWindowReader({ resolveDocument, fileAccess, getOwner });
  const history = createResourceWindowHistory({ read: readHistory, write: writeHistory });
  const handoffs = createResourceWindowHandoffs();
  const scopes = new Map(), windows = new Map();
  let disposed = false;
  const registry = createResourceViewRegistry({
    isMainSender: sender => trustedWindows.getRole(sender) === 'main',
    isResourceSender: sender => trustedWindows.getRole(sender) === 'resource',
    resolveSource: async (request, _sender, { signal }) => {
      const found = await reader.prepare(request.resource);
      if (signal.aborted) return fail('source_unavailable');
      return found;
    },
    onPrepared: (context, found) => scopes.set(context.viewId, { ...found, owner: context.owner, resource: context.resource }),
  });
  const editSource = createResourceWindowEditSource({ registry, reader, getScope: id => scopes.get(id) });
  const feedback = createResourceWindowFeedback({ registry, reader, getScope: id => scopes.get(id), prepare: prepareFeedback });
  // Awaiting a local app page is bounded; close/dispose retires even a load promise that never settles.
  async function loadWindow(win, url) {
    let timer, onClosed;
    const retired = new Promise((_, reject) => {
      onClosed = () => reject(Error('window_closed'));
      win.once('closed', onClosed);
      timer = setTimeout(() => reject(Error('window_load_timeout')), 30_000);
    });
    try { await Promise.race([win.loadURL(url), retired]); }
    finally { clearTimeout(timer); win.removeListener('closed', onClosed); }
  }
  function persist(context) {
    const scope = scopes.get(context.viewId); if (!scope) return false;
    if (scope.historySuppressed) return true;
    let resource = context.resource;
    if (resource.kind === 'document') resource = { ...resource,
      ...(resource.mode !== 'diff' && context.navigation?.mode ? { mode: context.navigation.mode } : {}),
      reference: { ...resource.reference, ...(scope.lastObservation ? { expectedObservation: { resourceId: scope.lastObservation.resourceId, contentVersion: scope.lastObservation.contentVersion } } : {}) } };
    const id = history.save({ ...context, resource }, scope, scope.recoveryId);
    if (id) scope.recoveryId = id;
    scope.persisted = !!id; return !!id;
  }
  async function ownerFor(sender, workspaceId) {
    if (disposed || trustedWindows.getRole(sender) !== 'main' || typeof workspaceId !== 'string') return null;
    const owner = await getOwner(workspaceId);
    if (disposed || trustedWindows.getRole(sender) !== 'main' || sender.isDestroyed?.()) return null;
    return owner?.conversationId ? { workspaceId, conversationId: owner.conversationId } : null;
  }
  async function open(sender, request, { restoration } = {}) {
    if (disposed) return fail('disposed');
    const result = await registry.prepare(sender, request);
    if (!result.ok) return result;
    const context = result.context;
    const storedScope = scopes.get(context.viewId);
    if (restoration && (!storedScope || resourceWindowSourceBinding(storedScope) !== restoration.sourceBinding)) {
      registry.release(context); scopes.delete(context.viewId); return fail('source_changed');
    }
    if (restoration) storedScope.recoveryId = restoration.id;
    let win;
    try {
      // Re-resolve after preparation; a root/owner change between the two is never accepted.
      const scope = await reader.prepare(context.resource);
      const captured = scopes.get(context.viewId);
      if (!scope.ok || !captured || scope.root !== captured.root || scope.target !== captured.target || scope.owner.conversationId !== context.owner.conversationId || disposed) throw new Error('source_unavailable');
      win = new BrowserWindow({ width: 1040, height: 780, minWidth: 480, minHeight: 400, show: false,
        title: context.resource.reference.path.split(/[\\/]/).pop() || 'Peer',
        webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
      trustedWindows.registerWindow({ window: win, role: 'resource', allowedLocations: [rendererLocation] });
      const attached = registry.attach(context, win.webContents);
      if (!attached.ok) throw new Error(attached.status);
      windows.set(context.viewId, win);
      const cleanup = () => { handoffs.release(context); windows.delete(context.viewId); scopes.delete(context.viewId); registry.release(context); };
      let closing = false, authorizedClose = false;
      win.on('close', event => {
        const binding = registry.bootstrap(win.webContents);
        if (authorizedClose) { authorizedClose = false; return; }
        if (disposed || !binding.ok || binding.context.phase !== 'ready') return;
        event.preventDefault(); if (closing) return; closing = true;
        void handoffs.request(win.webContents, context, 'checkpoint', requestId => win.webContents.send('resource-window:checkpoint-request', { requestId, identity: context }))
          .then(status => {
            closing = false;
            if (win.isDestroyed() || disposed) return;
            const latest = registry.bootstrap(win.webContents);
            if (!latest.ok) return;
            if (status !== 'confirmed') {
              win.webContents.send('resource-window:close-blocked', { identity: context, reason: status === 'blocked' ? 'save_failed' : 'unconfirmed' });
              return;
            }
            persist(latest.context); authorizedClose = true; win.close();
          });
      });
      win.once('closed', cleanup);
      win.webContents.once('destroyed', cleanup);
      win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); });
      const url = new URL(rendererLocation); url.searchParams.set('window', 'resource');
      await loadWindow(win, url.toString());
      if (disposed || win.isDestroyed() || !registry.bootstrap(win.webContents).ok) throw new Error('source_unavailable');
      win.show();
      const latest = registry.bootstrap(win.webContents);
      return { ...attached, persisted: latest.ok && persist(latest.context) };
    } catch {
      registry.release(context); scopes.delete(context.viewId); windows.delete(context.viewId);
      if (win && !win.isDestroyed()) win.destroy();
      return fail(disposed ? 'disposed' : 'source_unavailable');
    }
  }
  return {
    open,
    prepareFeedback: feedback,
    isEditingSourceCurrent: editSource.isCurrent,
    readEditingSource: editSource.read,
    resolveEditingTarget: editSource.resolveSubmissionTarget,
    bootstrap(sender) { const result = registry.bootstrap(sender), saved = result.ok ? scopes.get(result.context.viewId)?.persisted : undefined;
      return result.ok && saved !== undefined ? { ...result, persisted: saved } : result; },
    appearance(sender) {
      if (!registry.bootstrap(sender).ok) return {};
      const raw = getAppearance();
      return { appearance: Object.fromEntries(['mode', 'palette', 'density', 'fontScale', 'codeFontSize', 'diffMarkerMode', 'windowMaterial'].filter(key => ['string', 'number'].includes(typeof raw?.[key])).map(key => [key, raw[key]])), locale: getLocale() };
    },
    ready: (sender, identity) => registry.markReady(sender, identity),
    navigation(sender, payload) {
      if (!Number.isSafeInteger(payload?.sequence) || payload.sequence < 1) return fail('invalid_request');
      const result = registry.updateNavigation(sender, payload?.identity, payload?.navigation, payload.sequence);
      return result.ok ? { ...result, persisted: persist(result.context) } : result;
    },
    acknowledgeCheckpoint: (sender, payload) => ({ ok: handoffs.acknowledge(sender, payload, 'checkpoint') }),
    acknowledgeReturn: (sender, payload) => ({ ok: handoffs.acknowledge(sender, payload, 'return') }),
    async history(sender, { workspaceId } = {}) {
      const owner = await ownerFor(sender, workspaceId);
      return owner ? history.list(owner) : { ok: false, status: 'scope_denied', entries: [] };
    },
    async restore(sender, { workspaceId, id } = {}) {
      const owner = await ownerFor(sender, workspaceId); if (!owner) return fail('scope_denied');
      if (!history.list(owner).ok) return fail('storage_unavailable');
      const record = history.find(id, owner); if (!record) return fail('source_unavailable');
      return open(sender, record.request, { restoration: record });
    },
    async forget(sender, { workspaceId, id } = {}) {
      const owner = await ownerFor(sender, workspaceId);
      const ok = !!owner && history.remove(id, owner);
      if (ok) for (const scope of scopes.values()) if (scope.recoveryId === id) scope.historySuppressed = true;
      return { ok };
    },
    async read(sender, request) {
      const binding = registry.readBinding(sender, request?.identity);
      if (!binding.ok) return binding;
      const scope = scopes.get(binding.context.viewId);
      if (!scope) return fail('source_unavailable');
      try {
        const result = await reader.read(scope, request);
        const current = registry.readBinding(sender, request.identity);
        if (!current.ok) return fail('stale_view');
        if (result.ok && result.document?.observation && current.context.resource.kind === 'document') {
          scope.lastObservation = result.document.observation; persist(current.context);
        }
        return result;
      } catch { return fail('source_unavailable'); }
    },
    async returnToSource(sender, identity) {
      const target = registry.returnTarget(sender, identity);
      if (!target.ok) return target;
      const scope = scopes.get(target.context.viewId);
      const current = await reader.prepare(target.context.resource).catch(() => null);
      if (!scope || !current?.ok || current.root !== scope.root || current.target !== scope.target || current.owner.conversationId !== target.context.owner.conversationId) return fail('source_unavailable');
      const latest = registry.returnTarget(sender, identity);
      if (!latest.ok) return latest;
      const win = BrowserWindow.fromWebContents(latest.sourceSender);
      if (!win || win.isDestroyed()) return fail('source_unavailable');
      const status = await handoffs.request(latest.sourceSender, identity, 'return', requestId => latest.sourceSender.send('resource-window:return-target', { requestId, context: latest.context, expiresAt: Date.now() + 3000 }));
      if (!['returned', 'source_tab_closed'].includes(status)) return fail(status === 'cancelled' ? 'cancelled' : 'source_unavailable');
      if (!registry.returnTarget(sender, identity).ok || win.isDestroyed()) return fail('source_unavailable');
      if (win.isMinimized()) win.restore(); win.show(); win.focus();
      return { ok: true, context: latest.context, returnStatus: status };
    },
    close(sender, identity) {
      const binding = registry.bootstrap(sender);
      if (!binding.ok || !identity || binding.context.viewId !== identity.viewId || binding.context.windowId !== identity.windowId || binding.context.generation !== identity.generation) return fail('stale_view');
      const win = windows.get(identity.viewId); if (!win || win.isDestroyed()) return fail('source_unavailable');
      win.close(); return { ok: true, context: binding.context };
    },
    dispose() { disposed = true; handoffs.dispose(); registry.dispose(); for (const win of windows.values()) if (!win.isDestroyed()) win.destroy(); windows.clear(); scopes.clear(); },
  };
}
