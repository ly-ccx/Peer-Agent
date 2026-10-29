import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function mountSheet() {
  let now = 1_000, nextTimer = 0, reads = 0, changes = 0, hook = 0;
  let hostItems: any[] = [{ id: 'question', workspaceId: 'w', expiresAt: new Date(2_000).toISOString() }];
  const slots: any[] = [], timers = new Map<number, { callback: () => void; delay: number }>();
  let effects: any[] = [], nextEffects: any[] = [];
  const modules: Record<string, any> = {
    react: {
      useState(initial: any) {
        const index = hook++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useRef(initial: any) { const index = hook++; return slots[index] ??= { current: initial }; },
      useEffect(callback: () => unknown, deps: readonly unknown[]) { nextEffects.push({ callback, deps }); },
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '../clientApi': { clientApi: {
      projectAgentListAttention: async () => { reads++; return { ok: true, items: [...hostItems] }; },
      onProjectAgentChanged: () => () => {}, onProjectAgentConversationChanged: () => () => {},
    } },
    '../app/components/Overlay': {}, '../ui/icons': {}, './conversation/CardView': {}, './styles/bot-attention.css': {},
  };
  const exports: any = {};
  class Clock extends Date { static now() { return now; } }
  const source = readFileSync(new URL('./AttentionSheet.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, Date: Clock,
    setTimeout(callback: () => void, delay: number) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id: number) { timers.delete(id); },
    require(id: string) { if (id in modules) return modules[id]; throw Error('Unexpected import: ' + id); },
  });
  const changed = () => { changes++; };
  const render = () => {
    hook = 0; nextEffects = [];
    exports.AttentionSheet({ workspaceId: 'w', i18n: { t: (key: string) => key }, onClose() {}, onLocate() {}, onChanged: changed });
    nextEffects.forEach((effect, index) => {
      const previous = effects[index];
      if (previous && effect.deps.length === previous.deps.length && effect.deps.every((value: unknown, i: number) => Object.is(value, previous.deps[i]))) {
        effect.cleanup = previous.cleanup;
      } else { previous?.cleanup?.(); effect.cleanup = effect.callback(); }
    });
    effects = nextEffects;
  };
  return {
    render, timers, get reads() { return reads; }, get changes() { return changes; }, get items() { return slots[0]; },
    setHostItems(items: any[]) { hostItems = items; },
    expire() { now = 2_025; const queued = [...timers.values()]; timers.clear(); queued.forEach(timer => timer.callback()); },
    dispose() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

test('an observed deadline requests host facts and keeps the item until those facts arrive', async () => {
  const sheet = mountSheet();
  sheet.render(); await Promise.resolve(); sheet.render();
  assert.equal(sheet.timers.size, 1);
  assert.equal([...sheet.timers.values()][0]!.delay, 1_025);
  sheet.setHostItems([]); sheet.expire();
  assert.equal(sheet.items.length, 1, 'elapsed time cannot resolve the decision locally');
  assert.equal(sheet.changes, 1, 'the parent count also requests a refresh');
  sheet.render();
  assert.equal(sheet.reads, 2);
  assert.equal(sheet.items.length, 1, 'retain the snapshot while the host read is pending');
  await Promise.resolve(); sheet.render();
  assert.equal(sheet.items.length, 0, 'only the returned host facts remove the item');
  assert.equal(sheet.timers.size, 0);
  sheet.dispose();
});

test('clock skew cannot repeatedly poll one unchanged deadline and leaving cancels its timer', async () => {
  const sheet = mountSheet();
  sheet.render(); await Promise.resolve(); sheet.render();
  sheet.expire(); sheet.render(); await Promise.resolve(); sheet.render();
  assert.equal(sheet.reads, 2);
  assert.equal(sheet.items.length, 1, 'an open host decision remains open');
  assert.equal(sheet.timers.size, 0, 'one automatic refresh per observed deadline');
  sheet.dispose();
  const leaving = mountSheet();
  leaving.render(); await Promise.resolve(); leaving.render();
  assert.equal(leaving.timers.size, 1); leaving.dispose();
  assert.equal(leaving.timers.size, 0);
});
