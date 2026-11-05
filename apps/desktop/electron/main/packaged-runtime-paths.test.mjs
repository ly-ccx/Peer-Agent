import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../scripts/verify-packaged-runtime.cjs', import.meta.url), 'utf8');

function verify(nativePath, missingEntry) {
  const files = new Map([
    ['electron/main/main.mjs', "import { runner } from '@peer-agent/runtime-node';"],
    ['node_modules/@peer-agent/runtime-node/package.json', JSON.stringify({ exports: './dist/index.mjs' })],
    ['node_modules/@peer-agent/runtime-node/dist/index.mjs', 'export const runner = {};'],
    ['node_modules/@peer-agent/interactive-content/package.json', JSON.stringify({ exports: {
      '.': { default: './src/index.mjs' }, './state': './src/state.mjs',
    } })],
    ['node_modules/@peer-agent/interactive-content/src/index.mjs', 'export const content = {};'],
    ['node_modules/@peer-agent/interactive-content/src/state.mjs', 'export const state = {};'],
  ].filter(([name]) => name !== missingEntry).map(([name, content]) => [nativePath.normalize(name), content]));
  const extracted = [], messages = [];
  const asar = {
    listPackage: () => [...files.keys()].map(name => nativePath.join('/', name)),
    extractFile: (_archive, name) => {
      extracted.push(name);
      const content = files.get(name);
      if (content === undefined) throw new Error(`Missing ASAR entry ${name}`);
      return Buffer.from(content);
    },
  };
  const fs = { statSync: () => ({ isDirectory: () => false }), existsSync: () => true };
  vm.runInNewContext(source, {
    require: name => {
      if (name === 'node:path') return nativePath;
      if (name === 'node:fs') return fs;
      assert.equal(name, '@electron/asar');
      return asar;
    },
    __dirname: nativePath.resolve('apps/desktop/scripts'),
    process: { argv: ['node', 'verify-packaged-runtime.cjs', nativePath.resolve('app.asar')] },
    Buffer, console: { log: message => messages.push(message) },
  });
  return { extracted, messages };
}

for (const [platform, nativePath] of [['posix', path.posix], ['win32', path.win32]]) {
  test(`packaged verifier discovers and reads runtime imports and subpath exports on ${platform}`, () => {
    const { extracted, messages } = verify(nativePath);
    assert.ok(messages.some(message => message.includes('verified 1 main-process workspace imports')));
    assert.ok(messages.some(message => message.includes('verified 2 interactive-content exports')));
    assert.ok(extracted.includes(nativePath.normalize('node_modules/@peer-agent/runtime-node/dist/index.mjs')));
    assert.ok(extracted.includes(nativePath.normalize('node_modules/@peer-agent/interactive-content/src/state.mjs')));
  });

  test(`packaged verifier still rejects a missing runtime dependency on ${platform}`, () => {
    assert.throws(() => verify(nativePath, 'node_modules/@peer-agent/runtime-node/dist/index.mjs'), /runtime entry.*is missing/);
  });

  test(`packaged verifier still rejects a missing interactive subpath on ${platform}`, () => {
    assert.throws(() => verify(nativePath, 'node_modules/@peer-agent/interactive-content/src/state.mjs'), /interactive-content export.*is missing/);
  });
}
