/**
 * 合成长历史的真实渲染组件。
 * react-dom 挂载生产环境的 BotComposer、ConversationRow 和 MarkdownMessage。
 * 不读用户会话，不发消息，不请求模型。结构 DOM 没有像素布局。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { globSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repo = path.resolve(new URL('../../../../../../', import.meta.url).pathname);

class DomEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  inputType?: string;
  target: DomNode | null;
  currentTarget: DomNode | null;
  defaultPrevented: boolean;
  stopped: boolean;
  timeStamp: number;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; inputType?: string } = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.inputType = init.inputType;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.stopped = false;
    this.timeStamp = Date.now();
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

class DomNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  namespaceURI: string | null;
  ownerDocument: DomDocument | null;
  parentNode: DomNode | null;
  childNodes: DomNode[];
  nodeValue: string | null;
  className: string;
  value: string;
  style: { setProperty: () => void; getPropertyValue: () => string };
  listeners: Map<string, Set<(event: DomEvent) => void>>;
  attributes: Map<string, string>;
  selectionStart: number;
  selectionEnd: number;
  disabled: boolean;
  hidden: boolean;
  constructor(nodeType: number, name: string, value: string | null = null) {
    this.nodeType = nodeType;
    this.nodeName = name;
    this.tagName = name.toUpperCase();
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.ownerDocument = null;
    this.parentNode = null;
    this.childNodes = [];
    this.nodeValue = value;
    this.className = '';
    this.value = '';
    this.style = { setProperty() {}, getPropertyValue: () => '' };
    this.listeners = new Map();
    this.attributes = new Map();
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.disabled = false;
    this.hidden = false;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): DomNode | null {
    const kids = this.parentNode?.childNodes ?? [];
    const index = kids.indexOf(this);
    return index >= 0 ? kids[index + 1] ?? null : null;
  }
  get previousSibling(): DomNode | null {
    const kids = this.parentNode?.childNodes ?? [];
    const index = kids.indexOf(this);
    return index > 0 ? kids[index - 1] ?? null : null;
  }
  get textContent() {
    return this.nodeType === 3 || this.nodeType === 8 ? this.nodeValue ?? '' : this.childNodes.map(child => child.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument?.createTextNode(value) ?? new DomNode(3, '#text', value));
  }
  get isConnected() { return Boolean(this.ownerDocument && this.parentNode); }
  appendChild(child: DomNode) { return this.insertBefore(child, null); }
  insertBefore(child: DomNode, before: DomNode | null) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index >= 0) this.childNodes.splice(index, 0, child);
    else this.childNodes.push(child);
    return child;
  }
  removeChild(child: DomNode) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  addEventListener(type: string, fn: (event: DomEvent) => void) {
    const list = this.listeners.get(type) ?? new Set();
    list.add(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: DomEvent) => void) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event: DomEvent) {
    event.target ??= this;
    let node: DomNode | null = this;
    while (node && !event.stopped) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(event.type) ?? [])]) fn.call(node, event);
      node = event.bubbles ? node.parentNode : null;
    }
    return !event.defaultPrevented;
  }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON() { return {}; } }; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  contains(node: DomNode | null) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  closest() { return null; }
  querySelectorAll(selector: string) {
    const out: DomNode[] = [];
    const visit = (node: DomNode) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  matches(selector: string) {
    if (selector === 'textarea') return this.tagName === 'TEXTAREA';
    if (selector.startsWith('[') && selector.endsWith(']')) return this.hasAttribute(selector.slice(1, -1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  getContext() { return null; }
}

class DomDocument extends DomNode {
  documentElement: DomNode;
  body: DomNode;
  head: DomNode;
  activeElement: DomNode | null;
  hidden: boolean;
  visibilityState: string;
  oninput: null = null;
  onchange: null = null;
  defaultView: DomWindow;
  constructor(view: DomWindow) {
    super(9, '#document');
    this.ownerDocument = this;
    this.defaultView = view;
    this.hidden = false;
    this.visibilityState = 'hidden';
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    super.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(name: string) { return this.createElementNS('http://www.w3.org/1999/xhtml', name); }
  createElementNS(namespace: string, name: string) {
    const node = new DomNode(1, name);
    node.namespaceURI = namespace;
    node.ownerDocument = this;
    return node;
  }
  createTextNode(text: string) {
    const node = new DomNode(3, '#text', text);
    node.ownerDocument = this;
    return node;
  }
  createComment(text: string) {
    const node = new DomNode(8, '#comment', text);
    node.ownerDocument = this;
    return node;
  }
  getElementById(id: string) {
    return this.querySelectorAll('[id]').find(node => node.getAttribute('id') === id) ?? null;
  }
  hasFocus() { return false; }
}

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer: FakePort | null = null;
  postMessage(data: unknown) {
    const deliver = this.peer?.onmessage;
    queueMicrotask(() => deliver?.({ data }));
  }
  start() {}
  close() {}
}
class FakeMessageChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

class DomWindow {
  document: DomDocument;
  listeners: Map<string, Set<(event: DomEvent) => void>>;
  HTMLElement = DomNode;
  Element = DomNode;
  Node = DomNode;
  SVGElement = DomNode;
  HTMLIFrameElement = DomNode;
  constructor() {
    this.listeners = new Map();
    const view = new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target) && (prop.endsWith('Element') || prop.endsWith('Node'))) return DomNode;
        return Reflect.get(target, prop, receiver);
      },
    });
    this.document = new DomDocument(view);
    return view;
  }
  addEventListener(type: string, fn: (event: DomEvent) => void) {
    const list = this.listeners.get(type) ?? new Set();
    list.add(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: DomEvent) => void) { this.listeners.get(type)?.delete(fn); }
  getComputedStyle() { return new Proxy({}, { get: () => '' }); }
  matchMedia() { return { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }; }
  requestAnimationFrame(fn: () => void) { return setTimeout(fn, 0); }
  cancelAnimationFrame(id: ReturnType<typeof setTimeout>) { clearTimeout(id); }
  getSelection() { return null; }
}

test('real composer and markdown components keep long-history state local for keystrokes and small chunks', { timeout: 60_000 }, async () => {
  const calls: string[] = [];
  const view = new DomWindow();
  const root = view.document.createElement('div');
  root.setAttribute('id', 'root');
  view.document.body.appendChild(root);
  (view as unknown as { peerAgent: unknown }).peerAgent = new Proxy({}, {
    get: (_target, name) => (..._args: unknown[]) => {
      calls.push(String(name));
      if (name === 'getSettings') return new Promise(() => {});
      return Promise.resolve({ ok: false, code: 'NOT_SENT' });
    },
  });
  const bin = globSync('node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild', { cwd: repo })[0];
  assert.ok(bin, 'esbuild binary');
  const esbuild = createRequire(path.join(repo, 'apps/desktop/package.json'))(path.join(repo, bin, '../../lib/main.js'));
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'peer-long-history-')), 'harness.cjs');
  const contextStub = path.join(repo, 'apps/desktop/renderer/src/workbench/ResourceWorkspaceContext.tsx');
  await esbuild.build({
    absWorkingDir: repo,
    entryPoints: ['apps/desktop/renderer/src/project-agent/state/long-history-render-harness.tsx'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    outfile: out,
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' },
    plugins: [{
      name: 'long-history-stubs',
      setup(build: { onResolve: Function; onLoad: Function }) {
        build.onResolve({ filter: /\?raw$/ }, (args: { path: string }) => ({ path: args.path, namespace: 'raw-empty' }));
        build.onResolve({ filter: /ResourceWorkspaceContext$/ }, () => ({ path: contextStub, namespace: 'workspace-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'raw-empty' }, () => ({ contents: 'export default "";', loader: 'js' }));
        build.onLoad({ filter: /.*/, namespace: 'workspace-stub' }, () => ({
          contents: 'export const useResourceWorkspace = () => null; export function useBotResourceOwner() {}',
          loader: 'js',
        }));
      },
    }],
  });
  const loaded = { exports: {} as { runLongHistoryScenario?: () => Promise<{
    history: number; window: number; domRows: number; historyRendersAtRest: number; historyRendersAfterKeys: number;
    rowScansAfterKeys: number; rowScansAfterChunks: number; keyMs: number; chunkMs: number; draft: string; tail: string;
    closedStable: boolean; writes: number; submits: number;
  }> } };
  const sandbox = {
    window: view, document: view.document, Event: DomEvent, HTMLElement: DomNode, Element: DomNode,
    Node: DomNode, SVGElement: DomNode, HTMLTextAreaElement: DomNode, HTMLInputElement: DomNode,
    console, setTimeout, clearTimeout, queueMicrotask, performance, crypto, Promise, Map, Set, WeakMap, WeakSet,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Symbol, Error, TypeError, RangeError, Proxy, Reflect,
    TextEncoder, TextDecoder, URL, URLSearchParams, MessageChannel: FakeMessageChannel, IS_REACT_ACT_ENVIRONMENT: true,
    module: loaded, exports: loaded.exports, navigator: { userAgent: 'synthetic' },
    getComputedStyle: () => view.getComputedStyle(),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  (sandbox as unknown as { globalThis: typeof sandbox; self: typeof sandbox }).globalThis = sandbox;
  (sandbox as unknown as { self: typeof sandbox }).self = sandbox;
  vm.runInContext(readFileSync(out, 'utf8'), vm.createContext(sandbox), { filename: out });
  const result = await loaded.exports.runLongHistoryScenario?.();
  if (!result) throw new Error('renderer scenario did not return');
  console.info(`long-history renderer history=${result.history} window=${result.window} domRows=${result.domRows} keyRenders=${result.historyRendersAtRest}->${result.historyRendersAfterKeys} scans=${result.rowScansAfterKeys}->${result.rowScansAfterChunks} keyMs=${result.keyMs.toFixed(1)} chunkMs=${result.chunkMs.toFixed(1)} closedStable=${result.closedStable} writes=${result.writes} submits=${result.submits}`);
  assert.equal(result.history, 4000);
  assert.equal(result.window, 80);
  assert.equal(result.domRows, 80);
  assert.equal(result.historyRendersAfterKeys, result.historyRendersAtRest);
  assert.equal(result.rowScansAfterKeys, 1);
  assert.equal(result.draft, '字'.repeat(40));
  assert.ok(result.keyMs < 250, `per-character composer ${result.keyMs.toFixed(1)}ms`);
  assert.equal(result.submits, 0);
  assert.equal(calls.includes('inputPredictionRequest'), false);
  assert.equal(calls.some(name => name.startsWith('llm')), false);
  assert.equal(result.tail.endsWith('一点'), true);
  assert.equal(result.closedStable, true);
  assert.ok(result.rowScansAfterChunks <= 41, `chunk scans ${result.rowScansAfterChunks}`);
  assert.ok(result.chunkMs < 1500, `small chunks ${result.chunkMs.toFixed(1)}ms`);
  assert.ok(result.writes >= 1);
});
