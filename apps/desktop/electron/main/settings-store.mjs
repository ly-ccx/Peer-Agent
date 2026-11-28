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
function sanitizeRuntimeModelRouting(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (raw.tiers && typeof raw.tiers === 'object' && !Array.isArray(raw.tiers)) {
    const tiers = {};
    for (const tier of ['strong', 'fast', 'economy', 'vision']) {
      const binding = raw.tiers[tier];
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
      const clean = {};
      if (typeof binding.primary === 'string' && binding.primary.trim()) clean.primary = binding.primary.trim();
      if (Array.isArray(binding.fallbacks)) clean.fallbacks = binding.fallbacks.filter(v => typeof v === 'string' && v.trim());
      if (typeof binding.reasoningEffort === 'string' && binding.reasoningEffort.trim()) clean.reasoningEffort = binding.reasoningEffort.trim();
      if (typeof binding.fastMode === 'boolean') clean.fastMode = binding.fastMode;
      if (clean.primary) tiers[tier] = clean;
    }
    if (Object.keys(tiers).length > 0) out.tiers = tiers;
  }
  if (raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles)) {
    const roles = {};
    for (const role of ['project_agent', 'session_worker', 'explorer', 'verifier', 'visual_verifier', 'memory_curator', 'objective_probe', 'compactor', 'input_predictor']) {
      const setting = raw.roles[role];
      if (!setting || typeof setting !== 'object' || Array.isArray(setting)) continue;
      const clean = {};
      if (typeof setting.mode === 'string') clean.mode = setting.mode;
      if (typeof setting.tier === 'string') clean.tier = setting.tier;
      if (typeof setting.modelProviderId === 'string') clean.modelProviderId = setting.modelProviderId;
      if (Array.isArray(setting.pool)) clean.pool = setting.pool.filter(v => typeof v === 'string' && v.trim());
      if (setting.reasoningEffort === null || typeof setting.reasoningEffort === 'string') clean.reasoningEffort = setting.reasoningEffort;
      if (typeof setting.fastMode === 'boolean') clean.fastMode = setting.fastMode;
      if (clean.mode) roles[role] = clean;
    }
    if (Object.keys(roles).length > 0) out.roles = roles;
  }
  if (typeof raw.verifierPreferDifferentFamily === 'boolean') {
    out.verifierPreferDifferentFamily = raw.verifierPreferDifferentFamily;
  }
  if (typeof raw.dailySpendCapUsd === 'number' && Number.isFinite(raw.dailySpendCapUsd)) {
    out.dailySpendCapUsd = raw.dailySpendCapUsd;
  }
  if (raw.roleSpendCaps && typeof raw.roleSpendCaps === 'object' && !Array.isArray(raw.roleSpendCaps)) {
    const caps = {};
    for (const [key, value] of Object.entries(raw.roleSpendCaps)) {
      if (typeof value === 'number' && Number.isFinite(value)) caps[key] = value;
    }
    if (Object.keys(caps).length > 0) out.roleSpendCaps = caps;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createSettingsStore({ settingsFile = pathOf('settings'), onChange = null } = {}) {
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
    const modelRouting = sanitizeRuntimeModelRouting(settings.modelRouting);
    return {
      projectAgent: Object.fromEntries(['shell', 'concurrency', 'proactivity', 'communicationStyle', 'quietHours', 'digestTime', 'interactiveResults']
        .map(key => [key, agent[key]])),
      memory: { enabled: memory?.enabled !== false, learnPreferences: memory?.learnPreferences !== false },
      ...(modelRouting ? { modelRouting } : {}),
    };
  }

  /** 浅合并写入（只覆盖传入的顶层 key），返回合并后的完整设置。 */
  function merge(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return readAll();
    }
    const next = { ...readAll(), ...partial };
    writeAll(next);
    if (typeof onChange === 'function') {
      try {
        onChange(partial, next);
      } catch {
        // listener errors must not roll back persisted settings
      }
    }
    return next;
  }

  return { getAll, getRuntimePolicy, merge };
}
