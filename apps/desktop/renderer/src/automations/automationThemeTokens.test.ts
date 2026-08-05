import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const automationCssUrl = new URL('./automations.css', import.meta.url);
const tokensCssUrl = new URL('../styles/tokens.css', import.meta.url);

async function readThemeSources() {
  const [automationCss, tokensCss] = await Promise.all([
    readFile(automationCssUrl, 'utf8'),
    readFile(tokensCssUrl, 'utf8'),
  ]);
  return { automationCss, tokensCss };
}

test('Automation CSS uses only declared Peer Frost semantic color tokens', async () => {
  const { automationCss, tokensCss } = await readThemeSources();

  assert.doesNotMatch(automationCss, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(
    automationCss,
    /--(?:surface-base|ink-base|ink-muted|border-base|border-subtle|accent)(?![a-z-])/i,
  );

  const declaredTokens = new Set(
    [...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
  );
  const usedTokens = new Set(
    [...automationCss.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]),
  );
  const missingTokens = [...usedTokens].filter((token) => !declaredTokens.has(token));

  assert.deepEqual(missingTokens, []);
});

test('Automation surfaces, controls, states and focus use semantic token roles', async () => {
  const { automationCss } = await readThemeSources();
  const requiredTokens = [
    '--za-thread-bg',
    '--paper-sheet',
    '--za-surface-1',
    '--za-control-fill',
    '--za-text',
    '--za-text-muted',
    '--za-text-faint',
    '--za-line',
    '--za-line-strong',
    '--za-primary-control-bg',
    '--za-primary-control-ink',
    '--za-focus',
    '--za-good',
    '--za-good-soft',
    '--za-warn',
    '--za-warn-soft',
    '--za-danger',
    '--za-danger-soft',
    '--za-accent',
    '--za-accent-soft',
    '--ui-surface-hover',
    '--ui-surface-selected',
    '--ui-selected-border',
  ];

  for (const token of requiredTokens) {
    assert.match(automationCss, new RegExp(`var\\(${token.replaceAll('-', '\\-')}\\)`));
  }
  assert.match(
    automationCss,
    /\.automation-form-section,\.automation-review-card,\.automation-panel\{background:var\(--paper-sheet\)/,
  );
  assert.match(
    automationCss,
    /\.automation-advanced\{border:1px solid var\(--za-line\);border-radius:14px;background:var\(--paper-sheet\)/,
  );
  assert.match(
    automationCss,
    /\.automation-bound-workspace,\.automation-bound-timezone\{[^}]*background:var\(--paper-sheet\)/,
  );
  assert.match(automationCss, /background:var\(--za-control-fill\)/);
  assert.match(automationCss, /:focus-visible\{[^}]*var\(--za-focus\)/);
  assert.match(automationCss, /::placeholder\{color:var\(--za-text-faint\)\}/);
});
