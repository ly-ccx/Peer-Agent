import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CLI_EXIT } from './cli-exit.ts';
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

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/;

export function parseVersion(value: string): readonly number[] | null {
  const match = value.trim().replace(/^v/, '').match(VERSION_PATTERN);
  if (!match) return null;
  const channelRank = match[4] === 'beta' ? 0 : match[4] === 'rc' ? 1 : 2;
  const prerelease = match[5] === undefined ? 0 : Number(match[5]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), channelRank, prerelease];
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

export type CliUpdateChannel = 'stable' | 'beta' | 'rc';

export function updateChannel(version: string): CliUpdateChannel {
  if (version.includes('-beta.')) return 'beta';
  if (version.includes('-rc.')) return 'rc';
  return 'stable';
}

export type CliUpdateLookup =
  | { readonly outcome: 'available'; readonly update: CliUpdateInfo }
  | { readonly outcome: 'current'; readonly currentVersion: string; readonly channel: CliUpdateChannel }
  | { readonly outcome: 'skipped'; readonly reason: 'interval' | 'unrecognized-version'; readonly currentVersion: string }
  | { readonly outcome: 'failed'; readonly message: string };

function releaseMatchesChannel(release: GithubRelease, channel: CliUpdateChannel): boolean {
  if (release.draft || !release.tag_name || !parseVersion(release.tag_name)) return false;
  if (updateChannel(release.tag_name) !== channel) return false;
  return channel === 'stable' ? release.prerelease !== true : release.prerelease === true;
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

export async function lookupCliUpdate(options: {
  readonly currentVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly statePath?: string;
  readonly force?: boolean;
} = {}): Promise<CliUpdateLookup> {
  const env = options.env ?? process.env;
  const currentVersion = options.currentVersion ?? resolvePeerCliVersion(env);
  if (!parseVersion(currentVersion)) {
    return { outcome: 'skipped', reason: 'unrecognized-version', currentVersion };
  }
  const now = options.now ?? Date.now();
  const statePath = options.statePath ?? UPDATE_STATE_PATH;
  if (!options.force && now - await readLastCheck(statePath) < (options.intervalMs ?? DEFAULT_INTERVAL_MS)) {
    return { outcome: 'skipped', reason: 'interval', currentVersion };
  }
  await recordCheck(now, statePath);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const repository = env.PEER_AGENT_GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
    const response = await (options.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${repository}/releases?per_page=20`,
      { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!response.ok) return { outcome: 'failed', message: `HTTP ${response.status}` };
    const releases = await response.json() as GithubRelease[];
    if (!Array.isArray(releases)) return { outcome: 'failed', message: 'response was not a list' };
    const channel = updateChannel(currentVersion);
    const candidates = releases.filter((release) => releaseMatchesChannel(release, channel));
    candidates.sort((a, b) => compareVersions(b.tag_name!, a.tag_name!));
    const latest = candidates[0];
    if (!latest?.tag_name || compareVersions(currentVersion, latest.tag_name) >= 0) {
      return { outcome: 'current', currentVersion, channel };
    }
    return {
      outcome: 'available',
      update: {
        currentVersion,
        latestVersion: latest.tag_name.replace(/^v/, ''),
        source: resolveInstallSource(env),
        releaseUrl: latest.html_url ?? `https://github.com/${repository}/releases/tag/${latest.tag_name}`,
      },
    };
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
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
  const result = await lookupCliUpdate(options);
  return result.outcome === 'available' ? result.update : null;
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
    const executable = resolveReleaseInstallTarget(process.execPath);
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

/** Release installs replace the running binary. Never treat bun, node, or another host as peer. */
export function resolveReleaseInstallTarget(execPath: string): string {
  const name = basename(execPath).toLowerCase();
  if (name !== 'peer' && name !== 'peer.exe') {
    throw new Error(`peer update: refusing to replace ${execPath}`);
  }
  return execPath;
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

const UPDATE_COMMAND_TIMEOUT_MS = 15_000;

function installSourceLabel(source: CliInstallSource): string {
  return source === 'release' ? 'the release archive' : source;
}

export async function runPeerUpdate(
  options: { readonly checkOnly: boolean },
  hooks: {
    readonly env?: NodeJS.ProcessEnv;
    readonly lookup?: typeof lookupCliUpdate;
    readonly install?: typeof installCliUpdate;
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const env = hooks.env ?? process.env;
  const writeOut = hooks.stdout ?? ((line: string) => console.log(line));
  const writeErr = hooks.stderr ?? ((line: string) => console.error(line));
  const result = await (hooks.lookup ?? lookupCliUpdate)({
    env,
    force: true,
    timeoutMs: UPDATE_COMMAND_TIMEOUT_MS,
  });

  if (result.outcome === 'skipped') {
    writeErr(result.reason === 'unrecognized-version'
      ? `peer update: cannot compare version ${result.currentVersion}.`
      : 'peer update: check was skipped.');
    return CLI_EXIT.runtime;
  }
  if (result.outcome === 'failed') {
    writeErr(`peer update: could not check GitHub Releases (${result.message}).`);
    return CLI_EXIT.runtime;
  }
  if (result.outcome === 'current') {
    writeOut(`peer ${result.currentVersion} is already the latest ${result.channel} release.`);
    return CLI_EXIT.ok;
  }

  const { update } = result;
  const channel = updateChannel(update.currentVersion);
  if (options.checkOnly) {
    writeOut(`peer ${update.currentVersion} → ${update.latestVersion} (${channel}, ${update.source})`);
    writeOut(update.releaseUrl);
    return CLI_EXIT.ok;
  }

  writeOut(`Updating peer ${update.currentVersion} → ${update.latestVersion} with ${installSourceLabel(update.source)}.`);
  try {
    await (hooks.install ?? installCliUpdate)(update, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`Update failed; the current version is unchanged: ${message}`);
    return CLI_EXIT.runtime;
  }
  writeOut(`Updated to ${update.latestVersion}. Restart peer to use it.`);
  return CLI_EXIT.ok;
}
