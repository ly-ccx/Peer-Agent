import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const binaryPath = resolve(process.cwd(), 'dist/peer');
const helperPath = resolve(
  process.cwd(),
  'dist',
  process.platform === 'win32'
    ? 'peer-credential-helper.exe'
    : 'peer-credential-helper',
);

chmodSync(binaryPath, 0o755);
if (process.platform !== 'win32') {
  chmodSync(helperPath, 0o755);
}

if (process.platform === 'darwin') {
  for (const executablePath of [binaryPath, helperPath]) {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', executablePath]);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', executablePath]);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}
