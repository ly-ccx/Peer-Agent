import assert from 'node:assert/strict';
import test from 'node:test';
import { renderRuntimeContext } from './runtime-source.mjs';

test('runtime context lists additional source folders as readable only', () => {
  const text = renderRuntimeContext('/tmp/knowledge', {
    linkedFolders: [
      { path: '/tmp/code' },
      { path: '/tmp/knowledge' },
      { path: '/tmp/code' },
    ],
  });

  assert.match(text, /Current workspace: \/tmp\/knowledge/);
  assert.match(text, /Project additional source folders \(readable\):/);
  assert.match(text, /- \/tmp\/code/);
  assert.match(text, /Write, edit, and default command cwd stay in the current workspace/);
  assert.equal(text.includes('/tmp/knowledge\n- /tmp/knowledge'), false);
});
