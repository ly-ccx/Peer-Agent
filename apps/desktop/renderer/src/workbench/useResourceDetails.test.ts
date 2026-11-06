import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as state from './resourceDetailState.ts';

function harness() {
  const slots: any[] = []; let index = 0, reveals = 0, tab = 'documents', owner = 'A', ready = true, visible = true;
  const exports: any = {};
  const react = {
    useRef(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useState(value: any) { const i = index++; if (!(i in slots)) slots[i] = value;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useCallback: (value: any) => value,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useResourceDetails.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: (id: string) => id === 'react' ? react : state });
  function render() { index = 0; return exports.useResourceDetails({ workspaceId: owner, ready, visible, activeTab: tab,
    setTab: (next: string) => { tab = next; }, reveal: () => { reveals++; } }); }
  return { render, setOwner: (id: string) => { owner = id; }, setTab: (id: string) => { tab = id; },
    setReady: (value: boolean) => { ready = value; }, setVisible: (value: boolean) => { visible = value; },
    getTab: () => tab, reveals: () => reveals };
}

test('detail → resource → return keeps one destination and never invents a resource or execution action', () => {
  const h = harness(); let ui = h.render();
  ui.registerDetail({ target: { workspaceId: 'A', kind: 'task', sessionId: 'work' }, title: 'Task' });
  ui = h.render(); ui.showDetails(); ui = h.render(); assert.equal(ui.detailsVisible, true);
  ui.rememberDetailSource(); h.setTab('documents'); ui = h.render();
  assert.equal(ui.returnDetail.sessionId, 'work'); ui.returnToDetail();
  ui = h.render(); assert.equal(h.getTab(), 'details'); ui.returnToResources();
  assert.equal(h.getTab(), 'documents'); assert.equal(h.render().returnDetail.sessionId, 'work');
});

test('switching Bot invalidates old registration and return, including switching back later', () => {
  const h = harness(); let ui = h.render();
  ui.registerDetail({ target: { workspaceId: 'A', kind: 'reply', replyId: 'r' }, title: 'Reply' });
  ui = h.render(); ui.showDetails(); ui = h.render(); ui.rememberDetailSource();
  h.setOwner('B'); h.setTab('launcher'); h.render(); ui = h.render();
  assert.equal(ui.detail, null); assert.equal(ui.returnDetail, null);
  ui.registerDetail({ target: { workspaceId: 'A', kind: 'bot' }, title: 'Late A' }); assert.equal(h.render().detail, null);
  h.setOwner('A'); h.render(); ui = h.render(); assert.equal(ui.returnDetail, null); assert.equal(ui.detail, null);
});

test('unready or hidden presentation cannot reopen another source or capture an invisible origin', () => {
  const h = harness(); h.setReady(false); let ui = h.render(); ui.showDetails(); assert.equal(h.reveals(), 0);
  h.setReady(true); ui = h.render(); ui.registerDetail({ target: { workspaceId: 'A', kind: 'bot' }, title: 'Bot' });
  ui = h.render(); ui.showDetails(); h.setVisible(false); ui = h.render(); assert.equal(ui.detailsVisible, false);
  ui.rememberDetailSource(); h.setTab('documents'); assert.equal(h.render().returnDetail, null);
});

test('returning to Bot settings clears only inspection and restores the retained resource without reopening it', () => {
  const h = harness(); let ui = h.render();
  ui.registerDetail({ target: { workspaceId: 'A', kind: 'reply', replyId: 'r' }, title: 'Reply' });
  ui = h.render(); ui.showDetails(); ui = h.render();
  const count = h.reveals(); ui.clearDetail(); ui = h.render();
  assert.equal(ui.detail, null); assert.equal(ui.returnDetail, null);
  assert.equal(h.getTab(), 'documents'); assert.equal(h.reveals(), count);
});
