import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as timers from 'node:timers';
import { installObservation } from './live-observation.mjs';

function fixture(handler = () => 42) {
  let clock = 0, observer = null;
  const ipcMain = { _invokeHandlers: new Map([['catalog:query', handler]]), eventNames: () => ['catalog:event'], emit() { return true; } };
  const fs = { readFileSync() { clock += 10; return 'private contents'; } };
  const json = { parse() { clock += 5; return {}; }, stringify: JSON.stringify };
  const phase = { setDiagnosticPhaseObserver(next) { const old = observer; observer = next; return old; } };
  const store = { readLifecycleFacts() { fs.readFileSync('/private/coordination/head.json'); json.parse('private contents'); observer?.('plan.normalize', { hit: 1, ms: 3 }); return { revision: 2 }; } };
  const host = { setTimeout: timers.setTimeout, setInterval: timers.setInterval };
  const deps = { ipcMain, fs, json, phase, stores: [store], timerHosts: [host], timers,
    syncExports() {}, now: () => clock, wall: () => 'fixture-time', AsyncLocalStorage };
  return { deps, ipcMain, fs, json, store, host, advance(ms) { clock += ms; } };
}

test('live query observation preserves sync values, receiver and nested inclusive/self accounting', () => {
  const f = fixture(function (secret) { assert.equal(this, f.ipcMain); assert.equal(secret, 'private argument'); f.store.readLifecycleFacts(); f.advance(2); return 42; });
  const original = f.ipcMain._invokeHandlers.get('catalog:query');
  const observation = installObservation(f.deps, { durationMs: 1000 });
  try {
    assert.equal(f.ipcMain._invokeHandlers.get('catalog:query').call(f.ipcMain, 'private argument'), 42);
    const [row] = observation.peek().records;
    assert.equal(row.synchronousMs, 17);
    assert.equal(row.metrics['Coordination.readLifecycleFacts'].inclusiveMs, 15);
    assert.equal(row.metrics['Coordination.readLifecycleFacts'].selfMs, 0);
    assert.equal(row.metrics['fs.readFileSync:coordination'].inclusiveMs, 10);
    assert.equal(row.phases['plan.normalize'].calls, 1);
    assert.equal(JSON.stringify(row).includes('private'), false);
    observation.setDetailed(false);
    f.ipcMain._invokeHandlers.get('catalog:query').call(f.ipcMain, 'private argument');
    assert.deepEqual(observation.peek().records[1].metrics, {});
  } finally { assert.ok(observation.stop().restored.every(Boolean)); }
  assert.equal(f.ipcMain._invokeHandlers.get('catalog:query'), original);
});
test('resource observation measures synchronous CPU and bounded evidence heap snapshots without payloads',()=>{
  let user=0,repeats=1;const store={listEvidenceIndex(){user+=10000;return [{}];}};
  const f=fixture(()=>{let value;for(let i=0;i<repeats;i++)value=store.listEvidenceIndex();return value;});
  f.deps.cpu=()=>({thread:{user,system:0},process:{user:user*2,system:0}});
  f.deps.heapSnapshot=()=>({usedBytes:1024,totalBytes:2048,spaces:[]});
  const observation=installObservation(f.deps,{durationMs:1000,resources:true,deepBuiltins:false});
  observation.instrumentObject(store,'GoalPlanStore',['listEvidenceIndex']);
  try{
    assert.equal(f.ipcMain._invokeHandlers.get('catalog:query')().length,1);
    const row=observation.peek().records[0],span=row.metrics['GoalPlanStore.listEvidenceIndex'].resourceReads[0];
    assert.equal(row.syncCpu.threadUserMs,10);assert.equal(row.syncCpu.processUserMs,20);
    assert.equal(span.cpu.threadUserMs,10);assert.equal(span.heapBefore.usedBytes,1024);assert.equal(observation.peek().resourceErrors,0);
    repeats=40;f.ipcMain._invokeHandlers.get('catalog:query')();
    const metric=observation.peek().records[1].metrics['GoalPlanStore.listEvidenceIndex'];
    assert.equal(metric.resourceReads.length,32);assert.equal(metric.resourceReadsDropped,8);
  }finally{observation.stop();}
});
test('resource collection failures cannot change the production return or bypass owned cleanup',()=>{
  const f=fixture(()=>42),original=f.ipcMain._invokeHandlers.get('catalog:query');
  f.deps.cpu=()=>{throw new Error('private telemetry failure');};f.deps.heapSnapshot=()=>({});
  const observation=installObservation(f.deps,{durationMs:1000,resources:true});
  assert.equal(f.ipcMain._invokeHandlers.get('catalog:query')(),42);const result=observation.stop();
  assert.ok(result.resourceErrors>0);assert.equal(f.ipcMain._invokeHandlers.get('catalog:query'),original);
  assert.equal(JSON.stringify(result).includes('private telemetry failure'),false);
});

test('live handler keeps original Promise identity and propagates rejection or synchronous throw', async () => {
  const failure = new Error('private failure');
  const rejected = Promise.reject(failure);
  const f = fixture(() => rejected), observation = installObservation(f.deps, { durationMs: 1000 });
  try {
    assert.equal(f.ipcMain._invokeHandlers.get('catalog:query')(), rejected);
    await assert.rejects(rejected, error => error === failure);
    assert.equal(observation.peek().records[0].rejected, true);
  } finally { observation.stop(); }
  const g = fixture(() => { throw failure; }), second = installObservation(g.deps, { durationMs: 1000 });
  try { assert.throws(() => g.ipcMain._invokeHandlers.get('catalog:query')(), error => error === failure); }
  finally { assert.equal(second.stop().records[0].threw, true); }
});

test('stopping releases observation records from already-created asynchronous resources', async () => {
  let storage, finish;
  const later = new Promise(resolve => { finish = resolve; });
  const f = fixture(() => { assert.ok(storage.getStore().row); setImmediate(() => finish(storage.getStore()?.row)); return 42; });
  f.deps.AsyncLocalStorage = class extends AsyncLocalStorage { constructor() { super(); storage = this; } };
  const observation = installObservation(f.deps, { durationMs: 1000 });
  f.ipcMain._invokeHandlers.get('catalog:query')();
  observation.stop(); observation.stop();
  assert.equal(await later, undefined);
});

test('adopted existing timer records only its synchronous callback and restores the same callback', () => {
  const f = fixture(), callback = function (value) { assert.equal(this, handle); f.advance(80); return value; };
  const handle = { _destroyed: false, _onTimeout: callback };
  const observation = installObservation(f.deps, { durationMs: 1000 });
  try {
    assert.equal(observation.adoptTimers([handle, handle]), 1);
    assert.equal(handle._onTimeout.call(handle, 9), 9);
    assert.equal(observation.peek().records[0].kind, 'timer');
    assert.equal(observation.peek().records[0].synchronousMs, 80);
  } finally { observation.stop(); }
  assert.equal(handle._onTimeout, callback);
});

test('partial installation failure restores earlier handler and store wrappers', () => {
  const f = fixture(), original = f.ipcMain._invokeHandlers.get('catalog:query'), originalStore = f.store.readLifecycleFacts;
  Object.defineProperty(f.fs, 'readFileSync', { writable: false });
  assert.throws(() => installObservation(f.deps, { durationMs: 1000 }), TypeError);
  assert.equal(f.ipcMain._invokeHandlers.get('catalog:query'), original);
  assert.equal(f.store.readLifecycleFacts, originalStore);
});

test('cleanup detects replacement by another owner and never overwrites it', () => {
  const f = fixture(), observation = installObservation(f.deps, { durationMs: 1000 });
  const replacement = () => 'new owner'; f.ipcMain._invokeHandlers.set('catalog:query', replacement);
  const state = observation.stop();
  assert.equal(state.restored.every(Boolean), false);
  assert.equal(f.ipcMain._invokeHandlers.get('catalog:query'), replacement);
  assert.equal(observation.stop(), state);
});

test('light collection retains store spans while preserving filesystem and JSON function identities', () => {
  const f = fixture(() => f.store.readLifecycleFacts()), read = f.fs.readFileSync, parse = f.json.parse;
  const observation = installObservation(f.deps, { durationMs: 1000, deepBuiltins: false });
  try {
    assert.equal(f.fs.readFileSync, read); assert.equal(f.json.parse, parse);
    f.ipcMain._invokeHandlers.get('catalog:query')();
    assert.equal(observation.peek().records[0].metrics['Coordination.readLifecycleFacts'].inclusiveMs, 15);
  } finally { observation.stop(); }
});

test('named read ports retain return identity and record array cardinality without content', () => {
  const records = [{ private: 'content' }], port = { read() { return records; } };
  const original = port.read, f = fixture(() => port.read());
  const observation = installObservation(f.deps, { durationMs: 1000, deepBuiltins: false });
  try {
    observation.instrumentObject(port, 'FixtureStore', ['read']);
    assert.equal(f.ipcMain._invokeHandlers.get('catalog:query')(), records);
    assert.equal(observation.peek().records[0].metrics['FixtureStore.read'].resultRows, 1);
    assert.equal(JSON.stringify(observation.peek()).includes('content'), false);
  } finally { observation.stop(); }
  assert.equal(port.read, original);
});

test('unattributed synchronous read roots cover async callers without double-counting IPC or exposing paths', () => {
  const records=[1],port={read(){assert.equal(this,port);f.advance(80);return records;}},original=port.read;
  const f=fixture(()=>port.read()),observation=installObservation(f.deps,{durationMs:1000,deepBuiltins:false});
  try{
    observation.instrumentObject(port,'SessionSupervisor',['read'],{rootWhenUnattributed:true});
    assert.equal(port.read(),records);
    f.ipcMain._invokeHandlers.get('catalog:query')();
    const rows=observation.peek().records;
    assert.equal(rows.length,2);assert.equal(rows[0].kind,'read-port');assert.equal(rows[0].synchronousMs,80);
    assert.equal(rows[0].metrics['SessionSupervisor.read'].resultRows,1);
    assert.equal(rows[1].kind,'ipc-invoke');assert.ok(rows[0].sourceStack.length>0);
    const previous=Error.prepareStackTrace;
    try{Error.prepareStackTrace=()=>{throw new Error('private formatter failure')};assert.equal(port.read(),records);}
    finally{Error.prepareStackTrace=previous;}
    assert.deepEqual(rows[2].sourceStack,[]);
    assert.equal(JSON.stringify(rows).includes('/private/'),false);
    assert.equal(JSON.stringify(rows).includes('/Users/'),false);
  }finally{assert.ok(observation.stop().restored.every(Boolean));}
  assert.equal(port.read,original);
});

test('read after await gets its own synchronous interval and retains the original IPC parent identity', async () => {
  const port={read(){f.advance(80);return 1;}},f=fixture(async()=>{port.read();await Promise.resolve();return port.read();});
  const observation=installObservation(f.deps,{durationMs:1000,deepBuiltins:false});
  try{
    observation.instrumentObject(port,'SessionSupervisor',['read'],{rootWhenUnattributed:true});
    assert.equal(await f.ipcMain._invokeHandlers.get('catalog:query')(),1);
    const rows=observation.peek().records,child=rows.find(row=>row.kind==='read-port'),parent=rows.find(row=>row.kind==='ipc-invoke');
    assert.equal(rows.length,2);assert.equal(child.parent,parent.id);
    assert.equal(parent.synchronousMs,80);assert.equal(child.synchronousMs,80);
    assert.equal(parent.metrics['SessionSupervisor.read'].calls,1);
    assert.equal(child.metrics['SessionSupervisor.read'].calls,1);
    assert.equal(child.entered,parent.syncEnd);
  }finally{observation.stop();}
});

test('phase capture can restore the production observer during paired live measurement', () => {
  const f = fixture(() => f.store.readLifecycleFacts()), observation = installObservation(f.deps, { durationMs: 1000, deepBuiltins: false });
  try {
    f.ipcMain._invokeHandlers.get('catalog:query')();
    observation.setPhaseCapture(false); f.ipcMain._invokeHandlers.get('catalog:query')();
    observation.setPhaseCapture(true); f.ipcMain._invokeHandlers.get('catalog:query')();
    assert.equal(observation.peek().records[0].phases['plan.normalize'].calls, 1);
    assert.deepEqual(observation.peek().records[1].phases, {});
    assert.equal(observation.peek().records[2].phases['plan.normalize'].calls, 1);
  } finally { assert.ok(observation.stop().restored.every(Boolean)); }
});

test('paired read-port observation restores the original function between cohorts and at cleanup', () => {
  const port={read:()=>[1]},original=port.read,f=fixture(()=>port.read());
  const observation=installObservation(f.deps,{durationMs:1000,deepBuiltins:false});
  try{
    observation.instrumentObject(port,'ReadPort',['read']);const installed=port.read;
    f.ipcMain._invokeHandlers.get('catalog:query')();
    observation.setModuleCapture('ReadPort',false);assert.equal(port.read,original);
    f.ipcMain._invokeHandlers.get('catalog:query')();
    observation.setModuleCapture('ReadPort',true);assert.equal(port.read,installed);
    f.ipcMain._invokeHandlers.get('catalog:query')();
    assert.equal(observation.peek().records[1].metrics['ReadPort.read'],undefined);
  }finally{assert.ok(observation.stop().restored.every(Boolean));}
  assert.equal(port.read,original);
});
