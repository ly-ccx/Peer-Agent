import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspaceCss = readFileSync(new URL('../project-agent/styles/bot-task-workspace.css', import.meta.url), 'utf8');
const chatCss = readFileSync(new URL('../chat/styles/chat-surface.css', import.meta.url), 'utf8');
const touchBarCss = readFileSync(new URL('../project-agent/styles/bot-touchbar.css', import.meta.url), 'utf8');
const embeddedChat = '.bot-task-workspace .bot-inline-scene--seamless .chat-surface';

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`^${escaped}(?:,\\n[^{}]+)?\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test('the seamless worker chat shares the task workspace paper', () => {
  const paper = /background:\s*var\(--paper-base\);/;
  for (const selector of [
    '.bot-task-workspace',
    '.bot-task-strip',
    embeddedChat,
    `${embeddedChat} > .chat-composer-wrap`,
  ]) {
    assert.match(ruleBody(workspaceCss, selector), paper, selector);
  }
  // The scroller and task composer shell let the paper underneath show through.
  const background = /(?:^|[;\n])\s*background(?:-color|-image)?\s*:/;
  assert.doesNotMatch(ruleBody(chatCss, '.chat-thread'), background);
  assert.doesNotMatch(ruleBody(touchBarCss, '.bot-composer-shell'), background);
});

test('standalone chat and its composer backing keep the shared chrome canvas', () => {
  const canvas = /background:\s*var\(--chrome-canvas\);/;
  for (const selector of ['.chat-surface', '.chat-composer-wrap', '.chat-composer-wrap--empty-home']) {
    assert.match(ruleBody(chatCss, selector), canvas, selector);
  }
  assert.doesNotMatch(workspaceCss, /^\.chat-(?:surface|composer-wrap)\b/m);
});
