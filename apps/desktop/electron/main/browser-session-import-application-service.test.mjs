import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSessionImportApplicationService } from './browser-session-import-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const preflight = { ok: true, ready: true, blocked: false, checks: [] };
  const loaded = {
    ok: true,
    profileId: 'profile-1',
    browserName: 'Chrome',
    cookies: [{ name: 'sid', value: 'super-secret', url: 'https://example.com' }],
    stats: { selected: 1 },
  };
  const ports = {
    getPlatform: () => 'darwin',
    buildPreflight: (platform) => {
      calls.push(['build-preflight', platform]);
      return preflight;
    },
    resolveDragTarget: (platform) => {
      calls.push(['resolve-drag-target', platform]);
      return {
        ok: true,
        appPath: '/Applications/Peer Agent.app',
        displayName: 'Peer Agent',
        kind: 'app_bundle',
        isPackagedApp: true,
      };
    },
    resolveDragIconDataUrl: async (appPath) => {
      calls.push(['resolve-drag-icon', appPath]);
      return 'data:image/png;base64,icon';
    },
    listBrowserSources: () => {
      calls.push(['list-browser-sources']);
      return [{
        adapterId: 'chrome-mac',
        browserName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        profiles: [{
          profileId: 'profile-1',
          displayName: 'Default',
          directory: 'Default',
          cookieDbPath: '/private/Cookies',
        }],
      }];
    },
    scanProfileSites: async (profileId) => {
      calls.push(['scan-profile-sites', profileId]);
      return { ok: true, sites: [{ registrableDomain: 'example.com' }] };
    },
    loadCookiesForSites: async (input) => {
      calls.push(['load-cookies', input]);
      return loaded;
    },
    getBrowserSession: () => {
      calls.push(['get-browser-session']);
      return { id: 'peer-browser-session' };
    },
    applyCookiesToSession: async (session, cookies) => {
      calls.push(['apply-cookies', session, cookies]);
      return { ok: true, added: 1, failed: 0, errors: [] };
    },
    redactLoadedCookies: (value) => {
      calls.push(['redact-cookies', value]);
      return { cookies: [{ name: 'sid', domain: '.example.com' }] };
    },
    ...overrides,
  };
  return {
    calls,
    loaded,
    preflight,
    service: createBrowserSessionImportApplicationService(ports),
  };
}

test('preflight enriches the pure probe with a safe draggable app target', async () => {
  const { calls, preflight, service } = createHarness();

  assert.deepEqual(await service.getPreflight(), {
    ...preflight,
    dragTarget: {
      ok: true,
      appPath: '/Applications/Peer Agent.app',
      displayName: 'Peer Agent',
      kind: 'app_bundle',
      isPackagedApp: true,
      iconDataUrl: 'data:image/png;base64,icon',
    },
  });
  assert.deepEqual(calls, [
    ['build-preflight', 'darwin'],
    ['resolve-drag-target', 'darwin'],
    ['resolve-drag-icon', '/Applications/Peer Agent.app'],
  ]);
});

test('preflight maps a missing drag target and catches probe failures', async () => {
  const missing = createHarness({
    resolveDragTarget: () => ({ ok: false, error: 'app_missing' }),
  });
  assert.deepEqual((await missing.service.getPreflight()).dragTarget, {
    ok: false,
    error: 'app_missing',
  });

  const failing = createHarness({
    buildPreflight: () => {
      throw new Error('probe failed');
    },
  });
  assert.deepEqual(await failing.service.getPreflight(), {
    ok: false,
    ready: false,
    blocked: true,
    checks: [],
    error: 'probe failed',
  });
});

test('listSessionSources rejects unsupported platforms with preflight context', async () => {
  const { calls, service } = createHarness({ getPlatform: () => 'linux' });

  const result = await service.listSessionSources();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_platform');
  assert.deepEqual(result.sources, []);
  assert.equal(result.preflight.dragTarget.ok, true);
  assert.equal(calls.some(([name]) => name === 'list-browser-sources'), false);
});

test('listSessionSources maps profiles without exposing the cookie database path', async () => {
  const { service } = createHarness();

  const result = await service.listSessionSources();
  assert.deepEqual(result, {
    ok: true,
    sources: [{
      adapterId: 'chrome-mac',
      browserName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      profiles: [{
        profileId: 'profile-1',
        displayName: 'Default',
        directory: 'Default',
        hasCookieDb: true,
      }],
    }],
    preflight: result.preflight,
    error: undefined,
  });
  assert.equal(JSON.stringify(result).includes('/private/Cookies'), false);
});

test('listSessionSources surfaces the first blocked detail when discovery is empty', async () => {
  const blockedPreflight = {
    ok: false,
    ready: false,
    blocked: true,
    checks: [{ status: 'blocked', detail: 'Full Disk Access required' }],
  };
  const { service } = createHarness({
    buildPreflight: () => blockedPreflight,
    listBrowserSources: () => [],
  });

  const result = await service.listSessionSources();
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, []);
  assert.equal(result.error, 'Full Disk Access required');
});

test('listSessionSources maps discovery failures and preserves preflight', async () => {
  const { service } = createHarness({
    listBrowserSources: () => {
      throw new Error('discovery failed');
    },
  });

  const result = await service.listSessionSources();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'discovery failed');
  assert.deepEqual(result.sources, []);
  assert.equal(result.preflight.dragTarget.ok, true);
});

test('listSessionSites validates the profile and maps permission failures', async () => {
  const { service } = createHarness();
  assert.deepEqual(await service.listSessionSites(), { ok: false, error: 'invalid_profile' });

  const permissionError = Object.assign(new Error('EACCES reading Cookies'), {
    code: 'SQLITE_CANTOPEN',
  });
  const failing = createHarness({
    scanProfileSites: async () => {
      throw permissionError;
    },
  });
  const result = await failing.service.listSessionSites({ profileId: 'profile-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SQLITE_CANTOPEN');
  assert.match(result.error, /完全磁盘访问权限/);
});

test('importSiteSession validates profile and selected domains', async () => {
  const { service } = createHarness();

  assert.deepEqual(await service.importSiteSession(), { ok: false, error: 'invalid_profile' });
  assert.deepEqual(await service.importSiteSession({ profileId: 'profile-1' }), {
    ok: false,
    error: 'no_domains_selected',
  });
});

test('importSiteSession maps load failures without applying cookies', async () => {
  const { calls, service } = createHarness({
    loadCookiesForSites: async (input) => {
      calls.push(['load-cookies', input]);
      return {
        ok: false,
        error: 'cookie_db_permission_denied',
        stats: { selected: 0 },
      };
    },
  });

  assert.deepEqual(await service.importSiteSession({
    profileId: 'profile-1',
    registrableDomains: ['example.com'],
  }), {
    ok: false,
    error: '无法复制浏览器 Cookies 文件（系统拒绝访问）。请到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」允许 Peer Agent（开发态可能是 Electron），然后完全退出并重启应用后再试。',
    code: 'permission_denied',
    stats: { selected: 0 },
  });
  assert.equal(calls.some(([name]) => name === 'apply-cookies'), false);
});

test('importSiteSession applies cookies but returns only redacted metadata', async () => {
  const { calls, loaded, service } = createHarness();

  const result = await service.importSiteSession({
    profileId: 'profile-1',
    registrableDomains: ['example.com'],
    includeSubdomains: false,
  });

  assert.deepEqual(calls.find(([name]) => name === 'load-cookies'), [
    'load-cookies',
    {
      profileId: 'profile-1',
      registrableDomains: ['example.com'],
      includeSubdomains: false,
    },
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'apply-cookies'), [
    'apply-cookies',
    { id: 'peer-browser-session' },
    loaded.cookies,
  ]);
  assert.deepEqual(result, {
    ok: true,
    status: 'cookies_applied',
    profileId: 'profile-1',
    browserName: 'Chrome',
    registrableDomains: ['example.com'],
    added: 1,
    failed: 0,
    stats: { selected: 1 },
    cookieSummaries: [{ name: 'sid', domain: '.example.com' }],
    applyErrors: [],
  });
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
});

test('importSiteSession preserves partial-apply and thrown-error shapes', async () => {
  const partial = createHarness({
    applyCookiesToSession: async () => ({
      ok: false,
      added: 1,
      failed: 1,
      errors: ['one failed'],
    }),
  });
  const partialResult = await partial.service.importSiteSession({
    profileId: 'profile-1',
    registrableDomains: ['example.com'],
  });
  assert.equal(partialResult.ok, true);
  assert.equal(partialResult.status, 'partially_applied');
  assert.equal(partialResult.failed, 1);

  const failing = createHarness({
    loadCookiesForSites: async () => {
      throw new Error('EPERM copyfile');
    },
  });
  const failedResult = await failing.service.importSiteSession({
    profileId: 'profile-1',
    registrableDomains: ['example.com'],
  });
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.code, 'permission_denied');
  assert.match(failedResult.error, /完全磁盘访问权限/);
});
