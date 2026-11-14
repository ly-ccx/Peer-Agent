import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { guardReadOnlySource } from './readonly-coordination.mjs';

test('read-only source guard refuses SQLite and filesystem writes while permitting source reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri00-readonly-'));
  const sqlite = createRequire(import.meta.url)('node:sqlite'), original = sqlite.DatabaseSync;
  const file = path.join(root, 'source.sqlite'), writer = new original(file);
  writer.exec('CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES (\'retained\')'); writer.close();
  const guard = guardReadOnlySource(root);
  let reader;
  try {
    reader = new sqlite.DatabaseSync(file);
    assert.equal(reader.prepare('SELECT value FROM facts').get().value, 'retained');
    assert.throws(() => reader.exec("INSERT INTO facts VALUES ('forbidden')"), /readonly/);
    assert.throws(() => fs.writeFileSync(file, 'forbidden'), /source_write_forbidden/);
    assert.throws(() => fs.renameSync(file, path.join(root, 'moved')), /source_write_forbidden/);
    assert.throws(() => fs.openSync(file, 'r+'), /source_write_forbidden/);
    const fd = fs.openSync(file, 'r'); fs.closeSync(fd);
    assert.equal(guard.state.sourceWritesDenied, 3);
  } finally { reader?.close(); guard.close(); }
  assert.equal(sqlite.DatabaseSync, original);
  const check = new original(file); assert.equal(check.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 1); check.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('multiple canonical roots remain protected while a separate diagnostic sink stays writable',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-multi-readonly-'));
  const stores=['plans','conversations','projects'].map(name=>{const dir=path.join(root,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'fact'),'retained');return dir;});
  const guard=guardReadOnlySource(stores);
  try{
    for(const dir of stores)assert.throws(()=>fs.appendFileSync(path.join(dir,'fact'),'forbidden'),/source_write_forbidden/);
    fs.writeFileSync(path.join(root,'diagnostic.log'),'safe metadata');
    assert.equal(fs.readFileSync(path.join(root,'diagnostic.log'),'utf8'),'safe metadata');
    assert.equal(guard.state.sourceWritesDenied,3);
  }finally{guard.close();fs.rmSync(root,{recursive:true,force:true});}
});
