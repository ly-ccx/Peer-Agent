const TRUSTED_WINDOW_ROLES = new Set([
  'main',
  'quick-chat',
  'quick-chat-popover',
  'permission-drag-float',
]);
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

export class DesktopIpcAuthorizationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DesktopIpcAuthorizationError';
    this.code = 'ERR_PEER_DESKTOP_IPC_UNAUTHORIZED';
    this.details = Object.freeze({ ...details });
  }
}

function parseLocation(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
}

function locationIdentity(value) {
  const url = value instanceof URL ? value : parseLocation(value, 'location');
  if (url.protocol === 'file:') {
    return Object.freeze({ protocol: 'file:', pathname: decodeURIComponent(url.pathname) });
  }
  return Object.freeze({
    protocol: url.protocol,
    origin: url.origin,
    pathname: url.pathname || '/',
  });
}

function locationsMatch(actual, allowed) {
  if (actual.protocol !== allowed.protocol) return false;
  if (actual.protocol === 'file:') return actual.pathname === allowed.pathname;
  return actual.origin === allowed.origin && actual.pathname === allowed.pathname;
}

function isTopFrame(event) {
  const frame = event?.senderFrame;
  if (!frame) return false;
  const mainFrame = event?.sender?.mainFrame;
  if (mainFrame) return frame === mainFrame;
  if ('parent' in frame) return frame.parent == null;
  return frame.top ? frame === frame.top : false;
}

function senderLocation(event) {
  const frameUrl = event?.senderFrame?.url;
  if (typeof frameUrl === 'string' && frameUrl) return frameUrl;
  const senderUrl = event?.sender?.getURL?.();
  return typeof senderUrl === 'string' ? senderUrl : '';
}

function canOpenExternal(value) {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function createTrustedWindowRegistry({ openExternal = async () => {} } = {}) {
  if (typeof openExternal !== 'function') throw new TypeError('openExternal must be a function');

  const records = new Map();
  const unregisterCallbacks = new Set();
  let disposed = false;

  function openExternalSafely(targetUrl) {
    if (!canOpenExternal(targetUrl)) return;
    Promise.resolve(openExternal(targetUrl)).catch(() => {});
  }

  function registerWindow({ window, role, allowedLocations }) {
    if (disposed) throw new Error('Trusted window registry is disposed');
    if (!TRUSTED_WINDOW_ROLES.has(role)) throw new TypeError(`Unknown trusted window role: ${role}`);
    const sender = window?.webContents;
    if (!sender || typeof sender !== 'object') throw new TypeError('BrowserWindow.webContents is required');
    if (records.has(sender)) throw new Error(`webContents is already registered as ${records.get(sender).role}`);
    if (!Array.isArray(allowedLocations) || allowedLocations.length === 0) {
      throw new TypeError(`allowedLocations are required for ${role}`);
    }

    const identities = Object.freeze(allowedLocations.map((value) => locationIdentity(parseLocation(value, 'allowed location'))));
    const record = Object.freeze({ role, allowedLocations: identities });
    records.set(sender, record);

    const isAllowedLocation = (targetUrl) => {
      try {
        const actual = locationIdentity(parseLocation(targetUrl, 'navigation URL'));
        return identities.some((allowed) => locationsMatch(actual, allowed));
      } catch {
        return false;
      }
    };

    const guardNavigation = (event, targetUrl) => {
      if (isAllowedLocation(targetUrl)) return;
      event?.preventDefault?.();
      openExternalSafely(targetUrl);
    };
    sender.on?.('will-navigate', guardNavigation);
    sender.on?.('will-redirect', guardNavigation);
    sender.setWindowOpenHandler?.(({ url }) => {
      if (!isAllowedLocation(url)) openExternalSafely(url);
      return { action: 'deny' };
    });

    let unregistered = false;
    const unregister = () => {
      if (unregistered) return false;
      unregistered = true;
      unregisterCallbacks.delete(unregister);
      if (records.get(sender) === record) records.delete(sender);
      sender.removeListener?.('will-navigate', guardNavigation);
      sender.removeListener?.('will-redirect', guardNavigation);
      sender.removeListener?.('destroyed', unregister);
      return true;
    };
    unregisterCallbacks.add(unregister);
    sender.once?.('destroyed', unregister);
    return unregister;
  }

  function authorize({ entry, event }) {
    const sender = event?.sender;
    const record = records.get(sender);
    if (!record) {
      throw new DesktopIpcAuthorizationError('IPC sender is not a registered application window', {
        channel: entry?.channel,
      });
    }
    if (!entry?.allowedWindowRoles?.includes(record.role)) {
      throw new DesktopIpcAuthorizationError('IPC channel is not allowed for this window role', {
        channel: entry?.channel,
        role: record.role,
      });
    }
    if (entry.framePolicy === 'top-frame' && !isTopFrame(event)) {
      throw new DesktopIpcAuthorizationError('IPC call did not originate from the trusted top frame', {
        channel: entry.channel,
        role: record.role,
      });
    }
    if (entry.originPolicy === 'app-origin') {
      const actualUrl = senderLocation(event);
      let actual;
      try {
        actual = locationIdentity(parseLocation(actualUrl, 'sender frame URL'));
      } catch {
        actual = null;
      }
      if (!actual || !record.allowedLocations.some((allowed) => locationsMatch(actual, allowed))) {
        throw new DesktopIpcAuthorizationError('IPC call originated from an untrusted location', {
          channel: entry.channel,
          role: record.role,
          url: actualUrl,
        });
      }
    }
    return Object.freeze({ role: record.role });
  }

  function getRole(sender) {
    return records.get(sender)?.role ?? null;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const unregister of [...unregisterCallbacks]) unregister();
    records.clear();
    return true;
  }

  return Object.freeze({ registerWindow, authorize, getRole, dispose });
}
