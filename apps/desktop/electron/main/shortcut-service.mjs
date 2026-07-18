export const DEFAULT_SHORTCUTS = Object.freeze({
  quickChat: process.platform === 'darwin' ? 'CommandOrControl+Shift+N' : 'Control+Shift+N',
  newTask: 'CommandOrControl+N',
});

/** Actions registered via Electron globalShortcut (OS-level). Others are app-local. */
const GLOBAL_ACTIONS = new Set(['quickChat']);

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

function isKnownAction(action) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SHORTCUTS, action);
}

/**
 * Owns shortcut configuration for both global and app-local actions.
 * Global actions (quickChat) register via Electron globalShortcut and keep the
 * previous working binding on failure. App-local actions (newTask) only persist
 * configuration for the renderer to bind.
 */
export function createShortcutService({ globalShortcut, settingsStore, onQuickChat }) {
  let activeAccelerator = null;
  let registrationError = null;

  function readShortcuts() {
    const shortcuts = settingsStore.getAll().shortcuts;
    return shortcuts && typeof shortcuts === 'object' ? shortcuts : {};
  }

  function configuredAccelerator(action) {
    const shortcuts = readShortcuts();
    return normalizeShortcut(shortcuts?.[action]) || DEFAULT_SHORTCUTS[action];
  }

  function persist(action, accelerator) {
    settingsStore.merge({
      shortcuts: {
        ...readShortcuts(),
        [action]: accelerator,
      },
    });
  }

  function register(accelerator = configuredAccelerator('quickChat')) {
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

  function update(action, accelerator) {
    const resolvedAction = typeof action === 'string' && isKnownAction(action) ? action : 'quickChat';
    // Backward compat: old callers passed only the accelerator string.
    const resolvedAccelerator = typeof accelerator === 'string'
      ? accelerator
      : (typeof action === 'string' && !isKnownAction(action) ? action : '');

    const validation = validateShortcut(resolvedAccelerator);
    if (!validation.valid) {
      return { success: false, error: validation.reason, ...status() };
    }

    if (GLOBAL_ACTIONS.has(resolvedAction)) {
      const result = register(validation.accelerator);
      if (!result.success) return { success: false, error: result.error, ...status() };
      persist(resolvedAction, result.accelerator);
      return { success: true, error: null, ...status() };
    }

    persist(resolvedAction, validation.accelerator);
    return { success: true, error: null, ...status() };
  }

  function reset(action = 'quickChat') {
    const resolvedAction = isKnownAction(action) ? action : 'quickChat';
    return update(resolvedAction, DEFAULT_SHORTCUTS[resolvedAction]);
  }

  function actionStatus(action) {
    const configured = configuredAccelerator(action);
    if (GLOBAL_ACTIONS.has(action)) {
      return {
        configured,
        active: activeAccelerator,
        registered: Boolean(activeAccelerator && globalShortcut.isRegistered(activeAccelerator)),
        error: registrationError,
        isDefault: configured === DEFAULT_SHORTCUTS[action],
      };
    }
    return {
      configured,
      active: configured,
      registered: true,
      error: null,
      isDefault: configured === DEFAULT_SHORTCUTS[action],
    };
  }

  function status() {
    return {
      quickChat: actionStatus('quickChat'),
      newTask: actionStatus('newTask'),
    };
  }

  function dispose() {
    if (activeAccelerator) globalShortcut.unregister(activeAccelerator);
    activeAccelerator = null;
  }

  return { register, update, reset, status, dispose, configuredAccelerator };
}
