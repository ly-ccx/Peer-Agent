#!/usr/bin/env node
/**
 * Assemble a CLI release archive: peer + peer-credential-helper side by side.
 *
 * Usage:
 *   node scripts/package-cli-archive.mjs [target]
 *
 * `target` is a platform.mjs key such as darwin-arm64 or linux-x64.
 * Defaults to the current process.platform-process.arch pair.
 *
 * Layout (same as the existing darwin-arm64 Release asset):
 *   cli-stage/peer-<target>/{peer,peer-credential-helper}
 *   cli-dist/peer-<target>.tar.gz
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePlatformTarget } from '../packages/npm-cli/lib/platform.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} spec
 * @returns {[string, string]}
 */
export function parseTargetSpec(spec) {
  if (spec.startsWith('win32-')) return ['win32', spec.slice('win32-'.length)];
  const idx = spec.lastIndexOf('-');
  if (idx <= 0 || idx === spec.length - 1) {
    throw new Error(`Invalid CLI target ${JSON.stringify(spec)}; expected platform-arch`);
  }
  return [spec.slice(0, idx), spec.slice(idx + 1)];
}

/**
 * @param {{
 *   targetSpec?: string,
 *   repositoryRoot?: string,
 *   distDir?: string,
 *   stageDir?: string,
 *   outputDir?: string,
 * }} [options]
 */
export function packageCliArchive(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? root;
  const targetSpec = options.targetSpec ?? `${process.platform}-${process.arch}`;
  const [platform, arch] = parseTargetSpec(targetSpec);
  const target = resolvePlatformTarget(platform, arch);
  if (!target) {
    throw new Error(`Unknown CLI target ${targetSpec}`);
  }

  const distDir = options.distDir ?? join(repositoryRoot, 'apps/tui/dist');
  const peerName = platform === 'win32' ? 'peer.exe' : 'peer';
  const helperName = platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper';
  const peerSrc = join(distDir, peerName);
  const helperSrc = join(distDir, helperName);
  if (!existsSync(peerSrc) || !existsSync(helperSrc)) {
    throw new Error(
      `Missing built CLI binaries in ${distDir} (need ${peerName} + ${helperName}). ` +
        'Run `pnpm --filter @peer-agent/tui build` first.',
    );
  }

  const folder = `peer-${target.os}-${target.arch}`;
  const archive = target.archive;
  if (!archive.endsWith('.tar.gz') && !archive.endsWith('.tgz')) {
    throw new Error(
      `package-cli-archive currently writes tar.gz only; ${folder} maps to ${archive}`,
    );
  }

  const stageRoot = options.stageDir ?? join(repositoryRoot, 'cli-stage');
  const outputDir = options.outputDir ?? join(repositoryRoot, 'cli-dist');
  const stage = join(stageRoot, folder);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const peerDest = join(stage, peerName);
  const helperDest = join(stage, helperName);
  copyFileSync(peerSrc, peerDest);
  copyFileSync(helperSrc, helperDest);
  if (platform !== 'win32') {
    chmodSync(peerDest, 0o755);
    chmodSync(helperDest, 0o755);
  }

  const archivePath = join(outputDir, archive);
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', stageRoot, folder], {
    encoding: 'utf8',
  });
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr || tar.stdout || tar.status}`);
  }

  return { target, folder, archive, archivePath, peerDest, helperDest };
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const result = packageCliArchive({ targetSpec: process.argv[2] });
  console.log(`Packaged CLI → ${result.archivePath}`);
}
