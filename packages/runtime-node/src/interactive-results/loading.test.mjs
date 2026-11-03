import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('public host/tool registration entry imports without loading the language engine, React or Electron', () => {
  const node = process.versions.bun ? 'node' : process.execPath;
  const output = execFileSync(node, ['--experimental-loader', new URL('./test-fixtures/deny-graphical-loader.mjs', import.meta.url).href,
    '--input-type=module', '-e', 'const runtime = await import("@peer-agent/runtime-node/interactive-results"); if (!runtime.createInteractiveRuntime || runtime.INTERACTIVE_TOOL_DEFINITIONS.length !== 2) process.exit(2); process.stdout.write("host-entry-only");'],
  { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output, 'host-entry-only');
});
