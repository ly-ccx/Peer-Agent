function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

const PERMISSION_ERROR_PATTERN = /cookie_db_permission_denied|EPERM|EACCES/i;
const PERMISSION_DETAIL_PATTERN = /cookie_db_permission_denied|EPERM|EACCES|operation not permitted|copyfile/i;
const PERMISSION_ERROR_ZH = '无法复制浏览器 Cookies 文件（系统拒绝访问）。请到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」允许 Peer Agent（开发态可能是 Electron），然后完全退出并重启应用后再试。';

function humanizeSessionImportError(error, isZh = true) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (PERMISSION_DETAIL_PATTERN.test(message)) {
    return isZh
      ? PERMISSION_ERROR_ZH
      : 'Cannot copy browser Cookies (permission denied). Grant Full Disk Access to Peer Agent under System Settings → Privacy & Security, fully quit and relaunch, then retry.';
  }
  return message || (isZh ? '导入失败' : 'import_failed');
}

function permissionCode(value) {
  return PERMISSION_ERROR_PATTERN.test(String(value || '')) ? 'permission_denied' : undefined;
}

export function createBrowserSessionImportApplicationService({
  getPlatform,
  buildPreflight,
  resolveDragTarget,
  resolveDragIconDataUrl,
  listBrowserSources,
  scanProfileSites,
  loadCookiesForSites,
  getBrowserSession,
  applyCookiesToSession,
  redactLoadedCookies,
} = {}) {
  const ports = {
    getPlatform: assertFunction(getPlatform, 'getPlatform'),
    buildPreflight: assertFunction(buildPreflight, 'buildPreflight'),
    resolveDragTarget: assertFunction(resolveDragTarget, 'resolveDragTarget'),
    resolveDragIconDataUrl: assertFunction(resolveDragIconDataUrl, 'resolveDragIconDataUrl'),
    listBrowserSources: assertFunction(listBrowserSources, 'listBrowserSources'),
    scanProfileSites: assertFunction(scanProfileSites, 'scanProfileSites'),
    loadCookiesForSites: assertFunction(loadCookiesForSites, 'loadCookiesForSites'),
    getBrowserSession: assertFunction(getBrowserSession, 'getBrowserSession'),
    applyCookiesToSession: assertFunction(applyCookiesToSession, 'applyCookiesToSession'),
    redactLoadedCookies: assertFunction(redactLoadedCookies, 'redactLoadedCookies'),
  };

  async function getPreflight() {
    try {
      const platform = ports.getPlatform();
      const preflight = ports.buildPreflight(platform);
      const dragTarget = ports.resolveDragTarget(platform);
      const iconDataUrl = dragTarget?.ok
        ? await ports.resolveDragIconDataUrl(dragTarget.appPath)
        : null;
      return {
        ...preflight,
        dragTarget: dragTarget?.ok
          ? {
              ok: true,
              appPath: dragTarget.appPath,
              displayName: dragTarget.displayName,
              kind: dragTarget.kind,
              isPackagedApp: dragTarget.isPackagedApp,
              iconDataUrl,
            }
          : {
              ok: false,
              error: dragTarget?.error || 'app_path_not_found',
            },
      };
    } catch (error) {
      return {
        ok: false,
        ready: false,
        blocked: true,
        checks: [],
        error: error?.message || 'preflight_failed',
      };
    }
  }

  async function listSessionSources() {
    try {
      if (ports.getPlatform() !== 'darwin') {
        return {
          ok: false,
          error: 'unsupported_platform',
          sources: [],
          preflight: await getPreflight(),
        };
      }

      const preflight = await getPreflight();
      const sources = ports.listBrowserSources().map((source) => ({
        adapterId: source.adapterId,
        browserName: source.browserName,
        bundleId: source.bundleId,
        profiles: (source.profiles || []).map((profile) => ({
          profileId: profile.profileId,
          displayName: profile.displayName,
          directory: profile.directory,
          hasCookieDb: Boolean(profile.cookieDbPath),
        })),
      }));
      return {
        ok: true,
        sources,
        preflight,
        error: sources.length === 0 && preflight.blocked
          ? (preflight.checks.find((check) => check.status === 'blocked')?.detail
            || 'permission_denied')
          : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'list_sources_failed',
        sources: [],
        preflight: await getPreflight(),
      };
    }
  }

  async function listSessionSites({ profileId } = {}) {
    try {
      if (!profileId || typeof profileId !== 'string') {
        return { ok: false, error: 'invalid_profile' };
      }
      return await ports.scanProfileSites(profileId);
    } catch (error) {
      return {
        ok: false,
        error: humanizeSessionImportError(error, true),
        code: error?.code || permissionCode(error?.message),
      };
    }
  }

  async function importSiteSession({
    profileId,
    registrableDomains,
    includeSubdomains = true,
  } = {}) {
    try {
      if (!profileId || typeof profileId !== 'string') {
        return { ok: false, error: 'invalid_profile' };
      }
      const domains = Array.isArray(registrableDomains) ? registrableDomains : [];
      if (domains.length === 0) return { ok: false, error: 'no_domains_selected' };

      const loaded = await ports.loadCookiesForSites({
        profileId,
        registrableDomains: domains,
        includeSubdomains: includeSubdomains !== false,
      });
      if (!loaded.ok) {
        return {
          ok: false,
          error: humanizeSessionImportError(loaded.error || 'load_cookies_failed', true),
          code: permissionCode(loaded.error),
          stats: loaded.stats,
        };
      }

      const applied = await ports.applyCookiesToSession(
        ports.getBrowserSession(),
        loaded.cookies,
      );
      const summary = ports.redactLoadedCookies(loaded);
      return {
        ok: applied.ok || applied.added > 0,
        status: applied.failed === 0 ? 'cookies_applied' : 'partially_applied',
        profileId: loaded.profileId,
        browserName: loaded.browserName,
        registrableDomains: domains,
        added: applied.added,
        failed: applied.failed,
        stats: loaded.stats,
        cookieSummaries: summary.cookies,
        applyErrors: applied.errors,
      };
    } catch (error) {
      return {
        ok: false,
        error: humanizeSessionImportError(error, true),
        code: permissionCode(error?.message),
      };
    }
  }

  return Object.freeze({
    getPreflight,
    listSessionSources,
    listSessionSites,
    importSiteSession,
  });
}
