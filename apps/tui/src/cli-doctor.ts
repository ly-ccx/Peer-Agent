import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_EXIT } from './cli-exit.ts';
import { resolvePeerDataHome } from './cli-data-home.ts';
import { resolvePeerCliVersion } from './cli-version.ts';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function helperName(): string {
  return process.platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper';
}

export function peerInstallPaths(execPath = process.execPath, moduleDir = dirname(fileURLToPath(import.meta.url))): {
  readonly peer: string;
  readonly helper: string;
} {
  const name = basename(execPath).toLowerCase();
  const dir = name === 'peer' || name === 'peer.exe' ? dirname(execPath) : join(moduleDir, '..', 'dist');
  const peer = name === 'peer' || name === 'peer.exe' ? execPath : join(dir, process.platform === 'win32' ? 'peer.exe' : 'peer');
  return { peer, helper: join(dir, helperName()) };
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function inspectPeerDoctor(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly moduleDir?: string;
  readonly stdinIsTTY?: boolean;
  readonly version?: string;
} = {}): { readonly checks: readonly DoctorCheck[]; readonly notes: readonly string[] } {
  const env = options.env ?? process.env;
  const paths = peerInstallPaths(options.execPath, options.moduleDir);
  const checks: DoctorCheck[] = [
    {
      name: 'peer',
      ok: isExecutable(paths.peer),
      detail: isExecutable(paths.peer) ? paths.peer : `missing ${paths.peer}`,
    },
    {
      name: 'credential helper',
      ok: isExecutable(paths.helper),
      detail: isExecutable(paths.helper) ? paths.helper : `missing ${paths.helper}`,
    },
  ];
  const dataHome = resolvePeerDataHome(env);
  try {
    mkdirSync(dataHome, { recursive: true });
    accessSync(dataHome, constants.W_OK);
    checks.push({ name: 'data root', ok: true, detail: dataHome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: 'data root', ok: false, detail: `${dataHome} (${message})` });
  }
  const version = options.version ?? resolvePeerCliVersion(env);
  checks.push({ name: 'version', ok: Boolean(version), detail: version || 'missing' });
  const tty = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const color = env.NO_COLOR === undefined && env.FORCE_COLOR !== '0';
  return {
    checks,
    notes: [
      `terminal: ${tty ? 'tty' : 'not a tty'}`,
      `color: ${color ? 'yes' : 'no'}`,
    ],
  };
}

export function formatDoctorReport(report: { readonly checks: readonly DoctorCheck[]; readonly notes: readonly string[] }): string {
  const lines = report.checks.map((check) => `${check.name}: ${check.ok ? 'ok' : 'failed'} ${check.detail}`);
  return [...lines, ...report.notes].join('\n');
}

export async function runPeerDoctor(hooks: {
  readonly env?: NodeJS.ProcessEnv;
  readonly inspect?: typeof inspectPeerDoctor;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
} = {}): Promise<number> {
  const writeOut = hooks.stdout ?? ((line: string) => console.log(line));
  const writeErr = hooks.stderr ?? ((line: string) => console.error(line));
  const report = (hooks.inspect ?? inspectPeerDoctor)({ env: hooks.env });
  writeOut(formatDoctorReport(report));
  const failed = report.checks.filter((check) => !check.ok);
  if (failed.length === 0) return CLI_EXIT.ok;
  writeErr(`peer doctor: ${failed.map((check) => check.name).join(', ')} failed.`);
  return CLI_EXIT.runtime;
}
