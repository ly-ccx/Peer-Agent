import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const identity = { viewId: 'view', windowId: 'window', generation: 1 };
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function fixture() {
  let receive: any, cleanup: any, unsafe = false;
  let flushDrafts: () => Promise<boolean> = async () => true, flushNavigation: () => Promise<boolean> = async () => true;
  const acknowledgements: any[] = [];
  const store = { start() {}, stop() {}, flush: () => flushNavigation() };
  const registry = { flushAll: () => flushDrafts(), hasUnsafe: () => unsafe };
  const api = { onCheckpointRequest: (callback: any) => { receive = callback; return () => { receive = undefined; }; },
    acknowledgeCheckpoint: async (request: any) => { acknowledgements.push(request); return { ok: true }; } };
  const exports: any = {};
  const source = readFileSync(new URL('./NativeNavigation.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, window: { peerResource: api, addEventListener() {}, removeEventListener() {} },
    require(id: string) {
      if (id === 'react') return { createContext: () => ({ Provider: 'provider' }), useMemo: (make: any) => make(), useEffect: (effect: any) => { cleanup = effect(); } };
      if (id === 'react/jsx-runtime') return { jsx: () => null };
      if (id === './nativeNavigationState') return { createNativeNavigation: () => store };
      if (id === './editing/resourceEditRegistry') return { resourceEditRegistry: () => registry };
      throw Error(id);
    },
  });
  exports.NativeNavigationProvider({ context: identity, children: null });
  return { receive: (value: any = identity) => receive({ requestId: 'checkpoint', identity: value }), acknowledgements,
    dirty: () => { unsafe = true; }, drafts: (next: () => Promise<boolean>) => { flushDrafts = next; },
    navigation: (next: () => Promise<boolean>) => { flushNavigation = next; }, cleanup: () => cleanup() };
}
test('native close confirms only both saved streams and the same actual view', async () => {
  const f = fixture();
  try {
    f.receive({ ...identity, generation: 2 }); await tick(); assert.equal(f.acknowledgements.length, 0);
    f.receive(); await tick(); assert.equal(f.acknowledgements.length, 1);
    assert.equal(f.acknowledgements[0].status, 'confirmed'); assert.equal(f.acknowledgements[0].identity.viewId, identity.viewId);
  } finally { f.cleanup(); }
});
test('save failure or rejected navigation blocks closing instead of withholding a reply until forced close', async () => {
  for (const source of ['drafts', 'navigation'] as const) {
    const f = fixture();
    try {
      f[source](async () => { if (source === 'navigation') throw Error('offline'); return false; });
      f.receive(); await tick(); assert.equal(f.acknowledgements.length, 1); assert.equal(f.acknowledgements[0].status, 'blocked');
    } finally { f.cleanup(); }
  }
});
test('input arriving while another stream is flushing invalidates a successful earlier draft flush', async () => {
  const f = fixture(); let finish!: (saved: boolean) => void;
  try {
    f.navigation(() => new Promise(resolve => { finish = resolve; })); f.receive(); await tick(); f.dirty(); finish(true); await tick();
    assert.equal(f.acknowledgements.length, 1); assert.equal(f.acknowledgements[0].status, 'blocked');
  } finally { f.cleanup(); }
});
