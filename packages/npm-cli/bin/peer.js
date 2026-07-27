#!/usr/bin/env node
/**
 * npm bin shim — exec the vendor peer binary downloaded by postinstall.
 * peer-credential-helper must live next to peer (same vendor/ directory).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const binary = join(vendor, process.platform === 'win32' ? 'peer.exe' : 'peer');
const helper = join(
  vendor,
  process.platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper',
);

if (!existsSync(binary) || !existsSync(helper)) {
  console.error(
    [
      '[@peer-agent/cli] CLI binaries are missing.',
      `  expected: ${binary}`,
      `  expected: ${helper}`,
      '',
      'postinstall should have downloaded them from GitHub Releases.',
      'Try reinstalling:',
      '  npm i -g @peer-agent/cli',
      'or set PEER_AGENT_RELEASE_URL to a direct archive URL and reinstall.',
      '',
      'Manual fallback: download peer-*-*.tar.gz from',
      '  https://github.com/ly-ccx/Peer-Agent/releases',
      'and keep peer + peer-credential-helper in the same directory.',
    ].join('\n'),
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(`[@peer-agent/cli] failed to start peer: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
