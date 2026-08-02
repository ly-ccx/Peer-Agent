function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

const DISCOVER_FIELDS_SCRIPT = [
  '(() => {',
  '  const isVisible = (el) => {',
  '    if (!el) return false;',
  '    const s = window.getComputedStyle(el);',
  "    return s && s.visibility !== 'hidden' && s.display !== 'none' && el.offsetParent !== null;",
  '  };',
  '  const passwords = [...document.querySelectorAll(\'input[type="password"]\')].filter(isVisible);',
  '  const password = passwords[0] || null;',
  "  if (!password) return { ok: false, reason: 'no_password_field' };",
  '  const form = password.form;',
  '  const candidates = form',
  "    ? [...form.querySelectorAll('input')]",
  "    : [...document.querySelectorAll('input')];",
  '  const username = candidates.find((el) => {',
  '    if (!isVisible(el) || el === password) return false;',
  "    const type = (el.type || 'text').toLowerCase();",
  "    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'password'].includes(type)) return false;",
  "    const auto = (el.autocomplete || '').toLowerCase();",
  "    const name = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '')).toLowerCase();",
  "    return auto.includes('username') || auto.includes('email') || type === 'email' || /user|email|login|account/.test(name);",
  '  }) || null;',
  "  const mark = 'data-peer-pw-fill';",
  "  document.querySelectorAll('[' + mark + ']').forEach((el) => el.removeAttribute(mark));",
  "  if (username) username.setAttribute(mark, 'username');",
  "  password.setAttribute(mark, 'password');",
  '  return { ok: true, hasUsername: Boolean(username), origin: location.origin };',
  '})()',
].join('\n');

const CLEANUP_FIELDS_SCRIPT =
  "document.querySelectorAll('[data-peer-pw-fill]').forEach((el) => el.removeAttribute('data-peer-pw-fill')); true;";

function focusAndClearScript(mark) {
  const selector = `[data-peer-pw-fill="${mark}"]`;
  return [
    '(() => {',
    `  const el = document.querySelector(${JSON.stringify(selector)});`,
    '  if (!el) return false;',
    '  el.focus();',
    "  el.value = '';",
    "  el.dispatchEvent(new Event('input', { bubbles: true }));",
    '  return true;',
    '})()',
  ].join('\n');
}

function commitFieldScript(mark) {
  const selector = `[data-peer-pw-fill="${mark}"]`;
  return [
    '(() => {',
    `  const el = document.querySelector(${JSON.stringify(selector)});`,
    '  if (!el) return;',
    "  el.dispatchEvent(new Event('input', { bubbles: true }));",
    "  el.dispatchEvent(new Event('change', { bubbles: true }));",
    '})()',
  ].join('\n');
}

export function createPasswordVaultFillApplicationService(options = {}) {
  const ports = {
    revealPassword: assertFunction(options.revealPassword, 'revealPassword'),
    getWebContents: assertFunction(options.getWebContents, 'getWebContents'),
  };

  async function typeIntoMarked(webContents, mark, text) {
    await webContents.executeJavaScript(focusAndClearScript(mark), true);
    for (const character of String(text)) {
      webContents.sendInputEvent({ type: 'char', keyCode: character });
    }
    await webContents.executeJavaScript(commitFieldScript(mark), true);
  }

  async function fill({ id, webContentsId, fillUsername = true } = {}) {
    try {
      const revealed = ports.revealPassword(id);
      if (!revealed?.ok) return revealed;

      const targetId = Number(webContentsId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return { ok: false, error: 'invalid_web_contents_id' };
      }
      const webContents = ports.getWebContents(targetId);
      if (
        !webContents ||
        (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())
      ) {
        return { ok: false, error: 'browser_unavailable' };
      }

      const fieldInfo = await webContents.executeJavaScript(DISCOVER_FIELDS_SCRIPT, true);
      if (!fieldInfo?.ok) {
        return { ok: false, error: fieldInfo?.reason || 'no_password_field' };
      }

      if (fillUsername && fieldInfo.hasUsername && revealed.username) {
        await typeIntoMarked(webContents, 'username', revealed.username);
      }
      await typeIntoMarked(webContents, 'password', revealed.password);
      await webContents.executeJavaScript(CLEANUP_FIELDS_SCRIPT, true);

      return {
        ok: true,
        id: revealed.id,
        origin: revealed.origin,
        filledUsername: Boolean(fillUsername && fieldInfo.hasUsername),
        pageOrigin: fieldInfo.origin,
      };
    } catch (error) {
      return { ok: false, error: error?.message || 'fill_failed' };
    }
  }

  return Object.freeze({ fill });
}
