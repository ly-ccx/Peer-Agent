import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./preload.source.cjs', import.meta.url), 'utf8');
for (const href of [undefined, '', 'about:blank', 'file:///test/index.html', 'http://localhost:5173/']) {
  test(`initial settings request for ${String(href)}`, () => {
    const calls = [];
    let exposed;
    vm.runInNewContext(source, {
      location: href === undefined ? undefined : { href },
      require: () => ({
        contextBridge: { exposeInMainWorld: (_key, api) => { exposed = api; } },
        ipcRenderer: { sendSync: (channel) => { calls.push(channel); return { language: 'en' }; } },
      }),
    });
    const realPage = Boolean(href && href !== 'about:blank');
    assert.equal(calls.length, realPage ? 1 : 0);
    assert.equal(exposed.initialSettings.language, realPage ? 'en' : undefined);
    if (realPage) assert.equal(calls[0], 'settings:get-sync');
  });
}
