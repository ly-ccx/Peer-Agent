import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const radiusName = /^--ui-radius-(detail|chip|control(?:-compact)?|row|panel|modal|inset|message|composer|pill|circle|avatar)$/;
const iconGlyph = /^[\s→←↑↓↗↘↙↖▶▼►▾▸◀▲✕×✓✔✖⚠⚙☰★☆◆◇●○+−\-\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]+$/u;
const privateGlyph = /[\uE000-\uF8FF]/u;

export function checkUiSource(file, source) {
  const errors = [];
  const fail = (position, message) => errors.push(`${file}:${source.slice(0, position).split('\n').length}: ${message}`);
  if (file.endsWith('.css')) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
    // Token definitions are the sole numeric scale; 0/inherit join surfaces.
    if (!file.endsWith('/styles/tokens.css')) {
      for (const match of css.matchAll(/border(?:-[\w-]+)?-radius\s*:\s*([^;{}]+)/g)) {
        const value = match[1];
        const withoutVars = value.replace(/var\((--[\w-]+)\)/g, (_, name) => {
          if (!radiusName.test(name)) fail(match.index, `Use a semantic UI radius, found ${name}`);
          return 'TOKEN';
        });
        if (/\d+(?:\.\d+)?(?:px|rem|em|%)/.test(withoutVars) && !/^calc\(TOKEN - [1-3]px\)$/.test(withoutVars.trim())) {
          // An inset may subtract its actual border/padding; additions create another scale.
          if (!/^calc\(TOKEN - 1px\) calc\(TOKEN - 1px\) 0 0$/.test(withoutVars.trim()))
            fail(match.index, 'Hardcoded radius; choose a semantic UI radius');
        }
      }
      for (const match of css.matchAll(/\brounded(?:-\[[^\]]+\]|-[\w-]+)?/g)) {
        const token = match[0].match(/^rounded-\[var\((--[\w-]+)\)\]$/)?.[1];
        if (match[0] !== 'rounded-none' && (!token || !radiusName.test(token)))
          fail(match.index, 'Tailwind rounding must use a semantic UI radius');
      }
    }
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, body] = match;
      // Dots, progress bars, switch geometry, sheen, separators and tooltip tips
      // are surfaces. Directional/stroke control icons must be SVG.
      if (/icon|chevron|spin|arrow|loading-mark/.test(selector) && !/tooltip|sidebar-conv-spinner|tool-progress-spinner/.test(selector)
        && (/spin|loading-mark/.test(selector) || /transform:[^;]*rotate/.test(body))
        && (/border(?:-(?:top|right|bottom|left))?\s*:[^;]*(?:solid|dashed)/.test(body) || /@apply[^;]*\bborder-(?:[trbl]|[1248])\b/.test(body)))
        fail(match.index, 'CSS draws a control icon; use PeerIcon or an existing SVG');
      if (/font-family\s*:[^;]*(?:FontAwesome|Material Icons|iconfont|IcoMoon)/i.test(body)
        || /content\s*:\s*['"][→←↑↓▶▼►▾▸✓✔✕⚠\\]/.test(body))
        fail(match.index, 'Font/generated icon; use SVG');
    }
    return errors;
  }
  if (!/\.[jt]sx?$/.test(file)) return errors;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const inIconSlot = node => {
    // A sign followed by a dynamic count is data, e.g. +{additions}.
    if (ts.isJsxText(node) && ts.isJsxElement(node.parent)
      && node.parent.children.some(child => ts.isJsxExpression(child) && child.expression)) return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      // Attribute values (labels, class names, styles) are not rendered content.
      if (ts.isJsxAttribute(parent)) return false;
      if (ts.isCallExpression(parent) || ts.isObjectLiteralExpression(parent)) return false;
      if (!ts.isJsxElement(parent)) continue;
      const opening = parent.openingElement;
      const tag = opening.tagName.getText(tree);
      if (['kbd', 'code', 'pre'].includes(tag)) return false;
      if (tag === 'button' || /(?:icon|chevron)/i.test(opening.attributes.getText(tree))) return true;
    }
    return false;
  };
  const visit = node => {
    const text = ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : '';
    if (text.trim() && (iconGlyph.test(text) || privateGlyph.test(text)) && inIconSlot(node))
      fail(node.pos, 'Text glyph in a control icon slot; use SVG');
    if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/['"]/g, '') === 'borderRadius') {
      const initializer = node.initializer;
      const value = ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer) ? initializer.text : initializer.getText(tree);
      const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
      if (!['inherit', '0'].includes(value) && (!token || !radiusName.test(token)))
        fail(node.pos, 'Inline rounding must use a semantic UI radius');
    }
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'className' && node.initializer) {
      for (const match of node.initializer.getText(tree).matchAll(/\brounded(?:-\[[^\]]+\]|-[\w-]+)?/g)) {
        const token = match[0].match(/^rounded-\[var\((--[\w-]+)\)\]$/)?.[1];
        if (match[0] !== 'rounded-none' && (!token || !radiusName.test(token)))
          fail(node.pos, 'JSX rounding must use a semantic UI radius');
      }
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'summary') {
      const children = node.children.map(child => child.getText(tree)).join('');
      if (!/<(?:PeerIcon|svg)\b/.test(children)) fail(node.pos, 'Summary needs an explicit SVG disclosure icon');
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return errors;
}

export function checkUiTree(directory = path.join(root, 'apps/desktop/renderer/src')) {
  const errors = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(css|tsx?|jsx?)$/.test(file) && !/\.test\./.test(file))
        errors.push(...checkUiSource(path.relative(root, file), readFileSync(file, 'utf8')));
    }
  }
  walk(directory);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkUiTree();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('UI radius and SVG conventions passed.');
}
