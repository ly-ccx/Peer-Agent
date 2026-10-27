import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const modulePath = process.env.PEER_PLAYWRIGHT_MODULE;
test('real source/Markdown selection geometry excludes gutter and preserves UTF-16 version-relative ranges', { skip: !modulePath }, async () => {
  const { chromium } = await import(modulePath); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const compiled = ts.transpileModule(readFileSync(new URL('./resourceSelection.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    await page.setContent('<main id="source"></main><article id="markdown"><p>Human <strong>selection</strong></p></article><aside id="outside">other content</aside>');
    const result = await page.evaluate(code => {
      const exports = {}; new Function('exports', 'require', code)(exports, () => ({ RESOURCE_FEEDBACK_EXCERPT_LIMIT: 8192 }));
      const content = 'first\n😀two\nlast', container = document.getElementById('source');
      for (const [i, text] of content.split('\n').entries()) {
        const row = document.createElement('span'); row.dataset.sourceLine = String(i + 1); row.className = 'source-line';
        const gutter = document.createElement('span'); gutter.className = 'source-gutter'; gutter.textContent = String(i + 1); row.appendChild(gutter);
        const body = document.createElement('span'); body.className = 'source-line-text'; body.textContent = text; row.appendChild(body); container.appendChild(row);
      }
      const spans = container.querySelectorAll('.source-line-text'), selected = window.getSelection(), range = document.createRange();
      range.setStart(spans[0].firstChild, 1); range.setEnd(spans[1].firstChild, 3); selected.removeAllRanges(); selected.addRange(range);
      const source = exports.captureResourceSelection(container, selected, content);
      const article = document.getElementById('markdown'), mdRange = document.createRange(); mdRange.selectNodeContents(article.querySelector('strong')); selected.removeAllRanges(); selected.addRange(mdRange);
      const markdown = exports.captureResourceSelection(article, selected);
      const external = exports.captureResourceSelection(container, selected, content);
      const large = document.createElement('span'); large.textContent = 'x'.repeat(8193); article.appendChild(large); mdRange.selectNodeContents(large); selected.removeAllRanges(); selected.addRange(mdRange);
      const over = exports.captureResourceSelection(article, selected);
      return { source, markdown, external, over };
    }, compiled);
    assert.equal(result.source.excerpt, 'irst\n😀t');
    assert.deepEqual(result.source.selection.range, { start: 1, end: 9, startLine: 1, startColumn: 2, endLine: 2, endColumn: 4 });
    assert.equal(result.markdown.selection.kind, 'discussion'); assert.equal(result.markdown.excerpt, 'selection');
    assert.equal(result.external, null); assert.equal(result.over, null);
  } finally { await browser.close(); }
});
