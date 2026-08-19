import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./UpdatesPanel.tsx', import.meta.url), 'utf8');

test('updates panel exposes help links as kind-only product opens', () => {
  assert.match(source, /updater\.settings\.help\.title/);
  assert.match(source, /updater\.settings\.help\.description/);
  assert.match(source, /openProductLink\('github'\)/);
  assert.match(source, /openProductLink\('feedback'\)/);
  assert.match(source, /openProductLink\('releaseNotes'\)/);
  assert.doesNotMatch(source, /https:\/\/github\.com/);
  assert.doesNotMatch(source, /https:\/\/ly-ccx\.github\.io/);
});
