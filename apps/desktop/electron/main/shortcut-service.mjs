export const DEFAULT_SHORTCUTS = Object.freeze({
  quickChat: process.platform === 'darwin' ? 'CommandOrControl+Shift+N' : 'Control+Shift+N',
});

const RESERVED_SHORTCUTS = new Set(
  process.platform === 'darwin'
    ? ['Command+Space', 'Command+Tab', 'Command+Option+Escape']
    : ['Alt+Tab', 'Control+Alt+Delete', 'Meta+L'],
);

export function normalizeShortcut(value) {
  if (typeof value !== 'string') return '';
  return value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('+');
}

export function validateShortcut(value) {
  const accelerator = normalizeShortcut(value);
  if (!accelerator) return { valid: false, reason: 'empty' };
  const parts = accelerator.split('+');
  const modifiers = new Set(['Command', 'Cmd', 'CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'Super', 'Meta']);
  const keys = parts.filter((part) => !modifiers.has(part));
  if (keys.length !== 1 || parts.length < 2) return { valid: false, reason: 'modifier-required' };
  if (RESERVED_SHORTCUTS.has(accelerator)) return { valid: false, reason: 'system-reserved' };
  return { valid: true, accelerator };
}

/** Owns global registration and keeps the previous working binding on failure. */
export function createShortcutService({ globalShortcut, settingsStore, onQuickChat }) {
  let activeAccelerator = null;
  let registrationError = null;

  function configuredAccelerator() {
    const shortcuts = settingsStore.getAll().shortcuts;
    return normalizeShortcut(shortcuts?.quickChat) || DEFAULT_SHORTCUTS.quickChat;
  }

  function register(accelerator = configuredAccelerator()) {
    const validation = validateShortcut(accelerator);
    if (!validation.valid) return { success: false, accelerator, error: validation.reason };
    const next = validation.accelerator;
    if (next === activeAccelerator && globalShortcut.isRegistered(next)) {
      return { success: true, accelerator: next };
    }
    if (!globalShortcut.register(next, onQuickChat)) {
      registrationError = 'registration-failed';
      return { success: false, accelerator: next, error: registrationError };
    }
    const previous = activeAccelerator;
    activeAccelerator = next;
    registrationError = null;
    if (previous && previous !== next) globalShortcut.unregister(previous);
    return { success: true, accelerator: next };
  }

  function update(accelerator) {
    const result = register(accelerator);
    if (!result.success) return result;
    settingsStore.merge({ shortcuts: { quickChat: result.accelerator } });
    return status();
  }

  function reset() {
    return update(DEFAULT_SHORTCUTS.quickChat);
  }

  function status() {
    const configured = configuredAccelerator();
    return {
      quickChat: {
        configured,
        active: activeAccelerator,
        registered: Boolean(activeAccelerator && globalShortcut.isRegistered(activeAccelerator)),
        error: registrationError,
        isDefault: configured === DEFAULT_SHORTCUTS.quickChat,
      },
    };
  }

  function dispose() {
    if (activeAccelerator) globalShortcut.unregister(activeAccelerator);
    activeAccelerator = null;
  }

  return { register, update, reset, status, dispose };
}
