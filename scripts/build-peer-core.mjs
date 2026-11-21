#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function peerCoreFilename(platform = process.platform) {
  return platform === 'win32'
    ? 'peer-native.exe'
    : 'peer-native';
}

export function peerCoreArtifactPath({
  repositoryRoot = REPOSITORY_ROOT,
  profile = 'release',
  platform = process.platform,
} = {}) {
  assertProfile(profile);
  return path.join(
    repositoryRoot,
    'target',
    profile,
    peerCoreFilename(platform),
  );
}

export function copyPeerCoreArtifact({
  repositoryRoot = REPOSITORY_ROOT,
  profile = 'release',
  platform = process.platform,
  destinationDirectory,
} = {}) {
  if (!destinationDirectory) {
    throw new Error('A destination directory is required when copying peer-native.');
  }

  const sourcePath = peerCoreArtifactPath({ repositoryRoot, profile, platform });
  if (!existsSync(sourcePath)) {
    throw new Error(`Peer core binary not found: ${sourcePath}`);
  }

  const resolvedDestination = path.isAbsolute(destinationDirectory)
    ? destinationDirectory
    : path.resolve(repositoryRoot, destinationDirectory);
  mkdirSync(resolvedDestination, { recursive: true, mode: 0o755 });

  const destinationPath = path.join(
    resolvedDestination,
    peerCoreFilename(platform),
  );
  copyFileSync(sourcePath, destinationPath);
  if (platform !== 'win32') {
    chmodSync(destinationPath, 0o755);
  }
  return destinationPath;
}

export function buildPeerCore({
  repositoryRoot = REPOSITORY_ROOT,
  profile = 'release',
  platform = process.platform,
  destinationDirectories = [],
  runner = spawnSync,
} = {}) {
  assertProfile(profile);
  const args = [
    'build',
    '--locked',
    '--package',
    'peer-cli',
    '--bin',
    'peer-native',
  ];
  if (profile === 'release') {
    args.push('--release');
  }

  const result = runner('cargo', args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`cargo exited with status ${result.status ?? 'unknown'}`);
  }

  const artifactPath = peerCoreArtifactPath({ repositoryRoot, profile, platform });
  if (!existsSync(artifactPath)) {
    throw new Error(`Peer core build completed without producing: ${artifactPath}`);
  }

  const copiedPaths = destinationDirectories.map((destinationDirectory) => (
    copyPeerCoreArtifact({
      repositoryRoot,
      profile,
      platform,
      destinationDirectory,
    })
  ));

  return { artifactPath, copiedPaths };
}

function assertProfile(profile) {
  if (profile !== 'debug' && profile !== 'release') {
    throw new Error(`Unsupported peer core build profile: ${profile}`);
  }
}

function parseArguments(argv) {
  let profile = 'release';
  const destinationDirectories = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--profile') {
      profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--copy-to') {
      const destination = argv[index + 1];
      if (!destination) {
        throw new Error('--copy-to requires a repository-relative or absolute directory.');
      }
      destinationDirectories.push(destination);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  assertProfile(profile);
  return { profile, destinationDirectories };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = buildPeerCore(options);
    console.log(`Peer core binary ready: ${result.artifactPath}`);
    for (const copiedPath of result.copiedPaths) {
      console.log(`Peer core binary copied: ${copiedPath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
