export const DEFAULT_SHORTCUTS = Object.freeze({
  quickChat: process.platform === 'darwin' ? 'CommandOrControl+Shift+N' : 'Control+Shift+N',
  newTask: 'CommandOrControl+N',
  // Appshots P0a (ADR 59 / spike S3): double-Command is not expressible as an
  // Electron accelerator, so the default is a standard chord.
  appshot: 'CommandOrControl+Shift+A',
});

/** Actions registered via Electron globalShortcut (OS-level). Others are app-local. */
const GLOBAL_ACTIONS = new Set(['quickChat', 'appshot']);

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
export function createShortcutService({ globalShortcut, settingsStore, onQuickChat, onAppshot }) {
  // Per-action callback table (T4). Legacy param onQuickChat maps to quickChat.
  const actionHandlers = {
    quickChat: onQuickChat,
    appshot: onAppshot,
  };
  // Per-action registration state: action -> { active, error }.
  const registration = new Map();

  function regState(action) {
    if (!registration.has(action)) registration.set(action, { active: null, error: null });
    return registration.get(action);
  }

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

  function register(actionOrAccelerator, maybeAccelerator) {
    // Overloads: register() → all global actions with configured accelerators;
    // register(accelerator) → legacy quickChat; register(action, accelerator?) → one action.
    if (actionOrAccelerator === undefined) {
      const results = {};
      for (const action of GLOBAL_ACTIONS) {
        if (typeof actionHandlers[action] !== 'function') continue;
        results[action] = registerAction(action, configuredAccelerator(action));
      }
      // Legacy single-result shape for the primary action, plus per-action map.
      return { ...(results.quickChat ?? { success: true }), actions: results };
    }
    if (typeof actionOrAccelerator === 'string' && isKnownAction(actionOrAccelerator)) {
      const action = actionOrAccelerator;
      return registerAction(action, maybeAccelerator ?? configuredAccelerator(action));
    }
    // Legacy: register('Cmd+X') targets quickChat.
    return registerAction('quickChat', actionOrAccelerator);
  }

  function registerAction(action, accelerator) {
    if (!GLOBAL_ACTIONS.has(action)) return { success: false, accelerator, error: 'not-a-global-action' };
    if (typeof actionHandlers[action] !== 'function') {
      return { success: false, accelerator, error: 'no-handler' };
    }
    const state = regState(action);
    const validation = validateShortcut(accelerator);
    if (!validation.valid) return { success: false, accelerator, error: validation.reason };
    const next = validation.accelerator;
    if (next === state.active && globalShortcut.isRegistered(next)) {
      return { success: true, accelerator: next };
    }
    // Cross-action conflict: refuse to steal another global action's binding.
    for (const [otherAction, otherState] of registration) {
      if (otherAction !== action && otherState.active === next) {
        return { success: false, accelerator: next, error: 'conflict-with-other-action' };
      }
    }
    if (!globalShortcut.register(next, actionHandlers[action])) {
      state.error = 'registration-failed';
      return { success: false, accelerator: next, error: state.error };
    }
    const previous = state.active;
    state.active = next;
    state.error = null;
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
      const result = registerAction(resolvedAction, validation.accelerator);
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
      const state = regState(action);
      return {
        configured,
        active: state.active,
        registered: Boolean(state.active && globalShortcut.isRegistered(state.active)),
        error: state.error,
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
      appshot: actionStatus('appshot'),
    };
  }

  function dispose() {
    for (const [, state] of registration) {
      if (state.active) globalShortcut.unregister(state.active);
      state.active = null;
    }
  }

  return { register, update, reset, status, dispose, configuredAccelerator };
}
