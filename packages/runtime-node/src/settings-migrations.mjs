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
import { createProjectRegistry, isRemoteWorkspaceId } from './project-registry.mjs';

/** @typedef {{ version: number, up: (settings: Record<string, unknown>, ctx: { now: () => Date, registryFile?: string | null, projectRegistry?: object | null }) => Record<string, unknown> }} SettingsMigration */

/**
 * 给 schemaVersion 2 的设置补上稳定项目 id。
 * 已有 id 且注册表能按路径对上时不改设置。旧的远程 workspaceId 若不是项目 id，记为活动项目的 remoteAlias。
 * @param {Record<string, unknown>} settings
 * @param {ReturnType<typeof createProjectRegistry>} registry
 */
export function reconcileWorkspaceIdentity(settings, registry) {
  if (!settings || settings.schemaVersion !== 2 || !registry) return { settings, changed: false };
  let changed = false;
  let workspaces = settings.workspaces;
  if (Array.isArray(settings.workspaces)) {
    const entries = registry.sync(settings.workspaces);
    let workspaceChanged = false;
    const next = settings.workspaces.map((workspace, index) => {
      const entry = entries[index];
      if (!entry || !workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return workspace;
      if (workspace.id === entry.workspaceId) return workspace;
      workspaceChanged = true;
      return { ...workspace, id: entry.workspaceId };
    });
    if (workspaceChanged) {
      workspaces = next;
      changed = true;
    }
  }

  let remoteAccess = settings.remoteAccess;
  if (remoteAccess && typeof remoteAccess === 'object' && !Array.isArray(remoteAccess)) {
    const current = typeof remoteAccess.workspaceId === 'string' ? remoteAccess.workspaceId.trim() : '';
    const projects = registry.list();
    const known = projects.some((item) => item.workspaceId === current);
    if (current && !known) {
      const aliased = projects.find((item) => item.remoteAlias === current);
      const activeEntry = typeof settings.activeWorkspace === 'string'
        ? registry.findByPath(settings.activeWorkspace)
        : null;
      const listed = Array.isArray(workspaces) ? workspaces : [];
      const active = aliased
        ? { id: aliased.workspaceId }
        : listed.find((item) => activeEntry && item && item.id === activeEntry.workspaceId)
          ?? listed.find((item) => item && typeof item.id === 'string')
          ?? null;
      if (aliased && active.id) {
        remoteAccess = { ...remoteAccess, workspaceId: active.id };
        changed = true;
      } else if (active?.id && isRemoteWorkspaceId(current) && current !== active.id) {
        const set = registry.setRemoteAlias(active.id, current);
        if (set.ok) {
          remoteAccess = { ...remoteAccess, workspaceId: active.id };
          changed = true;
        }
      }
    }
  }

  if (!changed) return { settings, changed: false };
  return {
    changed: true,
    settings: {
      ...settings,
      ...(Array.isArray(settings.workspaces) ? { workspaces } : {}),
      ...(remoteAccess !== settings.remoteAccess ? { remoteAccess } : {}),
    },
  };
}

function registryFor(ctx) {
  if (ctx.projectRegistry) return ctx.projectRegistry;
  return createProjectRegistry({
    filePath: ctx.registryFile ?? null,
    now: ctx.now,
  });
}

/** @type {SettingsMigration[]} */
export const SETTINGS_MIGRATIONS = [
  {
    version: 1,
    up(settings) {
      return { ...settings, schemaVersion: 1 };
    },
  },
  {
    version: 2,
    up(settings, ctx) {
      return reconcileWorkspaceIdentity({ ...settings, schemaVersion: 2 }, registryFor(ctx)).settings;
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
  registryFile = null,
  projectRegistry = null,
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
      const updated = migration.up({ ...next }, { now, registryFile, projectRegistry });
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

  const now = options.now ?? (() => new Date());
  const migrations = options.migrations ?? SETTINGS_MIGRATIONS;
  const knowsIdentity = migrations.some((migration) => migration.version === 2);
  const registryFile = options.registryFile
    ?? path.join(path.dirname(settingsFile), 'projects', 'registry.json');
  const projectRegistry = options.projectRegistry
    ?? (knowsIdentity ? createProjectRegistry({ filePath: registryFile, now }) : null);
  const result = runSettingsMigrations({
    settings: original,
    migrations,
    now,
    log: options.log,
    registryFile,
    projectRegistry,
  });
  let settings = result.settings;
  let changed = result.applied.length > 0;
  if (projectRegistry && currentVersion(settings) === 2) {
    const repaired = reconcileWorkspaceIdentity(settings, projectRegistry);
    settings = repaired.settings;
    changed = changed || repaired.changed;
  }
  if (!changed) return settings;

  try {
    const directory = path.dirname(settingsFile);
    mkdirSync(directory, { recursive: true });
    if (result.applied.length > 0) {
      const backup = path.join(directory, backupName(settingsFile, currentVersion(original), now));
      copyFileSync(settingsFile, backup);
      pruneBackups(directory, path.basename(settingsFile));
    }
    writeAtomically(settingsFile, settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.log ?? console.error)(`[settings-migration] ${message}`);
    return asSettings(original);
  }
  return settings;
}
