import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mainUrl = new URL('./main.mjs', import.meta.url);
const mainSource = readFileSync(mainUrl, 'utf8');

test('main entry parses as an ECMAScript module', () => {
  const result = spawnSync(process.execPath, ['--check', mainUrl.pathname], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('packaged desktop acquires a single-instance lock before creating the composition root', () => {
  const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock()');
  const rootIndex = mainSource.indexOf('createDesktopCompositionRoot({');
  assert.ok(lockIndex >= 0, 'main entry must request the Electron single-instance lock');
  assert.ok(rootIndex > lockIndex, 'single-instance lock must be acquired before the composition root starts');
  assert.match(mainSource, /const hasSingleInstanceLock = !isPackaged \|\| app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /if \(!hasSingleInstanceLock\) app\.quit\(\)/);
  assert.match(mainSource, /app\.on\(['"]second-instance['"], \(\) => \{\s*showOrCreateMainWindow\(\)/);
  assert.match(mainSource, /desktopLifecycleBinding = hasSingleInstanceLock \? bindDesktopAppLifecycle/);
});

test('main delegates Electron lifecycle ownership to the desktop composition root', () => {
  assert.match(mainSource, /createDesktopCompositionRoot\(\{/);
  assert.match(mainSource, /bindDesktopAppLifecycle\(\{/);
  assert.doesNotMatch(mainSource, /app\.whenReady\s*\(/);
  assert.doesNotMatch(mainSource, /app\.(?:on|once)\(\s*['"](?:activate|window-all-closed|before-quit|will-quit)['"]/);
  assert.doesNotMatch(mainSource, /ipcMain\.(?:handle|on)\s*\(/);
  assert.doesNotMatch(mainSource, /desktopIpcRegistrationHost/);
});

test('local runtime and desktop IPC become ready before the first renderer window', () => {
  const localRuntime = mainSource.indexOf("{ name: 'local-runtime', start: startLocalRuntime }");
  const desktopIpc = mainSource.indexOf("{ name: 'desktop-ipc', start: () => registerDesktopIpcHost() }");
  const firstWindow = mainSource.indexOf("name: 'first-main-window'");

  assert.notEqual(localRuntime, -1);
  assert.notEqual(desktopIpc, -1);
  assert.notEqual(firstWindow, -1);
  assert.ok(localRuntime < desktopIpc, 'local runtime must be ready before IPC registrars capture it');
  assert.ok(desktopIpc < firstWindow, 'desktop IPC must be registered before the first window loads');
});

test('stateful Desktop owners are admitted to deterministic cleanup', () => {
  for (const expected of [
    "name: 'native-theme-listener'",
    "name: 'local-tool-host-events'",
    "name: 'desktop-ipc'",
    "name: 'desktop-affordances'",
    "name: 'conversation-change-subscription'",
    "name: 'goal-plan-change-subscription'",
    "name: 'mcp-oauth-callback'",
    "name: 'catalog-ipc-main'",
    "name: 'trusted-window-registry'",
    "name: 'full-disk-access-drag-float'",
  ]) {
    assert.ok(mainSource.includes(expected), `missing composition owner: ${expected}`);
  }
  assert.match(mainSource, /unsubscribeRuntimeEvents/);
  assert.match(mainSource, /nativeTheme\.removeListener\(['"]updated['"]/);
  assert.match(mainSource, /quickChatWindowController\.destroy\(\)/);
  assert.match(mainSource, /stopAutoUpdater\(\)/);
});
