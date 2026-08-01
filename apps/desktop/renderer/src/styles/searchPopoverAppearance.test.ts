import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const conversationSearchCss = readFileSync(join(stylesDir, 'conversation-search.css'), 'utf8');
const chatSurfaceCss = readFileSync(join(stylesDir, '../chat/styles/chat-surface.css'), 'utf8');
const composerControlsSource = readFileSync(
  join(stylesDir, '../chat/components/ComposerDraftControls.tsx'),
  'utf8',
);

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('conversation search uses semantic radius and scalable typography tokens', () => {
  assert.match(ruleBody(conversationSearchCss, '.conversation-search-panel'), /border-radius:\s*var\(--ui-radius-modal/);
  assert.match(ruleBody(conversationSearchCss, '.conversation-search-item'), /border-radius:\s*var\(--ui-radius-control/);

  for (const selector of [
    '.conversation-search-input',
    '.conversation-search-section-label',
    '.conversation-search-empty',
    '.conversation-search-item-title',
    '.conversation-search-item-meta',
    '.conversation-search-item-shortcut',
  ]) {
    const body = ruleBody(conversationSearchCss, selector);
    assert.match(body, /font-size:\s*var\(--ui-font-/);
    assert.doesNotMatch(body, /font-size:\s*\d+(?:\.\d+)?px/);
  }
});

test('session mention menu uses semantic radius and scalable typography tokens', () => {
  assert.match(ruleBody(chatSurfaceCss, '.slash-command-menu'), /border-radius:\s*var\(--ui-radius-panel/);
  assert.match(ruleBody(chatSurfaceCss, '.slash-command-item'), /border-radius:\s*var\(--ui-radius-control/);

  for (const selector of [
    '.slash-command-badge',
    '.slash-command-label',
    '.slash-command-desc',
    '.session-mention-title',
    '.session-mention-id',
    '.session-mention-menu .session-mention-empty',
  ]) {
    const body = ruleBody(chatSurfaceCss, selector);
    assert.match(body, /font-size:\s*var\(--ui-font-/);
  }
});

test('session mention presents the session id as secondary text below the title', () => {
  const mainRule = ruleBody(chatSurfaceCss, '.session-mention-main');
  const idRule = ruleBody(chatSurfaceCss, '.session-mention-id');

  assert.match(mainRule, /flex-direction:\s*column/);
  assert.match(idRule, /font-size:\s*var\(--ui-font-caption/);
  assert.match(idRule, /opacity:\s*0\.72/);
  assert.match(composerControlsSource, /className="session-mention-main"/);
  assert.match(composerControlsSource, /className="session-mention-title"/);
  assert.match(composerControlsSource, /className="session-mention-id">\{hit\.id\}/);
  assert.doesNotMatch(
    composerControlsSource,
    /className="slash-command-description">\{hit\.id\}/,
  );
});
