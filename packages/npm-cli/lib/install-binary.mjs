import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { peerBinaryPath, helperBinaryPath, vendorDir } from './paths.mjs';
import { releaseAssetUrl, resolvePlatformTarget } from './platform.mjs';

/**
 * @param {{
 *   version: string,
 *   root?: string,
 *   platform?: string,
 *   arch?: string,
 *   fetchImpl?: typeof fetch,
 *   skipDownload?: boolean,
 *   force?: boolean,
 *   log?: (msg: string) => void,
 * }} options
 */
export async function installBinary(options) {
  const log = options.log ?? ((msg) => console.log(msg));
  const root = options.root;
  if (!root) throw new Error('installBinary: root is required');
  const version = options.version;
  if (!version) throw new Error('installBinary: version is required');

  if (options.skipDownload || process.env.PEER_AGENT_SKIP_DOWNLOAD === '1') {
    log('[@peer-agent/cli] PEER_AGENT_SKIP_DOWNLOAD=1 — skipping binary download');
    return { skipped: true, reason: 'skip-download' };
  }

  const target = resolvePlatformTarget(options.platform, options.arch);
  if (!target) {
    throw new Error(
      `Unsupported platform ${options.platform ?? process.platform}/${options.arch ?? process.arch}. ` +
        'Peer Agent npm CLI currently supports platforms published on GitHub Releases.',
    );
  }
  if (!target.supported) {
    throw new Error(
      `Platform ${target.os}-${target.arch} is recognized but not yet published as a Release asset ` +
        `(expected ${target.archive}). Download a manual archive from GitHub Releases, or wait for multi-platform CLI builds.`,
    );
  }

  const vendor = vendorDir(root);
  const peerPath = peerBinaryPath(root);
  const helperPath = helperBinaryPath(root);
  const markerPath = join(vendor, '.peer-agent-version');

  if (
    !options.force &&
    existsSync(peerPath) &&
    existsSync(helperPath) &&
    existsSync(markerPath) &&
    readFileSync(markerPath, 'utf8').trim() === version
  ) {
    log(`[@peer-agent/cli] vendor binaries already present for ${version}`);
    return { skipped: true, reason: 'already-installed', peerPath, helperPath };
  }

  const url = process.env.PEER_AGENT_RELEASE_URL || releaseAssetUrl(version, target);
  log(`[@peer-agent/cli] downloading ${url}`);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available; Node.js 20+ is required');
  }

  const response = await fetchImpl(url, {
    headers: { 'User-Agent': `@peer-agent/cli/${version}` },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download CLI archive (${response.status} ${response.statusText}): ${url}\n` +
        `Check that this version published ${target.archive} on GitHub Releases.`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), 'peer-agent-npm-'));
  const archivePath = join(tmp, target.archive);
  try {
    const body = response.body;
    if (!body) throw new Error('Empty response body from GitHub Releases');
    await pipeline(body, createWriteStream(archivePath));

    const extractDir = join(tmp, 'extract');
    mkdirSync(extractDir, { recursive: true });
    extractArchive(archivePath, extractDir, target.archive);

    const found = findBinaries(extractDir);
    if (!found.peer || !found.helper) {
      throw new Error(
        `Archive did not contain peer + peer-credential-helper (found peer=${Boolean(found.peer)} helper=${Boolean(found.helper)})`,
      );
    }

    mkdirSync(vendor, { recursive: true });
    copyFileSync(found.peer, peerPath);
    copyFileSync(found.helper, helperPath);
    try {
      chmodSync(peerPath, 0o755);
      chmodSync(helperPath, 0o755);
    } catch {
      // Windows no-op
    }
    writeFileSync(markerPath, `${version}\n`);

    log(`[@peer-agent/cli] installed peer + peer-credential-helper → ${vendor}`);
    return { skipped: false, peerPath, helperPath, url };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {string} archivePath
 * @param {string} extractDir
 * @param {string} archiveName
 */
function extractArchive(archivePath, extractDir, archiveName) {
  if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) {
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`tar extract failed: ${result.stderr || result.stdout || result.status}`);
    }
    return;
  }
  if (archiveName.endsWith('.zip')) {
    // Prefer system unzip when present (stage-2 windows).
    const result = spawnSync('unzip', ['-o', archivePath, '-d', extractDir], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `unzip extract failed: ${result.stderr || result.stdout || result.status}. ` +
          'Install unzip or use a tar.gz asset.',
      );
    }
    return;
  }
  throw new Error(`Unsupported archive format: ${archiveName}`);
}

/**
 * Walk extract tree for peer + helper (archive may nest peer-<platform>-<arch>/).
 * @param {string} dir
 * @returns {{ peer: string | null, helper: string | null }}
 */
export function findBinaries(dir) {
  let peer = null;
  let helper = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'peer' || entry.name === 'peer.exe') peer = full;
      if (entry.name === 'peer-credential-helper' || entry.name === 'peer-credential-helper.exe') {
        helper = full;
      }
    }
  }
  // Prefer executable-looking files when duplicates exist
  if (peer && !statSync(peer).isFile()) peer = null;
  if (helper && !statSync(helper).isFile()) helper = null;
  return { peer, helper };
}
