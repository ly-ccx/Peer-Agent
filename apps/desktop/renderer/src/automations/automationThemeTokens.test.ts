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
    '--paper-base',
    '--paper-sheet',
    '--control-fill',
    '--graphite-base',
    '--graphite-fade',
    '--graphite-mute',
    '--chrome-hairline',
    '--chrome-hairline-strong',
    '--chrome-keycap-bg',
    '--chrome-keycap-fg',
    '--ui-focus-glow',
    '--state-success',
    '--state-success-soft',
    '--state-warn',
    '--state-warn-soft',
    '--state-danger',
    '--state-danger-soft',
    '--azure-seal',
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
    /\.automation-advanced\{border:1px solid var\(--chrome-hairline\);border-radius:var\(--ui-radius-panel\);background:var\(--paper-sheet\)/,
  );
  assert.match(
    automationCss,
    /\.automation-bound-workspace,\.automation-bound-timezone\{[^}]*background:var\(--paper-sheet\)/,
  );
  assert.match(automationCss, /background:var\(--control-fill\)/);
  assert.match(automationCss, /:focus-visible\{[^}]*var\(--ui-focus-glow\)/);
  assert.match(automationCss, /::placeholder\{color:var\(--graphite-mute\)\}/);
});
