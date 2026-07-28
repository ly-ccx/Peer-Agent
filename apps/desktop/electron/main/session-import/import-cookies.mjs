/**
 * 会话导入编排：站点元数据扫描 + 选定站点 Cookie 解密 + 映射为 Electron cookies.set 详情。
 * 不写 session；不把 password 打进返回的 meta。
 */

import {
  getRegistrableDomain,
  hostBelongsToRegistrableDomain,
  normalizeHostKey,
} from './site-domain.mjs';
import { decryptChromeCookieValue } from './chrome-decrypt.mjs';
import { readChromeSafeStoragePassword } from './chrome-keychain.mjs';
import { resolveProfileById } from './chrome-profiles.mjs';
import {
  hexToBuffer,
  readCookieRowsFromSqlite,
  removeSnapshot,
  snapshotCookieDatabase,
} from './chrome-cookie-db.mjs';

/** Chrome expires_utc → Unix 秒；0/无 expires → undefined（session cookie）。 */
export function chromeExpiryToUnixSeconds(expiresUtc, hasExpires) {
  const has = Number(hasExpires) === 1 || hasExpires === true || hasExpires === '1';
  const n = Number(expiresUtc) || 0;
  if (!has || n <= 0) return undefined;
  // Chrome: microseconds since 1601-01-01 UTC
  const unix = Math.floor(n / 1_000_000 - 11_644_473_600);
  if (unix <= 0) return undefined;
  return unix;
}

export function mapSameSite(value) {
  // Chromium: -1 unspecified, 0 no_restriction, 1 lax, 2 strict
  const n = Number(value);
  if (n === 0) return 'no_restriction';
  if (n === 1) return 'lax';
  if (n === 2) return 'strict';
  return 'unspecified';
}

/**
 * 从 host_key 构造 Electron cookies.set 所需 url。
 */
export function buildCookieUrl({ hostKey, path: cookiePath, secure }) {
  const host = normalizeHostKey(hostKey);
  const p = cookiePath && String(cookiePath).startsWith('/') ? cookiePath : '/';
  const scheme = secure ? 'https' : 'http';
  // host-only: host_key 无前导点；domain cookie: 有前导点
  const hostname = host;
  return `${scheme}://${hostname}${p === '/' ? '/' : p}`;
}

/**
 * 扫描 Profile 下站点元数据（无解密 / 无 value）。
 * @param {string} profileId
 * @param {object} [options]
 */
export async function scanProfileSites(profileId, options = {}) {
  const resolved = resolveProfileById(profileId, options);
  if (!resolved.ok) return { ok: false, error: resolved.error || 'profile_not_found' };
  const cookieDbPath = resolved.profile.cookieDbPath;
  if (!cookieDbPath) return { ok: false, error: 'cookie_db_not_found' };

  let snapshotDir;
  try {
    const snap = snapshotCookieDatabase(cookieDbPath, options);
    snapshotDir = snap.snapshotDir;
    const rows = await readCookieRowsFromSqlite(snap.snapshotDbPath, options);
    /** @type {Map<string, { registrableDomain: string, cookieCount: number, hosts: Set<string>, secureCount: number }>} */
    const byDomain = new Map();
    const nowUnix = Math.floor(Date.now() / 1000);

    for (const row of rows) {
      const hostKey = String(row.host_key || '');
      const reg = getRegistrableDomain(hostKey);
      if (!reg) continue;
      const exp = chromeExpiryToUnixSeconds(row.expires_utc, row.has_expires);
      if (exp != null && exp < nowUnix) continue; // 跳过已过期
      let bucket = byDomain.get(reg);
      if (!bucket) {
        bucket = {
          registrableDomain: reg,
          cookieCount: 0,
          hosts: new Set(),
          secureCount: 0,
        };
        byDomain.set(reg, bucket);
      }
      bucket.cookieCount += 1;
      bucket.hosts.add(normalizeHostKey(hostKey));
      if (Number(row.is_secure) === 1 || row.is_secure === true || row.is_secure === '1') {
        bucket.secureCount += 1;
      }
    }

    const sites = [...byDomain.values()]
      .map((b) => ({
        registrableDomain: b.registrableDomain,
        cookieCount: b.cookieCount,
        hostCount: b.hosts.size,
        hosts: [...b.hosts].sort(),
      }))
      .sort((a, b) => b.cookieCount - a.cookieCount || a.registrableDomain.localeCompare(b.registrableDomain));

    return {
      ok: true,
      profileId,
      browserName: resolved.browserName,
      displayName: resolved.profile.displayName,
      sites,
      totalCookies: sites.reduce((n, s) => n + s.cookieCount, 0),
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'scan_failed' };
  } finally {
    removeSnapshot(snapshotDir, options);
  }
}

/**
 * 解密并导出选定 registrable domains 的 Cookie，映射为 Electron set 详情。
 * @param {{ profileId: string, registrableDomains: string[], includeSubdomains?: boolean }} input
 * @param {{ password?: string, keychain?: object, fsImpl?: object }} [options]
 */
export async function loadCookiesForSites(input, options = {}) {
  const profileId = input?.profileId;
  const domains = Array.isArray(input?.registrableDomains)
    ? input.registrableDomains.map((d) => normalizeHostKey(d)).filter(Boolean)
    : [];
  if (!profileId) return { ok: false, error: 'invalid_profile' };
  if (domains.length === 0) return { ok: false, error: 'no_domains_selected' };

  const resolved = resolveProfileById(profileId, options);
  if (!resolved.ok) return { ok: false, error: resolved.error || 'profile_not_found' };
  const cookieDbPath = resolved.profile.cookieDbPath;
  if (!cookieDbPath) return { ok: false, error: 'cookie_db_not_found' };

  let snapshotDir;
  /** @type {string|undefined} */
  let password = options.password;
  try {
    if (password == null) {
      password = await readChromeSafeStoragePassword({
        browserId: resolved.keychainBrowserId,
        ...(options.keychain || {}),
      });
    }

    const snap = snapshotCookieDatabase(cookieDbPath, options);
    snapshotDir = snap.snapshotDir;
    const rows = await readCookieRowsFromSqlite(snap.snapshotDbPath, options);
    const nowUnix = Math.floor(Date.now() / 1000);

    /** @type {Array<Record<string, unknown>>} */
    const cookies = [];
    let skippedExpired = 0;
    let skippedOutOfScope = 0;
    let skippedDecrypt = 0;
    let skippedEmpty = 0;

    for (const row of rows) {
      const hostKey = String(row.host_key || '');
      const inScope = domains.some((d) => hostBelongsToRegistrableDomain(hostKey, d));
      if (!inScope) {
        skippedOutOfScope += 1;
        continue;
      }
      const exp = chromeExpiryToUnixSeconds(row.expires_utc, row.has_expires);
      if (exp != null && exp < nowUnix) {
        skippedExpired += 1;
        continue;
      }

      const secure =
        Number(row.is_secure) === 1 || row.is_secure === true || row.is_secure === '1';
      const httpOnly =
        Number(row.is_httponly) === 1 || row.is_httponly === true || row.is_httponly === '1';
      const cookiePath = String(row.path || '/');
      const name = String(row.name || '');
      if (!name) {
        skippedEmpty += 1;
        continue;
      }

      let value = '';
      const encHex = row.encrypted_value_hex;
      const encLen = Number(row.encrypted_value_len) || 0;
      try {
        if (encLen > 0 && encHex) {
          value = decryptChromeCookieValue(hexToBuffer(String(encHex)), { password });
        } else if (row.plain_value != null && String(row.plain_value).length > 0) {
          value = String(row.plain_value);
        } else {
          skippedEmpty += 1;
          continue;
        }
      } catch {
        skippedDecrypt += 1;
        continue;
      }
      if (!value) {
        skippedEmpty += 1;
        continue;
      }

      const sameSite = mapSameSite(row.samesite);
      // SameSite=None 必须 Secure
      if (sameSite === 'no_restriction' && !secure) {
        skippedEmpty += 1;
        continue;
      }

      const rawHost = String(row.host_key || '');
      const domainCookie = rawHost.startsWith('.');
      const details = {
        url: buildCookieUrl({ hostKey: rawHost, path: cookiePath, secure }),
        name,
        value,
        path: cookiePath,
        secure,
        httpOnly,
        sameSite: sameSite === 'unspecified' ? undefined : sameSite,
        expirationDate: exp,
      };
      if (domainCookie) {
        details.domain = normalizeHostKey(rawHost);
      }

      cookies.push({
        ...details,
        hostKey: rawHost,
        registrableDomain: getRegistrableDomain(rawHost),
      });
    }

    return {
      ok: true,
      profileId,
      browserName: resolved.browserName,
      cookies,
      stats: {
        selected: cookies.length,
        skippedExpired,
        skippedOutOfScope,
        skippedDecrypt,
        skippedEmpty,
      },
    };
  } catch (err) {
    const msg = err?.message || 'load_cookies_failed';
    return { ok: false, error: msg };
  } finally {
    removeSnapshot(snapshotDir, options);
    password = undefined;
  }
}

/**
 * 去掉 value 后供 UI / Evidence 使用的摘要。
 * @param {Awaited<ReturnType<typeof loadCookiesForSites>>} loaded
 */
export function redactLoadedCookies(loaded) {
  if (!loaded?.ok) return loaded;
  return {
    ok: true,
    profileId: loaded.profileId,
    browserName: loaded.browserName,
    stats: loaded.stats,
    cookies: (loaded.cookies || []).map((c) => ({
      name: c.name,
      domain: c.domain,
      hostKey: c.hostKey,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
      registrableDomain: c.registrableDomain,
      // 故意不包含 value
    })),
  };
}
