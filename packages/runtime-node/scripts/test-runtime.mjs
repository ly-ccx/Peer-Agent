import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['src', 'src/sqlite', 'src/memory', 'src/project-agent',
  'src/project-agent/probes', 'src/testing', 'src/interactive-results'];
// Match the previous package script's exact eight globs. Root TS tests and
// nested MJS tests retain their normal parallel execution.
const files = directories.flatMap(directory => readdirSync(path.join(root, directory))
  .filter(name => name.endsWith('.test.mjs') || (directory === 'src' && name.endsWith('.test.ts')))
  .map(name => path.join(directory, name))).sort();
const benchmark = path.join('src', 'project-agent', 'watch-reconcile-scale.test.mjs');
if (!files.includes(benchmark)) throw new Error('Required Watch scale benchmark is missing.');
const stages = [
  { name: 'parallel behavioral tests', files: files.filter(file => file !== benchmark) },
  { name: 'isolated Watch scale benchmark (original 500ms/read-count assertions)', files: [benchmark] },
];
if (process.argv.includes('--list')) {
  process.stdout.write(`${JSON.stringify(stages)}\n`);
} else {
  let failed = false;
  for (const stage of stages) {
    process.stdout.write(`Runtime Node: ${stage.name}, ${stage.files.length} files\n`);
    const result = spawnSync(process.execPath, ['--test', ...stage.files], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  // A failed behavioral file must not prevent the benchmark from running:
  // CI may retry individual failed files, so every phase needs an actual result.
  process.exitCode = failed ? 1 : 0;
}
