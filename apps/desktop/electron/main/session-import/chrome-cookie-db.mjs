/**
 * 只读读取 Chromium Cookie SQLite（快照后查询）。
 * 使用系统 sqlite3 CLI，避免原生 better-sqlite3 依赖。
 * 不在此模块解密；只返回 host_key / name / 密文等字段。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

/**
 * 复制 Cookie DB（及 wal/shm）到私有临时目录。
 * @param {string} cookieDbPath
 * @param {{ fsImpl?: typeof fs, tmpDir?: string }} [options]
 */
export function snapshotCookieDatabase(cookieDbPath, options = {}) {
  const fsp = options.fsImpl || fs;
  if (!cookieDbPath || !fsp.existsSync(cookieDbPath)) {
    throw new Error('cookie_db_not_found');
  }
  const base = options.tmpDir || path.join(os.tmpdir(), `peer-session-import-${randomUUID()}`);
  fsp.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dest = path.join(base, 'Cookies');
  fsp.copyFileSync(cookieDbPath, dest);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const side = `${cookieDbPath}${suffix}`;
    if (fsp.existsSync(side)) {
      try {
        fsp.copyFileSync(side, `${dest}${suffix}`);
      } catch {
        /* ignore side file copy errors */
      }
    }
  }
  return { snapshotDir: base, snapshotDbPath: dest };
}

/** 删除快照目录。 */
export function removeSnapshot(snapshotDir, options = {}) {
  const fsp = options.fsImpl || fs;
  if (!snapshotDir) return;
  try {
    fsp.rmSync(snapshotDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 用 sqlite3 以 JSON 行读取 cookies 表。
 * @param {string} dbPath
 * @param {{ execFileImpl?: typeof execFileAsync }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function readCookieRowsFromSqlite(dbPath, options = {}) {
  const run = options.execFileImpl || execFileAsync;
  // 使用 sqlite3 -json（比 stdin .mode json 更稳，避免挂起）
  const sql = `
SELECT
  host_key AS host_key,
  name AS name,
  path AS path,
  expires_utc AS expires_utc,
  is_secure AS is_secure,
  is_httponly AS is_httponly,
  samesite AS samesite,
  has_expires AS has_expires,
  is_persistent AS is_persistent,
  hex(encrypted_value) AS encrypted_value_hex,
  length(encrypted_value) AS encrypted_value_len,
  CASE WHEN encrypted_value IS NULL OR length(encrypted_value)=0 THEN value ELSE NULL END AS plain_value
FROM cookies
`.trim();

  try {
    const { stdout } = await run('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '');
    if (/unknown option|unrecognized|JSON/i.test(msg)) {
      return readCookieRowsCsvFallback(dbPath, options);
    }
    throw new Error(`sqlite_read_failed:${msg.slice(0, 200)}`);
  }
}

async function readCookieRowsCsvFallback(dbPath, options = {}) {
  const run = options.execFileImpl || execFileAsync;
  const sql = `
SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, has_expires, is_persistent,
  hex(encrypted_value) AS encrypted_value_hex,
  length(encrypted_value) AS encrypted_value_len,
  CASE WHEN encrypted_value IS NULL OR length(encrypted_value)=0 THEN value ELSE '' END AS plain_value
FROM cookies
`.trim();
  const { stdout } = await run(
    'sqlite3',
    ['-csv', '-header', dbPath, sql],
    {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const lines = String(stdout || '').trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    /** @type {Record<string, unknown>} */
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 将 hex 密文转为 Buffer。
 * @param {string|null|undefined} hex
 */
export function hexToBuffer(hex) {
  if (!hex || typeof hex !== 'string') return Buffer.alloc(0);
  const clean = hex.trim();
  if (!clean) return Buffer.alloc(0);
  return Buffer.from(clean, 'hex');
}
