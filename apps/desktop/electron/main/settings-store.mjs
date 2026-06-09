import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
    if (!existsSync(settingsFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(obj) {
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(obj, null, 2), 'utf8');
  }

  function getAll() {
    return readAll();
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

  return { getAll, merge };
}
