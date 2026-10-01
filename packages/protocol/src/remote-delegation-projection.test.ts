import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseRemoteDelegationProjection} from './remote-access.ts';
const legacy=()=>({version:1,workspaceIds:['bot'],allowTaskRead:true,allowResultExport:true,expiresAt:60_000});
const project=()=>({...legacy(),allowProjectRead:true,allowProjectMessage:true,projectGrants:[{workspaceId:'bot',allowProjectRead:true,allowProjectMessage:true}]});
test('legacy and extended projection preserve exact fields without granting anything',()=>{
  for(const input of [legacy(),project()]){const parsed=parseRemoteDelegationProjection(input,1000);assert.deepEqual(parsed,input);
    input.workspaceIds.push('mutated');assert.deepEqual(parsed?.workspaceIds,['bot']);}
  const p=project(),parsed=parseRemoteDelegationProjection(p,1000);p.projectGrants[0]!.allowProjectMessage=false;assert.equal(parsed?.projectGrants?.[0]?.allowProjectMessage,true);
});
test('shared projection refuses extra fields, invalid grants, capability mismatch and expiry',()=>{
  for(const now of [NaN,Infinity,-1])assert.equal(parseRemoteDelegationProjection(project(),now),null);
  for(const input of [null,[],{}, {...project(),approve:true},{...project(),expiresAt:1000},{...project(),version:0},
    {...project(),allowProjectRead:false},{...project(),allowProjectMessage:false},{...project(),workspaceIds:[]},
    {...project(),projectGrants:[{workspaceId:'bot',allowProjectRead:false,allowProjectMessage:true}]},
    {...project(),projectGrants:[...project().projectGrants,...project().projectGrants]},
    {...project(),projectGrants:[{...project().projectGrants[0],evidence:'secret'}]}])assert.equal(parseRemoteDelegationProjection(input,1000),null);
});
test('legacy retains 32 workspaces, project projection permits 200 explicit grants and defaults off',()=>{
  assert.equal(parseRemoteDelegationProjection({...legacy(),workspaceIds:Array.from({length:33},(_,i)=>'bot'+i)},1000),null);
  const rows=Array.from({length:200},(_,i)=>({workspaceId:'bot'+i,allowProjectRead:true,allowProjectMessage:false}));
  assert.equal(parseRemoteDelegationProjection({...project(),workspaceIds:rows.map(r=>r.workspaceId),allowProjectMessage:false,projectGrants:rows},1000)?.projectGrants?.length,200);
  assert.equal(parseRemoteDelegationProjection({...project(),projectGrants:[...rows,{workspaceId:'extra',allowProjectRead:false,allowProjectMessage:false}]},1000),null);
  assert.ok(parseRemoteDelegationProjection({...project(),workspaceIds:[],projectGrants:[],allowProjectRead:false,allowProjectMessage:false},1000));
});
