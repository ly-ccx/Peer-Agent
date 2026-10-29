import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssUrl = new URL('./capability-workbench.css', import.meta.url);

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('plugin toolbar segmented tracks, inner buttons, and fields use panel tracks and smaller control tokens', async () => {
  const css = await readFile(cssUrl, 'utf8');

  const trackRadius = /border-radius:\s*var\(--ui-radius-panel\)/;
  const buttonRadius = /rounded-\[var\(--ui-radius-control\)\]/;
  const fieldRadius = /border-radius:\s*var\(--ui-radius-control\)/;

  assert.match(ruleBody(css, '.skill-view-tabs'), trackRadius);
  assert.match(ruleBody(css, '.capability-tabs'), trackRadius);
  assert.doesNotMatch(ruleBody(css, '.skill-view-tabs'), /rounded-xl|rounded-lg/);

  assert.match(ruleBody(css, '.skill-view-tabs button'), buttonRadius);
  assert.match(ruleBody(css, '.capability-tabs button'), buttonRadius);

  assert.match(ruleBody(css, '.skill-marketplace-toolbar input'), fieldRadius);
  assert.match(ruleBody(css, '.skill-marketplace-category-select .pa-dropdown-trigger'), fieldRadius);

  assert.match(
    css,
    /\.skill-marketplace-toolbar input,\s*\.skill-marketplace-category-select \.pa-dropdown-trigger,\s*\.skill-marketplace-toolbar \.skill-marketplace-install \{\s*border-radius:\s*var\(--ui-radius-control\);\s*\}/,
  );
  assert.doesNotMatch(
    css,
    /\.skill-marketplace-toolbar input,[\s\S]*?border-radius:\s*var\(--ui-radius-panel\)/,
  );
});
