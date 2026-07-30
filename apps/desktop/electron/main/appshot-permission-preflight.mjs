/**
 * Appshot Screen Recording permission preflight (T5).
 *
 * Contract: ADR 59 decision 3 — permission_denied must be decided here, before
 * any capture attempt, because `screencapture` emits identical errors for
 * "no permission" and "window not capturable" (spike S4).
 *
 * Spike S4 facts (2026-07-30):
 * - `systemPreferences.getMediaAccessStatus('screen')` reads are immediate and
 *   accurate for NEW processes after a TCC change.
 * - A RUNNING process may not observe a grant until restart → we surface a
 *   "restart Peer if capture still fails" hint key instead of promising
 *   restart-free recovery.
 */

/** i18n keys for the renderer; actual copy lives in packages/i18n. */
export const APPSHOT_PERMISSION_HINT_KEYS = Object.freeze({
  granted: 'appshot.permission.granted',
  denied: 'appshot.permission.denied',
  restartFallback: 'appshot.permission.restartFallback',
});

const SCREEN_CAPTURE_SETTINGS_URLS = [
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
  'x-apple.systempreferences:com.apple.preference.security?Privacy',
];

/**
 * @param {object} deps
 * @param {(mediaType: string) => string} deps.getMediaAccessStatus
 * @param {string} [deps.platform]
 * @returns {{ ok: boolean, status: string, canCapture: boolean, hintKey: string }}
 */
export function buildAppshotPermissionPreflight({ getMediaAccessStatus, platform = process.platform }) {
  if (platform !== 'darwin') {
    // P0a is macOS-only; other platforms report unsupported (not denied).
    return { ok: false, status: 'unsupported-platform', canCapture: false, hintKey: APPSHOT_PERMISSION_HINT_KEYS.denied };
  }
  const status = getMediaAccessStatus('screen');
  const canCapture = status === 'granted';
  return {
    ok: true,
    status,
    canCapture,
    hintKey: canCapture
      ? APPSHOT_PERMISSION_HINT_KEYS.granted
      : APPSHOT_PERMISSION_HINT_KEYS.denied,
  };
}

/**
 * Open System Settings at the Screen Recording privacy pane.
 * Mirrors openFullDiskAccessSettings (session-import) deep-link + fallback.
 *
 * @param {object} options
 * @param {(url: string) => Promise<void>} options.shellOpenExternal
 */
export async function openScreenRecordingSettings(options = {}) {
  const openExternal = options.shellOpenExternal;
  if (typeof openExternal !== 'function') {
    return { ok: false, error: 'shell_open_unavailable' };
  }
  let lastErr = null;
  for (const url of SCREEN_CAPTURE_SETTINGS_URLS) {
    try {
      await openExternal(url);
      return { ok: true, url };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  return { ok: false, error: lastErr?.message || 'open_settings_failed' };
}
