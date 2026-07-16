import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('motion-ripple only animates compositor-safe properties', async () => {
  const css = await readFile(new URL('./motion.css', import.meta.url), 'utf8');
  const start = css.indexOf('@keyframes motion-ripple');
  const end = css.indexOf('/* 发光呼吸 glow', start);
  const keyframes = css.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(keyframes, /box-shadow\s*:/);
  assert.match(keyframes, /transform\s*:/);
  assert.match(keyframes, /opacity\s*:/);
});
