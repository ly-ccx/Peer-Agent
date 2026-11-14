import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const expected = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { cwd: root, encoding: 'utf8' }));
const names = ['peer-protocol', 'peer-tui', 'peer-cli', 'peer-store', 'peer-runtime'];
for (const name of names) {
  const pkg = metadata.packages.find(p => p.name === name);
  if (!pkg || pkg.version !== expected || pkg.publish?.length !== 0) throw Error(`${name}: version/publish contract mismatch`);
}
const ui = metadata.packages.find(p => p.name === 'peer-tui');
if (ui.dependencies.some(d => /^peer-(?:cli|store|runtime|providers|project-agent|credential)/.test(d.name))) throw Error('TUI depends on a concrete privileged Host adapter');
for (const name of names) {
  const directory = resolve(root, 'crates', name, 'src');
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]);
  for (const path of walk(directory)) {
    const source = readFileSync(path, 'utf8');
    if (/\bunsafe\s*\{/.test(source)) throw Error(`${path}: unreviewed unsafe block`);
    if (/Command::new\s*\(\s*"(?:bun|node|electron)"/.test(source)) throw Error(`${path}: forbidden JS sidecar`);
    if (name === 'peer-tui' && /std::(?:fs|process)|tokio::(?:fs|process)/.test(source)) throw Error(`${path}: concrete I/O in View`);
  }
}
process.stdout.write('Native crate versions, publish flags, UI dependency direction and sidecar bans passed.\n');
