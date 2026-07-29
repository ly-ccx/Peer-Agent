import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), 'main.mjs');
const indexHtml = join(dirname(fileURLToPath(import.meta.url)), '../../index.html');

test('main window starts hidden and reveals on ready-to-show', () => {
  const src = readFileSync(root, 'utf8');
  assert.match(src, /function createWindow\s*\(/);
  assert.match(src, /show:\s*false/);
  assert.match(src, /ready-to-show/);
  assert.match(src, /revealMainWindow/);
  // 避免再次回到「创建即 show」导致冷启动透明底闪黑。
  assert.doesNotMatch(
    src,
    /function createWindow\([\s\S]*?new BrowserWindow\([\s\S]*?show:\s*true/,
  );
});

test('index.html provides first-paint background fallback before CSS bundle', () => {
  const html = readFileSync(indexHtml, 'utf8');
  assert.match(html, /background:\s*#F4F6F9/i);
  assert.match(html, /prefers-color-scheme:\s*dark/);
  assert.match(html, /background:\s*#16191D/i);
});
