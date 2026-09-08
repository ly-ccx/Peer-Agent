import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as projection from './goalInvestigation.ts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('./GoalInvestigationCards.tsx', import.meta.url), 'utf8');
// Execute the actual component with a minimal hook/timer harness. Not a DOM layout test.
function mount() {
  let value: string | null = null;
  let deps: unknown[] | undefined;
  let cleanup: (() => void) | void;
  let pending: (() => (() => void) | void) | null = null;
  const timers = new Map<number, {fn: () => void; ms: number}>(); let id = 0;
  const hooks = {
    useState: () => [value, (next: string | null) => { value = next; }],
    useEffect: (fn: () => (() => void) | void, next: unknown[]) => {
      if (!deps || next.some((v, i) => v !== deps?.[i])) {
        cleanup?.(); deps = next; pending = fn;
      }
    },
  };
  const exports = {} as { GoalInvestigation: (args: unknown) => {props: Record<string, unknown>} };
  const jsx = (type: unknown, props: unknown, key: unknown) => ({type, props, key});
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  runInNewContext(code, {exports, require: (name: string) => name === 'react' ? hooks : name === 'react/jsx-runtime' ? {jsx,jsxs:jsx} : name.endsWith('.css') ? {} : projection,
    window: {setTimeout(fn: () => void, ms: number) { timers.set(++id, {fn, ms}); return id; }, clearTimeout(id: number) {timers.delete(id);}}});
  return {
    render(status: string, batch = 'b') {
      const plan = {planId:'p',status:'executing',runner:{explorerBatch:{batchId:batch,total:1,done:0},explorers:[{explorerId:batch,batchId:batch,status,request:{question:'Real topic',reason:'reason'}}]}};
      let tree = exports.GoalInvestigation({plan,isZh:true});
      if (pending) {const fn = pending; pending = null; cleanup = fn(); tree = exports.GoalInvestigation({plan,isZh:true});}
      return tree;
    },
    timers,
    tick() {for (const [key, timer] of [...timers]) {timers.delete(key);timer.fn();}},
    unmount() {cleanup?.();},
  };
}
for (const state of ['queued','running','failed','cancelled']) test(`success timer interrupted by ${state}`, () => {
  const h = mount();
  assert.equal(h.render('completed').props['data-hidden'], false);
  assert.equal([...h.timers.values()][0].ms, 1800);
  assert.equal(h.render(state).props['data-hidden'], false);
  assert.equal(h.timers.size, 0);
  h.tick(); assert.equal(h.render(state).props['data-hidden'], false);
});
test('successful batch dismisses; next batch gets independent hold; unmount clears timer', () => {
  const h = mount();h.render('completed');h.tick();
  assert.equal(h.render('completed').props['data-hidden'], true);
  assert.equal(h.render('completed','next').props['data-hidden'], false);
  assert.equal(h.timers.size, 1);h.unmount();assert.equal(h.timers.size, 0);
  const nextSession = mount();assert.equal(nextSession.render('completed').props['data-hidden'], false);
  nextSession.unmount();
});
