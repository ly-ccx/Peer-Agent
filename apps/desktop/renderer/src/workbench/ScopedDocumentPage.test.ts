import * as documentErrors from './documentReadError.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as adapterState from './file-preview/documentAdapterState.ts';
import * as fileTypes from './file-preview/fileTypes.ts';
import * as revisionState from './documentRevisionState.ts';

function moduleFrom(file: string, modules: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  return exports;
}

function reader() {
  const calls: any[] = [];
  let metadata = async () => ({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md', content: '' });
  const api = {
    readFile: async (_: string, _root: unknown, _rel: unknown, reference: any) => {
      calls.push(reference); return reference.metadataOnly ? metadata() : { ok: true, status: 'ok', content: 'body', revision: reference.revision };
    },
    readImageDataUrl: async (_: string, _root: unknown, _rel: unknown, reference: any) => { calls.push(reference); return { ok: true, status: 'ok', dataUrl: 'data:image/png;base64,AA==' }; },
  };
  const exports = moduleFrom('./useObservedDocument.ts', { react: {}, '../clientApi': { clientApi: api },
    './file-preview/fileTypes': fileTypes, './documentObservationState': {}, './documentRevisionState': revisionState });
  return { calls, metadata(read: () => Promise<any>) { metadata = read; }, read: exports.readObservedDocument };
}

test('observed content resolves metadata first, reads exact bytes second, and carries the conditional receipt', async () => {
  const h = reader(); let resolve!: (value: unknown) => void;
  h.metadata(() => new Promise(done => { resolve = done; }));
  const expected = { resourceId: 'bound-resource', contentVersion: 'bound-version' };
  const pending = h.read({ workspaceId: 'bot', path: 'guide.md' }, expected);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].metadataOnly, true);
  resolve({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md', content: '' }); await pending;
  assert.equal(h.calls[1].path, '/real/guide.md'); assert.equal(h.calls[1].expectedObservation, expected);
});

test('denial, changed resource or unavailable metadata never starts a follow-up byte read', async () => {
  for (const next of [{ ok: false, status: 'permission_denied' },
    { ok: true, metadataOnly: false, resolvedPath: '/real/guide.md' },
    { ok: true, metadataOnly: true, resolvedPath: '/other/guide.md', identity: { resourceId: 'other' } }]) {
    const h = reader(); h.metadata(async () => next);
    const result = await h.read({ workspaceId: 'bot', path: 'guide.md' }, { resourceId: 'bound' });
    assert.equal(result.ok, false); assert.equal(h.calls.length, 1);
  }
  const image = reader(); image.metadata(async () => ({ ok: true, metadataOnly: true, resolvedPath: '/real/photo.png' }));
  const value = await image.read({ workspaceId: 'bot', path: 'photo.png' });
  assert.equal(value.media, 'image'); assert.equal(image.calls[1].path, '/real/photo.png');
});

function find(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

test('a changed version keeps the accepted body and limits adoption feedback to this document', () => {
  let adopts = 0;
  let reading: any = { value: { ok: true, content: 'accepted old body', media: 'text', resolvedPath: '/real/guide.md' },
    failure: { ok: false, status: 'version_changed' }, loading: false, loadCurrent() { adopts++; } };
  const modules: Record<string, unknown> = {
    './documentReadError': documentErrors,
    './editing/EditDraftButton': { EditDraftButton: 'edit-draft-button' },
    './feedback/ResourceSelectionFeedback': { ResourceSelectionFeedback: 'resource-selection-feedback' },
    './OpenResourceWindowButton': { OpenResourceWindowButton: 'open-native-window' },
    react: { useMemo: (read: () => unknown) => read(), useCallback: (read: unknown) => read, useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }) },
    'react/jsx-runtime': { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) },
    '../clientApi': { clientApi: {} }, '../ui/resources/useResourceState': { useResourceRead: () => ({ value: null, loaded: false, loading: false, snapshot: () => ({}) }) },
    './useObservedDocument': { useObservedDocument: () => reading },
    './DocumentHistoryTools': { DocumentHistoryTools: 'history-tools' }, './DocumentDeliveryTools': { DocumentDeliveryTools: 'delivery-tools' }, './documentRevisionState': revisionState,
    '../chat/components/markdown/DocumentPreviewContext': { DocumentPreviewContext: { Provider: 'provider' } },
    './file-preview/MarkdownDocument': { MarkdownDocument: 'markdown' }, './file-preview/SourceViewer': { SourceViewer: 'source' }, './file-preview/DiffViewer': { DiffViewer: 'diff' },
    './file-preview/RasterImageView': { RasterImageView: 'raster' }, './file-preview/documentAdapterState': adapterState,
    './file-preview/fileTypes': fileTypes, './ResourceWorkspaceContext': { useResourceWorkspace: () => ({}) },
    './useDocumentReadingPosition': { useDocumentReadingPosition: () => ({ ref: {}, onScroll() {}, restore() {} }) },
  };
  const page = moduleFrom('./ScopedDocumentPage.tsx', modules);
  const tree = page.ScopedDocumentPage({ workspaceId: 'bot', active: true, isZh: false, tab: { id: 'doc', absPath: 'guide.md', mode: 'preview' }, onModeChange() {} });
  assert.equal(find(tree, node => node.type === 'markdown').props.content, 'accepted old body');
  find(tree, node => node.type === 'button' && node.props.children === 'Load current version').props.onClick();
  assert.equal(adopts, 1);
  assert.ok(find(tree, node => node.props?.role === 'status'));
  reading = { value: null, failure: { ok: false, status: 'not_found' }, loading: false };
  const missing = page.ScopedDocumentPage({ workspaceId: 'bot', active: true, isZh: false, tab: { id: 'missing', absPath: 'missing.md', mode: 'preview' }, onModeChange() {} });
  assert.ok(find(missing, node => node.props?.role === 'alert'));
  assert.equal(find(missing, node => node.type === 'markdown'), undefined);
});

test('hiding or superseding a pending metadata read retires the follow-up byte request', async () => {
  const h = reader(); let current = true; let resolve!: (value: unknown) => void;
  h.metadata(() => new Promise(done => { resolve = done; }));
  const pending = h.read({ workspaceId: 'bot', path: 'guide.md' }, undefined, () => current);
  current = false; resolve({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md' });
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(h.calls.length, 1);
});

test('the first byte read binds the identity returned by metadata even without a saved receipt', async () => {
  const h = reader(); h.metadata(async () => ({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md', identity: { resourceId: 'confirmed-resource' } }));
  await h.read({ workspaceId: 'bot', path: 'guide.md' });
  assert.equal(h.calls[1].expectedObservation.resourceId, 'confirmed-resource');
});

test('a historical read binds host-confirmed commit/repository; old hosts cannot silently read live content', async () => {
  const commit = 'a'.repeat(40), repositoryId = `sha256:${'b'.repeat(64)}`;
  const reference = { workspaceId: 'bot', path: '/real/guide.md', revision: { kind: 'git', commit } };
  const h = reader();
  const result = await h.read(reference);
  assert.equal(result.status, 'version_unavailable'); assert.equal(h.calls.length, 1);
  const pinned = reader(); pinned.metadata(async () => ({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md',
    revision: { kind: 'git', commit, repositoryId, path: 'guide.md' } }));
  assert.equal((await pinned.read(reference)).ok, true);
  assert.equal(pinned.calls[1].revision.repositoryId, repositoryId);
  const moved = reader(); moved.metadata(async () => ({ ok: true, metadataOnly: true, resolvedPath: '/real/guide.md',
    revision: { kind: 'git', commit: 'c'.repeat(40), repositoryId, path: 'guide.md' } }));
  assert.equal((await moved.read(reference)).status, 'source_changed'); assert.equal(moved.calls.length, 1);
});
