import {realpathSync,statSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createPermissionGrant,createFailedClientToolResult} from '../runtime-gateway/tool-result-factory.mjs';
const READS=new Set(['local.file.read','local.file.list','local.file.search','local.search.aggregate']);
/** Probe authority is a host policy. Cached approvals and full access cannot expand this read-only scope. */
export function evaluateObjectiveProbeCall({policy,call,workspacePath}={}){
 if(policy?.kind!=='objective_probe')return {applies:false,allowed:true};
 const deny=reason=>({applies:true,allowed:false,reason});
 if(!READS.has(call?.capabilityId))return deny('objective_probe_read_only');
 if(typeof policy.workspacePath!=='string'||!policy.workspacePath||workspacePath&&path.resolve(workspacePath)!==path.resolve(policy.workspacePath))return deny('objective_probe_workspace_mismatch');
 const args=call.arguments || {},paths=call.capabilityId==='local.search.aggregate'?(Array.isArray(args.queries)?args.queries.map(query=>query?.path ?? '.'):[]):[args.path ?? '.'];
 if(!paths.length||paths.some(value=>typeof value!=='string'||!value.trim()))return deny('objective_probe_invalid_path');
 const declaredRoot=path.resolve(policy.workspacePath);
 const relatives=paths.map(value=>path.relative(declaredRoot,path.resolve(declaredRoot,value)));
 if(relatives.some(relative=>relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)))return deny('objective_probe_outside_workspace');
 try{
  const root=realpathSync(policy.workspacePath);
  for(const relative of relatives){
   let candidate=root;
   for(const part of relative.split(path.sep).filter(Boolean)){candidate=path.join(candidate,part);if(lstatSync(candidate).isSymbolicLink())return deny('objective_probe_outside_workspace');}
   if(call.capabilityId==='local.file.read'&&statSync(candidate).size>1024*1024)return deny('objective_probe_file_limit');
  }
 }catch{return deny('objective_probe_path_unavailable');}
 return {applies:true,allowed:true,reason:'objective_probe_observe'};
}

export function objectiveProbeDenial(call,reason,locale='zh-CN'){
 const execution={call,grant:createPermissionGrant({toolCallId:call.toolCallId,granted:false,scope:call.capabilityId}),result:createFailedClientToolResult({call,locale,reason,status:'denied',dataLevel:'D1_internal'})};
 return {success:false,error:reason,output:JSON.stringify({ok:false,error:reason}),execution};
}
