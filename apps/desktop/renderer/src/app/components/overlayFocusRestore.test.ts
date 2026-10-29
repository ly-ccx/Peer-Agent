import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createInteractionLayers } from './interactionLayers.ts';
import { focusBoundary } from '../hooks/focusScope.ts';
import { createClosePreparation } from '../state/closePreparation.ts';

test('an overlay releases its focus trap before its layer restores the opener', () => {
  const effects: (() => void | (() => void))[] = [];
  const listeners = new Map<string, Set<(event: { target: Element }) => void>>();
  class Element {
    children: Element[] = [];
    parentElement: Element | null = null;
    isConnected = true;
    tabIndex: number;
    readonly tagName: string;
    constructor(tagName: string, children: unknown[] = []) {
      this.tagName = tagName;
      this.tabIndex = tagName === 'BUTTON' ? 0 : -1;
      this.children = children.flat(Infinity).filter(item => item instanceof Element) as Element[];
      this.children.forEach(item => { item.parentElement = this; });
    }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    closest() { return null; }
    matches() { return false; }
    getClientRects() { return [{}]; }
    querySelector() { return null; }
    focus() {
      document.activeElement = this;
      for (const listener of listeners.get('focusin') ?? []) listener({ target: this });
    }
  }
  const body = new Element('BODY');
  const trigger = new Element('BUTTON'), inside = new Element('BUTTON');
  body.children.push(trigger); trigger.parentElement = body;
  const document = {
    body, activeElement: trigger,
    addEventListener(type: string, listener: (event: { target: Element }) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: { target: Element }) => void) { listeners.get(type)?.delete(listener); },
  };
  const layers = createInteractionLayers();
  const focusable = (node: Element): Element[] => node.children.flatMap(child =>
    [...(child.tabIndex >= 0 ? [child] : []), ...focusable(child)]);
  const react = {
    createContext: () => ({ Provider: 'provider' }), useContext: () => null,
    useRef: (current: unknown) => ({ current }),
    useState: (value: unknown) => [value, () => {}],
    useCallback: (callback: unknown) => callback,
    useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useEffect() {},
  };
  const jsx = (type: string, props: Record<string, any>) => {
    const node = new Element(String(type).toUpperCase(), [props.children]);
    if (props.ref) props.ref.current = node;
    if (props.tabIndex !== undefined) node.tabIndex = props.tabIndex;
    return node;
  };
  const modules: Record<string, any> = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (node: Element) => { body.children.push(node); node.parentElement = body; return node; } },
    './interactionLayers': { interactionLayers: layers },
    '../components/interactionLayers': { interactionLayers: layers, synchronizeModalBoundary() {}, ownsLayerPointer: () => true },
    './focusScope': { collectFocusable: focusable, focusBoundary },
    '../../chat/state/compositionGuard': { isImeKey: () => false },
    '../state/closePreparation': { createClosePreparation },
    '../hooks/useMotionSettled': { useMotionSettled: () => true },
    './anchoredOverlay': {}, './overlayCloseTarget': {}, '../state/visualMotion': {},
  };
  function load(name: string, relative: string) {
    const exports: Record<string, any> = {};
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      exports, document, HTMLElement: Element, Node: Element,
      window: { addEventListener() {}, removeEventListener() {} },
      require(id: string) { if (id in modules) return modules[id]; throw Error('Unexpected dependency: ' + id); },
    });
    modules[name] = exports; return exports;
  }
  load('../hooks/useInteractionLayer', '../hooks/useInteractionLayer.ts');
  load('../hooks/useFocusScope', '../hooks/useFocusScope.ts');
  const { Overlay } = load('Overlay', './Overlay.tsx');
  const overlay = Overlay({ children: inside, onClose() {} }) as Element;
  const cleanups = effects.map(effect => effect());
  assert.equal(document.activeElement, inside);
  assert.ok(layers.modal());
  // React cleans up hooks in declaration order while the old DOM still exists.
  // The layer cleanup returns focus before the focus-scope cleanup removes listeners.
  cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
  if (overlay.contains(document.activeElement)) document.activeElement = body;
  assert.equal(layers.modal(), undefined);
  assert.equal(document.activeElement, trigger, 'the departing trap must not recapture focus from the opener');
});
