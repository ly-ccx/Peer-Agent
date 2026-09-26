import { mkdirSync, writeFileSync } from 'node:fs';
import { loadMigratedSettings } from '@peer-agent/runtime-node';
import path from 'node:path';

import type { LocalAccessLevel } from '@peer-agent/protocol';

import { normalizeLocalAccessLevel } from './tui-permission-policy.ts';

export interface TuiLocalAccessStore {
  getAccessLevel(): LocalAccessLevel;
  setAccessLevel(value: unknown): LocalAccessLevel;
}

export function createTuiLocalAccessStore({
  userDataPath,
}: {
  readonly userDataPath: string;
}): TuiLocalAccessStore {
  const settingsFile = path.join(userDataPath, 'settings.json');

  const readSettings = (): Record<string, unknown> => loadMigratedSettings(settingsFile);

  return {
    getAccessLevel() {
      return normalizeLocalAccessLevel(readSettings().localAccessLevel);
    },
    setAccessLevel(value) {
      const localAccessLevel = normalizeLocalAccessLevel(value);
      const next = { ...readSettings(), localAccessLevel };
      mkdirSync(userDataPath, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
      return localAccessLevel;
    },
  };
}
