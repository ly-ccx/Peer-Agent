#!/usr/bin/env node
/**
 * Compile the peer CLI binary with a stamped PEER_CLI_VERSION.
 *
 * Version resolution:
 *   1. PEER_CLI_VERSION env (CI may inject after stamp-version)
 *   2. apps/tui/package.json version (aligned by VERSION / stamp-version)
 *
 * Bun inlines matching env vars via a *prefix* filter (not a full var name).
 * Use `--env=PEER_CLI_*` so PEER_CLI_VERSION is embedded and
 * `peer --version` reports the release tag even without package.json nearby.
 *
 * Notes:
 * - `--env=PEER_CLI_VERSION` is treated as a prefix and will NOT match the
 *   variable name PEER_CLI_VERSION (Bun expects trailing `*`).
 * - Only *direct* `process.env.PEER_CLI_VERSION` reads are rewritten; reading
 *   through a function parameter (`env.PEER_CLI_VERSION`) is not inlined.
 *   See apps/tui/src/cli-version.ts (COMPILED_PEER_CLI_VERSION).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(appRoot, 'package.json');
const packageVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
const version =
  (process.env.PEER_CLI_VERSION && process.env.PEER_CLI_VERSION.trim()) ||
  (typeof packageVersion === 'string' && packageVersion.trim()) ||
  '0.0.0-dev';

const outfile = join(appRoot, 'dist', 'peer');
const entry = join(appRoot, 'src', 'index.tsx');

const env = {
  ...process.env,
  PEER_CLI_VERSION: version,
};

const result = spawnSync(
  'bun',
  [
    'build',
    '--compile',
    '--minify',
    // Prefix wildcard: Bun matches env keys starting with PEER_CLI_
    '--env=PEER_CLI_*',
    '--outfile',
    outfile,
    entry,
  ],
  {
    cwd: appRoot,
    env,
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built peer CLI ${version} → ${outfile}`);
