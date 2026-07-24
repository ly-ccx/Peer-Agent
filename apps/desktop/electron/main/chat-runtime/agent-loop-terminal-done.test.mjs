import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const loops = [
  'openai-agent-loop.mjs',
  'anthropic-agent-loop.mjs',
  'gemini-agent-loop.mjs',
  'qoder-agent-loop.mjs',
];

test('terminal tools do not sendDone before applyToolResults', async () => {
  for (const name of loops) {
    const source = await readFile(path.join(dir, name), 'utf8');
    // tools.execute 内不得在 controlSignal.terminal 时立刻 sendDone。
    assert.doesNotMatch(
      source,
      /if \(toolExecution\.controlSignal\?\.terminal\) \{[\s\S]*?loop\.sendDone\(\)/,
      `${name} still early-sends done on terminal tools`,
    );
    // 仍由 pipeline onStopped 统一收尾。
    assert.match(source, /onStopped:\s*\(\)\s*=>\s*loop\.sendDone\(\)/);
    assert.match(source, /不得在这里 sendDone/);
  }
});
