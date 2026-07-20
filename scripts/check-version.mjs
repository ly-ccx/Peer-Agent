import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected = readFileSync(join(root, 'VERSION'), 'utf8').trim();

const packageJsonFiles = [
  'package.json',
  'apps/desktop/package.json',
  'apps/tui/package.json',
  'packages/chat-kernel/package.json',
  'packages/i18n/package.json',
  'packages/task-thread/package.json',
  'packages/ui/package.json',
];

const cargoPackages = [
  ['peer-credential-helper', 'crates/peer-credential-helper/Cargo.toml'],
];

const errors = [];

for (const file of packageJsonFiles) {
  const json = JSON.parse(readFileSync(join(root, file), 'utf8'));
  if (json.version !== expected) {
    errors.push(`${file}: expected ${expected}, found ${json.version}`);
  }
}

const cargoLock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
for (const [packageName, manifestPath] of cargoPackages) {
  const cargoToml = readFileSync(join(root, manifestPath), 'utf8');
  if (!new RegExp(`^version = "${expected}"$`, 'm').test(cargoToml)) {
    errors.push(`${manifestPath}: expected version = "${expected}"`);
  }
  if (!new RegExp(`name = "${packageName}"\\nversion = "${expected}"`, 'm').test(cargoLock)) {
    errors.push(`Cargo.lock: expected ${packageName} ${expected}`);
  }
}

if (errors.length > 0) {
  console.error('Version check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Version check passed: ${expected}`);
