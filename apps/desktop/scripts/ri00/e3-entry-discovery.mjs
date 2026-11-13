import { inspectNamedReadBindings } from './inspector-read-ports.mjs';

export const E3_READ_ENTRIES = Object.freeze([
  ['project-agent:list','list'], ['project-agent:get','get'], ['project-agent:list-sessions','listSessions'],
  ['project-agent:get-session','getSession'], ['project-agent:list-obligation-grants','listObligationGrants'],
]);
/** Resolve named bindings, then prove object equality. No product function is invoked to discover it. */
export async function discoverE3Entries(post,{electronRequireBase}={}) {
  const {property,closure}=inspectNamedReadBindings(post);
  const requireBase=electronRequireBase?JSON.stringify(electronRequireBase):"process.resourcesPath+'/app.asar/package.json'";
  const same=async(a,b)=>{
    const reply=await post('Runtime.callFunctionOn',{objectId:a,functionDeclaration:'function(other){return this===other;}',arguments:[{objectId:b}],returnByValue:true});
    if(reply.exceptionDetails||reply.result?.value!==true)throw Error('e3_reader_object_mismatch');
  };
  const refs=[];let ports;
  for(const [channel,key]of E3_READ_ENTRIES){
    const response=await post('Runtime.evaluate',{expression:`process.getBuiltinModule('module').createRequire(${requireBase})('electron').ipcMain._invokeHandlers.get(${JSON.stringify(channel)})`,objectGroup:'ri00-e3-entry-discovery'});
    if(response.exceptionDetails||!response.result?.objectId)throw Error('e3_registered_entry_missing:'+key);
    const callback=await closure(response.result.objectId,'callback',true)||response.result.objectId;
    const candidate=await closure(callback,'ports');if(ports)await same(ports,candidate);else ports=candidate;
    refs.push({channel,key,function:await property(candidate,key)});
  }
  const byKey=Object.fromEntries(refs.map(r=>[r.key,r.function]));
  const supervisor=await closure(byKey.listSessions,'sessions');
  for(const key of['getSession','listObligationGrants'])await same(supervisor,await closure(byKey[key],'sessions'));
  const directory=await closure(byKey.list,'directory');await same(directory,await closure(byKey.get,'directory'));
  const batch=await closure(await property(directory,'list'),'readSessionsBatch');
  await same(supervisor,await closure(batch,'supervisor'));
  const single=await closure(await property(directory,'get'),'listSessions');
  await same(supervisor,await closure(single,'supervisor'));
  let list=await property(supervisor,'list'),store;
  for(let i=0;i<8;i++){
    store=await closure(list,'goalPlanStore',true);if(store)break;
    const original=await closure(list,'listed',true)||await closure(list,'original',true);if(!original)break;list=original;
  }
  if(!store)throw Error('e3_goal_plan_reader_missing');
  for(const key of['getPlan','listEvidenceIndex'])await property(store,key);
  for(const key of['list','get','listByWorkspaceIds'])await property(supervisor,key);
  return {ports,directory,supervisor,store,proof:{registeredEntries:refs.map(({channel,key})=>({channel,key})),
    sharedPorts:true,sharedSupervisorForSessionAndGrantEntries:true,sharedDirectoryForListAndGet:true,
    directoryBatchUsesSameSupervisor:true,directorySingleUsesSameSupervisor:true,goalPlanStoreFromSupervisorClosure:true,
    directoryRootMeansTrayCompatibleNotProvenTrayUserAction:true}};
}
