#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const teamIdentifier = '82672N97RP';

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.status}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifySignedHelper(path, run) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path]);
  const identity = run('/usr/bin/codesign', ['--display', '--verbose=4', path]);
  if (!/^Authority=Developer ID Application:/m.test(identity)) {
    throw new Error('CLI helper must have a Developer ID Application signature');
  }
  if (!/^Identifier=peer-credential-helper\r?$/m.test(identity)) {
    throw new Error('CLI helper Identifier must be peer-credential-helper');
  }
  if (!new RegExp(`^TeamIdentifier=${teamIdentifier}\\r?$`, 'm').test(identity)) {
    throw new Error(`CLI helper TeamIdentifier must be ${teamIdentifier}`);
  }
  if (run('/usr/bin/lipo', ['-archs', path]).trim() !== 'arm64') {
    throw new Error('CLI helper architecture must be arm64');
  }
}

/**
 * Reuse the same-run signed Desktop helper at build time. The CLI archive remains
 * self-contained and requires neither Desktop installation nor Electron at runtime.
 */
export function prepareMacosCliHelper({
  expectedVersion,
  artifactDir = join(repositoryRoot, 'signed-desktop'),
  distDir = join(repositoryRoot, 'apps/tui/dist'),
  platform = process.platform,
  temporaryRoot = tmpdir(),
  runCommand: run = runCommand,
} = {}) {
  if (platform !== 'darwin') throw new Error('Signed CLI helper assembly requires macOS');
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(expectedVersion)) {
    throw new Error('Expected a release version');
  }
  const archive = join(artifactDir, `Peer-Agent-${expectedVersion}-arm64.zip`);
  if (!existsSync(archive)) throw new Error(`Same-version signed desktop archive missing: ${archive}`);
  if (!statSync(distDir).isDirectory()) throw new Error('CLI dist must be an existing directory');

  const extraction = mkdtempSync(join(temporaryRoot, 'peer-cli-desktop-'));
  let staging;
  try {
    run('/usr/bin/ditto', ['-x', '-k', archive, extraction]);
    const app = join(extraction, 'Peer Agent.app');
    const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).trim();
    if (version !== expectedVersion) throw new Error(`Desktop version mismatch: expected ${expectedVersion}, got ${version}`);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const source = join(app, 'Contents/Resources/bin/peer-credential-helper');
    verifySignedHelper(source, run);
    const sourceSha256 = sha256(source);

    // Verify the complete replacement before replacing the original built helper.
    staging = mkdtempSync(join(distDir, '.peer-cli-helper-'));
    const stagedHelper = join(staging, 'peer-credential-helper');
    copyFileSync(source, stagedHelper);
    chmodSync(stagedHelper, 0o755);
    if (sha256(stagedHelper) !== sourceSha256) throw new Error('CLI helper signature bytes changed during copy');
    verifySignedHelper(stagedHelper, run);
    const helperPath = join(distDir, 'peer-credential-helper');
    renameSync(stagedHelper, helperPath);
    return { version, helperPath, sha256: sourceSha256, identifier: 'peer-credential-helper', teamIdentifier };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(extraction, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(prepareMacosCliHelper({ expectedVersion: process.argv[2], artifactDir: process.argv[3], distDir: process.argv[4] })));
}
