import { existsSync, mkdirSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 宙斯统一数据根 —— `~/.zeusos/`。
 *
 * 为什么不用 Electron `app.getPath('userData')`：那个路径绑 app 标识
 * （name/productName/appId），改名、升级、重装都可能换路径导致数据"消失"；
 * 且会跟 Chromium 运行时数据（Cache/Cookies/Local Storage/...）混在一起。
 *
 * `~/.zeusos/` 是固定的、与 app 标识解耦的家目录（对标 .claude / .qoderwork）。
 * 所有宙斯业务数据 + 后续配置（settings.json 等）+ 一键配置迁移都收口到这里，
 * 由本模块统一管理，不再让各 store 自己散拼路径。
 *
 * 本模块只依赖 os/fs/path（不 import electron），因此可被单测直接 import；
 * 迁移源（旧 userData）由调用方（main.mjs）传入，不在这里碰 app。
 */

/** 数据根，默认 ~/.zeusos，可用 ZEUS_ATLAS_HOME 覆盖（多环境 / 测试隔离）。 */
function resolveZeusHome() {
  const override = process.env.ZEUS_ATLAS_HOME;
  return override && override.trim()
    ? override.trim()
    : path.join(os.homedir(), '.zeusos');
}

/**
 * 数据项注册中心 —— 持久化数据的唯一权威声明，也是迁移 / 一键导出的枚举依据。
 * 新增任何持久化数据（如后续的 settings.json）只在这里加一行。
 *
 * scope 语义（服务一键配置迁移/导出）：
 * - device   设备绑定，不应跨设备导出（token、设备身份）
 * - portable 可随用户迁移/导出（skill、设置、授权规则）
 * - cache    临时产物，不迁移不导出（可重建）
 */
export const ZEUS_ENTRIES = {
  auth:              { rel: 'auth',                    kind: 'dir',  scope: 'device'   },
  deviceIdentity:    { rel: 'device-identity.json',    kind: 'file', scope: 'device'   },
  skills:            { rel: 'skills',                  kind: 'dir',  scope: 'portable' },
  mcpRegistry:       { rel: 'mcp-registry.json',       kind: 'file', scope: 'portable' },
  permissions:       { rel: 'permissions',             kind: 'dir',  scope: 'portable' },
  developerSettings: { rel: 'developer-settings.json', kind: 'file', scope: 'portable' },
  settings:          { rel: 'settings.json',           kind: 'file', scope: 'portable' },
  shellArtifacts:    { rel: 'shell-artifacts',         kind: 'dir',  scope: 'cache'    },
};

/** 返回数据根并确保其存在。mkdir recursive 对已存在目录是 no-op，可安全多次调用。 */
export function getZeusHome() {
  const home = resolveZeusHome();
  mkdirSync(home, { recursive: true });
  return home;
}

/** 取某个数据项的绝对路径（目录型返回目录，文件型返回文件）。 */
export function pathOf(key) {
  const entry = ZEUS_ENTRIES[key];
  if (!entry) throw new Error(`[zeus-store] unknown entry: ${key}`);
  return path.join(getZeusHome(), entry.rel);
}

/** 枚举数据项（可按 scope 过滤），供迁移 / 一键导出使用。 */
export function listEntries(filter = {}) {
  return Object.entries(ZEUS_ENTRIES)
    .filter(([, entry]) => !filter.scope || entry.scope === filter.scope)
    .map(([key, entry]) => ({ key, ...entry, path: path.join(getZeusHome(), entry.rel) }));
}

/**
 * 一次性从旧 Electron userData 把业务数据搬到 ~/.zeusos。
 *
 * - copy 不删：保留旧数据做回退，迁移出错不丢数据
 * - 幂等：目标已存在则跳过该项（靠 existsSync 判断，无需进程级 flag）
 * - 只搬 ZEUS_ENTRIES 里声明的项；Chromium 运行时数据不在其中，不迁
 */
export function migrateFromLegacy(legacyUserDataPath) {
  const home = getZeusHome();
  if (!legacyUserDataPath || legacyUserDataPath === home) return { migrated: [] };

  const done = [];
  for (const [key, entry] of Object.entries(ZEUS_ENTRIES)) {
    const from = path.join(legacyUserDataPath, entry.rel);
    const to = path.join(home, entry.rel);
    if (existsSync(from) && !existsSync(to)) {
      try {
        cpSync(from, to, { recursive: true });
        done.push(key);
      } catch (error) {
        console.warn(`[zeus-store] migrate failed for ${key}:`, error?.message ?? error);
      }
    }
  }
  if (done.length > 0) {
    console.log('[zeus-store] migrated from legacy userData:', done.join(', '));
  }
  return { migrated: done };
}

/**
 * 一键导出：把 scope=portable 的数据项 copy 到目标目录（用户选定）。
 * 用于跨设备迁移/备份；device（token/设备身份）与 cache（临时产物）不导出。
 */
export function exportBundle(targetDir) {
  if (!targetDir) return { exported: [], targetDir: null };
  mkdirSync(targetDir, { recursive: true });
  const exported = [];
  for (const entry of listEntries({ scope: 'portable' })) {
    if (!existsSync(entry.path)) continue;
    try {
      cpSync(entry.path, path.join(targetDir, entry.rel), { recursive: true });
      exported.push(entry.key);
    } catch (error) {
      console.warn(`[zeus-store] export failed for ${entry.key}:`, error?.message ?? error);
    }
  }
  return { exported, targetDir };
}

/**
 * 一键导入：从来源目录把 portable 项恢复回 ~/.zeusos（覆盖现有同名项）。
 * 只认 ZEUS_ENTRIES 里 portable 的项；来源目录里的其它内容忽略。
 */
export function importBundle(sourceDir) {
  if (!sourceDir) return { imported: [] };
  const home = getZeusHome();
  const imported = [];
  for (const entry of listEntries({ scope: 'portable' })) {
    const from = path.join(sourceDir, entry.rel);
    if (!existsSync(from)) continue;
    try {
      cpSync(from, path.join(home, entry.rel), { recursive: true, force: true });
      imported.push(entry.key);
    } catch (error) {
      console.warn(`[zeus-store] import failed for ${entry.key}:`, error?.message ?? error);
    }
  }
  return { imported };
}
