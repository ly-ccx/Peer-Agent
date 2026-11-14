import{inspectNamedReadBindings}from'./inspector-read-ports.mjs';
import{E3_READ_ENTRIES,discoverE3Entries}from'./e3-entry-discovery.mjs';
/** Inspect the registered wrapper and its named closure, without invoking any business or authorization function. */
export async function proveE3RegisteredSite(post,{electronRequireBase}={}){
 const refs=await discoverE3Entries(post,{electronRequireBase}),{closure}=inspectNamedReadBindings(post),handlers=[],requireBase=electronRequireBase?JSON.stringify(electronRequireBase):"process.resourcesPath+'/app.asar/package.json'";
 const same=async(a,b)=>{const r=await post('Runtime.callFunctionOn',{objectId:a,functionDeclaration:'function(b){return this===b;}',arguments:[{objectId:b}],returnByValue:true});if(r.exceptionDetails||r.result?.value!==true)throw Error('site_proof_owner_changed');};
 const source=async id=>{const r=await post('Runtime.callFunctionOn',{objectId:id,functionDeclaration:'function(){return Function.prototype.toString.call(this);}',returnByValue:true});if(r.exceptionDetails||typeof r.result?.value!=='string')throw Error('site_proof_function_source');return r.result.value;};
 let authorize,authorizationSource;
 for(const[channel,key]of E3_READ_ENTRIES){
  const result=await post('Runtime.evaluate',{expression:`process.getBuiltinModule('module').createRequire(${requireBase})('electron').ipcMain._invokeHandlers.get(${JSON.stringify(channel)})`,objectGroup:'ri00-e3-entry-discovery'});
  const handler=result.result?.objectId;if(result.exceptionDetails||!handler)throw Error('site_proof_handler_missing');
  const outerSource=await source(handler),a=await closure(handler,'authorize'),run=await closure(handler,'runAuthorization'),callback=await closure(handler,'callback');
  if(!/runAuthorization\(authorize, entry, event\);\s*return callback\(event, \.\.\.args\);/.test(outerSource))throw Error('site_proof_authorization_order');
  if(authorize)await same(authorize,a);else{authorize=a;authorizationSource=await source(a);}
  if(!/authorize\(\{ entry, event \}\)/.test(await source(run)))throw Error('site_proof_authorization_bridge');
  // A no-op default authorizer must never qualify. Static contract checks are not a behavioral authorization test.
  for(const text of['records.get(sender)','allowedWindowRoles','isTopFrame(event)','record.allowedLocations'])if(!authorizationSource.includes(text))throw Error('site_proof_trusted_authorizer_missing');
  await same(refs.ports,await closure(callback,'ports'));handlers.push({channel,key,handler,callback,outerSource});
 }
 return{refs,handlers,authorize,authorizationSource,proof:{...refs.proof,outerAuthorizationBeforeCallback:true,sharedTrustedWindowAuthorizer:true,noAuthorizationOrBusinessFunctionInvoked:true,behavioralAuthorizationNotClaimed:true}};
}
