import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from '@peer-agent/protocol';
import { directoryFeedbackExcerpt } from './directoryFeedback.ts';
import { feedbackPreparationFailureText } from './browserFeedbackNotice.ts';
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  const slots: any[] = [], calls: any[] = []; let cursor = 0, ids = 0, saved = false, finishDigest: any;
  const hooks = {
    useRef: (initial: any) => { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = value; }]; },
    useMemo: (create: any, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) slots[i] = { value: create(), deps }; return slots[i].value; },
  };
  const port = { recipient: { workspaceId: 'bot', conversationId: 'main' }, prepare: async (row: any) => { calls.push(row); return { ok: saved, code: saved ? undefined : 'DRAFT_SAVE_FAILED' }; } };
  const exports: any = {}, element = (type: any, props: any) => ({ type, props });
  runInNewContext(ts.transpileModule(readFileSync(new URL('./DirectoryFeedbackAction.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, Date, crypto: { randomUUID: () => `id-${++ids}` }, require(id: string) {
      if (id === 'react') return hooks; if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element };
      if (id === '@peer-agent/protocol') return protocol; if (id === '../../ui/icons') return { PeerIcon: 'icon' };
      if (id === './ResourceFeedbackContext') return { useResourceFeedback: () => port };
      if (id === './resourceSelection') return { feedbackDigest: () => new Promise(resolve => { finishDigest = resolve; }) };
      if (id === './directoryFeedback') return { directoryFeedbackExcerpt };
      if (id === './browserFeedbackNotice') return { feedbackPreparationFailureText };
      throw Error(id);
    } });
  const props = { reference: { workspaceId: 'bot', kind: 'directory', path: '/repo' }, entries: [{ name: 'a.md', isDir: false }], selected: '/repo/a.md', incomplete: false, active: true, isZh: false };
  const render = () => { cursor = 0; return exports.DirectoryFeedbackAction(props); };
  return { calls, props, render, digest: () => finishDigest(`sha256:${'a'.repeat(64)}`), save: () => { saved = true; } };
}
test('rapid activation creates one quote; unknown save retry keeps ID and selection without submitting an input', async () => {
  const h = fixture(), tree = h.render(), click = tree.props.children[0].props.onClick;
  click(); click(); assert.equal(h.calls.length, 0); h.digest(); await tick(); assert.equal(h.calls.length, 1);
  const pending = h.calls[0]; assert.equal(pending.recipient.conversationId, 'main'); assert.equal(pending.selection.path, '/repo/a.md');
  h.save(); h.render().props.children[0].props.onClick(); await tick();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].id, pending.id);
  assert.match(h.render().props.children[1].props.children, /draft; not sent/);
});
test('switching directory during digest preserves captured target and does not put its status on the new listing', async () => {
  const h = fixture(); h.render().props.children[0].props.onClick(); h.props.reference = { ...h.props.reference, path: '/other' }; h.props.selected = '/other/new.md'; h.render();
  h.digest(); await tick(); assert.equal(h.calls[0].resource.reference.path, '/repo'); assert.equal(h.calls[0].selection.path, '/repo/a.md');
  assert.equal(h.render().props.children[1], null);
});
