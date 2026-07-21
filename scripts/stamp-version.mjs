/**
 * stamp-version.mjs — 将指定版本号写入所有“版本事实源”文件。
 *
 * 用途：CI 中由 git tag 驱动版本（如 v0.0.1-beta.1）。tag 才是发布时的
 * 权威版本，但仓库内 VERSION / package.json / Cargo.toml / Cargo.lock 仍是
 * 基线版本（如 0.0.1）。本脚本把 tag 版本回写到这些文件，使得：
 *   1. electron-builder 打出的产物版本 == tag 版本；
 *   2. scripts/check-version.mjs 仍然“全量一致”从而通过校验。
 *
 * 这是 check-version.mjs 的“写”对偶，覆盖完全相同的文件集合，避免双事实源漂移。
 *
 * 用法：
 *   node scripts/stamp-version.mjs 0.0.1-beta.1
 *   node scripts/stamp-version.mjs v0.0.1        # 允许带前导 v
 *
 * 注意：本脚本只改工作区文件，不做 git 操作。提交/打 tag 由调用方负责。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const rawArg = process.argv[2];
if (!rawArg) {
  console.error('Usage: node scripts/stamp-version.mjs <version>');
  process.exit(1);
}

// 允许传入 v 前缀的 tag 名，统一去掉。
const version = rawArg.replace(/^v/, '').trim();

// 语义版本校验（含可选预发布段，如 -beta.1 / -rc.2 / -alpha.3）。
const SEMVER = /^\d+\.\d+\.\d+(-(?:alpha|beta|rc)\.\d+)?$/;
if (!SEMVER.test(version)) {
  console.error(
    `Invalid version: "${version}". Expected x.y.z or x.y.z-(alpha|beta|rc).N`,
  );
  process.exit(1);
}

const packageJsonFiles = [
  'package.json',
  'apps/desktop/package.json',
  'apps/tui/package.json',
  'packages/chat-kernel/package.json',
  'packages/i18n/package.json',
  'packages/npm-cli/package.json',
  'packages/task-thread/package.json',
  'packages/ui/package.json',
];

const cargoPackages = [
  ['peer-credential-helper', 'crates/peer-credential-helper/Cargo.toml'],
];

const changed = [];

// 1) VERSION
writeFileSync(join(root, 'VERSION'), `${version}\n`);
changed.push('VERSION');

// 2) package.json 集合（保留 2 空格缩进 + 末尾换行，与仓库既有风格一致）
for (const file of packageJsonFiles) {
  const abs = join(root, file);
  const json = JSON.parse(readFileSync(abs, 'utf8'));
  if (json.version !== version) {
    json.version = version;
    writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
    changed.push(file);
  }
}

// 3) Rust package manifests —— 只改各 [package] 段的首个 version 行
for (const [, file] of cargoPackages) {
  const abs = join(root, file);
  const toml = readFileSync(abs, 'utf8');
  const next = toml.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
  if (next !== toml) {
    writeFileSync(abs, next);
    changed.push(file);
  }
}

// 4) Cargo.lock —— 定位受治理的 Rust 包条目并替换其紧邻 version 行
{
  const file = 'Cargo.lock';
  const abs = join(root, file);
  const lock = readFileSync(abs, 'utf8');
  let next = lock;
  for (const [packageName] of cargoPackages) {
    next = next.replace(
      new RegExp(`(name = "${packageName}"\\nversion = ")[^"]*(")`),
      (_, prefix, suffix) => `${prefix}${version}${suffix}`,
    );
  }
  if (next !== lock) {
    writeFileSync(abs, next);
    changed.push(file);
  }
}

console.log(`Stamped version ${version} into:`);
for (const f of changed) console.log(`  - ${f}`);
