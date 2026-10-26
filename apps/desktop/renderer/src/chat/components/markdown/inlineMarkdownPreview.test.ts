import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { DocumentPreviewContext } from './DocumentPreviewContext.ts';
import * as references from './documentReference.ts';
import * as links from './inlineMarkdownLinks.ts';

function load() {
  const modules: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../../../clientApi': { clientApi: {} },
    '../thread/ImageLightbox': { ImageLightbox: () => null },
    '../../../workbench/WorkbenchContext': { useWorkbenchOptional: () => null },
    '../../state/localImagePreview': { isLocalImagePath: () => false },
    './inlineMarkdownLinks': links,
    './DocumentPreviewContext': { DocumentPreviewContext },
    './documentReference': references,
    '../../../ui/icons': { PeerIcon: () => React.createElement('svg') },
  };
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
