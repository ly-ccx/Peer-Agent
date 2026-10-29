import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DATA_STORE_ENTRIES} from './data-store.mjs';
test('remote binding identity and project input receipts stay device-scoped',()=>{
  assert.deepEqual(DATA_STORE_ENTRIES.remoteBinding,{rel:'remote-binding.sqlite',kind:'file',scope:'device'});
  assert.equal(DATA_STORE_ENTRIES.projectRuntime.scope,'device');
});
