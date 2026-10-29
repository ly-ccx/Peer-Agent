import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadMigratedSettings, normalizeProjectAgentSettings, SETTINGS_MIGRATIONS } from '@peer-agent/runtime-node';
import { pathOf } from './data-store.mjs';

/**
 * 用户设置统一存储 —— `~/.peer-agent/settings.json`。
 *
 * 收口 renderer 侧设置（appearance / appMode / 后续新增），替代散落在 Chromium
 * localStorage 的做法，使其与 app 标识解耦、可随 ~/.peer-agent 一键迁移/导出。
 *
 * 结构为扁平命名空间，每类设置一个 key：
 *   { "appearance": {...}, "appMode": "work", ... }
 * 读整份 / 浅合并写；调用方（IPC）只传要变的那部分。
 *
 * settingsFile 可注入，便于单测隔离；默认走 data-store 注册中心的 pathOf('settings')。
 */
export function createSettingsStore({ settingsFile = pathOf('settings') } = {}) {
  function readAll() {
    return loadMigratedSettings(settingsFile);
  }

  function writeAll(obj) {
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(obj, null, 2), 'utf8');
  }

  function getAll() {
    return readAll();
  }

  // Runtime gates need fresh policy, not a repeated full workspace identity repair.
  // This projection cannot supply workspace/remote scope or permission truth.
  function getRuntimePolicy() {
    let settings;
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return {}; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
    const current = SETTINGS_MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
    if (!Number.isSafeInteger(settings.schemaVersion) || settings.schemaVersion < current) settings = readAll();
    const agent = normalizeProjectAgentSettings(settings.projectAgent), memory = settings.memory;
    return {
      projectAgent: Object.fromEntries(['shell', 'concurrency', 'proactivity', 'quietHours', 'digestTime']
        .map(key => [key, agent[key]])),
      memory: { enabled: memory?.enabled !== false, learnPreferences: memory?.learnPreferences !== false },
    };
  }

  /** 浅合并写入（只覆盖传入的顶层 key），返回合并后的完整设置。 */
  function merge(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return readAll();
    }
    const next = { ...readAll(), ...partial };
    writeAll(next);
    return next;
  }

  return { getAll, getRuntimePolicy, merge };
}
