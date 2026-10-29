import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_SHORTCUT_TABLE, resolveBotShortcut } from './botShortcuts.ts';

const base = {
  meta: true,
  ctrl: false,
  shift: false,
  alt: false,
  palette: false,
  shell: 'bots' as const,
};

test('bot shortcuts stay off the classic shell', () => {
  assert.equal(resolveBotShortcut({ ...base, key: 'n', shell: 'classic' }), null);
  assert.equal(resolveBotShortcut({ ...base, key: 'f', shell: 'classic' }), null);
  assert.equal(resolveBotShortcut({ ...base, key: '1', shell: 'classic' }), null);
});

test('bot shortcuts switch, create, search, and toggle the profile', () => {
  assert.deepEqual(resolveBotShortcut({ ...base, key: 'n' }), { action: 'new-bot' });
  assert.deepEqual(resolveBotShortcut({ ...base, key: 'f' }), { action: 'list-search' });
  assert.deepEqual(resolveBotShortcut({ ...base, key: 'p', shift: true }), { action: 'toggle-profile' });
  assert.deepEqual(resolveBotShortcut({ ...base, key: '3' }), { action: 'switch-bot', index: 2 });
  assert.equal(resolveBotShortcut({ ...base, key: '3', palette: true }), null);
  assert.equal(resolveBotShortcut({ ...base, key: 'k' }), null);
  assert.equal(BOT_SHORTCUT_TABLE.some((row) => row.combo === '⌘⇧N'), true);
});
