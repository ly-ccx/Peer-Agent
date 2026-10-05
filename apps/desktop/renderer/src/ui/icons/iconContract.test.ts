import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// Scan parsed literals, not comments. Ordinary prose, math, shortcuts and diff data are content.
const iconGlyph = /[‹›⌄⌃⋯✓✔✗✘✕⚠★☆Ⅱ↛⌁☰✅❌❎❗❓⏳⌛⏸⏹⏵⏱⏲➜➔➤➕➖\u2580-\u25FF\u2B00-\u2BFF\uE000-\uF8FF\u{1F300}-\u{1FAFF}]/u;
const singleIconGlyph = /^(?:[→←↑↓↔↕↗↘↙↖×·•+−–—!?i<>^vxX…]|\.{3})$/u;
const iconClass = /(?:^|[-_\s"'`])(?:icon|glyph|signal|caret|chevron|check|mark|ellipsis)(?:$|[-_\s"'`])/;

function glyphsInSource(source: string): string[] {
  const file = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const value = node.text.trim();
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isJsxElement(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      const classes = owner && ts.isJsxElement(owner)
        ? owner.openingElement.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(file) === 'className')?.getText(file) ?? ''
        : '';
      const parserLiteral = ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression)
        && ['includes', 'replace', 'startsWith', 'endsWith'].includes(node.parent.expression.name.text);
      const control = owner && ts.isJsxElement(owner) && owner.openingElement.tagName.getText(file) === 'button'
        && owner.children.filter(child => !ts.isJsxText(child) || child.text.trim()).length === 1;
      const standaloneArrow = (ts.isJsxText(node) || ts.isStringLiteral(node)) && /^[→←↑↓↔↕↗↘↙↖]$/u.test(value);
      const placeholder = ts.isJsxText(node) && /^(?:…|\.{3})$/.test(value) && owner && ts.isJsxElement(owner)
        && owner.children.filter(child => !ts.isJsxText(child) || child.text.trim()).length === 1;
      if (iconGlyph.test(value) || (singleIconGlyph.test(value) && (iconClass.test(classes) || control || standaloneArrow || placeholder) && !parserLiteral)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        found.push(`${line}: ${value}`);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(file);
  return found;
}

function glyphsInCss(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/\bcontent\s*:\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)].flatMap(match => {
    const value = match[2]!.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).trim();
    return iconGlyph.test(value) || /^(?:[→←↑↓↔↕↗↘↙↖×…]|\.{3})$/u.test(value) ? [value] : [];
  });
}

test('icon scanner catches JSX, conditional state glyphs, emoji, ASCII icon labels and escaped CSS', () => {
  assert.equal(glyphsInSource('<button>‹</button>').length, 1);
  assert.equal(glyphsInSource("const state = ok ? '✓' : '✗';").length, 2);
  assert.equal(glyphsInSource('<div>⚠️</div><div>📎</div>').length, 2);
  assert.equal(glyphsInSource('<span className="streaming-cursor">▍</span>').length, 1);
  assert.equal(glyphsInSource('<span className="banner-icon">i</span>').length, 1);
  assert.equal(glyphsInSource('<span className="status-icon">{ok ? "!" : "?"}</span>').length, 2);
  assert.equal(glyphsInSource('<span className="pagination-ellipsis">…</span><button>{saving ? "..." : "Save"}</button>').length, 2);
  assert.deepEqual(glyphsInCss('summary::after { content: "⌄" } .close::after {content: "\\00d7"}'), ['⌄', '×']);
});

test('icon scanner preserves comments, SVG geometry, keyboard notation, prose and math/diff content', () => {
  assert.deepEqual(glyphsInSource('// ✓ comment\nconst view = <><kbd>⌘⇧N</kbd><p>System Settings → Privacy</p><span>证据 ×3</span><pre>+ file change</pre><svg><path d="M5 12h14" /></svg></>; const legacy = label.includes("→");'), []);
  assert.deepEqual(glyphsInSource('const view = <span>×{count}</span>; const range = `${start} → ${end}`; const size = `${width} × ${height}`;'), []);
  assert.deepEqual(glyphsInSource('const view = <p>{excerpt}…</p>;'), []);
  assert.deepEqual(glyphsInCss('/* content: "›" */ .diff::before {content: "+ "} .diff::after {content: "- "} .list::before {content: "— "}'), []);
});

test('desktop and shared UI use SVG icons instead of character glyphs', (t) => {
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const roots = ['apps/desktop/renderer', 'packages/ui', 'packages/i18n'];
  const issues: string[] = [];
  let scanned = 0;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(?:ts|tsx|css)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) continue;
      scanned += 1;
      const source = readFileSync(path, 'utf8');
      const found = entry.name.endsWith('.css') ? glyphsInCss(source) : glyphsInSource(source);
      issues.push(...found.map(value => `${relative(root, path)}:${value}`));
    }
  };
  roots.forEach(directory => walk(join(root, directory)));
  assert.ok(scanned > 400, `unexpected scan scope: ${scanned} files`);
  t.diagnostic(`Scanned ${scanned} renderer, shared UI and locale source files`);
  assert.deepEqual(issues, [], `Use an SVG icon:\n${issues.join('\n')}`);
});
