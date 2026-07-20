import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Compile-time / runtime PEER_CLI_VERSION capture.
 *
 * Bun only inlines *direct* `process.env.PEER_CLI_*` property access when
 * building with `--env=PEER_CLI_*`. Reading via an `env` parameter
 * (`env.PEER_CLI_VERSION`) is NOT rewritten and stays empty in compiled
 * binaries. Keep this module-scope read so release builds embed the version.
 */
const COMPILED_PEER_CLI_VERSION = process.env.PEER_CLI_VERSION;

/**
 * Resolve the CLI release version.
 *
 * Priority:
 * 1. Explicit `env` override (tests / callers that pass a custom env object)
 * 2. PEER_CLI_VERSION — inlined at `bun build --compile --env=PEER_CLI_*`
 * 3. apps/tui/package.json version (dev / source runs)
 * 4. 0.0.0-dev fallback
 */
export function resolvePeerCliVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Prefer an explicit override object (unit tests) over the compiled value.
  if (env !== process.env) {
    const override = env.PEER_CLI_VERSION?.trim();
    if (override) return override;
  }

  const injected = COMPILED_PEER_CLI_VERSION?.trim();
  if (injected) return injected;

  // When called with process.env at runtime (source runs), also honor a live env.
  const live = process.env.PEER_CLI_VERSION?.trim();
  if (live) return live;

  try {
    const packageJsonPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
    if (typeof version === 'string' && version.trim()) {
      return version.trim();
    }
  } catch {
    // package.json is unavailable inside some compiled layouts; fall through.
  }

  return '0.0.0-dev';
}

export function formatPeerVersionLine(
  version: string = resolvePeerCliVersion(),
): string {
  return `peer ${version}`;
}

export function shouldPrintVersionAndExit(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--version' || arg === '-v');
}

/**
 * If argv requests version output, print `peer <semver>` and return true.
 * Caller should exit(0) when this returns true.
 */
export function handleCliVersionArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => console.log(line),
): boolean {
  if (!shouldPrintVersionAndExit(argv)) return false;
  write(formatPeerVersionLine(resolvePeerCliVersion(env)));
  return true;
}
