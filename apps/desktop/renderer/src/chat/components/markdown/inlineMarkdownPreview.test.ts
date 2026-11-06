import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { DocumentPreviewContext, LocalDocumentRenderingContext } from './DocumentPreviewContext.ts';
import * as references from './documentReference.ts';
import * as links from './inlineMarkdownLinks.ts';

function load(overrides: Record<string, unknown> = {}) {
  const modules: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../../../clientApi': { clientApi: {} },
    '../thread/ImageLightbox': { ImageLightbox: () => null },
    '../../../workbench/WorkbenchContext': { useWorkbenchOptional: () => null },
    '../../state/localImagePreview': { isLocalImagePath: () => false },
    './inlineMarkdownLinks': links,
    './DocumentPreviewContext': { DocumentPreviewContext, LocalDocumentRenderingContext },
    './documentReference': references,
    '../../../ui/icons': { PeerIcon: () => React.createElement('svg') },
  };
  Object.assign(modules, overrides);
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL('./InlineMarkdown.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  return exports.renderInlineLines as (text: string, key: string) => React.ReactNode[];
}

test('static document preview renders an explicit remote-image action without an eager image request', () => {
  const inline = load();
  const html = renderToStaticMarkup(React.createElement(DocumentPreviewContext.Provider, {
    value: { label: 'Open', open() {}, openUrl() {}, remoteImages: 'link', remoteImageLabel: 'Open external image' },
  }, inline('![diagram](https://example.invalid/tracker.png)', 'image')));
  assert.doesNotMatch(html, /<img|<iframe|<script|rel="preload"/);
  assert.match(html, /<button/); assert.match(html, /Open external image/); assert.match(html, /diagram/);
});

test('ordinary chat image rendering remains compatible and file line targets survive shortened labels', () => {
  const inline = load();
  assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, inline('![diagram](https://example.invalid/picture.png)', 'chat'))), /<img/);
  const html = renderToStaticMarkup(React.createElement(DocumentPreviewContext.Provider, {
    value: { label: 'Open', open() {}, resolve: () => '/repo/scripts/a.ts' },
  }, inline('`a.ts:12:4`', 'code')));
  assert.match(html, /title="Open: \/repo\/scripts\/a.ts#L12"/);
  assert.match(html, /a.ts:12:4/);
});


test('local Markdown requires an explicit action for remote images even without a scoped resolver', () => {
  const inline = load();
  const html = renderToStaticMarkup(React.createElement(LocalDocumentRenderingContext.Provider, { value: true },
    inline('![remote](https://example.invalid/tracker.png) <script>alert(1)</script> ![bad](javascript:alert(1))', 'local')));
  assert.doesNotMatch(html, /<img|<iframe|<script|rel="preload"|href="javascript:/);
  assert.match(html, /remote/);
});


test('local document rendering never probes local paths or loads local thumbnails, including effect flush', () => {
  let reads = 0; const effects: Array<() => unknown> = [];
  const inline = load({
    react: { ...React, useState: (initial: unknown) => [initial, () => {}], useEffect: (effect: () => unknown) => effects.push(effect) },
    '../../../clientApi': { clientApi: { fileExists() { reads++; return Promise.resolve({ exists: true }); } } },
    '../../state/localImagePreview': { isLocalImagePath: () => true, loadLocalImageDataUrl() { reads++; return Promise.resolve('data:image/png;base64,AA=='); } },
  });
  const html = renderToStaticMarkup(React.createElement(LocalDocumentRenderingContext.Provider, { value: true },
    inline('![local](/repo/secret.png) `/repo/private.md`', 'local-path')));
  for (const effect of effects) effect();
  assert.ok(effects.length > 0); assert.equal(reads, 0); assert.doesNotMatch(html, /<img/);
});
