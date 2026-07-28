/**
 * 将已解密 Cookie 写入 Electron persist:peer-browser。
 * 调用方负责解密；本模块不接触 Keychain / SQLite。
 */

/**
 * @param {import('electron').Session} ses
 * @param {Array<{
 *   url: string,
 *   name: string,
 *   value: string,
 *   domain?: string,
 *   path?: string,
 *   secure?: boolean,
 *   httpOnly?: boolean,
 *   sameSite?: string,
 *   expirationDate?: number,
 * }>} cookies
 */
export async function applyCookiesToSession(ses, cookies) {
  if (!ses?.cookies?.set) {
    return { ok: false, error: 'session_unavailable', added: 0, failed: 0 };
  }
  const list = Array.isArray(cookies) ? cookies : [];
  let added = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  for (const c of list) {
    if (!c?.url || !c?.name || c.value == null) {
      failed += 1;
      continue;
    }
    /** @type {Record<string, unknown>} */
    const details = {
      url: c.url,
      name: c.name,
      value: String(c.value),
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
    };
    if (c.domain) details.domain = c.domain;
    if (c.expirationDate != null && Number(c.expirationDate) > 0) {
      details.expirationDate = Number(c.expirationDate);
    }
    // Electron: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
    if (c.sameSite && c.sameSite !== 'unspecified') {
      details.sameSite = c.sameSite;
    }
    try {
      await ses.cookies.set(details);
      added += 1;
    } catch (err) {
      failed += 1;
      if (errors.length < 5) {
        errors.push(String(err?.message || 'set_failed'));
      }
    }
  }

  try {
    if (typeof ses.cookies.flushStore === 'function') {
      await ses.cookies.flushStore();
    }
  } catch {
    /* flush best-effort */
  }

  return {
    ok: failed === 0 && added > 0,
    added,
    failed,
    errors,
  };
}
