import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as browser from '../browserSessionState.ts';
import * as recovery from '../browserRecoveryState.ts';

function harness() {
  const effects: (() => unknown)[] = [], registrations: any[] = [], unregistered: any[] = [], runtime: any[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const refs: any[] = []; let index = 0, navigation = 0;
  const guest = { getURL: () => 'https://example.com/current', getTitle: () => 'Page', getWebContentsId: () => 21,
    canGoBack: () => true, canGoForward: () => false, reload: () => { navigation++; }, loadURL: () => { navigation++; },
    addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name) };
  const modules: Record<string, any> = {
    react: { useRef: (value: any) => refs[index++] ?? (refs[index - 1] = { current: value }), useCallback: (value: any) => value,
      useEffect: (effect: () => unknown) => effects.push(effect) },
    'react/jsx-runtime': { jsx: (type: any, props: any) => ({ type, props }) },
    '../../clientApi': { clientApi: { registerBrowserWebContents: async (value: any) => { registrations.push(value); },
      unregisterBrowserWebContents: async (value: any) => { unregistered.push(value); } } },
    '../ResourceTabStrip': { resourceTabIds: (_: any, id: string) => ({ panel: `panel-${id}`, tab: `tab-${id}` }) },
    '../browserSessionState': browser, '../browserRecoveryState': recovery,
  };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./BrowserPage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id: string) => { if (id in modules) return modules[id]; throw Error(id); } });
  function render(url = 'https://example.com/saved') {
    index = 0; effects.length = 0;
    return exports.BrowserPage({ idPrefix: 'tabs', tab: { id: 'one', url, title: 'Saved', visited: true },
      active: true, conversationId: 'conversation-A', claimForeground: false, onHandleChange() {},
      onMetadataChange() {}, onRuntimeChange: (_: any, patch: any) => runtime.push(patch) });
  }
  const element = render(); element.props.ref.current = guest;
  const cleanup = effects.map(effect => effect()).filter((value): value is () => void => typeof value === 'function');
  return { element, guest, render, listeners, registrations, unregistered, runtime, navigation: () => navigation,
    cleanup: () => cleanup.forEach(fn => fn()), initialRuntime: exports.initialRuntime };
}

test('kept guest metadata updates do not replace its src or registration ownership', () => {
  const h = harness();
  assert.equal(h.element.props.partition, 'persist:peer-browser');
  const updated = h.render('https://example.com/current');
  assert.equal(updated.props.src, 'https://example.com/saved');
  assert.equal(h.navigation(), 0);
  assert.equal(h.registrations[0].conversationId, 'conversation-A');
  assert.equal(h.registrations[0].browserTabId, 'one'); assert.equal(h.registrations[0].claimForeground, false);
  h.cleanup(); assert.equal(h.listeners.size, 0);
});

test('guest crash drops its live handle and reports failure without automatic navigation or replay', () => {
  const h = harness();
  h.listeners.get('render-process-gone')!({ details: { reason: 'oom' } });
  const last = h.runtime.at(-1);
  assert.equal(last.loading, false); assert.equal(last.webContentsId, null); assert.match(last.failure.desc, /memory/);
  assert.equal(h.unregistered[0].conversationId, 'conversation-A'); assert.equal(h.unregistered[0].webContentsId, 21);
  const registrations = h.registrations.length;
  h.listeners.get('did-stop-loading')!({});
  assert.equal(h.registrations.length, registrations, 'a crashed handle must not be registered again');
  assert.equal(h.navigation(), 0); h.cleanup();
});

test('subframe and aborted loads do not masquerade as main-page failures', () => {
  const h = harness(); const count = h.runtime.length;
  h.listeners.get('did-fail-load')!({ isMainFrame: false, errorCode: -105 });
  h.listeners.get('did-fail-load')!({ isMainFrame: true, errorCode: -3 });
  assert.equal(h.runtime.length, count);
  h.listeners.get('did-fail-load')!({ isMainFrame: true, errorCode: -105, errorDescription: 'Name not resolved', validatedURL: 'https://example.com' });
  assert.equal(h.runtime.at(-1).failure.code, -105); assert.equal(h.navigation(), 0); h.cleanup();
});
