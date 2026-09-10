import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRemoteBindingStore } from './remote-binding-store.mjs';
const binding = { origin: 'https://peer.example', deviceId: 'mac', ownerId: 'owner', bindingVersion: 1 };
for (const disabled of [false, true]) {
  for (const restart of ['reopen', 'killed-process']) {
    test(`local-binding-${disabled}-${restart}`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'peer-local-binding-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'binding.sqlite');
      if (restart === 'reopen') {
        const writer = createRemoteBindingStore(path); writer.save(binding); writer.setDisabled(disabled); writer.close();
      } else {
        const moduleUrl = new URL('./remote-binding-store.mjs', import.meta.url).href;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
          import { createRemoteBindingStore } from ${JSON.stringify(moduleUrl)};
          const store = createRemoteBindingStore(${JSON.stringify(path)});
          store.save(${JSON.stringify(binding)}); store.setDisabled(${disabled});
          process.kill(process.pid, 'SIGKILL');
        `], { encoding: 'utf8', timeout: 10000 });
        assert.ifError(result.error); assert.equal(result.signal, 'SIGKILL', result.stderr);
      }
      const reader = createRemoteBindingStore(path);
      try {
        assert.deepEqual(reader.load(), { ...binding, disabled });
        assert.deepEqual(reader.save(binding), { ...binding, disabled }, 'remote replay cannot undo local stop');
        for (const patch of [{ origin: 'https://other.example' }, { deviceId: 'other' }, { ownerId: 'other' }, { bindingVersion: 2 }]) {
          assert.throws(() => reader.save({ ...binding, ...patch }), /BINDING_CONFLICT/);
        }
        assert.deepEqual(reader.load(), { ...binding, disabled });
      } finally { reader.close(); }
    });
  }
}
test('invalid metadata is never persisted', () => {
  const store = createRemoteBindingStore(':memory:');
  try {
    for (const patch of [{ origin: 'http://peer.example' }, { origin: 'https://user:pass@peer.example' },
      { ownerId: '' }, { bindingVersion: 0 }, { deviceId: '/tmp' }]) {
      assert.throws(() => store.save({ ...binding, ...patch }));
      assert.equal(store.load(), null);
    }
  } finally { store.close(); }
});
