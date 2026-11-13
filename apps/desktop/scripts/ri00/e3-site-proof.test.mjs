import test from'node:test';import assert from'node:assert/strict';import inspector from'node:inspector';
import{createCatalogIpcMain}from'../../electron/main/ipc/catalog-ipc-main.mjs';import{createTrustedWindowRegistry}from'../../electron/main/ipc/trusted-window-registry.mjs';
import{proveE3RegisteredSite}from'./e3-site-proof.mjs';import{E3_READ_ENTRIES}from'./e3-entry-discovery.mjs';
function fixture(){
 let calls=0;const goalPlanStore={getPlan(){calls++;},listEvidenceIndex(){calls++;}},supervisor={list(){calls++;return goalPlanStore;},listByWorkspaceIds(){calls++;},get(){calls++;}};
 const readSessionsBatch=()=>supervisor.listByWorkspaceIds(),listSessions=()=>supervisor.list(),directory={list(){return readSessionsBatch();},get(){return listSessions();}},sessions=supervisor;
 const ports={list(){return directory.list();},get(){return directory.get();},listSessions(){return sessions.list();},getSession(){return sessions.get();},listObligationGrants(){return sessions.list();}};
 return{ports,calls:()=>calls};
}
for(const trusted of[true,false])test('registered-site metadata '+(trusted?'proves the real authorization wrapper without invoking readers':'rejects the no-op default authorizer'),async t=>{
 const handlers=new Map(),graph=fixture(),registry=createTrustedWindowRegistry(),ipc=createCatalogIpcMain({ipcMain:{handle(k,v){handlers.set(k,v);},on(){}},...(trusted?{authorize:registry.authorize}:{})});
 const ports=graph.ports;for(const[channel,key]of E3_READ_ENTRIES)ipc.handle(channel,(event,payload)=>ports[key](payload));
 const session=new inspector.Session();session.connect();globalThis.__ri00ProofHandlers=handlers;
 t.after(()=>{session.disconnect();delete globalThis.__ri00ProofHandlers;ipc.dispose();registry.dispose();});
 const post=(method,params={})=>new Promise((resolve,reject)=>{if(method==='Runtime.evaluate'){const channel=E3_READ_ENTRIES.find(([c])=>params.expression.endsWith(`.get(${JSON.stringify(c)})`))?.[0];if(!channel)return reject(Error('unexpected-evaluation'));params={...params,expression:`globalThis.__ri00ProofHandlers.get(${JSON.stringify(channel)})`};}session.post(method,params,(e,r)=>e?reject(e):resolve(r));});
 if(trusted){const p=await proveE3RegisteredSite(post);assert.equal(p.proof.outerAuthorizationBeforeCallback,true);assert.equal(p.proof.sharedTrustedWindowAuthorizer,true);assert.equal(p.handlers.length,5);}else await assert.rejects(()=>proveE3RegisteredSite(post),/trusted_authorizer_missing/);
 assert.equal(graph.calls(),0);
});
