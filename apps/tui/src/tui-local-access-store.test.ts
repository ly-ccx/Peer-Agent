import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTuiLocalAccessStore } from './tui-local-access-store.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TUI shared local-access settings', () => {
  test('reads and updates the desktop settings file without dropping unrelated preferences', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'peer-tui-access-'));
    roots.push(userDataPath);
    const settingsFile = path.join(userDataPath, 'settings.json');
    await Bun.write(settingsFile, JSON.stringify({ appearance: { theme: 'dark' }, localAccessLevel: 'session_local' }));
    const store = createTuiLocalAccessStore({ userDataPath });

    expect(store.getAccessLevel()).toBe('session_local');
    expect(store.setAccessLevel('full_local')).toBe('full_local');
    expect(await Bun.file(settingsFile).json()).toEqual({
      appearance: { theme: 'dark' },
      localAccessLevel: 'full_local',
    });
  });

  test('fails safely to ask for missing, invalid, or corrupt settings', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'peer-tui-access-'));
    roots.push(userDataPath);
    const store = createTuiLocalAccessStore({ userDataPath });

    expect(store.getAccessLevel()).toBe('ask_before_local');
    await Bun.write(path.join(userDataPath, 'settings.json'), '{broken');
    expect(store.getAccessLevel()).toBe('ask_before_local');
  });
});
