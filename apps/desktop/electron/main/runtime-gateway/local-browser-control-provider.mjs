import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';
import {
  getActiveBrowserEntry,
  waitForActiveBrowserEntry,
} from './browser-control-registry.mjs';
import { createHeadlessBrowserManager } from './browser-control-headless.mjs';

const electronModule = electron;
const { webContents: electronWebContents } = electron;

/**
 * 内嵌浏览器操控 Provider —— 见 ADR 40（local.web.control）。
 *
 * 经正规运行时链路暴露：
 *   Capability Provider(local.web.control.*) → Manifest(capabilities/local.web.control.*.json)
 *     → Tool(browser-tool-definitions.mjs) → Runtime Projection → Tool Call(browser_*)
 *     → PermissionGrant → Evidence
 *
 * 关键设计：Agent 操控的是「用户眼前那个可见的」Workbench 浏览器面板 <webview>。
 * renderer 在 webview `dom-ready` 后把 getWebContentsId() 上报给 main（见
 * browser-control-registry.mjs）；本 provider 用 webContents.fromId(id) 直接拿到
 * 同一个 WebContents 操控（loadURL / executeJavaScript / sendInputEvent / capturePage），
 * 避免逐跳 IPC 往返的脆弱链路。所有操作对用户实时可见。
 *
 * 截图与 DOM 读取属「事实/用户上下文」，体量可能很大且不应整段回灌进模型上下文：
 * Provider 把完整内容落到本地 artifact，仅向模型返回 摘要 + artifactRef，符合
 * evidencePolicy=artifact_ref。
 */

const OPEN_PANEL = 'local.web.control.openPanel';
const NAVIGATE = 'local.web.control.navigate';
const CLICK = 'local.web.control.click';
const TYPE = 'local.web.control.type';
const SCREENSHOT = 'local.web.control.screenshot';
const READ_DOM = 'local.web.control.readDom';
const HOVER = 'local.web.control.hover';
const SCROLL = 'local.web.control.scroll';
const KEY = 'local.web.control.key';
const DRAG = 'local.web.control.drag';

const CONTROL_CAPABILITIES = Object.freeze([OPEN_PANEL, NAVIGATE, CLICK, TYPE, SCREENSHOT, READ_DOM, HOVER, SCROLL, KEY, DRAG]);

const SUMMARY_MAX_CHARS = 2_000;
const MAX_ARTIFACT_CHARS = 2_000_000;
const MAX_IMAGE_PREVIEW_EDGE = 640;
const MAX_IMAGE_PREVIEW_DATA_URL_CHARS = 512 * 1024;
const EXECUTE_JS_TIMEOUT_MS = 8_000;
const MAX_DOM_CHARS = 1_000_000;

/**
 * 给 executeJavaScript 这类可能永不 resolve 的 Promise 加超时门卫，
 * 避免页面脚本死循环 / 断点 / 跨域 iframe 挂起时把工具调用永久卡死。
 * 超时返回 null，调用方据上下文给「超时」语义（而非永久挂起）。
 */
function withTimeout(promise, ms = EXECUTE_JS_TIMEOUT_MS) {
  const timer = new Promise((resolve) => {
    const id = setTimeout(() => resolve(null), ms);
    // 不让 timer 保持事件循环存活
    if (typeof id === 'object' && typeof id.unref === 'function') id.unref();
  });
  return Promise.race([promise, timer]);
}

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function summarize(content, maxChars = SUMMARY_MAX_CHARS) {
  const text = String(content ?? '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeViewportPoint(cssPoint, viewport = {}) {
  const dpr = Number.isFinite(viewport.devicePixelRatio) && viewport.devicePixelRatio > 0
    ? viewport.devicePixelRatio
    : 1;
  const scale = Number.isFinite(viewport.visualViewportScale) && viewport.visualViewportScale > 0
    ? viewport.visualViewportScale
    : 1;
  const scrollX = Number.isFinite(viewport.scrollX) ? viewport.scrollX : 0;
  const scrollY = Number.isFinite(viewport.scrollY) ? viewport.scrollY : 0;
  // 契约：坐标统一用逻辑坐标，不乘 dpr/scale 放大；底层负责物理像素换算。
  const x = Math.round(cssPoint.x ?? 0);
  const y = Math.round(cssPoint.y ?? 0);
  return {
    x,
    y,
    css: { x: Math.round(cssPoint.x ?? 0), y: Math.round(cssPoint.y ?? 0) },
    dpr,
    visualViewportScale: scale,
    scroll: { x: scrollX, y: scrollY },
  };
}

export const ELEMENT_ACTIONABLE_SAMPLE_BODY = `
    if (!el || !el.isConnected) return { ok: false, reason: 'stale', x: 0, y: 0, x0: 0, y0: 0, w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const x0 = Math.round(r.left);
    const y0 = Math.round(r.top);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w <= 0 || h <= 0) return { ok: false, reason: 'not_visible', x, y, x0, y0, w, h };
    const disabled = Boolean(
      el.disabled === true
      || el.getAttribute('aria-disabled') === 'true'
      || el.closest('[disabled], [aria-disabled="true"]')
    );
    if (disabled) return { ok: false, reason: 'disabled', x, y, x0, y0, w, h };
    const hit = (el.ownerDocument || document).elementFromPoint(x, y);
    const occluded = !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    if (occluded) return { ok: false, reason: 'occluded', x, y, x0, y0, w, h };
    return { ok: true, reason: 'actionable', x, y, x0, y0, w, h };
`;

export function describeActionableWaitFailure(reason, zh, action = 'click') {
  const verb = action === 'type'
    ? (zh ? '未输入' : 'did not type')
    : action === 'hover'
      ? (zh ? '未悬停' : 'did not hover')
      : (zh ? '未点击' : 'did not click');
  switch (reason) {
    case 'disabled':
      return zh ? `目标仍被禁用，${verb}。` : `Target stayed disabled; ${verb}.`;
    case 'occluded':
      return zh ? `目标仍被挡住，${verb}。` : `Target stayed covered; ${verb}.`;
    case 'stale':
      return zh ? `目标节点已不在页面上，${verb}。` : `Target node was detached; ${verb}.`;
    case 'not_visible':
      return zh ? `目标仍不可见，${verb}。` : `Target stayed not visible; ${verb}.`;
    default:
      return zh ? `目标仍不可点，${verb}。` : `Target stayed not actionable; ${verb}.`;
  }
}

function failUnlessActionable(waited, { call, permissionGrant, locale, zh, action }) {
  if (waited?.ok) return null;
  return {
    call,
    permissionGrant,
    result: createFailedClientToolResult({
      call,
      locale,
      reason: describeActionableWaitFailure(waited?.reason, zh, action),
      dataLevel: 'D2_sensitive',
      status: 'failed',
    }),
  };
}

async function waitForElementStable(wc, selector, opts = {}) {
  return waitForLocatorElementStable(
    wc,
    (body) => buildElementJs(selector, body),
    opts,
  );
}

function parseRoleNth(value) {
  if (value == null || value === '') return { ok: true, nth: null };
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false, nth: null };
  return { ok: true, nth: n };
}

async function waitForLocatorElementStable(wc, buildJs, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const pollMs = opts.pollMs ?? 120;
  const sampleJs = buildJs(ELEMENT_ACTIONABLE_SAMPLE_BODY);
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  let lastReason = 'not_actionable';
  while (Date.now() < deadline) {
    const sample = await wc.executeJavaScript(sampleJs, true);
    if (!sample || sample.ok !== true) {
      lastReason = sample?.reason || 'stale';
      prev = null;
      await sleep(pollMs);
      continue;
    }
    lastReason = sample.reason || 'actionable';
    if (prev) {
      const stable = prev.x === sample.x && prev.y === sample.y &&
        prev.x0 === sample.x0 && prev.y0 === sample.y0 &&
        prev.w === sample.w && prev.h === sample.h;
      if (stable) return { ok: true, reason: 'actionable', sample };
    }
    prev = sample;
    await sleep(pollMs);
  }
  return { ok: false, reason: lastReason };
}

async function waitForRoleElementStable(wc, role, name, opts = {}) {
  return waitForLocatorElementStable(
    wc,
    (body) => buildRoleResolveJs(role, name, body, { nth: opts.nth }),
    opts,
  );
}

async function waitForTextTestIdElementStable(wc, kind, value, opts = {}) {
  return waitForLocatorElementStable(
    wc,
    (body) => buildTextTestIdResolveJs(kind, value, body, { nth: opts.nth }),
    opts,
  );
}

/**
 * 解析「frame:index 前缀 + CSS selector」。
 *
 * 支持形如 `frame:0 #submit`、`frame:1 .btn`。无前缀时 framePath 为空，表示主文档。
 * 纯函数，产出 { framePath: number[], css: string }，供 buildElementJs 使用。
 *
 * @param {string} selector
 * @returns {{ framePath: number[], css: string }}
 */
export function parseFrameSelector(selector) {
  const framePath = [];
  let rest = selector ?? '';
  const match = rest.match(/^frame:(\d+)(?:\s*)(.*)$/);
  if (match) {
    framePath.push(Number(match[1]));
    rest = match[2];
  }
  return { framePath, css: rest.trim() };
}

/**
 * 在文档（含 open shadowRoot）里按 CSS 查找第一个元素。
 * 注入到 executeJavaScript 字符串里；closed shadow 进不去。
 */
const DEEP_QUERY_HELPER = `function queryDeep(root, css) {
  if (!root || !css) return null;
  try {
    const hit = root.querySelector(css);
    if (hit) return hit;
  } catch {
    return null;
  }
  const walk = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (const node of walk) {
    if (node.shadowRoot) {
      const nested = queryDeep(node.shadowRoot, css);
      if (nested) return nested;
    }
  }
  return null;
}`;

/**
 * 生成「在目标文档（可跨 iframe / open shadowRoot）里 querySelector」的自执行表达式。
 *
 * click/type/readDom/waitForElementStable 各处统一用它来定位元素，
 * 消除裸 document.querySelector 只在主 frame、光 DOM 生效的局限。
 * selector 以 JSON.stringify 转义，frame index 经 parseInt 校验，防止注入。
 *
 * @param {string} selector
 * @returns {string} 一段可交给 executeJavaScript 的 IIFE 字符串，命中元素或 null
 */
export function buildElementJs(selector, body = 'return el;') {
  const { framePath, css } = parseFrameSelector(selector);
  const safeCss = JSON.stringify(css);
  const down = [
    'let doc = document;',
    ...framePath.map((i) => {
      const idx = Number.isInteger(i) ? i : parseInt(i, 10);
      return `doc = doc.defaultView?.frames[${idx}]?.document || null; if (!doc) return null;`;
    }),
  ].join('\n');
  return `(() => { ${DEEP_QUERY_HELPER} ${down} const el = queryDeep(doc, ${safeCss}); if (!el) return null; ${body} })()`;
}

const ROLE_SNAPSHOT_MAX_NODES = 80;
const ROLE_SNAPSHOT_NAME_MAX = 80;
const IMPLICIT_ROLES = Object.freeze({
  A: 'link',
  BUTTON: 'button',
  INPUT: null,
  TEXTAREA: 'textbox',
  SELECT: 'combobox',
  SUMMARY: 'button',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  IMG: 'img',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  ASIDE: 'complementary',
  FORM: 'form',
  TABLE: 'table',
  LI: 'listitem',
  UL: 'list',
  OL: 'list',
  OPTION: 'option',
  LABEL: null,
});
const INPUT_ROLES = Object.freeze({
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  email: 'textbox',
  password: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  text: 'textbox',
  number: 'spinbutton',
});

const ROLE_SNAPSHOT_COLLECTOR = `function compactCss(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id && typeof el.id === 'string' && /^[A-Za-z][\\w:-]*$/.test(el.id)) return '#' + el.id;
  const tag = String(el.tagName || '').toLowerCase();
  const cls = typeof el.className === 'string'
    ? el.className.trim().split(/\\s+/).filter((c) => /^[A-Za-z][\\w:-]*$/.test(c)).slice(0, 2)
    : [];
  const classPart = cls.length ? '.' + cls.join('.') : '';
  const type = el.getAttribute && el.getAttribute('type');
  const typePart = type && /^[A-Za-z0-9_-]+$/.test(type) ? '[type="' + type + '"]' : '';
  const name = el.getAttribute && el.getAttribute('name');
  const namePart = name && /^[A-Za-z][\\w:-]*$/.test(name) ? '[name="' + name + '"]' : '';
  return tag + classPart + typePart + namePart;
}
function accessibleName(el, doc, nameMax) {
  const labelled = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelled) {
    const parts = labelled.split(/\\s+/).map((id) => doc.getElementById(id)?.textContent?.trim()).filter(Boolean);
    if (parts.length) return parts.join(' ').slice(0, nameMax);
  }
  const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'))) || '';
  if (label) return String(label).trim().slice(0, nameMax);
  if (el.labels && el.labels[0] && el.labels[0].textContent) return String(el.labels[0].textContent).trim().slice(0, nameMax);
  const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  return text.slice(0, nameMax);
}
function roleOf(el, implicit, inputRoles) {
  const explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit.trim();
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = ((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
    return inputRoles[type] || 'textbox';
  }
  if (Object.prototype.hasOwnProperty.call(implicit, tag)) return implicit[tag];
  return '';
}
function collectRoles(root, doc, implicit, inputRoles, nameMax, maxNodes) {
  const nodes = [];
  const stack = [];
  if (root && root.nodeType === 1) stack.push(root);
  else if (root && root.firstElementChild) stack.push(root.firstElementChild);
  while (stack.length && nodes.length < maxNodes) {
    const current = stack.shift();
    const role = roleOf(current, implicit, inputRoles);
    if (role) {
      const r = current.getBoundingClientRect();
      const href = current.getAttribute && current.getAttribute('href');
      nodes.push({
        role,
        name: accessibleName(current, doc, nameMax),
        tag: String(current.tagName || '').toLowerCase(),
        selector: compactCss(current),
        disabled: Boolean(current.disabled || (current.getAttribute && current.getAttribute('aria-disabled') === 'true')),
        href: href || undefined,
        headingLevel: /^H[1-6]$/.test(current.tagName) ? Number(current.tagName.slice(1)) : undefined,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    const kids = [];
    if (current.shadowRoot) {
      for (const child of current.shadowRoot.children || []) kids.push(child);
    }
    for (const child of current.children || []) kids.push(child);
    stack.unshift(...kids);
  }
  return { count: nodes.length, truncated: stack.length > 0, nodes };
}`;

const ROLE_FIND_HELPER = `function nameMatches(have, want, nameMax) {
  const actual = String(have || '').trim();
  const expected = String(want || '').trim();
  if (!expected) return true;
  if (actual === expected) return true;
  if (expected.length === nameMax && actual.slice(0, nameMax) === expected) return true;
  return false;
}
function findRoleMatches(root, doc, implicit, inputRoles, nameMax, wantRole, wantName) {
  const matches = [];
  const stack = [];
  const targetRole = String(wantRole || '').trim().toLowerCase();
  if (!targetRole) return matches;
  if (root && root.nodeType === 1) stack.push(root);
  else if (root && root.firstElementChild) stack.push(root.firstElementChild);
  while (stack.length) {
    const current = stack.shift();
    const role = roleOf(current, implicit, inputRoles);
    if (role && String(role).trim().toLowerCase() === targetRole && nameMatches(accessibleName(current, doc, nameMax), wantName, nameMax)) {
      matches.push(current);
    }
    const kids = [];
    if (current.shadowRoot) {
      for (const child of current.shadowRoot.children || []) kids.push(child);
    }
    for (const child of current.children || []) kids.push(child);
    stack.unshift(...kids);
  }
  return matches;
}`;

const TEXT_TESTID_FIND_HELPER = `function visibleTextOf(el) {
  const raw = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  return raw;
}
function findTextTestIdMatches(root, kind, want) {
  const matches = [];
  const stack = [];
  const target = String(want || '').trim();
  if (!target) return matches;
  const mode = String(kind || '').trim();
  if (root && root.nodeType === 1) stack.push(root);
  else if (root && root.firstElementChild) stack.push(root.firstElementChild);
  while (stack.length) {
    const current = stack.shift();
    let hit = false;
    if (mode === 'testid') {
      const attr = current.getAttribute && (current.getAttribute('data-testid') || current.getAttribute('data-test-id') || current.getAttribute('data-test'));
      hit = String(attr || '').trim() === target;
    } else if (mode === 'hasText') {
      hit = visibleTextOf(current) === target;
    }
    if (hit) matches.push(current);
    const kids = [];
    if (current.shadowRoot) {
      for (const child of current.shadowRoot.children || []) kids.push(child);
    }
    for (const child of current.children || []) kids.push(child);
    stack.unshift(...kids);
  }
  return matches;
}`;

export function buildRolesSnapshotJs(selector = '', { maxNodes = ROLE_SNAPSHOT_MAX_NODES } = {}) {
  const limit = Math.max(1, Math.min(200, Math.round(Number(maxNodes) || ROLE_SNAPSHOT_MAX_NODES)));
  const { framePath, css } = parseFrameSelector(selector || '');
  const safeCss = JSON.stringify(css);
  const implicit = JSON.stringify(IMPLICIT_ROLES);
  const inputRoles = JSON.stringify(INPUT_ROLES);
  const down = [
    'let doc = document;',
    ...framePath.map((i) => {
      const idx = Number.isInteger(i) ? i : parseInt(i, 10);
      return `doc = doc.defaultView?.frames[${idx}]?.document || null; if (!doc) return null;`;
    }),
  ].join('\n');
  const scopeLine = css
    ? `const root = queryDeep(doc, ${safeCss}); if (!root) return null;`
    : 'const root = doc.body || doc.documentElement; if (!root) return null;';
  return `(() => {
    ${DEEP_QUERY_HELPER}
    ${down}
    ${scopeLine}
    const IMPLICIT = ${implicit};
    const INPUT_ROLES = ${inputRoles};
    const NAME_MAX = ${ROLE_SNAPSHOT_NAME_MAX};
    const MAX = ${limit};
    ${ROLE_SNAPSHOT_COLLECTOR}
    return collectRoles(root, doc, IMPLICIT, INPUT_ROLES, NAME_MAX, MAX);
  })()`;
}

export function buildRoleResolveJs(role, name = '', body = 'return el;', { nth } = {}) {
  const wantRole = JSON.stringify(String(role || '').trim());
  const wantName = JSON.stringify(String(name || '').trim());
  const implicit = JSON.stringify(IMPLICIT_ROLES);
  const inputRoles = JSON.stringify(INPUT_ROLES);
  const wantNth = Number.isInteger(nth) && nth >= 0 ? nth : null;
  return `(() => {
    let doc = document;
    const root = doc;
    const IMPLICIT = ${implicit};
    const INPUT_ROLES = ${inputRoles};
    const NAME_MAX = ${ROLE_SNAPSHOT_NAME_MAX};
    const wantRole = ${wantRole};
    const wantName = ${wantName};
    const wantNth = ${wantNth == null ? 'null' : String(wantNth)};
    ${ROLE_SNAPSHOT_COLLECTOR}
    ${ROLE_FIND_HELPER}
    const matches = findRoleMatches(root, doc, IMPLICIT, INPUT_ROLES, NAME_MAX, wantRole, wantName);
    if (wantNth == null) {
      if (matches.length !== 1) return { ok: false, count: matches.length };
    } else if (wantNth < 0 || wantNth >= matches.length) {
      return { ok: false, count: matches.length, nth: wantNth };
    }
    const el = wantNth == null ? matches[0] : matches[wantNth];
    ${body}
  })()`;
}

async function resolveRoleTarget(wc, role, name, { zh, nth } = {}) {
  const wantedRole = String(role || '').trim();
  const wantedName = String(name || '').trim();
  const baseLabel = wantedName ? `${wantedRole} "${wantedName}"` : wantedRole;
  const label = nth == null ? baseLabel : `${baseLabel} nth=${nth}`;
  const resolved = await wc.executeJavaScript(
    buildRoleResolveJs(wantedRole, wantedName, 'return { ok: true, count: 1 };', { nth }),
    true,
  );
  if (!resolved?.ok) {
    const count = Number(resolved?.count) || 0;
    const reason = nth != null
      ? (zh
        ? `角色「${baseLabel}」匹配到 ${count} 个元素，nth=${nth} 越界。`
        : `Role "${baseLabel}" matched ${count} elements; nth=${nth} is out of range.`)
      : count > 1
        ? (zh
          ? `角色「${baseLabel}」匹配到 ${count} 个元素，请改用 nth、更具体的 name 或 CSS selector。`
          : `Role "${baseLabel}" matched ${count} elements; use nth, a more specific name, or a CSS selector.`)
        : (zh
          ? `未找到角色「${baseLabel}」。先用 browser_read_dom format=roles 查看可用 role/name。`
          : `No unique element matched role "${baseLabel}". Read format=roles first.`);
    return { ok: false, count, reason, label };
  }
  return { ok: true, label };
}

export function buildTextTestIdResolveJs(kind, value, body = 'return el;', { nth } = {}) {
  const mode = kind === 'testid' ? 'testid' : 'hasText';
  const want = JSON.stringify(String(value || '').trim());
  const wantNth = Number.isInteger(nth) && nth >= 0 ? nth : null;
  return `(() => {
    let doc = document;
    const root = doc;
    const kind = ${JSON.stringify(mode)};
    const want = ${want};
    const wantNth = ${wantNth == null ? 'null' : String(wantNth)};
    ${TEXT_TESTID_FIND_HELPER}
    const matches = findTextTestIdMatches(root, kind, want);
    if (wantNth == null) {
      if (matches.length !== 1) return { ok: false, count: matches.length };
    } else if (wantNth < 0 || wantNth >= matches.length) {
      return { ok: false, count: matches.length, nth: wantNth };
    }
    const el = wantNth == null ? matches[0] : matches[wantNth];
    ${body}
  })()`;
}

async function resolveTextTestIdTarget(wc, kind, value, { zh, nth } = {}) {
  const mode = kind === 'testid' ? 'testid' : 'hasText';
  const wanted = String(value || '').trim();
  const kindLabel = mode === 'testid' ? 'testid' : 'text';
  const baseLabel = `${kindLabel} "${wanted}"`;
  const label = nth == null ? baseLabel : `${baseLabel} nth=${nth}`;
  const resolved = await wc.executeJavaScript(
    buildTextTestIdResolveJs(mode, wanted, 'return { ok: true, count: 1 };', { nth }),
    true,
  );
  if (!resolved?.ok) {
    const count = Number(resolved?.count) || 0;
    const reason = nth != null
      ? (zh
        ? `「${baseLabel}」匹配到 ${count} 个元素，nth=${nth} 越界。`
        : `${baseLabel} matched ${count} elements; nth=${nth} is out of range.`)
      : count > 1
        ? (zh
          ? `「${baseLabel}」匹配到 ${count} 个元素，请改用 nth 或更具体的定位。`
          : `${baseLabel} matched ${count} elements; use nth or a more specific locator.`)
        : (zh
          ? `未找到「${baseLabel}」。`
          : `No unique element matched ${baseLabel}.`);
    return { ok: false, count, reason, label, locatedBy: mode };
  }
  return { ok: true, label, locatedBy: mode };
}

const POINT_LOCATE_BODY = `
              el.scrollIntoView({block:'center',inline:'center'});
              const r = el.getBoundingClientRect();
              const vv = window.visualViewport;
              return { ok: true, count: 1, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), dpr: window.devicePixelRatio || 1, vvScale: vv ? (vv.scale || 1) : 1, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
            `;

async function locatePointByRoleOrText(wc, { role, name, hasText, testid, nth, zh }) {
  if (role) {
    const resolved = await resolveRoleTarget(wc, role, name, { zh, nth });
    if (!resolved.ok) return resolved;
    const located = await wc.executeJavaScript(
      buildRoleResolveJs(role, name, POINT_LOCATE_BODY, { nth }),
      true,
    );
    if (!located?.ok) {
      return { ok: false, reason: zh ? `未找到角色「${resolved.label}」。` : `No unique element matched role "${resolved.label}".`, label: resolved.label };
    }
    return { ok: true, located, locatedBy: 'role', label: resolved.label };
  }
  const kind = testid ? 'testid' : 'hasText';
  const value = testid || hasText;
  const resolved = await resolveTextTestIdTarget(wc, kind, value, { zh, nth });
  if (!resolved.ok) return resolved;
  const located = await wc.executeJavaScript(
    buildTextTestIdResolveJs(kind, value, POINT_LOCATE_BODY, { nth }),
    true,
  );
  if (!located?.ok) {
    return { ok: false, reason: zh ? `未找到「${resolved.label}」。` : `No unique element matched ${resolved.label}.`, label: resolved.label };
  }
  return { ok: true, located, locatedBy: resolved.locatedBy, label: resolved.label };
}

const SCROLL_ALIGNMENTS = new Set(['start', 'center', 'end', 'nearest']);

export function normalizeScrollAlignment(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return SCROLL_ALIGNMENTS.has(trimmed) ? trimmed : '';
}

const NAMED_KEYS = Object.freeze({
  tab: 'Tab',
  enter: 'Return',
  return: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
});

const MODIFIER_ALIASES = Object.freeze({
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
});

export function parseBrowserKeySpec(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const parts = trimmed.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: 'empty' };
  const modifiers = { alt: false, control: false, meta: false, shift: false };
  let keyName = '';
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    const lower = token.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier) {
      if (i === parts.length - 1) return { ok: false, reason: 'modifier_only' };
      modifiers[modifier] = true;
      continue;
    }
    if (i !== parts.length - 1) return { ok: false, reason: 'unknown', token };
    if (NAMED_KEYS[lower]) {
      keyName = NAMED_KEYS[lower];
    } else if (/^[a-z0-9]$/i.test(token)) {
      keyName = token.toUpperCase();
    } else {
      return { ok: false, reason: 'unknown', token };
    }
  }
  if (!keyName) return { ok: false, reason: 'empty' };
  return { ok: true, keyName, modifiers, label: trimmed };
}

export function interpolateDragPath(from, to, steps = 6) {
  const count = Math.max(3, Math.min(8, Math.round(Number(steps) || 6)));
  const path = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    path.push({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    });
  }
  return path;
}

async function locatePointFromSelector(wc, selector) {
  const located = await wc.executeJavaScript(
    buildElementJs(selector, `
      el.scrollIntoView({block:'center',inline:'center'});
      const r = el.getBoundingClientRect();
      const vv = window.visualViewport;
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), dpr: window.devicePixelRatio || 1, vvScale: vv ? (vv.scale || 1) : 1, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
    `),
    true,
  );
  if (!located) return null;
  const normalized = computeViewportPoint(
    { x: located.x, y: located.y },
    { devicePixelRatio: located.dpr, visualViewportScale: located.vvScale, scrollX: located.scrollX, scrollY: located.scrollY },
  );
  await waitForElementStable(wc, selector, { timeoutMs: 1500, pollMs: 120 });
  return { point: { x: normalized.x, y: normalized.y }, viewport: normalized };
}

function dispatchBrowserKey(wc, spec) {
  const { keyName, modifiers } = spec;
  const payload = {
    type: 'keyDown',
    keyCode: keyName,
    modifiers: Object.entries(modifiers).filter(([, on]) => on).map(([name]) => name),
  };
  wc.sendInputEvent(payload);
  if (keyName === 'Return') {
    wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: payload.modifiers });
  } else if (keyName === 'Space') {
    wc.sendInputEvent({ type: 'char', keyCode: ' ', modifiers: payload.modifiers });
  }
  wc.sendInputEvent({ ...payload, type: 'keyUp' });
}

function buildImagePreview(image) {
  if (!image || typeof image.getSize !== 'function' || typeof image.toDataURL !== 'function') return null;
  const sourceSize = image.getSize();
  const sourceWidth = Number.isFinite(sourceSize?.width) ? Math.max(0, Math.floor(sourceSize.width)) : 0;
  const sourceHeight = Number.isFinite(sourceSize?.height) ? Math.max(0, Math.floor(sourceSize.height)) : 0;
  if (sourceWidth === 0 || sourceHeight === 0) return null;
  const scale = Math.min(1, MAX_IMAGE_PREVIEW_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const previewImage = scale < 1 && typeof image.resize === 'function'
    ? image.resize({ width, height, quality: 'good' })
    : image;
  const dataUrl = previewImage.toDataURL();
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) return null;
  if (dataUrl.length > MAX_IMAGE_PREVIEW_DATA_URL_CHARS) return null;
  return { kind: 'image', dataUrl, width, height };
}

/**
 * 浏览器操控 artifact 落盘：截图 PNG / DOM 文本，与 web-artifacts 同构。
 */
function createBrowserArtifactStore({ userDataPath }) {
  const rootPath = path.join(userDataPath, 'browser-artifacts');

  async function writeTextArtifact({ actionId, toolCallId, format, content, metadata = {} }) {
    const dir = path.join(rootPath, dateKey(), actionId);
    await mkdir(dir, { recursive: true });
    const raw = String(content ?? '');
    const truncated = raw.length > MAX_ARTIFACT_CHARS;
    const capped = truncated ? `${raw.slice(0, MAX_ARTIFACT_CHARS)}\n...[artifact truncated]` : raw;
    const ext = format === 'html' ? 'html' : format === 'roles' ? 'json' : 'txt';
    await writeFile(path.join(dir, `content.${ext}`), capped, 'utf8');
    await writeFile(
      path.join(dir, 'metadata.json'),
      `${JSON.stringify({ actionId, toolCallId, contentTruncated: truncated, ...metadata }, null, 2)}\n`,
      'utf8',
    );
    return {
      artifactRef: `local-browser-artifact://${actionId}`,
      artifactRefs: [
        `local-browser-artifact://${actionId}/content`,
        `local-browser-artifact://${actionId}/metadata`,
      ],
      localPath: dir,
      truncated,
    };
  }

  async function writeImageArtifact({ actionId, toolCallId, pngBuffer, metadata = {} }) {
    const dir = path.join(rootPath, dateKey(), actionId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'screenshot.png'), pngBuffer);
    await writeFile(
      path.join(dir, 'metadata.json'),
      `${JSON.stringify({ actionId, toolCallId, bytes: pngBuffer.length, ...metadata }, null, 2)}\n`,
      'utf8',
    );
    return {
      artifactRef: `local-browser-artifact://${actionId}`,
      artifactRefs: [
        `local-browser-artifact://${actionId}/screenshot`,
        `local-browser-artifact://${actionId}/metadata`,
      ],
      localPath: dir,
      screenshotPath: path.join(dir, 'screenshot.png'),
      bytes: pngBuffer.length,
    };
  }

  return { rootPath, writeTextArtifact, writeImageArtifact };
}

function permissionReason(capabilityId, { host, locale }) {
  const zh = locale === 'zh-CN';
  switch (capabilityId) {
    case NAVIGATE:
      return zh ? `请求在内嵌浏览器中打开网页：${host}` : `Requesting to navigate the in-app browser to: ${host}`;
    case CLICK:
      return zh ? `请求在内嵌浏览器（${host}）中点击元素` : `Requesting to click in the in-app browser (${host})`;
    case TYPE:
      return zh ? `请求在内嵌浏览器（${host}）中输入文本` : `Requesting to type in the in-app browser (${host})`;
    case SCREENSHOT:
      return zh ? `请求对内嵌浏览器（${host}）截图` : `Requesting to screenshot the in-app browser (${host})`;
    case READ_DOM:
      return zh ? `请求读取内嵌浏览器（${host}）的页面内容` : `Requesting to read the in-app browser DOM (${host})`;
    case HOVER:
      return zh ? `请求在内嵌浏览器（${host}）中悬停元素` : `Requesting to hover in the in-app browser (${host})`;
    case SCROLL:
      return zh ? `请求滚动内嵌浏览器（${host}）` : `Requesting to scroll the in-app browser (${host})`;
    case KEY:
      return zh ? `请求在内嵌浏览器（${host}）中发送按键` : `Requesting to send keys in the in-app browser (${host})`;
    case DRAG:
      return zh ? `请求在内嵌浏览器（${host}）中拖拽` : `Requesting to drag in the in-app browser (${host})`;
    default:
      return zh ? '请求操控内嵌浏览器' : 'Requesting to control the in-app browser';
  }
}

export function createLocalBrowserControlProvider({
  userDataPath,
  artifactStore = null,
  // 便于测试注入：默认用 electron 的 webContents.fromId(注册的 id)。
  resolveWebContents = (id) => electronWebContents.fromId(id),
  ensureBrowserReady = null,
  browserReadyTimeoutMs = 2_500,
  // 便于测试注入：read_dom 的 executeJavaScript 超时（默认 8s）。
  executeJSTimeoutMs = EXECUTE_JS_TIMEOUT_MS,
  // 后台静默浏览器支持：面板未打开时降级执行的 headless 会话管理器。
  // 传 false 显式禁用（保持旧行为）；默认在 electron 环境可用时惰性创建。
  headlessManager = undefined,
} = {}) {
  const store = artifactStore ?? createBrowserArtifactStore({ userDataPath });
  const executeJsWithTimeout = (p) => withTimeout(p, executeJSTimeoutMs);
  let headless = headlessManager === false ? null : headlessManager ?? null;
  if (!headless && headlessManager !== false) {
    try {
      // 惰性加载：测试环境（无真实 electron BrowserWindow）注入失败则保持 null，
      // resolveTarget 自动退回旧的"必须有可见面板"语义。
      headless = createHeadlessBrowserManager({ electron: electronModule });
    } catch {
      headless = null;
    }
  }

  function resolveRegisteredTarget(conversationId) {
    const entry = getActiveBrowserEntry(conversationId);
    const id = entry?.webContentsId ?? null;
    if (!id) return { ok: false, reason: 'no_active_browser' };
    const wc = resolveWebContents(id);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { ok: false, reason: 'browser_unavailable' };
    }
    return { ok: true, id, wc, entry, conversationId };
  }

  async function resolveTarget(context = {}) {
    const conversationId = context?.toolContext?.conversationId ?? null;
    if (!conversationId) return resolveRegisteredTarget(null);

    // 可见 Browser 工具必须先确保当前 Conversation 的工作现场已展开。BrowserView
    // 为保留网页 Session 会持续 mounted，因此 Registry 有 entry 不代表用户看得见面板。
    // reveal ack 后再解析/等待同会话 WebContents，保持可见语义与控制目标一致。
    //
    // 注意：reveal 是「尽力而为」，失败不阻断——面板未打开时降级到 headless 执行
    // （执行不依赖展示层）。
    await ensureBrowserReady?.({
      conversationId,
      focus: false,
      timeoutMs: browserReadyTimeoutMs,
    }).catch(() => { /* 尽力 reveal：面板不在时由 headless 降级接住 */ });
    const immediate = resolveRegisteredTarget(conversationId);
    if (immediate.ok) return immediate;
    await waitForActiveBrowserEntry(conversationId, { timeoutMs: browserReadyTimeoutMs }).catch(() => null);
    const registered = resolveRegisteredTarget(conversationId);
    if (registered.ok) return registered;

    // 降级路径：会话没有可见浏览器（面板未打开/已关闭），在后台静默创建
    // headless WebContents 继续执行。headless entry 复用 registry，可见面板
    // 之后注册时会自动接管 active 槽位。
    if (headless) {
      const ensured = await headless.ensureHeadlessBrowserEntry(conversationId);
      if (ensured.ok) {
        const wc = resolveWebContents(ensured.webContentsId);
        if (wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
          return {
            ok: true,
            id: ensured.webContentsId,
            wc,
            entry: getActiveBrowserEntry(conversationId),
            conversationId,
            headless: true,
          };
        }
      }
    }
    return registered;
  }

  function failed({ call, locale, reason, status = 'failed', dataLevel = 'D2_sensitive' }) {
    return {
      call,
      result: createFailedClientToolResult({ call, locale, reason, dataLevel, status }),
    };
  }

  async function executeCapability(request, context = {}) {
    const call = request?.call;
    const locale = context.locale ?? 'en-US';
    if (!call || !CONTROL_CAPABILITIES.includes(call.capabilityId)) return null;

    const zh = locale === 'zh-CN';
    const args = call.arguments ?? call.argumentsPreview ?? {};
    const capabilityId = call.capabilityId;

    if (capabilityId === OPEN_PANEL) {
      const conversationId = context?.toolContext?.conversationId ?? null;
      if (!conversationId) {
        return failed({
          call,
          locale,
          reason: zh ? '缺少当前会话，无法打开 Browser 工作现场。' : 'No current conversation is available for the Browser workspace.',
          dataLevel: 'D1_internal',
        });
      }
      if (typeof ensureBrowserReady !== 'function') {
        return failed({
          call,
          locale,
          reason: zh ? 'Browser 工作现场启动服务尚未就绪。' : 'The Browser workspace reveal service is unavailable.',
          dataLevel: 'D1_internal',
        });
      }
      try {
        const reveal = await ensureBrowserReady({
          conversationId,
          focus: args?.focus !== false,
          timeoutMs: browserReadyTimeoutMs,
        });
        const status = reveal?.status ?? 'opened';
        const sessionId = reveal?.sessionId ?? null;
        return {
          call,
          permissionGrant: createPermissionGrant({
            toolCallId: call.toolCallId,
            granted: true,
            scope: { kind: 'browser-panel', conversationId },
          }),
          result: {
            toolCallId: call.toolCallId,
            status: 'success',
            output: JSON.stringify({
              status,
              conversationId,
              sessionId,
              visible: true,
              focused: reveal?.focused !== false,
            }),
            dataLevel: 'D1_internal',
            evidence: {
              summary: `Browser workspace ${status} for conversation ${conversationId}`,
              source: 'local.browser.control',
              observedAt: nowIso(),
            },
          },
        };
      } catch (err) {
        // 尽力而为：面板 reveal 失败（面板未挂载/超时）不再阻断——降级为
        // 「后台模式」成功返回。可见面板不是浏览器工具执行的前置条件。
        // 若 headless 可用则顺手预热，后续 navigate 等操作直接在后台执行。
        let headlessEnsured = null;
        if (headless) {
          headlessEnsured = await headless.ensureHeadlessBrowserEntry(conversationId).catch(() => null);
        }
        return {
          call,
          permissionGrant: createPermissionGrant({
            toolCallId: call.toolCallId,
            granted: true,
            scope: { kind: 'browser-panel', conversationId, ...(headlessEnsured?.ok ? { headless: true } : {}) },
          }),
          result: {
            toolCallId: call.toolCallId,
            status: 'success',
            output: JSON.stringify({
              status: 'background',
              conversationId,
              visible: false,
              focused: false,
              headless: Boolean(headlessEnsured?.ok),
              note: zh
                ? '面板未能展示（可能未挂载），已在后台准备浏览器会话；工具调用将继续在后台执行。'
                : 'Panel could not be shown; a background browser session is prepared. Tool calls will continue headlessly.',
            }),
            dataLevel: 'D1_internal',
            evidence: {
              summary: `Browser workspace reveal failed (${err?.message ?? String(err)}); degraded to headless for conversation ${conversationId}`,
              source: 'local.browser.control',
              observedAt: nowIso(),
            },
          },
        };
      }
    }

    // navigate 必填 url 的早校验。
    if (capabilityId === NAVIGATE) {
      const url = String(args?.url ?? '').trim();
      if (!url) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 url。' : 'Missing required argument: url.' });
      }
      if (!/^https?:\/\//i.test(url)) {
        return failed({
          call,
          locale,
          reason: zh ? '仅支持 http(s) 网址。' : 'Only http(s) URLs are supported.',
        });
      }
    }
    if (capabilityId === TYPE) {
      const text = args?.text;
      if (typeof text !== 'string' || text.length === 0) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 text。' : 'Missing required argument: text.' });
      }
    }
    if (capabilityId === CLICK || capabilityId === HOVER) {
      const hasSelector = typeof args?.selector === 'string' && args.selector.trim().length > 0;
      const hasRole = typeof args?.role === 'string' && args.role.trim().length > 0;
      const hasVisibleText = typeof args?.hasText === 'string' && args.hasText.trim().length > 0;
      const hasTestId = typeof args?.testid === 'string' && args.testid.trim().length > 0;
      const hasPoint = Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y));
      if (!hasSelector && !hasRole && !hasVisibleText && !hasTestId && !hasPoint) {
        return failed({
          call,
          locale,
          reason: zh ? '需要提供 selector、role/name、hasText、testid 或 x/y 坐标之一。' : 'Provide a selector, role/name, hasText, testid, or x/y coordinates.',
        });
      }
    }

    const activeEntry = getActiveBrowserEntry(context?.toolContext?.conversationId ?? null);
    const host = capabilityId === NAVIGATE ? hostOf(String(args?.url ?? '')) : hostOf(activeEntry?.url ?? '');
    // headless 语义标注：active entry 是 hidden 时，授权 scope 与提示语显式携带
    // 「后台执行」信息，保持 PermissionGrant 可审计（A 级铁律：grant 必须反映真实执行语义）。
    const isHiddenTarget = activeEntry?.hidden === true;
    const scope = { kind: 'browser-control', capabilityId, host, ...(isHiddenTarget ? { headless: true } : {}) };

    // 授权：导航类复用联网授权语义；点击/输入/截图/读DOM 在已授权的可见浏览器上执行。
    let permissionGrant = createPermissionGrant({ toolCallId: call.toolCallId, granted: true, scope });
    if (typeof context.requestPermission === 'function') {
      const decision = await context.requestPermission({
        toolCallId: call.toolCallId,
        capabilityId,
        toolName: call.toolName,
        arguments: args,
        scope,
        riskLevel: call.riskLevel ?? (capabilityId === SCREENSHOT || capabilityId === READ_DOM ? 'L2_external_read' : 'L3_external_write'),
        dataLevel: call.dataLevel ?? 'D2_sensitive',
        reason: permissionReason(capabilityId, { host, locale }),
      });
      permissionGrant = createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: decision?.granted !== false,
        scope,
        duration: decision?.duration,
      });
      if (decision?.granted === false) {
        return {
          call,
          permissionGrant,
          result: createFailedClientToolResult({
            call,
            locale,
            reason: zh ? '操控内嵌浏览器未获授权，已拒绝。' : 'Browser control was not authorized; request denied.',
            dataLevel: 'D2_sensitive',
            status: 'denied',
          }),
        };
      }
    }

    // 解析目标 WebContents：优先会话的可见 webview；面板未打开时降级 headless。
    const target = await resolveTarget(context);
    if (!target.ok) {
      const reason =
        target.reason === 'no_active_browser'
          ? zh
            ? '未检测到可用的内嵌浏览器（面板未打开且后台浏览器不可用），请重试或打开「浏览器」面板。'
            : 'No usable in-app browser detected (panel closed and headless fallback unavailable). Retry or open the Browser panel.'
          : zh
            ? '内嵌浏览器已不可用（可能已关闭）。'
            : 'The in-app browser is no longer available (it may have been closed).';
      return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason, dataLevel: 'D2_sensitive', status: 'failed' }) };
    }

    const { wc } = target;
    const targetIdentity = {
      conversationId: target.entry?.conversationId ?? target.conversationId,
      browserTabId: target.entry?.browserTabId ?? null,
      ...(target.headless ? { headless: true } : {}),
    };
    const startedAt = nowIso();

    try {
      let outputPreview;
      let output;
      let evidenceSummary;
      let evidenceArtifactRefs = [];
      let userArtifacts = [];
      let returnedToCloud = true;
      let visualObservations = [];

      if (capabilityId === NAVIGATE) {
        const url = String(args.url).trim();
        await wc.loadURL(url);
        const finalUrl = typeof wc.getURL === 'function' ? wc.getURL() : url;
        const title = typeof wc.getTitle === 'function' ? wc.getTitle() : '';
        outputPreview = { status: 'success', action: 'navigate', requestedUrl: url, finalUrl, title, ...targetIdentity };
        output = { action: 'navigate', finalUrl, title, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器打开「${title || finalUrl}」。`
          : `Navigated the in-app browser to "${title || finalUrl}".`;
      } else if (capabilityId === CLICK) {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const role = typeof args.role === 'string' ? args.role.trim() : '';
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const hasText = typeof args.hasText === 'string' ? args.hasText.trim() : '';
        const testid = typeof args.testid === 'string' ? args.testid.trim() : '';
        const parsedNth = parseRoleNth(args.nth);
        if (!parsedNth.ok) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? 'nth 必须是从 0 起的整数。' : 'nth must be an integer starting at 0.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const nth = parsedNth.nth;
        let point = { x: Number(args.x), y: Number(args.y) };
        let locatedBy = 'point';
        let viewportMeta = {};
        let roleLabel = '';
        if (selector) {
          const located = await wc.executeJavaScript(
            buildElementJs(selector, `
              el.scrollIntoView({block:'center',inline:'center'});
              const r = el.getBoundingClientRect();
              const vv = window.visualViewport;
              return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), dpr: window.devicePixelRatio || 1, vvScale: vv ? (vv.scale || 1) : 1, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
            `),
            true,
          );
          if (!located) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          const normalized = computeViewportPoint(
            { x: located.x, y: located.y },
            { devicePixelRatio: located.dpr, visualViewportScale: located.vvScale, scrollX: located.scrollX, scrollY: located.scrollY },
          );
          point = { x: normalized.x, y: normalized.y };
          locatedBy = 'selector';
          viewportMeta = normalized;
          const waited = await waitForElementStable(wc, selector, { timeoutMs: 1500, pollMs: 120 });
          const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'click' });
          if (blocked) return blocked;
        } else if (role || hasText || testid) {
          const locatedTarget = await locatePointByRoleOrText(wc, { role, name, hasText, testid, nth, zh });
          if (!locatedTarget.ok) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: locatedTarget.reason, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          roleLabel = locatedTarget.label;
          const located = locatedTarget.located;
          const normalized = computeViewportPoint(
            { x: located.x, y: located.y },
            { devicePixelRatio: located.dpr, visualViewportScale: located.vvScale, scrollX: located.scrollX, scrollY: located.scrollY },
          );
          point = { x: normalized.x, y: normalized.y };
          locatedBy = locatedTarget.locatedBy;
          viewportMeta = normalized;
          if (role) {
            const waited = await waitForRoleElementStable(wc, role, name, { timeoutMs: 1500, pollMs: 120, nth });
            const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'click' });
            if (blocked) return blocked;
          } else {
            const waited = await waitForTextTestIdElementStable(wc, testid ? 'testid' : 'hasText', testid || hasText, { timeoutMs: 1500, pollMs: 120, nth });
            const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'click' });
            if (blocked) return blocked;
          }
        }
        wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        outputPreview = { status: 'success', action: 'click', locatedBy, selector: selector || undefined, role: role || undefined, name: name || undefined, hasText: hasText || undefined, testid: testid || undefined, nth: nth ?? undefined, x: point.x, y: point.y, viewport: viewportMeta, ...targetIdentity };
        output = { action: 'click', locatedBy, x: point.x, y: point.y, viewport: viewportMeta, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器点击${selector ? `元素「${selector}」` : roleLabel ? `「${roleLabel}」` : `坐标 (${point.x}, ${point.y})`}。`
          : `Clicked ${selector ? `element "${selector}"` : roleLabel ? `"${roleLabel}"` : `point (${point.x}, ${point.y})`} in the in-app browser.`;
      } else if (capabilityId === HOVER) {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const role = typeof args.role === 'string' ? args.role.trim() : '';
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const hasText = typeof args.hasText === 'string' ? args.hasText.trim() : '';
        const testid = typeof args.testid === 'string' ? args.testid.trim() : '';
        const parsedNth = parseRoleNth(args.nth);
        if (!parsedNth.ok) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? 'nth 必须是从 0 起的整数。' : 'nth must be an integer starting at 0.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const nth = parsedNth.nth;
        let point = { x: Number(args.x), y: Number(args.y) };
        let locatedBy = 'point';
        let viewportMeta = {};
        let roleLabel = '';
        if (selector) {
          const located = await wc.executeJavaScript(
            buildElementJs(selector, `
              el.scrollIntoView({block:'center',inline:'center'});
              const r = el.getBoundingClientRect();
              const vv = window.visualViewport;
              return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), dpr: window.devicePixelRatio || 1, vvScale: vv ? (vv.scale || 1) : 1, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
            `),
            true,
          );
          if (!located) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          const normalized = computeViewportPoint(
            { x: located.x, y: located.y },
            { devicePixelRatio: located.dpr, visualViewportScale: located.vvScale, scrollX: located.scrollX, scrollY: located.scrollY },
          );
          point = { x: normalized.x, y: normalized.y };
          locatedBy = 'selector';
          viewportMeta = normalized;
          const waited = await waitForElementStable(wc, selector, { timeoutMs: 1500, pollMs: 120 });
          const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'hover' });
          if (blocked) return blocked;
        } else if (role || hasText || testid) {
          const locatedTarget = await locatePointByRoleOrText(wc, { role, name, hasText, testid, nth, zh });
          if (!locatedTarget.ok) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: locatedTarget.reason, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          roleLabel = locatedTarget.label;
          const located = locatedTarget.located;
          const normalized = computeViewportPoint(
            { x: located.x, y: located.y },
            { devicePixelRatio: located.dpr, visualViewportScale: located.vvScale, scrollX: located.scrollX, scrollY: located.scrollY },
          );
          point = { x: normalized.x, y: normalized.y };
          locatedBy = locatedTarget.locatedBy;
          viewportMeta = normalized;
          if (role) {
            const waited = await waitForRoleElementStable(wc, role, name, { timeoutMs: 1500, pollMs: 120, nth });
            const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'hover' });
            if (blocked) return blocked;
          } else {
            const waited = await waitForTextTestIdElementStable(wc, testid ? 'testid' : 'hasText', testid || hasText, { timeoutMs: 1500, pollMs: 120, nth });
            const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'hover' });
            if (blocked) return blocked;
          }
        }
        wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        outputPreview = { status: 'success', action: 'hover', locatedBy, selector: selector || undefined, role: role || undefined, name: name || undefined, hasText: hasText || undefined, testid: testid || undefined, nth: nth ?? undefined, x: point.x, y: point.y, viewport: viewportMeta, ...targetIdentity };
        output = { action: 'hover', locatedBy, x: point.x, y: point.y, viewport: viewportMeta, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器悬停${selector ? `元素「${selector}」` : roleLabel ? `「${roleLabel}」` : `坐标 (${point.x}, ${point.y})`}。`
          : `Hovered ${selector ? `element "${selector}"` : roleLabel ? `"${roleLabel}"` : `point (${point.x}, ${point.y})`} in the in-app browser.`;
      } else if (capabilityId === SCROLL) {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const deltaX = Number.isFinite(Number(args.deltaX)) ? Number(args.deltaX) : 0;
        const deltaY = Number.isFinite(Number(args.deltaY)) ? Number(args.deltaY) : 0;
        const block = normalizeScrollAlignment(args.block);
        const inline = normalizeScrollAlignment(args.inline);
        const useIntoView = Boolean(block || inline);
        if (!selector && !useIntoView && deltaX === 0 && deltaY === 0) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? '需要提供 selector、deltaX/deltaY 或 block/inline 之一。' : 'Provide a selector, deltaX/deltaY, or block/inline.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        if (selector) await waitForElementStable(wc, selector, { timeoutMs: 1500, pollMs: 120 });
        const scrollBody = useIntoView
          ? `el.scrollIntoView({block:${JSON.stringify(block || 'nearest')},inline:${JSON.stringify(inline || 'nearest')}});`
          : `const target = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth ? el : (el.closest && el.closest('*') ? (() => { let n = el; while (n && n !== doc && n !== doc.documentElement) { const s = n.ownerDocument.defaultView.getComputedStyle(n); const oy = s.overflowY; const ox = s.overflowX; if ((oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll') && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n; n = n.parentElement; } return doc.scrollingElement || doc.documentElement; })() : el); target.scrollBy(${deltaX}, ${deltaY});`;
        const viewportBody = useIntoView
          ? `const el = doc.scrollingElement || doc.documentElement; el.scrollIntoView({block:${JSON.stringify(block || 'nearest')},inline:${JSON.stringify(inline || 'nearest')}});`
          : `const el = doc.scrollingElement || doc.documentElement; el.scrollBy(${deltaX}, ${deltaY});`;
        const js = selector
          ? buildElementJs(selector, `
              const pickScroller = () => {
                if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) return el;
                let n = el.parentElement;
                while (n && n !== doc && n !== doc.documentElement) {
                  if (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) return n;
                  n = n.parentElement;
                }
                return doc.scrollingElement || doc.documentElement;
              };
              const scroller = pickScroller();
              const before = { x: scroller.scrollLeft, y: scroller.scrollTop };
              ${scrollBody}
              return { before, after: { x: scroller.scrollLeft, y: scroller.scrollTop }, mode: ${JSON.stringify(useIntoView ? 'intoView' : 'delta')} };
            `)
          : `(() => { let doc = document; const el = doc.scrollingElement || doc.documentElement; const before = { x: el.scrollLeft, y: el.scrollTop }; ${viewportBody} const afterEl = doc.scrollingElement || doc.documentElement; return { before, after: { x: afterEl.scrollLeft, y: afterEl.scrollTop }, mode: ${JSON.stringify(useIntoView ? 'intoView' : 'delta')} }; })()`;
        const scrolled = await wc.executeJavaScript(js, true);
        if (selector && !scrolled) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const after = scrolled?.after ?? { x: 0, y: 0 };
        outputPreview = { status: 'success', action: 'scroll', selector: selector || undefined, deltaX, deltaY, block: block || undefined, inline: inline || undefined, mode: scrolled?.mode, after, ...targetIdentity };
        output = { action: 'scroll', selector: selector || undefined, deltaX, deltaY, mode: scrolled?.mode, after, ...targetIdentity };
        evidenceSummary = zh
          ? `已滚动内嵌浏览器${selector ? `元素「${selector}」` : '视口'}${useIntoView ? '（scrollIntoView）' : `（Δx=${deltaX}, Δy=${deltaY}）`}。`
          : `Scrolled ${selector ? `element "${selector}"` : 'the viewport'} in the in-app browser${useIntoView ? ' via scrollIntoView' : ` by Δx=${deltaX}, Δy=${deltaY}`}.`;
      } else if (capabilityId === KEY) {
        const rawKeys = Array.isArray(args.keys) ? args.keys : [];
        if (rawKeys.length === 0) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? '需要提供 keys 数组。' : 'Provide a keys array.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const parsed = [];
        for (const raw of rawKeys) {
          const spec = parseBrowserKeySpec(raw);
          if (!spec.ok) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `不支持的按键：${String(raw)}` : `Unsupported key: ${String(raw)}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          parsed.push(spec);
        }
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        if (selector) {
          await waitForElementStable(wc, selector, { timeoutMs: 1500, pollMs: 120 });
          const focused = await wc.executeJavaScript(
            buildElementJs(selector, 'el.focus(); return true;'),
            true,
          );
          if (!focused) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
        }
        for (const spec of parsed) dispatchBrowserKey(wc, spec);
        const labels = parsed.map((spec) => spec.label);
        outputPreview = { status: 'success', action: 'key', keys: labels, selector: selector || undefined, ...targetIdentity };
        output = { action: 'key', keys: labels, selector: selector || undefined, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器发送按键 ${labels.join(', ')}${selector ? `（先聚焦「${selector}」）` : ''}。`
          : `Sent keys ${labels.join(', ')} in the in-app browser${selector ? ` after focusing "${selector}"` : ''}.`;
      } else if (capabilityId === DRAG) {
        const fromSelector = typeof args.fromSelector === 'string' ? args.fromSelector.trim() : '';
        const toSelector = typeof args.toSelector === 'string' ? args.toSelector.trim() : '';
        let fromPoint = { x: Number(args.fromX), y: Number(args.fromY) };
        let toPoint = { x: Number(args.toX), y: Number(args.toY) };
        let fromLocatedBy = 'point';
        let toLocatedBy = 'point';
        if (fromSelector) {
          const located = await locatePointFromSelector(wc, fromSelector);
          if (!located) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到拖拽起点：${fromSelector}` : `No drag source matched selector: ${fromSelector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          fromPoint = located.point;
          fromLocatedBy = 'selector';
        } else if (!Number.isFinite(fromPoint.x) || !Number.isFinite(fromPoint.y)) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? '需要提供 fromSelector 或 fromX/fromY。' : 'Provide fromSelector or fromX/fromY.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        if (toSelector) {
          const located = await locatePointFromSelector(wc, toSelector);
          if (!located) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到拖拽终点：${toSelector}` : `No drag target matched selector: ${toSelector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          toPoint = located.point;
          toLocatedBy = 'selector';
        } else if (!Number.isFinite(toPoint.x) || !Number.isFinite(toPoint.y)) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? '需要提供 toSelector 或 toX/toY。' : 'Provide toSelector or toX/toY.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const path = interpolateDragPath(fromPoint, toPoint);
        wc.sendInputEvent({ type: 'mouseDown', x: fromPoint.x, y: fromPoint.y, button: 'left', clickCount: 1 });
        for (const step of path.slice(1)) {
          wc.sendInputEvent({ type: 'mouseMove', x: step.x, y: step.y });
        }
        wc.sendInputEvent({ type: 'mouseUp', x: toPoint.x, y: toPoint.y, button: 'left', clickCount: 1 });
        outputPreview = {
          status: 'success',
          action: 'drag',
          from: { ...fromPoint, locatedBy: fromLocatedBy, selector: fromSelector || undefined },
          to: { ...toPoint, locatedBy: toLocatedBy, selector: toSelector || undefined },
          steps: path.length,
          ...targetIdentity,
        };
        output = { action: 'drag', from: fromPoint, to: toPoint, steps: path.length, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器从 (${fromPoint.x}, ${fromPoint.y}) 拖到 (${toPoint.x}, ${toPoint.y})。`
          : `Dragged from (${fromPoint.x}, ${fromPoint.y}) to (${toPoint.x}, ${toPoint.y}) in the in-app browser.`;
      } else if (capabilityId === TYPE) {
        const text = String(args.text);
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const role = typeof args.role === 'string' ? args.role.trim() : '';
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const hasText = typeof args.hasText === 'string' ? args.hasText.trim() : '';
        const testid = typeof args.testid === 'string' ? args.testid.trim() : '';
        const parsedNth = parseRoleNth(args.nth);
        if (!parsedNth.ok) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? 'nth 必须是从 0 起的整数。' : 'nth must be an integer starting at 0.', dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const nth = parsedNth.nth;
        const clear = args.clear === true;
        const submit = args.submit === true;
        let locatedBy = selector ? 'selector' : '';
        let roleLabel = '';
        if (selector) {
          const waited = await waitForElementStable(wc, selector, { timeoutMs: 1500, pollMs: 120 });
          const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'type' });
          if (blocked) return blocked;
          const focused = await wc.executeJavaScript(
            buildElementJs(selector, `el.focus(); if (${clear ? 'true' : 'false'} && 'value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } return true;`),
            true,
          );
          if (!focused) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的输入元素：${selector}` : `No input element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
        } else if (role || hasText || testid) {
          if (role) {
            const resolved = await resolveRoleTarget(wc, role, name, { zh, nth });
            if (!resolved.ok) {
              return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: resolved.reason, dataLevel: 'D2_sensitive', status: 'failed' }) };
            }
            roleLabel = resolved.label;
            locatedBy = 'role';
            const waited = await waitForRoleElementStable(wc, role, name, { timeoutMs: 1500, pollMs: 120, nth });
            const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'type' });
            if (blocked) return blocked;
            const focused = await wc.executeJavaScript(
              buildRoleResolveJs(role, name, `el.focus(); if (${clear ? 'true' : 'false'} && 'value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } return { ok: true, count: 1 };`, { nth }),
              true,
            );
            if (!focused?.ok) {
              return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到角色「${roleLabel}」的输入元素。` : `No unique input matched role "${roleLabel}".`, dataLevel: 'D2_sensitive', status: 'failed' }) };
            }
          } else {
            const kind = testid ? 'testid' : 'hasText';
            const value = testid || hasText;
            const resolved = await resolveTextTestIdTarget(wc, kind, value, { zh, nth });
            if (!resolved.ok) {
              return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: resolved.reason, dataLevel: 'D2_sensitive', status: 'failed' }) };
            }
            roleLabel = resolved.label;
            locatedBy = resolved.locatedBy;
            const waited = await waitForTextTestIdElementStable(wc, kind, value, { timeoutMs: 1500, pollMs: 120, nth });
            const blocked = failUnlessActionable(waited, { call, permissionGrant, locale, zh, action: 'type' });
            if (blocked) return blocked;
            const focused = await wc.executeJavaScript(
              buildTextTestIdResolveJs(kind, value, `el.focus(); if (${clear ? 'true' : 'false'} && 'value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } return { ok: true, count: 1 };`, { nth }),
              true,
            );
            if (!focused?.ok) {
              return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到「${roleLabel}」的输入元素。` : `No unique input matched ${roleLabel}.`, dataLevel: 'D2_sensitive', status: 'failed' }) };
            }
          }
        }
        if (typeof wc.insertText === 'function') {
          await wc.insertText(text);
        } else {
          for (const ch of text) {
            wc.sendInputEvent({ type: 'char', keyCode: ch });
          }
        }
        if (submit) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          wc.sendInputEvent({ type: 'char', keyCode: '\r' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        }
        outputPreview = { status: 'success', action: 'type', locatedBy: locatedBy || undefined, selector: selector || undefined, role: role || undefined, name: name || undefined, hasText: hasText || undefined, testid: testid || undefined, nth: nth ?? undefined, chars: text.length, cleared: clear, submitted: submit, ...targetIdentity };
        output = { action: 'type', locatedBy: locatedBy || undefined, chars: text.length, submitted: submit, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器输入 ${text.length} 个字符${submit ? '并回车提交' : ''}。`
          : `Typed ${text.length} characters into the in-app browser${submit ? ' and submitted' : ''}.`;
        // 输入内容可能含敏感信息，不回灌原文。
        returnedToCloud = false;
      } else if (capabilityId === SCREENSHOT) {
        const image = await wc.capturePage();
        const pngBuffer = image.toPNG();
        const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 };
        const actionId = randomUUID();
        const finalUrl = typeof wc.getURL === 'function' ? wc.getURL() : (activeEntry?.url ?? '');
        const title = typeof wc.getTitle === 'function' ? wc.getTitle() : (activeEntry?.title ?? '');
        const artifact = await store.writeImageArtifact({
          actionId,
          toolCallId: call.toolCallId,
          pngBuffer,
          metadata: { capability: SCREENSHOT, finalUrl, title, width: size.width, height: size.height, ...targetIdentity, startedAt, completedAt: nowIso() },
        });
        evidenceArtifactRefs = artifact.artifactRefs;
        const preview = buildImagePreview(image);
        userArtifacts = [{
          kind: 'image',
          ref: `${artifact.artifactRef}/screenshot`,
          path: artifact.screenshotPath,
          label: '界面截图',
          ...(preview ? { preview } : {}),
        }];
        visualObservations = [{
          kind: 'browser_screenshot',
          mediaType: 'image/png',
          artifactRef: artifact.artifactRef,
          dataUrl: image.toDataURL(),
        }];
        outputPreview = { status: 'success', action: 'screenshot', width: size.width, height: size.height, bytes: artifact.bytes, artifactRef: artifact.artifactRef, artifactRefs: artifact.artifactRefs, ...targetIdentity };
        output = {
          action: 'screenshot',
          width: size.width,
          height: size.height,
          artifactRef: artifact.artifactRef,
          // Provider-neutral observation contract. Keep image bytes out of Tool Result,
          // Evidence, and logs; the model-request seam materializes this governed ref once.
          visualObservation: {
            kind: 'browser_screenshot',
            mediaType: 'image/png',
            artifactRef: artifact.artifactRef,
          },
          ...targetIdentity,
        };
        evidenceSummary = zh
          ? `已对内嵌浏览器截图（${size.width}×${size.height}），图片已落盘（${artifact.artifactRef}）。`
          : `Captured the in-app browser (${size.width}×${size.height}); image stored at ${artifact.artifactRef}.`;
      } else if (capabilityId === READ_DOM) {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const format = args.format === 'html' ? 'html' : args.format === 'roles' ? 'roles' : 'text';
        const actionId = randomUUID();
        const finalUrl = typeof wc.getURL === 'function' ? wc.getURL() : (activeEntry?.url ?? '');
        const title = typeof wc.getTitle === 'function' ? wc.getTitle() : (activeEntry?.title ?? '');
        let fullText = '';
        let roleCount = 0;
        let roleTruncated = false;
        if (format === 'roles') {
          const snapshot = await executeJsWithTimeout(wc.executeJavaScript(buildRolesSnapshotJs(selector), true));
          if (snapshot == null) {
            if (selector) {
              return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
            }
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? '读取 DOM 超时（页面脚本未在限定时间内返回）' : 'DOM read timed out', dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
          roleCount = Number.isFinite(snapshot?.count) ? snapshot.count : nodes.length;
          roleTruncated = Boolean(snapshot?.truncated);
          fullText = JSON.stringify({ count: roleCount, truncated: roleTruncated, nodes }, null, 2);
        } else {
          const prop = format === 'html' ? 'outerHTML' : 'innerText';
          const expr = selector
            ? buildElementJs(selector, `return el.${prop};`)
            : `(() => { const el = document.body; return el ? el.${prop} : ''; })()`;
          const dom = await executeJsWithTimeout(wc.executeJavaScript(expr, true));
          if (dom == null) {
            if (selector) {
              return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
            }
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? '读取 DOM 超时（页面脚本未在限定时间内返回）' : 'DOM read timed out', dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          const rawDom = String(dom ?? '');
          fullText = rawDom.length > MAX_DOM_CHARS ? `${rawDom.slice(0, MAX_DOM_CHARS)}…` : rawDom;
        }
        const artifact = await store.writeTextArtifact({
          actionId,
          toolCallId: call.toolCallId,
          format,
          content: fullText,
          metadata: { capability: READ_DOM, selector: selector || null, format, finalUrl, title, chars: fullText.length, roleCount: format === 'roles' ? roleCount : undefined, ...targetIdentity, startedAt, completedAt: nowIso() },
        });
        evidenceArtifactRefs = artifact.artifactRefs;
        const maxChars = Number.isFinite(Number(args.maxChars)) ? Number(args.maxChars) : SUMMARY_MAX_CHARS;
        const summarySource = format === 'roles'
          ? (JSON.parse(fullText).nodes || []).map((n) => `${n.role}${n.name ? ` "${n.name}"` : ''}${n.selector ? ` ${n.selector}` : ''}`).join('\n') || '(no roles)'
          : fullText;
        const summary = summarize(summarySource, maxChars);
        outputPreview = { status: 'success', action: 'read_dom', format, chars: fullText.length, summary, artifactRef: artifact.artifactRef, artifactRefs: artifact.artifactRefs, truncated: artifact.truncated || roleTruncated, roleCount: format === 'roles' ? roleCount : undefined, ...targetIdentity };
        output = { action: 'read_dom', format, chars: fullText.length, summary, artifactRef: artifact.artifactRef, roleCount: format === 'roles' ? roleCount : undefined, ...targetIdentity };
        evidenceSummary = zh
          ? (format === 'roles'
            ? `已读取内嵌浏览器角色快照（${roleCount} 个节点），内容已落盘（${artifact.artifactRef}）。`
            : `已读取内嵌浏览器页面（${format}，${fullText.length} 字符），内容已落盘（${artifact.artifactRef}）。`)
          : (format === 'roles'
            ? `Read the in-app browser role snapshot (${roleCount} nodes); content stored at ${artifact.artifactRef}.`
            : `Read the in-app browser DOM (${format}, ${fullText.length} chars); content stored at ${artifact.artifactRef}.`);
      }

      const completedAt = nowIso();
      return {
        call,
        permissionGrant,
        result: {
          toolCallId: call.toolCallId,
          status: 'success',
          outputPreview,
          output,
          evidence: {
            toolCallId: call.toolCallId,
            summary: evidenceSummary,
            locale,
            returnedToCloud,
            dataLevel: 'D2_sensitive',
            redactions: [],
            artifactRefs: evidenceArtifactRefs,
            ...(userArtifacts.length > 0 ? { userArtifacts } : {}),
            origin: {
              providerId: 'local.browser.control',
              capabilityId,
              host,
              ...targetIdentity,
            },
          },
          completedAt,
          ...(visualObservations.length > 0
            ? {
                // Ephemeral model context: never serialized into outputPreview/output/Evidence.
                // Runtime Projection may forward it only to the current provider turn.
                modelContext: { visualObservations },
              }
            : {}),
        },
      };
    } catch (err) {
      return {
        call,
        permissionGrant,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: (zh ? '操控内嵌浏览器失败：' : 'Browser control failed: ') + (err?.message ?? String(err)),
          dataLevel: 'D2_sensitive',
          status: 'failed',
        }),
      };
    }
  }

  return {
    providerId: 'local.browser.control',
    capabilityIds: CONTROL_CAPABILITIES,
    executeCapability,
    artifactStore: store,
  };
}
