function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

const FLOAT_RETRY_DELAYS_MS = Object.freeze([250, 500, 900, 1500, 2400]);

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

export function createBrowserFdaDragApplicationService(options = {}) {
  const ports = {
    getPlatform: assertFunction(options.getPlatform, 'getPlatform'),
    openSettings: assertFunction(options.openSettings, 'openSettings'),
    showFloat: assertFunction(options.showFloat, 'showFloat'),
    hideFloat: assertFunction(options.hideFloat, 'hideFloat'),
    setDragging: assertFunction(options.setDragging, 'setDragging'),
    schedule: assertFunction(options.schedule, 'schedule'),
    resolveDragTarget: assertFunction(options.resolveDragTarget, 'resolveDragTarget'),
    pathExists: assertFunction(options.pathExists, 'pathExists'),
    getCachedDragIcon: assertFunction(options.getCachedDragIcon, 'getCachedDragIcon'),
    startDrag: assertFunction(options.startDrag, 'startDrag'),
    resolveDragIconDataUrl: assertFunction(
      options.resolveDragIconDataUrl,
      'resolveDragIconDataUrl',
    ),
    warn: assertFunction(options.warn, 'warn'),
  };
  const pathSeparator =
    typeof options.pathSeparator === 'string' && options.pathSeparator
      ? options.pathSeparator
      : '/';

  function showDragFloat(payload = {}) {
    try {
      const shown = ports.showFloat({ isZh: payload?.isZh });
      try {
        if (shown?.ok && shown.appPath) ports.getCachedDragIcon(shown.appPath);
      } catch {
        // Icon prewarming is an optimization and must not replace the float result.
      }
      return shown;
    } catch (error) {
      ports.warn('[fda-drag-float] show failed:', errorMessage(error, 'float_show_failed'));
      return { ok: false, error: errorMessage(error, 'float_show_failed') };
    }
  }

  async function openFullDiskAccessSettings(payload = {}) {
    try {
      if (ports.getPlatform() !== 'darwin') {
        return { ok: false, error: 'unsupported_platform' };
      }
      const opened = await ports.openSettings();
      const dragFloat = showDragFloat(payload);
      for (const delay of FLOAT_RETRY_DELAYS_MS) {
        ports.schedule(() => {
          try {
            showDragFloat(payload);
          } catch {
            // Delayed float placement is best-effort.
          }
        }, delay);
      }
      return { ...opened, dragFloat };
    } catch (error) {
      return { ok: false, error: errorMessage(error, 'open_settings_failed') };
    }
  }

  async function hideDragFloat() {
    try {
      ports.hideFloat();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error, 'hide_float_failed') };
    }
  }

  function hideDragFloatSync() {
    try {
      ports.hideFloat();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error, 'hide_float_failed') };
    }
  }

  function setDragFloatDragging(payload = {}) {
    try {
      ports.setDragging(Boolean(payload?.dragging));
    } catch {
      // The transient float may already be gone; renderer drag must continue.
    }
  }

  function normalizeAppBundlePath(filePath) {
    const marker = `${pathSeparator}Contents${pathSeparator}MacOS${pathSeparator}`;
    const markerIndex = filePath.lastIndexOf(marker);
    return markerIndex > 0 ? filePath.slice(0, markerIndex) : filePath;
  }

  // This method is intentionally synchronous: preload calls it through sendSync during dragstart.
  function startAppDrag(payload = {}, sender) {
    try {
      if (ports.getPlatform() !== 'darwin') {
        return { ok: false, error: 'unsupported_platform' };
      }
      const requestedPath = typeof payload?.appPath === 'string' ? payload.appPath.trim() : '';
      const resolved = ports.resolveDragTarget();
      let filePath = requestedPath || (resolved?.ok ? resolved.appPath : '');
      if (!filePath) return { ok: false, error: 'app_path_missing' };

      filePath = normalizeAppBundlePath(filePath);
      if (!ports.pathExists(filePath)) {
        return { ok: false, error: 'app_path_not_found' };
      }

      const dragIcon = ports.getCachedDragIcon(filePath);
      ports.startDrag({ sender, filePath, dragIcon });
      return { ok: true, filePath };
    } catch (error) {
      ports.warn('[session-import] start-app-drag failed:', errorMessage(error, 'start_drag_failed'));
      return { ok: false, error: errorMessage(error, 'start_drag_failed') };
    }
  }

  async function getAppDragTarget() {
    try {
      const resolved = ports.resolveDragTarget();
      if (!resolved?.ok) return resolved;
      const iconDataUrl = await ports.resolveDragIconDataUrl(resolved.appPath);
      return { ...resolved, iconDataUrl };
    } catch (error) {
      return { ok: false, error: errorMessage(error, 'get_app_drag_target_failed') };
    }
  }

  return Object.freeze({
    openFullDiskAccessSettings,
    hideDragFloat,
    hideDragFloatSync,
    setDragFloatDragging,
    startAppDrag,
    getAppDragTarget,
  });
}
