import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** @typedef {{ version: number, up: (settings: Record<string, unknown>, ctx: { now: () => Date }) => Record<string, unknown> }} SettingsMigration */

/** @type {SettingsMigration[]} */
export const SETTINGS_MIGRATIONS = [
  {
    version: 1,
    up(settings) {
      return { ...settings, schemaVersion: 1 };
    },
  },
];

const BACKUP_LIMIT = 5;

function asSettings(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function currentVersion(settings) {
  const value = settings.schemaVersion;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * @param {{ settings?: unknown, migrations?: SettingsMigration[], now?: () => Date, log?: (message: string) => void }} [options]
 */
export function runSettingsMigrations({
  settings,
  migrations = SETTINGS_MIGRATIONS,
  now = () => new Date(),
  log = console.error,
} = {}) {
  const original = asSettings(settings);
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const maxKnown = ordered.reduce((max, migration) => Math.max(max, migration.version), 0);
  const from = currentVersion(original);
  if (from > maxKnown) return { settings: original, applied: [] };

  let next = original;
  let version = from;
  const applied = [];
  try {
    for (const migration of ordered) {
      if (migration.version <= version) continue;
      if (migration.version !== version + 1) break;
      const updated = migration.up({ ...next }, { now });
      if (!updated || typeof updated !== 'object' || Array.isArray(updated)) {
        throw new Error(`settings migration ${migration.version} did not return an object`);
      }
      next = updated;
      version = migration.version;
      applied.push(migration.version);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[settings-migration] ${message}`);
    return { settings: original, applied: [] };
  }
  return { settings: next, applied };
}

function backupName(settingsFile, fromVersion, now) {
  const stamp = now().toISOString().replace(/:/g, '-');
  return `${path.basename(settingsFile)}.bak-v${fromVersion}-${stamp}`;
}

function pruneBackups(directory, settingsName) {
  const prefix = `${settingsName}.bak-v`;
  const backups = readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, mtimeMs: statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  for (const stale of backups.slice(BACKUP_LIMIT)) {
    unlinkSync(path.join(directory, stale.name));
  }
}

function writeAtomically(settingsFile, settings) {
  const temporary = `${settingsFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(temporary, settingsFile);
}

/**
 * Read settings and apply pending migrations. A missing or unreadable file stays absent.
 * A newer schema than this build understands is returned unchanged.
 * @param {string} settingsFile
 * @param {{ migrations?: SettingsMigration[], now?: () => Date, log?: (message: string) => void }} [options]
 */
export function loadMigratedSettings(settingsFile, options = {}) {
  if (!existsSync(settingsFile)) return {};
  let original;
  try {
    original = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
  if (!original || typeof original !== 'object' || Array.isArray(original)) return {};

  const result = runSettingsMigrations({ settings: original, ...options });
  if (result.applied.length === 0) return result.settings;

  try {
    const directory = path.dirname(settingsFile);
    mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, backupName(settingsFile, currentVersion(original), options.now ?? (() => new Date())));
    copyFileSync(settingsFile, backup);
    pruneBackups(directory, path.basename(settingsFile));
    writeAtomically(settingsFile, result.settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.log ?? console.error)(`[settings-migration] ${message}`);
    return asSettings(original);
  }
  return result.settings;
}
