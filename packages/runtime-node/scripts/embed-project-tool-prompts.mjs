import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../src/project-agent');
const prompts = {};
for (const family of ['delegation', 'memory']) {
  const directory = path.join(root, 'prompts', family);
  for (const name of readdirSync(directory).sort()) {
    if (name.endsWith('.md')) prompts[name.slice(0, -3)] = readFileSync(path.join(directory, name), 'utf8').trim();
  }
}
writeFileSync(path.join(root, 'tool-prompts.generated.mjs'),
  '// Generated from prompts/{delegation,memory}/*.md. Run pnpm build to update.\n'
  + `const prompts = Object.freeze(${JSON.stringify(prompts, null, 2)});\n`
  + 'export function projectToolDescription(name) {\n'
  + '  if (!Object.hasOwn(prompts, name)) throw new Error(`Unknown project tool: ${name}`);\n'
  + '  return prompts[name];\n}\n');
