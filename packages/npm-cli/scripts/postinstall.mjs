#!/usr/bin/env node
/**
 * postinstall — download peer + peer-credential-helper for the current platform
 * from the matching GitHub Release (package version == release tag without v).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBinary } from '../lib/install-binary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

// Monorepo checkout: packages/npm-cli lives next to apps/tui — developers build
// peer locally; do not hit GitHub on every pnpm install unless forced.
const monorepoMarker = join(root, '../../apps/tui/package.json');
const inMonorepo = existsSync(monorepoMarker);
const forceDownload = process.env.PEER_AGENT_FORCE_DOWNLOAD === '1';
if (inMonorepo && !forceDownload) {
  console.log(
    '[@peer-agent/cli] monorepo install detected — skipping binary download ' +
      '(set PEER_AGENT_FORCE_DOWNLOAD=1 to fetch Release assets anyway)',
  );
  process.exit(0);
}

try {
  await installBinary({
    version,
    root,
    log: (msg) => console.log(msg),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[@peer-agent/cli] postinstall failed: ${message}`);
  console.error(
    '[@peer-agent/cli] You can still install manually from GitHub Releases: ' +
      `https://github.com/yinLiangDream/Peer-Agent/releases/tag/v${version}`,
  );
  // Fail install so global users notice missing binaries instead of a broken `peer`.
  process.exit(1);
}
