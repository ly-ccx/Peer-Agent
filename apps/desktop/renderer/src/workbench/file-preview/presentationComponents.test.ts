import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as budgets from './presentationBudget.ts';
import * as raster from './rasterImageState.ts';
import * as diff from './diffLines.ts';
import * as presentation from './diffPresentationState.ts';

function hooks() {
  const values: any[] = []; let cursor = 0;
  return { begin() { cursor = 0; }, react: {
    useMemo: (read: () => unknown) => read(), useCallback: (callback: unknown) => callback, useEffect() {}, useLayoutEffect() {}, useId: () => 'file-panel',
    useState(initial: any) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], (next: any) => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; },
    useRef(initial: any) { const index = cursor++; return values[index] ??= { current: initial }; },
  } };
}
function load(file: string, react: object, extra: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {}, modules: Record<string, unknown> = {
    react, 'react/jsx-runtime': jsx, '../../ui/icons': { PeerIcon: () => null },
    './presentationBudget': budgets, './rasterImageState': raster, './diffLines': diff, './diffPresentationState': presentation, ...extra,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); },
    window: { clearTimeout() {}, setTimeout() { return 1; } } });
  return exports;
}
function findAll(node: any, predicate: (node: any) => boolean): any[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate));
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
function png(width = 2) {
  const b = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(13,8); b.write('IHDR',12);
  b.writeUInt32BE(width,16); b.writeUInt32BE(3,20); return `data:image/png;base64,${b.toString('base64')}`;
}

test('source rendering caps blank-line DOM and escapes unhighlighted HTML', () => {
  const h = hooks(); const { SourceViewer } = load('./SourceViewer.tsx', h.react, {
    '../../chat/components/markdown/useHighlightLanguages': { useHighlightLanguages: () => 0 },
    './sourceHighlight.ts': { highlightSourceLines: (text: string) => ({ language: null, lines: text.split('\n') }) },
  });
  const tree = SourceViewer({ content: '\n'.repeat(50_000), emptyLabel: 'empty' });
  assert.equal(findAll(tree, n => n.props['data-source-line']).length, 4000);
  assert.equal(findAll(tree, n => n.props.role === 'status').length, 1);
  const html = renderToStaticMarkup(SourceViewer({ content: '<script>x</script><img src="https://example.invalid">', emptyLabel: 'empty' }));
  assert.doesNotMatch(html, /<script|<img/); assert.match(html, /&lt;script/);
});
test('over-budget Markdown skips rich parsing and delegates truthful bounded source', () => {
  const h = hooks(); let parses = 0;
  const { MarkdownDocument } = load('./MarkdownDocument.tsx', h.react, {
    './SourceViewer': { SourceViewer: 'source' },
    '../../chat/components/markdown/DocumentPreviewContext': { LocalDocumentRenderingContext: { Provider: 'local-policy' } },
    '../../chat/components/markdown/InlineMarkdown': { renderInlineLines: () => [] },
    '../../chat/components/markdown/markdownParser': { parseMarkdownBlocks() { parses++; return []; } },
  });
  const content = 'x'.repeat(16_001), tree = MarkdownDocument({ content, emptyLabel: 'empty', copyLabel: 'copy', copiedLabel: 'copied' });
  assert.equal(parses, 0); assert.equal(findAll(tree, n => n.type === 'source')[0].props.content, content);
  MarkdownDocument({ content: 'small', emptyLabel: 'empty', copyLabel: 'copy', copiedLabel: 'copied' }); assert.equal(parses, 1);
});
test('raster admission, local decoding error, retry, zoom and late image events stay with their resource', () => {
  const h = hooks(); const { RasterImageView } = load('./RasterImageView.tsx', h.react);
  let reads = 0, ready = 0;
  const props = { dataUrl: png(), name: 'image', isZh: false, onRetry() { reads++; }, onReady() { ready++; } };
  const render = (dataUrl = props.dataUrl) => { h.begin(); return RasterImageView({ ...props, dataUrl }); };
  assert.equal(findAll(render('https://example.invalid/a.png'), n => n.type === 'img').length, 0);
  let tree = render(), image = findAll(tree, n => n.type === 'img')[0];
  const oldImage = image, oldNode = { naturalWidth: 2, naturalHeight: 3 }; image.props.ref.current = oldNode;
  image.props.onLoad({ currentTarget: oldNode }); assert.equal(ready, 1);
  findAll(tree, n => n.props['aria-label'] === 'Zoom in')[0].props.onClick();
  assert.equal(findAll(render(), n => n.type === 'img')[0].props.style.width, 2.5);
  tree = render(png(3)); image = findAll(tree, n => n.type === 'img')[0];
  assert.equal(image.props.style.maxWidth, '100%'); assert.notEqual(image.key, oldImage.key);
  const currentNode = { naturalWidth: 3, naturalHeight: 3 }; image.props.ref.current = currentNode;
  oldImage.props.onError({ currentTarget: oldNode }); assert.equal(findAll(render(png(3)), n => n.type === 'img').length, 1);
  image.props.onError({ currentTarget: currentNode });
  tree = render(png(3)); assert.equal(findAll(tree, n => n.props.role === 'alert').length, 1);
  findAll(tree, n => n.type === 'button')[0].props.onClick(); assert.equal(reads, 1);
  assert.equal(findAll(render(png(3)), n => n.type === 'img').length, 1);
});
test('Diff index click keeps the selected full body, and disappearance never substitutes another file', () => {
  const h = hooks(); const { DiffFileIndex } = load('./DiffFileIndex.tsx', h.react, {
    'react-dom': { createPortal: () => null }, '../../app/components/MotionSurface': {}, '../../app/hooks/useInteractionLayer': {},
    '../../app/pages/taskArtifactPreviewPosition': {}, './FileKindIcon': { FileKindIcon: 'icon' }, './DiffRows': { DiffLines: 'lines' },
  });
  const files = diff.groupDiffByFile('diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b');
  const render = (items = files) => { h.begin(); return DiffFileIndex({ files: items, isZh: false }); };
  let tree = render(); findAll(tree, n => n.type === 'button' && n.props['aria-controls'])[0].props.onClick(); tree = render();
  assert.equal(findAll(tree, n => n.type === 'section')[0].props['aria-label'], 'a');
  assert.equal(findAll(tree, n => n.type === 'lines')[0].props.lines, files[0]!.lines);
  const disappeared = render([]); assert.equal(findAll(disappeared, n => n.type === 'section').length, 0);
  assert.equal(findAll(disappeared, n => n.props.role === 'status').length, 1);
});
