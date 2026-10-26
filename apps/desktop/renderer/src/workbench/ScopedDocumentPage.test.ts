import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as fileTypes from './file-preview/fileTypes.ts';

type Node = { type: unknown; props: Record<string, any> };
function find(node: any, predicate: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

function mount(initial = { ok: true, metadataOnly: true, resolvedPath: '/real/guide.md', content: '' }) {
  const calls: { metadata: boolean; path: string }[] = [], enabled = new Map<string, boolean>();
  const refs: any[] = []; let cursor = 0;
  const controllers = new Map<string, any>();
  let nextMetadata: () => Promise<unknown> = async () => initial;
  const api = {
    readFile: async (_: string, _root: unknown, _rel: unknown, reference: { metadataOnly?: boolean; path: string }) => {
      calls.push({ metadata: !!reference.metadataOnly, path: reference.path });
      return reference.metadataOnly ? nextMetadata() : { ok: true, content: 'body', resolvedPath: reference.path };
    },
  };
  const modules: Record<string, unknown> = {
    react: {
      useMemo: (read: () => unknown) => read(), useState: (value: unknown) => [value, () => {}],
      useRef: (value: unknown) => refs[cursor++] ??= { current: value },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) },
    '../clientApi': { clientApi: api },
    '../ui/resources/useResourceState': { useResourceRead: (key: string, read: () => Promise<unknown>, active: boolean) => {
      enabled.set(key, active);
      if (!controllers.has(key)) controllers.set(key, { value: key.startsWith('meta:') ? initial : null, loaded: key.startsWith('meta:'), loading: false });
      const state = controllers.get(key);
      return { ...state, snapshot: () => state, reload: async () => { state.value = await read(); state.loaded = true; return true; } };
    } },
    '../chat/components/markdown/DocumentPreviewContext': { DocumentPreviewContext: { Provider: 'provider' } },
    './file-preview/MarkdownDocument': { MarkdownDocument: 'markdown' }, './file-preview/SourceViewer': { SourceViewer: 'source' },
    './file-preview/DiffViewer': { DiffViewer: 'diff' }, './file-preview/fileTypes': fileTypes,
    './ResourceWorkspaceContext': { useResourceWorkspace: () => ({ openReference() {}, openUrl() {} }) },
    './useDocumentReadingPosition': { useDocumentReadingPosition: () => ({ ref: {}, onScroll() {}, restore() {}, missingLine: false }) },
  };
  const exports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./ScopedDocumentPage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  return {
    calls, enabled,
    nextMetadata(read: () => Promise<unknown>) { nextMetadata = read; },
    render(active = true) {
      cursor = 0;
      const tree = exports.ScopedDocumentPage({ workspaceId: 'bot', active, isZh: false, onModeChange() {}, tab: { id: 'a', absPath: 'guide.md', mode: 'preview' } });
      const refresh = find(tree, node => node.type === 'button' && node.props.children === 'Refresh')!;
      return { tree, refresh: refresh.props.onClick as () => Promise<void>, disabled: refresh.props.disabled };
    },
  };
}

test('refresh confirms the source before reading the exact confirmed target', async () => {
  const h = mount(); const view = h.render();
  let resolve!: (value: unknown) => void;
  h.nextMetadata(() => new Promise(done => { resolve = done; }));
  const pending = view.refresh();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0]?.metadata, true);
  resolve({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md', content: '' }); await pending;
  assert.deepEqual(h.calls[1], { metadata: false, path: '/real/guide.md' });
});

test('denial, changed target, or an inactive tab prevents the old follow-up read', async () => {
  for (const next of [{ ok: false, status: 'permission_denied', content: '' }, { ok: true, metadataOnly: true, resolvedPath: '/other/guide.md', content: '' }]) {
    const h = mount(); const view = h.render(); h.nextMetadata(async () => next); await view.refresh();
    assert.equal(h.calls.length, 1);
  }
  const h = mount(); const view = h.render(); let resolve!: (value: unknown) => void;
  h.nextMetadata(() => new Promise(done => { resolve = done; })); const pending = view.refresh();
  h.render(false); resolve({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md', content: '' }); await pending;
  assert.equal(h.calls.length, 1);
});

test('an old host without confirmed metadata never enables content reads and still permits retry', () => {
  const h = mount({ ok: true, metadataOnly: false, resolvedPath: '/real/guide.md', content: '' });
  const view = h.render();
  assert.equal(view.disabled, false);
  assert.equal([...h.enabled].some(([key, active]) => !key.startsWith('meta:') && active), false);
});
