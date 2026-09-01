import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * L2 ExternalBrowserAdapter（ADR 71 第一刀）。
 * Playwright 只活在 Adapter 内；模型看不到 Playwright / CDP。
 * 本切片只支持 temporary Peer-managed profile，不附着日常浏览器。
 */

export const EXTERNAL_BROWSER_ALLOWED_ACTIONS = Object.freeze([
  'open',
  'close',
  'navigate',
  'click',
  'type',
  'hover',
  'scroll',
  'screenshot',
  'readDom',
]);

export const EXTERNAL_BROWSER_REFUSED_ACTIONS = Object.freeze(['download', 'dialog']);

const SCROLL_ALIGNMENTS = new Set(['start', 'center', 'end', 'nearest']);

export class ExternalBrowserActionError extends Error {
  constructor(code, message, { recoverable = true, details = {} } = {}) {
    super(message);
    this.name = 'ExternalBrowserActionError';
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

export function parseExternalFrameSelector(selector) {
  const framePath = [];
  let rest = selector ?? '';
  const match = rest.match(/^frame:(\d+)(?:\s*)(.*)$/);
  if (match) {
    framePath.push(Number(match[1]));
    rest = match[2];
  }
  return { framePath, css: rest.trim() };
}

function refusedError(action) {
  return new ExternalBrowserActionError(
    `${action}_not_supported`,
    `L2 first slice refuses ${action}. Retry with a whitelist action (navigate/click/type/screenshot/readDom/hover/scroll) or close the session.`,
    { recoverable: true, details: { action, slice: 'temporary-peer-managed' } },
  );
}

async function defaultPlaywrightFactory() {
  const errors = [];
  for (const spec of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(spec);
      const resolved = mod?.chromium ? mod : (mod?.default ?? mod);
      if (resolved?.chromium) return resolved;
    } catch (err) {
      errors.push(`${spec}: ${err?.message ?? err}`);
    }
  }
  throw new ExternalBrowserActionError(
    'playwright_unavailable',
    `Playwright is not available in this Desktop runtime (${errors.join('; ') || 'no chromium export'}).`,
    { recoverable: true },
  );
}

function attachGuards(page, session) {
  if (typeof page?.on !== 'function') return;
  page.on('download', async (download) => {
    session.lastBlocked = { kind: 'download', url: download?.url?.() ?? null };
    try {
      await download.cancel?.();
    } catch {
      // ignore cancel failures; the action path still refuses download.
    }
  });
  page.on('dialog', async (dialog) => {
    session.lastBlocked = { kind: 'dialog', type: dialog?.type?.() ?? 'unknown' };
    try {
      await dialog.dismiss?.();
    } catch {
      // ignore dismiss failures; the action path still refuses dialog.
    }
  });
}

function resolveTarget(page, selector) {
  const { framePath, css } = parseExternalFrameSelector(selector);
  let target = page;
  if (framePath.length > 0) {
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    const frame = frames[framePath[0]];
    if (!frame) {
      throw new ExternalBrowserActionError(
        'frame_not_found',
        `No iframe at index ${framePath[0]}.`,
        { recoverable: true, details: { frameIndex: framePath[0] } },
      );
    }
    target = frame;
  }
  return { target, css };
}

function locatorOf(page, selector) {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    throw new ExternalBrowserActionError('missing_selector', 'A CSS selector is required.', { recoverable: true });
  }
  const { target, css } = resolveTarget(page, selector);
  if (!css) {
    throw new ExternalBrowserActionError('missing_selector', 'A CSS selector is required.', { recoverable: true });
  }
  if (typeof target.locator !== 'function') {
    throw new ExternalBrowserActionError('locator_unavailable', 'Playwright locator() is not available on the target.', { recoverable: true });
  }
  const located = target.locator(css);
  return typeof located.first === 'function' ? located.first() : located;
}

export function createExternalBrowserAdapter({
  playwrightFactory = defaultPlaywrightFactory,
  userDataPath = os.tmpdir(),
  headless = false,
} = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map();

  function sessionOrThrow(conversationId) {
    const session = sessions.get(conversationId);
    if (!session) {
      throw new ExternalBrowserActionError(
        'session_not_open',
        'No temporary Peer-managed Chromium session is open for this conversation. Call browser_external_open first.',
        { recoverable: true },
      );
    }
    return session;
  }

  async function destroySession(conversationId) {
    const session = sessions.get(conversationId);
    if (!session) return { closed: false, conversationId };
    sessions.delete(conversationId);
    try {
      await session.context?.close?.();
    } catch {
      // best-effort close
    }
    try {
      if (session.userDataDir) await rm(session.userDataDir, { recursive: true, force: true });
    } catch {
      // temp profile cleanup is best-effort
    }
    return {
      closed: true,
      conversationId,
      sessionId: session.sessionId,
      profileKind: 'temporary',
    };
  }

  async function open({ conversationId, url } = {}) {
    if (!conversationId) {
      throw new ExternalBrowserActionError('missing_conversation', 'conversationId is required to open an L2 session.', { recoverable: true });
    }
    const existing = sessions.get(conversationId);
    if (existing) {
      if (url) await navigate({ conversationId, url });
      return snapshot(existing);
    }

    const pw = await playwrightFactory();
    const chromium = pw?.chromium;
    if (!chromium?.launchPersistentContext) {
      throw new ExternalBrowserActionError(
        'playwright_unavailable',
        'Playwright chromium.launchPersistentContext is not available.',
        { recoverable: true },
      );
    }

    const userDataDir = await mkdtemp(path.join(userDataPath, 'peer-external-browser-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
    });
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    const page = pages[0] ?? await context.newPage();
    const session = {
      sessionId: randomUUID(),
      conversationId,
      profileKind: 'temporary',
      isolatedFromL1: true,
      userDataDir,
      context,
      page,
      url: typeof page?.url === 'function' ? page.url() : '',
      title: '',
      lastBlocked: null,
    };
    attachGuards(page, session);
    sessions.set(conversationId, session);
    if (url) await navigate({ conversationId, url });
    else await refreshIdentity(session);
    return snapshot(session);
  }

  async function close({ conversationId } = {}) {
    if (!conversationId) {
      throw new ExternalBrowserActionError('missing_conversation', 'conversationId is required to close an L2 session.', { recoverable: true });
    }
    return destroySession(conversationId);
  }

  async function navigate({ conversationId, url }) {
    const session = sessionOrThrow(conversationId);
    const trimmed = String(url ?? '').trim();
    if (!trimmed) {
      throw new ExternalBrowserActionError('missing_url', 'url is required.', { recoverable: true });
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new ExternalBrowserActionError('invalid_url', 'Only http(s) URLs are supported.', { recoverable: true });
    }
    await session.page.goto(trimmed, { waitUntil: 'domcontentloaded' });
    await refreshIdentity(session);
    return snapshot(session);
  }

  async function click({ conversationId, selector }) {
    const session = sessionOrThrow(conversationId);
    const locator = locatorOf(session.page, selector);
    await locator.click();
    return { ...snapshot(session), action: 'click', selector };
  }

  async function type({ conversationId, selector, text, clear = false, submit = false }) {
    const session = sessionOrThrow(conversationId);
    if (typeof text !== 'string' || text.length === 0) {
      throw new ExternalBrowserActionError('missing_text', 'text is required.', { recoverable: true });
    }
    if (selector) {
      const locator = locatorOf(session.page, selector);
      if (clear && typeof locator.fill === 'function') {
        await locator.fill(text);
      } else if (typeof locator.type === 'function') {
        if (clear && typeof locator.fill === 'function') await locator.fill('');
        await locator.click?.();
        await locator.type(text);
      } else if (typeof locator.fill === 'function') {
        await locator.fill(text);
      } else {
        throw new ExternalBrowserActionError('type_unavailable', 'Playwright locator cannot type into the target.', { recoverable: true });
      }
      if (submit) await locator.press?.('Enter');
    } else if (typeof session.page.keyboard?.type === 'function') {
      await session.page.keyboard.type(text);
      if (submit) await session.page.keyboard.press?.('Enter');
    } else {
      throw new ExternalBrowserActionError('missing_selector', 'A CSS selector is required to type.', { recoverable: true });
    }
    return { ...snapshot(session), action: 'type', selector: selector || null };
  }

  async function hover({ conversationId, selector }) {
    const session = sessionOrThrow(conversationId);
    const locator = locatorOf(session.page, selector);
    await locator.hover();
    return { ...snapshot(session), action: 'hover', selector };
  }

  async function scroll({ conversationId, selector, deltaX = 0, deltaY = 0, block } = {}) {
    const session = sessionOrThrow(conversationId);
    const dx = Number(deltaX) || 0;
    const dy = Number(deltaY) || 0;
    const align = typeof block === 'string' ? block : '';
    if (!selector && dx === 0 && dy === 0 && !SCROLL_ALIGNMENTS.has(align)) {
      throw new ExternalBrowserActionError(
        'missing_scroll_target',
        'Provide a selector, deltaX/deltaY, or block alignment.',
        { recoverable: true },
      );
    }
    if (selector && SCROLL_ALIGNMENTS.has(align) && typeof locatorOf(session.page, selector).scrollIntoViewIfNeeded === 'function') {
      await locatorOf(session.page, selector).scrollIntoViewIfNeeded();
    } else if (selector) {
      const locator = locatorOf(session.page, selector);
      if (typeof locator.evaluate === 'function') {
        await locator.evaluate((el, delta) => {
          const node = el.closest?.('*') ?? el;
          if (typeof node.scrollBy === 'function') node.scrollBy(delta.dx, delta.dy);
          else window.scrollBy(delta.dx, delta.dy);
        }, { dx, dy });
      } else {
        await session.page.mouse?.wheel?.(dx, dy);
      }
    } else {
      await session.page.mouse?.wheel?.(dx, dy);
    }
    return { ...snapshot(session), action: 'scroll', selector: selector || null, deltaX: dx, deltaY: dy, block: align || null };
  }

  async function screenshot({ conversationId } = {}) {
    const session = sessionOrThrow(conversationId);
    const pngBuffer = await session.page.screenshot({ type: 'png' });
    return { ...snapshot(session), action: 'screenshot', pngBuffer };
  }

  async function readDom({ conversationId, selector, format = 'text' } = {}) {
    const session = sessionOrThrow(conversationId);
    const kind = format === 'html' ? 'html' : 'text';
    let content = '';
    if (selector) {
      const locator = locatorOf(session.page, selector);
      content = kind === 'html'
        ? await (locator.innerHTML?.() ?? locator.evaluate?.((el) => el.outerHTML))
        : await (locator.innerText?.() ?? locator.textContent?.());
      if (content == null) {
        throw new ExternalBrowserActionError('element_not_found', `No element matched selector: ${selector}`, { recoverable: true });
      }
    } else if (kind === 'html' && typeof session.page.content === 'function') {
      content = await session.page.content();
    } else if (typeof session.page.innerText === 'function') {
      content = await session.page.innerText();
    } else {
      content = await session.page.evaluate?.(() => document.body?.innerText ?? '') ?? '';
    }
    return { ...snapshot(session), action: 'read_dom', format: kind, content: String(content ?? '') };
  }

  async function refreshIdentity(session) {
    const page = session.page;
    session.url = typeof page?.url === 'function' ? page.url() : (session.url ?? '');
    try {
      session.title = typeof page?.title === 'function' ? await page.title() : (session.title ?? '');
    } catch {
      session.title = session.title ?? '';
    }
  }

  function snapshot(session) {
    const page = session.page;
    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      profileKind: session.profileKind,
      isolatedFromL1: true,
      url: typeof page?.url === 'function' ? page.url() : (session.url ?? ''),
      title: session.title ?? '',
      lastBlocked: session.lastBlocked,
    };
  }

  async function execute(action, args = {}) {
    if (EXTERNAL_BROWSER_REFUSED_ACTIONS.includes(action)) {
      throw refusedError(action);
    }
    if (!EXTERNAL_BROWSER_ALLOWED_ACTIONS.includes(action)) {
      throw new ExternalBrowserActionError(
        'action_not_whitelisted',
        `Action "${action}" is not in the L2 first-slice whitelist.`,
        { recoverable: true, details: { action } },
      );
    }
    switch (action) {
      case 'open':
        return open(args);
      case 'close':
        return close(args);
      case 'navigate':
        return navigate(args);
      case 'click':
        return click(args);
      case 'type':
        return type(args);
      case 'hover':
        return hover(args);
      case 'scroll':
        return scroll(args);
      case 'screenshot':
        return screenshot(args);
      case 'readDom':
        return readDom(args);
      default:
        throw refusedError(action);
    }
  }

  return {
    execute,
    open,
    close,
    navigate,
    click,
    type,
    hover,
    scroll,
    screenshot,
    readDom,
    getSession(conversationId) {
      const session = sessions.get(conversationId);
      return session ? snapshot(session) : null;
    },
    async closeAll() {
      const ids = [...sessions.keys()];
      for (const id of ids) await destroySession(id);
    },
  };
}
