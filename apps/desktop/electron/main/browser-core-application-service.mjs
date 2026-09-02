function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

const SITE_STORAGE_TYPES = Object.freeze([
  'cookies',
  'localstorage',
  'indexdb',
  'shadercache',
  'websql',
  'serviceworkers',
  'cachestorage',
]);

export function createBrowserCoreApplicationService({
  getActiveWebContentsId,
  registerWebContents,
  unregisterWebContents,
  rebuildMenu,
  getBrowserSession,
  getWebContentsById,
  resolveWindowFromSender,
  showSaveDialog,
  getDownloadsPath,
  joinPath,
  now,
  writeFile,
  openExternal,
} = {}) {
  const ports = {
    getActiveWebContentsId: assertFunction(getActiveWebContentsId, 'getActiveWebContentsId'),
    registerWebContents: assertFunction(registerWebContents, 'registerWebContents'),
    unregisterWebContents: assertFunction(unregisterWebContents, 'unregisterWebContents'),
    rebuildMenu: assertFunction(rebuildMenu, 'rebuildMenu'),
    getBrowserSession: assertFunction(getBrowserSession, 'getBrowserSession'),
    getWebContentsById: assertFunction(getWebContentsById, 'getWebContentsById'),
    resolveWindowFromSender: assertFunction(resolveWindowFromSender, 'resolveWindowFromSender'),
    showSaveDialog: assertFunction(showSaveDialog, 'showSaveDialog'),
    getDownloadsPath: assertFunction(getDownloadsPath, 'getDownloadsPath'),
    joinPath: assertFunction(joinPath, 'joinPath'),
    now: assertFunction(now, 'now'),
    writeFile: assertFunction(writeFile, 'writeFile'),
    openExternal: assertFunction(openExternal, 'openExternal'),
  };

  function runRegistryCommand(command, registration) {
    const hadActiveBrowser = ports.getActiveWebContentsId() != null;
    const result = command(registration);
    const hasActiveBrowser = ports.getActiveWebContentsId() != null;
    if (hadActiveBrowser !== hasActiveBrowser) ports.rebuildMenu();
    return result;
  }

  async function clearSiteData({ url } = {}) {
    try {
      if (!url || typeof url !== 'string') return { ok: false, error: 'invalid_url' };
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: 'invalid_url' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'unsupported_scheme' };
      }

      const origin = parsed.origin;
      const browserSession = ports.getBrowserSession();
      await browserSession.clearStorageData({
        origin,
        storages: [...SITE_STORAGE_TYPES],
      });
      try {
        await browserSession.clearCache();
      } catch {
        // HTTP cache cleanup is best-effort across Electron versions.
      }
      return { ok: true, origin };
    } catch (error) {
      return { ok: false, error: error?.message || 'clear_site_data_failed' };
    }
  }

  async function capturePage({ sender, webContentsId, savePath } = {}) {
    try {
      const id = Number(webContentsId);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, error: 'invalid_web_contents_id' };
      }
      const browserWebContents = ports.getWebContentsById(id);
      if (
        !browserWebContents
        || (typeof browserWebContents.isDestroyed === 'function' && browserWebContents.isDestroyed())
      ) {
        return { ok: false, error: 'browser_unavailable' };
      }

      const image = await browserWebContents.capturePage();
      if (!image || image.isEmpty?.()) return { ok: false, error: 'empty_capture' };

      const png = image.toPNG();
      let targetPath = typeof savePath === 'string' && savePath.trim() ? savePath.trim() : '';
      if (!targetPath) {
        const window = ports.resolveWindowFromSender(sender);
        const stamp = ports.now().toISOString().replace(/[:.]/g, '-');
        const result = await ports.showSaveDialog(window ?? undefined, {
          title: 'Save screenshot',
          defaultPath: ports.joinPath(
            ports.getDownloadsPath(),
            `peer-browser-${stamp}.png`,
          ),
          filters: [{ name: 'PNG', extensions: ['png'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
        targetPath = result.filePath;
      }

      await ports.writeFile(targetPath, png);
      return { ok: true, path: targetPath, bytes: png.length };
    } catch (error) {
      return { ok: false, error: error?.message || 'capture_failed' };
    }
  }

  async function openExternalUrl({ url } = {}) {
    try {
      if (!url || typeof url !== 'string') return { ok: false, error: 'invalid_url' };
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: 'invalid_url' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'unsupported_protocol' };
      }
      const href = parsed.toString();
      await ports.openExternal(href);
      return { ok: true, url: href };
    } catch (error) {
      return { ok: false, error: error?.message || 'open_external_failed' };
    }
  }

  return Object.freeze({
    registerWebContents: (registration = {}) =>
      runRegistryCommand(ports.registerWebContents, registration),
    unregisterWebContents: (registration = {}) =>
      runRegistryCommand(ports.unregisterWebContents, registration),
    clearSiteData,
    capturePage,
    openExternal: openExternalUrl,
  });
}
