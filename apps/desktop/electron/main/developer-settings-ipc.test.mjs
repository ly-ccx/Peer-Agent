import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getDesktopIpcPolicy } from '../ipc/channels.mjs';
import { createSettingsIpcRegistrations } from './ipc/register-settings-ipc.mjs';

const preloadSource = readFileSync(new URL('../preload/preload.cjs', import.meta.url), 'utf8');

function extractDeveloperSettingChannels(source, pattern) {
  return new Set(
    [...source.matchAll(pattern)]
      .map((match) => match[1])
      .filter((channel) => channel.startsWith('developer-settings:')),
  );
}

function noOpSettingsServices() {
  const noop = () => ({});
  return {
    settings: {
      get: noop,
      update: noop,
      exportSettings: noop,
      importSettings: noop,
      getDeveloperSettings: noop,
      updateDeveloperSettings: noop,
      resetDeveloperSettings: noop,
      diagnostics: noop,
      updateLocale: noop,
    },
    permissions: { approve: noop, deny: noop },
  };
}

test('developer settings preload channels are cataloged and owned by developer-settings-ipc', () => {
  const rendererChannels = extractDeveloperSettingChannels(
    preloadSource,
    /ipcRenderer\.invoke\(['"]([^'"]+)['"]/g,
  );
  const descriptor = createSettingsIpcRegistrations(noOpSettingsServices())
    .find(({ owner }) => owner === 'developer-settings-ipc');
  const registeredChannels = new Set();
  descriptor.register({
    handle(channel) {
      registeredChannels.add(channel);
    },
  });

  assert.deepEqual(
    [...rendererChannels].sort(),
    [
      'developer-settings:diagnostics',
      'developer-settings:get',
      'developer-settings:reset',
      'developer-settings:update',
    ],
  );
  assert.deepEqual([...registeredChannels].sort(), [...rendererChannels].sort());

  for (const channel of rendererChannels) {
    const policy = getDesktopIpcPolicy(channel);
    assert.equal(policy?.owner, 'developer-settings-ipc');
    assert.equal(policy?.transport, 'invoke');
  }
});
