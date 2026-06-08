import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected = readFileSync(join(root, 'VERSION'), 'utf8').trim();

const packageJsonFiles = [
  'package.json',
  'apps/desktop/package.json',
  'packages/chat-kernel/package.json',
  'packages/i18n/package.json',
  'packages/protocol/package.json',
  'packages/task-thread/package.json',
  'packages/ui/package.json',
];

const errors = [];

for (const file of packageJsonFiles) {
  const json = JSON.parse(readFileSync(join(root, file), 'utf8'));
  if (json.version !== expected) {
    errors.push(`${file}: expected ${expected}, found ${json.version}`);
  }
}

const cargoToml = readFileSync(join(root, 'crates/cu-proxy-core/Cargo.toml'), 'utf8');
if (!new RegExp(`^version = "${expected}"$`, 'm').test(cargoToml)) {
  errors.push(`crates/cu-proxy-core/Cargo.toml: expected version = "${expected}"`);
}

const cargoLock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
if (!new RegExp(`name = "cu-proxy-core"\\nversion = "${expected}"`, 'm').test(cargoLock)) {
  errors.push(`Cargo.lock: expected cu-proxy-core ${expected}`);
}

if (errors.length > 0) {
  console.error('Version check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Version check passed: ${expected}`);
