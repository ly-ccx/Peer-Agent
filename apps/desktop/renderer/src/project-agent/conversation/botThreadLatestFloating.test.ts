import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readCss = () => readFileSync(new URL('../styles/bot-conversation.css', import.meta.url), 'utf8');

function block(source: string, selector: string, fromIndex = 0): string {
  const start = source.indexOf(selector, fromIndex);
  assert.notEqual(start, -1, selector);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${selector}`);
}

test('return-to-latest floats independently over the thread instead of reserving an opaque strip', () => {
  const css = readCss();
  const shell = block(css, '.bot-thread-shell');
  const latest = block(css, '.bot-thread-latest');

  assert.match(shell, /position:\s*relative;/);
  assert.match(latest, /position:\s*absolute;/);
  assert.match(latest, /left:\s*50%;/);
  assert.match(latest, /transform:\s*translateX\(-50%\);/);
  assert.match(latest, /background:\s*var\(--glass-popover\);/);
  assert.match(latest, /backdrop-filter:\s*blur\(var\(--blur-popover\)\)\s*saturate\(var\(--blur-saturate\)\);/);
  assert.match(latest, /box-shadow:\s*var\(--glass-edge-highlight\),\s*var\(--shadow-popover\);/);
  assert.doesNotMatch(latest, /flex:\s*none|align-self:\s*center|margin-block-end/);

  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{\s*\.bot-thread-latest \{[^}]*background:\s*var\(--paper-sheet\);[^}]*backdrop-filter:\s*none;/);
  assert.match(css, /html\[data-window-material="solid"\] \.bot-thread-latest \{[^}]*background:\s*var\(--paper-sheet\);[^}]*backdrop-filter:\s*none;/);
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?\.bot-thread-latest \{[^}]*background:\s*Canvas;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.bot-thread-latest:is\(:hover, :active\) \{ transform:\s*translateX\(-50%\); \}/);
});
