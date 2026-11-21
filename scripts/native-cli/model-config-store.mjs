// Actual Desktop + Rust Store cross-process contract, using synthetic data only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { readModelConfigFile, withModelConfigLock } from '../../packages/runtime-node/src/model-config-file.mjs';
const root = mkdtempSync(join(tmpdir(), 'peer-model-config-interop-'));
const binary = resolve('target/debug/examples/model-config-conformance');
const file = join(root, 'llm-providers.json');
const read = () => JSON.parse(execFileSync(binary, [root, 'read'], {encoding:'utf8'}));
let checks=0;
const same = () => { const node=readModelConfigFile(file), rust=read(); assert.deepEqual(rust.value,node.value);assert.equal(rust.revision,node.revision);checks+=2; };
function child(command, args) {
  const process = spawn(command, args, {stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';process.stdout.on('data',b=>{stdout+=b;});process.stderr.on('data',b=>{stderr+=b;});
  return { process, result: new Promise((resolve,reject)=>{
    process.on('error',reject);process.on('close',code=>code===0?resolve(stdout):reject(new Error(`${command}: ${code}: ${stderr}`)));
  }) };
}
const children=[];
try {
  same();
  writeFileSync(file, JSON.stringify({version:2,channels:[],models:[],future:{preserve:['original']}}));same();
  // Both processes change the real document repeatedly while retaining each
  // other's fields. Desktop uses its production public CRUD, not a test writer.
  const native=child(binary,[root,'increment','30']);children.push(native);
  const module=pathToFileURL(resolve('apps/desktop/electron/main/llm-config-store.mjs')).href;
  const script=`import {createLlmConfigStore} from ${JSON.stringify(module)};
const secrets=new Map();const store=createLlmConfigStore({configFile:${JSON.stringify(file)},credentialClient:{getSecret:k=>secrets.get(k)??null,setSecret:(k,v)=>secrets.set(k,v),deleteSecret:k=>secrets.delete(k)}});
for(let i=0;i<20;i++)store.addProvider({provider:'openai',model:'fixture-'+i});`;
  const desktop=child(process.execPath,['--input-type=module','-e',script]);children.push(desktop);
  await Promise.all(children.map(c=>c.result));same();
  const final=readModelConfigFile(file).value;
  assert.equal(final.nativeCounter,30);assert.equal(final.models.length,20);assert.equal(final.channels.length,20);
  assert.deepEqual(final.future,{preserve:['original']});checks+=4;
  withModelConfigLock(file,()=>{
    const blocked=spawn(binary,[root,'increment','1'],{stdio:['ignore','pipe','pipe']});
    // Rust begin is bounded at five seconds; do not synchronously await while
    // owning this lock. This short observation only establishes an actual child.
    children.push({process:blocked,result:new Promise((resolve,reject)=>{blocked.on('error',reject);blocked.on('close',code=>code===0?resolve():reject(new Error('Rust waiter failed')));})});
  });
  await children.at(-1).result;same();assert.equal(read().value.nativeCounter,31);checks++;
  console.log(JSON.stringify({modelConfigCrossLanguageChecks:checks,desktopCreates:20,rustConcurrentMutations:30,sharedRevision:true,personalData:false}));
} finally {
  // All normal children were awaited. On failure kill and await only this
  // fixture's handles before removing its isolated root.
  for(const c of children) if(c.process.exitCode===null && c.process.signalCode===null)c.process.kill('SIGTERM');
  await Promise.allSettled(children.map(c=>c.result));
  rmSync(root,{recursive:true,force:true});
}
