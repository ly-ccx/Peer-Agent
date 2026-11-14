import test from'node:test';import assert from'node:assert/strict';import{loopbackListenerPorts,newlyOwnedPorts,discoverFreshInspector}from'./inspector-port-owner.mjs';
test('random owned loopback ports come from the PID inventory, without inheriting preexisting listeners',()=>{assert.deepEqual(loopbackListenerPorts('p123\nf70\nn127.0.0.1:65413\nf71\nn[::1]:65414\n'),[65413,65414]);assert.deepEqual(newlyOwnedPorts([60000],[60000,65413]),[65413]);assert.deepEqual(loopbackListenerPorts(''),[]);});
test('non-loopback, invalid or too many new listeners reject',()=>{for(const x of['n*:9229','n0.0.0.0:9229','n127.0.0.1:0','n127.0.0.1:65536'])assert.throws(()=>loopbackListenerPorts(x),/inspector_listener/);assert.throws(()=>newlyOwnedPorts([],[1,2,3,4,5]),/cap/);});
test('discovery accepts one fresh random node endpoint, never an inherited or mismatched listener',async()=>{
 const list=port=>[{type:'node',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/private-owned`}],args={beforePorts:[12345],listeners:async()=>[12345,54321],readList:async p=>list(p),attempts:1,wait:async()=>{}};
 assert.equal((await discoverFreshInspector(args)).port,54321);
 await assert.rejects(()=>discoverFreshInspector({...args,beforePorts:[12345,54321]}),/not_found/);
 await assert.rejects(()=>discoverFreshInspector({...args,readList:async()=>list(1)}),/owner_invalid/);
 await assert.rejects(()=>discoverFreshInspector({...args,beforePorts:[]}),/ambiguous/);
});
