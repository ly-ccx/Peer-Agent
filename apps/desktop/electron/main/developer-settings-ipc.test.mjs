import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../preload/preload.cjs', import.meta.url), 'utf8');

function extractDeveloperSettingChannels(source, pattern) {
  return new Set(
    [...source.matchAll(pattern)]
      .map((match) => match[1])
      .filter((channel) => channel.startsWith('developer-settings:')),
  );
}

test('developer settings preload channels are registered in Electron main', () => {
  const rendererChannels = extractDeveloperSettingChannels(
    preloadSource,
    /ipcRenderer\.invoke\(['"]([^'"]+)['"]/g,
  );
  const mainChannels = extractDeveloperSettingChannels(
    mainSource,
    /ipcMain\.handle\(['"]([^'"]+)['"]/g,
  );

  assert.deepEqual(
    [...rendererChannels].sort(),
    [
      'developer-settings:diagnostics',
      'developer-settings:get',
      'developer-settings:reset',
      'developer-settings:update',
    ],
  );

  for (const channel of rendererChannels) {
    assert.equal(mainChannels.has(channel), true, `${channel} is missing an ipcMain.handle registration`);
  }
});
