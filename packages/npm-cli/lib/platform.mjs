/**
 * Map Node process.platform / process.arch to the GitHub Release CLI archive name.
 *
 * First-class Release assets: peer-darwin-arm64.tar.gz, peer-linux-x64.tar.gz.
 * Other keys stay recognized so installers fail with a precise
 * "not yet published" message instead of inventing a wrong URL.
 */

/** @typedef {{ os: string, arch: string, archive: string, supported: boolean }} PlatformTarget */

const TARGETS = {
  'darwin-arm64': {
    os: 'darwin',
    arch: 'arm64',
    archive: 'peer-darwin-arm64.tar.gz',
    supported: true,
  },
  'darwin-x64': {
    os: 'darwin',
    arch: 'x64',
    archive: 'peer-darwin-x64.tar.gz',
    supported: false,
  },
  'linux-arm64': {
    os: 'linux',
    arch: 'arm64',
    archive: 'peer-linux-arm64.tar.gz',
    supported: false,
  },
  'linux-x64': {
    os: 'linux',
    arch: 'x64',
    archive: 'peer-linux-x64.tar.gz',
    supported: true,
  },
  'win32-x64': {
    os: 'win32',
    arch: 'x64',
    archive: 'peer-win32-x64.zip',
    supported: false,
  },
};

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {PlatformTarget | null}
 */
export function resolvePlatformTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return TARGETS[key] ?? null;
}

/**
 * @param {string} version semver without leading v
 * @param {PlatformTarget} target
 * @param {{ owner?: string, repo?: string }} [opts]
 */
export function releaseAssetUrl(version, target, opts = {}) {
  const owner = opts.owner ?? process.env.PEER_AGENT_GITHUB_OWNER ?? 'ly-ccx';
  const repo = opts.repo ?? process.env.PEER_AGENT_GITHUB_REPO ?? 'Peer-Agent';
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${target.archive}`;
}

export function listKnownTargets() {
  return Object.values(TARGETS);
}
