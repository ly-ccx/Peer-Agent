#!/usr/bin/env node
/**
 * Assemble a CLI release archive with peer, the credential helper and the Linux maintenance launcher.
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
 *   native?: boolean,
 *   cargoReleaseDir?: string,
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

  const peerName = platform === 'win32' ? 'peer.exe' : 'peer';
  const helperName = platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper';
  let peerSrc;
  let helperSrc;
  if (options.native) {
    const cargoDir = options.cargoReleaseDir ?? join(repositoryRoot, 'target/release');
    const nativePeerName = platform === 'win32' ? 'peer-native.exe' : 'peer-native';
    peerSrc = join(cargoDir, nativePeerName);
    helperSrc = join(cargoDir, helperName);
    if (!existsSync(peerSrc) || !existsSync(helperSrc)) {
      throw new Error(
        `Missing built native Rust CLI binaries in ${cargoDir} (need ${nativePeerName} + ${helperName}). ` +
          'Run `cargo build --locked --release -p peer-cli --bin peer-native -p peer-credential-helper --bin peer-credential-helper` first.',
      );
    }
  } else {
    const distDir = options.distDir ?? join(repositoryRoot, 'apps/tui/dist');
    peerSrc = join(distDir, peerName);
    helperSrc = join(distDir, helperName);
    if (!existsSync(peerSrc) || !existsSync(helperSrc)) {
      throw new Error(
        `Missing built CLI binaries in ${distDir} (need ${peerName} + ${helperName}). ` +
          'Build native CLI binaries or pass --native / --dist-dir <dir>.',
      );
    }
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
  if (platform === 'linux') {
    const launcher = join(stage, 'peer-interactive-maintenance');
    copyFileSync(join(repositoryRoot, 'apps/tui/scripts/interactive-maintenance-linux.py'), launcher);
    chmodSync(launcher, 0o755);
  }
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
  const args = process.argv.slice(2);
  let native = false;
  let distDir;
  let targetSpec;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--native') {
      native = true;
    } else if (arg === '--dist-dir') {
      distDir = args[++i];
      if (!distDir) throw new Error('--dist-dir requires a path');
    } else if (!arg.startsWith('-')) {
      targetSpec = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  const result = packageCliArchive({ targetSpec, native, distDir });
  console.log(`Packaged CLI → ${result.archivePath}`);
}
