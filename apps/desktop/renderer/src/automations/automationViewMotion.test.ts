import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);
const motionUrl = new URL('../styles/motion.css', import.meta.url);

test('Automation view switches enter with motion-enter-rise instead of hard cuts', async () => {
  const [center, css, motion] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
    readFile(motionUrl, 'utf8'),
  ]);

  assert.match(center, /className=\{`automation-center narrow automation-editor motion-enter-rise\$\{/);
  assert.match(center, /!editing \? ' automation-create-home' : ''/);
  assert.match(center, /data-automation-view="editor"/);
  assert.match(center, /data-automation-view="list"/);
  assert.match(center, /data-automation-view="detail"/);
  assert.match(center, /data-automation-view="run"/);
  assert.equal((center.match(/motion-enter-rise/g) || []).length, 4);

  assert.match(motion, /\.motion-enter-rise \{/);
  assert.match(motion, /animation: motion-enter-rise var\(--za-motion-medium\) var\(--za-ease-decelerate\) both;/);
  assert.match(css, /\.automation-center\.motion-enter-rise\{--motion-enter-from:var\(--za-motion-shift-sm\)\}/);
});
