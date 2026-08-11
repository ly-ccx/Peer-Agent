import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolvePeerCliVersion } from './cli-version.ts';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_REPOSITORY = 'ly-ccx/Peer-Agent';
const UPDATE_STATE_PATH = join(homedir(), '.peer-agent', 'cli-update.json');

export type CliInstallSource = 'npm' | 'pnpm' | 'release';
export type CliUpdateInfo = {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly source: CliInstallSource;
  readonly releaseUrl: string;
};
export type CliUpdateStatus =
  | { readonly phase: 'idle' | 'checking' }
  | { readonly phase: 'available'; readonly update: CliUpdateInfo }
  | { readonly phase: 'installing'; readonly update: CliUpdateInfo }
  | { readonly phase: 'installed'; readonly update: CliUpdateInfo }
  | { readonly phase: 'failed'; readonly update: CliUpdateInfo; readonly error: string }
  | { readonly phase: 'dismissed' };

type GithubRelease = {
  readonly tag_name?: string;
  readonly html_url?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly assets?: readonly { readonly name?: string; readonly browser_download_url?: string }[];
};

export function parseVersion(value: string): readonly number[] | null {
  const match = value.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

export function updateChannel(version: string): 'stable' | 'beta' {
  return version.includes('-beta.') ? 'beta' : 'stable';
}

export function resolveInstallSource(env: NodeJS.ProcessEnv = process.env): CliInstallSource {
  return env.PEER_AGENT_INSTALL_SOURCE === 'pnpm'
    ? 'pnpm'
    : env.PEER_AGENT_INSTALL_SOURCE === 'npm'
      ? 'npm'
      : 'release';
}

export function shouldCheckForUpdates(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
} = {}): boolean {
  const env = options.env ?? process.env;
  return env.PEER_AGENT_NO_UPDATE_CHECK !== '1'
    && !env.CI
    && (options.stdinIsTTY ?? Boolean(process.stdin.isTTY))
    && (options.stdoutIsTTY ?? Boolean(process.stdout.isTTY));
}

async function readLastCheck(path = UPDATE_STATE_PATH): Promise<number> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as { checkedAt?: number };
    return Number(state.checkedAt) || 0;
  } catch {
    return 0;
  }
}

async function recordCheck(now: number, path = UPDATE_STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ checkedAt: now })}\n`, 'utf8');
}

export async function checkForCliUpdate(options: {
  readonly currentVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly statePath?: string;
  readonly force?: boolean;
} = {}): Promise<CliUpdateInfo | null> {
  const env = options.env ?? process.env;
  const currentVersion = options.currentVersion ?? resolvePeerCliVersion(env);
  if (!parseVersion(currentVersion)) return null;
  const now = options.now ?? Date.now();
  const statePath = options.statePath ?? UPDATE_STATE_PATH;
  if (!options.force && now - await readLastCheck(statePath) < (options.intervalMs ?? DEFAULT_INTERVAL_MS)) return null;
  await recordCheck(now, statePath);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const repository = env.PEER_AGENT_GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
    const response = await (options.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${repository}/releases?per_page=20`,
      { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!response.ok) return null;
    const releases = await response.json() as GithubRelease[];
    const channel = updateChannel(currentVersion);
    const candidates = releases.filter((release) => {
      if (release.draft || !release.tag_name || !parseVersion(release.tag_name)) return false;
      return channel === 'beta' ? release.prerelease === true : release.prerelease !== true;
    });
    candidates.sort((a, b) => compareVersions(b.tag_name!, a.tag_name!));
    const latest = candidates[0];
    if (!latest?.tag_name || compareVersions(currentVersion, latest.tag_name) >= 0) return null;
    return {
      currentVersion,
      latestVersion: latest.tag_name.replace(/^v/, ''),
      source: resolveInstallSource(env),
      releaseUrl: latest.html_url ?? `https://github.com/${repository}/releases/tag/${latest.tag_name}`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code ?? 'unknown'}`)));
  });
}

function archiveName(platform = process.platform, arch = process.arch): string {
  return `peer-${platform}-${arch}.tar.gz`;
}

async function findReleaseBinaries(root: string): Promise<{ peer: string; helper: string } | null> {
  let peer = '';
  let helper = '';
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === (process.platform === 'win32' ? 'peer.exe' : 'peer')) peer = path;
      else if (entry.name === (process.platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper')) helper = path;
    }
  };
  await visit(root);
  return peer && helper ? { peer, helper } : null;
}

async function installReleaseUpdate(update: CliUpdateInfo, env: NodeJS.ProcessEnv): Promise<void> {
  const repository = env.PEER_AGENT_GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
  const archive = archiveName();
  const url = `https://github.com/${repository}/releases/download/v${update.latestVersion}/${archive}`;
  const temporary = await mkdtemp(join(tmpdir(), 'peer-update-'));
  const archivePath = join(temporary, archive);
  const extracted = join(temporary, 'extracted');
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    await mkdir(extracted);
    await run('tar', ['-xzf', archivePath, '-C', extracted]);
    const executable = process.execPath;
    const helper = join(dirname(executable), process.platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper');
    const binaries = await findReleaseBinaries(extracted);
    if (!binaries) throw new Error('release archive does not contain peer and peer-credential-helper');
    const stagedPeer = `${executable}.next`;
    const stagedHelper = `${helper}.next`;
    const backupPeer = `${executable}.previous`;
    const backupHelper = `${helper}.previous`;
    await rm(stagedPeer, { force: true });
    await rm(stagedHelper, { force: true });
    await copyFile(binaries.peer, stagedPeer);
    await copyFile(binaries.helper, stagedHelper);
    await chmod(stagedPeer, 0o755);
    await chmod(stagedHelper, 0o755);
    await rm(backupPeer, { force: true });
    await rm(backupHelper, { force: true });
    await rename(executable, backupPeer);
    try {
      await rename(helper, backupHelper);
      await rename(stagedPeer, executable);
      await rename(stagedHelper, helper);
    } catch (error) {
      await rm(executable, { force: true });
      await rm(helper, { force: true });
      await rename(backupPeer, executable).catch(() => {});
      await rename(backupHelper, helper).catch(() => {});
      throw error;
    } finally {
      await rm(stagedPeer, { force: true });
      await rm(stagedHelper, { force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function installCliUpdate(update: CliUpdateInfo, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (update.source === 'pnpm') {
    await run('pnpm', ['add', '--global', `@peer-agent/cli@${update.latestVersion}`]);
    return;
  }
  if (update.source === 'npm') {
    await run('npm', ['install', '--global', `@peer-agent/cli@${update.latestVersion}`]);
    return;
  }
  await installReleaseUpdate(update, env);
}

export function createCliUpdateController(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly shouldCheck?: () => boolean;
  readonly checkImpl?: () => Promise<CliUpdateInfo | null>;
  readonly installImpl?: (update: CliUpdateInfo) => Promise<void>;
} = {}) {
  const env = options.env ?? process.env;
  let status: CliUpdateStatus = { phase: 'idle' };
  const listeners = new Set<(value: CliUpdateStatus) => void>();
  const publish = (next: CliUpdateStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };
  return {
    getStatus: () => status,
    subscribe(listener: (value: CliUpdateStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async check() {
      if (!(options.shouldCheck?.() ?? shouldCheckForUpdates({ env }))) return;
      publish({ phase: 'checking' });
      const update = await (options.checkImpl?.() ?? checkForCliUpdate({ env }));
      publish(update ? { phase: 'available', update } : { phase: 'idle' });
    },
    dismiss() { publish({ phase: 'dismissed' }); },
    async install() {
      if (status.phase !== 'available' && status.phase !== 'failed') return;
      const update = status.update;
      publish({ phase: 'installing', update });
      try {
        await (options.installImpl?.(update) ?? installCliUpdate(update, env));
        publish({ phase: 'installed', update });
      } catch (error) {
        publish({ phase: 'failed', update, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export type CliUpdateController = ReturnType<typeof createCliUpdateController>;
