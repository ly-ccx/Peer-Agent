import assert from 'node:assert/strict';
import test from 'node:test';
import { commitSettingsNavigation, registerSettingsNavigation, requestSettingsNavigation } from './settingsNavigation.ts';
test('settings navigation remains pending until the active editor resolves it', () => {
  let pending: (() => void) | undefined, page = 'settings';
  const off = registerSettingsNavigation(next => { pending = next; return false; });
  assert.equal(requestSettingsNavigation(() => { page = 'chat'; }), false);
  assert.equal(page, 'settings');
  commitSettingsNavigation(pending!); assert.equal(page, 'chat'); off();
});
test('a confirmed navigation does not reopen the same unsaved guard', () => {
  let requests = 0, commits = 0;
  const off = registerSettingsNavigation(() => { requests++; return false; });
  commitSettingsNavigation(() => { requestSettingsNavigation(() => { commits++; }); });
  assert.equal(requests, 0); assert.equal(commits, 1);
  off(); requestSettingsNavigation(() => { commits++; }); assert.equal(commits, 2);
});
