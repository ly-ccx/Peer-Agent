import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(desktopRoot, 'dist', 'assets');
const cssFiles = readdirSync(assetsDir).filter((name) => name.endsWith('.css'));

assert.ok(cssFiles.length > 0, `no production CSS found in ${assetsDir}; run the desktop build first`);

const css = cssFiles.map((name) => readFileSync(join(assetsDir, name), 'utf8')).join('\n');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `production CSS is missing ${selector}`);
  return match[1];
}

for (const selector of ['.pa-overlay-backdrop', '.pa-overlay-panel:before']) {
  const body = ruleBody(selector);
  assert.match(
    body,
    /(?:^|;)backdrop-filter:var\(--glass-modal-filter\)(?:;|$)/,
    `${selector} must retain the standard backdrop-filter declaration in production CSS`,
  );
}

const anchored = ruleBody('.pa-overlay--anchored>.pa-overlay-panel:before');
assert.match(anchored, /(?:^|;)backdrop-filter:var\(--blur-popover\)(?:;|$)/);
const surface = ruleBody('.pa-overlay--anchored>.pa-overlay-panel');
assert.match(surface, /(?:^|;)border-radius:var\(--radius-xl\)(?:;|$)/);
assert.match(surface, /(?:^|;)pointer-events:auto(?:;|$)/);
const nonModal = ruleBody('.pa-overlay-backdrop.pa-overlay--anchored');
assert.match(nonModal, /(?:^|;)pointer-events:none(?:;|$)/);
console.log('Production Overlay CSS preserves modal filters and non-modal surface boundaries.');
