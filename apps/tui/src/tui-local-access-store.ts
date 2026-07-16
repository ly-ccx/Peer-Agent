import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  const readSettings = (): Record<string, unknown> => {
    if (!existsSync(settingsFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  };

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
