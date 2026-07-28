/**
 * Browser Password Vault（Phase 1）
 *
 * - 元数据明文：origin / username / timestamps（可列表）
 * - 密码：Electron safeStorage 加密后落盘（scheme 与 MCP 凭据一致）
 * - 不跨设备导出（data-store scope=device）
 * - 不投影给 Agent；仅用户面 IPC
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathOf } from './data-store.mjs';

const VERSION = 1;
const SAFE_STORAGE_SCHEME = 'electron.safeStorage';
const PLAINTEXT_FALLBACK_SCHEME = 'plaintext.local';
const require = createRequire(import.meta.url);

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getSafeStorage(adapter) {
  if (adapter) return adapter;
  try {
    // 懒加载：单测环境可能无 electron 包，可注入 safeStorage。
    return require('electron').safeStorage ?? null;
  } catch {
    return null;
  }
}

function canUseSafeStorage(safeStorage) {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

function encryptSecret(plaintext, safeStorage) {
  const secret = String(plaintext ?? '');
  if (canUseSafeStorage(safeStorage)) {
    const encrypted = safeStorage.encryptString(secret);
    return {
      encrypted: true,
      scheme: SAFE_STORAGE_SCHEME,
      data: Buffer.from(encrypted).toString('base64'),
    };
  }
  // 测试 / 无加密环境：明文落盘（与 MCP 凭据策略一致，生产应有 safeStorage）
  return {
    encrypted: false,
    scheme: PLAINTEXT_FALLBACK_SCHEME,
    data: secret,
  };
}

function decryptSecret(stored, safeStorage) {
  if (!stored || typeof stored !== 'object') return '';
  if (!stored.encrypted) return String(stored.data ?? '');
  if (stored.scheme !== SAFE_STORAGE_SCHEME) {
    throw new Error(`Unsupported password vault scheme: ${stored.scheme}`);
  }
  if (!canUseSafeStorage(safeStorage)) {
    throw new Error('Password vault encryption is not available on this device.');
  }
  return safeStorage.decryptString(Buffer.from(String(stored.data ?? ''), 'base64'));
}

/** 规范化 origin：只保留 scheme://host[:port] */
export function normalizeOrigin(input) {
  const raw = asString(input);
  if (!raw) return '';
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function loadVaultFile(file) {
  if (!existsSync(file)) return { version: VERSION, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      version: Number(parsed?.version) || VERSION,
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: VERSION, entries: [] };
  }
}

function saveVaultFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function toMeta(entry) {
  return {
    id: entry.id,
    origin: entry.origin,
    username: entry.username,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastUsedAt: entry.lastUsedAt || undefined,
    // 故意不含 password
  };
}

/**
 * @param {{ vaultFile?: string, safeStorage?: object }} [options]
 */
export function createPasswordVaultStore({
  vaultFile = pathOf('passwordVault'),
  safeStorage = getSafeStorage(),
} = {}) {
  function readAll() {
    return loadVaultFile(vaultFile);
  }

  function writeAll(data) {
    saveVaultFile(vaultFile, data);
  }

  return {
    /** 列表：仅 meta */
    listEntries() {
      const data = readAll();
      return data.entries
        .map(toMeta)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    /**
     * 新增或更新（同 origin+username 则更新密码）
     * @param {{ origin: string, username: string, password: string, id?: string }} input
     */
    upsertEntry(input = {}) {
      const origin = normalizeOrigin(input.origin);
      const username = asString(input.username);
      const password = String(input.password ?? '');
      if (!origin) throw new Error('invalid_origin');
      if (!username) throw new Error('invalid_username');
      if (!password) throw new Error('invalid_password');

      const data = readAll();
      const now = new Date().toISOString();
      let entry = null;

      if (input.id) {
        entry = data.entries.find((e) => e.id === input.id) || null;
      }
      if (!entry) {
        entry =
          data.entries.find(
            (e) => e.origin === origin && e.username === username,
          ) || null;
      }

      const secret = encryptSecret(password, safeStorage);

      if (entry) {
        entry.origin = origin;
        entry.username = username;
        entry.password = secret;
        entry.updatedAt = now;
      } else {
        entry = {
          id: randomUUID(),
          origin,
          username,
          password: secret,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        data.entries.push(entry);
      }

      writeAll(data);
      return toMeta(entry);
    },

    /** 删除 */
    deleteEntry(id) {
      const entryId = asString(id);
      if (!entryId) return { ok: false, error: 'invalid_id' };
      const data = readAll();
      const before = data.entries.length;
      data.entries = data.entries.filter((e) => e.id !== entryId);
      if (data.entries.length === before) return { ok: false, error: 'not_found' };
      writeAll(data);
      return { ok: true };
    },

    /**
     * 解密单条密码（用户手势后调用）。
     * 返回后调用方应尽快丢弃明文。
     */
    revealPassword(id) {
      const entryId = asString(id);
      if (!entryId) return { ok: false, error: 'invalid_id' };
      const data = readAll();
      const entry = data.entries.find((e) => e.id === entryId);
      if (!entry) return { ok: false, error: 'not_found' };
      try {
        const password = decryptSecret(entry.password, safeStorage);
        entry.lastUsedAt = new Date().toISOString();
        writeAll(data);
        return {
          ok: true,
          id: entry.id,
          origin: entry.origin,
          username: entry.username,
          password,
        };
      } catch (err) {
        return { ok: false, error: err?.message || 'decrypt_failed' };
      }
    },

    /** 按 origin 匹配（精确 origin；可选 host 后缀由调用方扩展） */
    listForOrigin(originInput) {
      const origin = normalizeOrigin(originInput);
      if (!origin) return [];
      return this.listEntries().filter((e) => e.origin === origin);
    },
  };
}
