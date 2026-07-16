import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRendererSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('Quick Chat only suppresses the main card bottom outline while a popover is open', async () => {
  const [component, css] = await Promise.all([
    readRendererSource('../app/components/QuickChatWindow.tsx'),
    readRendererSource('./quick-chat.css'),
  ]);

  assert.match(component, /popoverState \? ' has-open-popover' : ''/);
  assert.match(
    css,
    /\.quick-chat-shell\.has-open-popover \.quick-chat-bar\s*\{[^}]*border-bottom-color:\s*transparent;[^}]*box-shadow:\s*none;/s,
  );
});

test('Quick Chat popover keeps its own border and shadow', async () => {
  const css = await readRendererSource('./quick-chat.css');
  const shellStart = css.indexOf('.quick-chat-popover-shell {');
  const panelStart = css.indexOf('.quick-chat-popover-panel {', shellStart);
  const shellRule = css.slice(shellStart, panelStart);

  assert.notEqual(shellStart, -1);
  assert.notEqual(panelStart, -1);
  assert.match(shellRule, /border:\s*1px solid/);
  assert.match(shellRule, /box-shadow:\s*var\(--shadow-card\)/);
});
