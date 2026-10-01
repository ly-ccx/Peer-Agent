import {expect,test} from 'bun:test';
import {runProjectCardAction} from './card-actions.ts';

function fixture(owner=true) {
  const calls:any[]=[];
  const host={workspaceId:()=> 'workspace',holdsLease:()=>owner,
    supervisor:{get:({sessionId}:any)=>({workspaceId:sessionId==='foreign'?'other':'workspace'}),deliveryFacts:()=>({accepted:true,questionId:'q'}),
      handleHandoffAnswer:async(input:any)=>{calls.push(['handoff',input]);return {ok:true};},confirmResult:async(id:string)=>{calls.push(['confirm',id]);return {ok:true};}},
    lifecycle:{startFamiliarize:async(id:string)=>{calls.push(['familiarize',id]);return {ok:true};},acceptReadme:async()=>({ok:true})},
    memory:{resolveConflict:(input:any)=>{calls.push(['memory',input]);return {ok:true};}}};
  const client={submit:(text:string,input:any)=>{calls.push(['submit',text,input]);return {inputId:'receipt'};},
    decide:async(...args:any[])=>{calls.push(['approval',...args]);return {ok:true};}};
  return {host:host as any,client:client as any,calls};
}

test('client submits ordinary answers but cannot decide approvals or alter local facts',async()=>{
  const f=fixture(false);
  expect(await runProjectCardAction(f.host,f.client,{channel:'project-agent:submit-input',payload:{text:'yes',answerTo:'ordinary-question'}})).toEqual({ok:true,inputId:'receipt'});
  for(const channel of ['project-agent:decide-approval','project-agent:confirm-result','project-agent:start-familiarize','project-memory:restore']) {
    expect(await runProjectCardAction(f.host,f.client,{channel,payload:{}})).toEqual({ok:false,error:'desktop_approval_required'});
  }
  expect(f.calls).toEqual([['submit','yes',{answerTo:'ordinary-question'}]]);
});

test('accepted handoff answers require local ownership before writing any input',async()=>{
  const f=fixture(false),action={channel:'project-agent:submit-input',payload:{text:'continue',answerTo:'card:question:session:q'}};
  expect(await runProjectCardAction(f.host,f.client,action)).toEqual({ok:false,error:'desktop_approval_required'});
  expect(f.calls).toEqual([]);
  const owner=fixture();expect(await runProjectCardAction(owner.host,owner.client,action)).toEqual({ok:true,inputId:'receipt'});
  expect(owner.calls.map(row=>row[0])).toEqual(['submit','handoff']);
});

test('owner action ports preserve task approval scope and reject foreign task confirmations',async()=>{
  const f=fixture();
  expect(await runProjectCardAction(f.host,f.client,{channel:'project-agent:decide-approval',payload:{approvalId:'actual-id',decision:'approve',duration:'task'}})).toEqual({ok:true});
  expect(f.calls[0]).toEqual(['approval','actual-id','approve','task']);
  expect(await runProjectCardAction(f.host,f.client,{channel:'project-agent:confirm-result',payload:{sessionId:'foreign'}})).toEqual({ok:false,error:'workspace_mismatch'});
  expect(await runProjectCardAction(f.host,f.client,{channel:'project-agent:confirm-result',payload:{sessionId:'local'}})).toEqual({ok:true});
  expect(await runProjectCardAction(f.host,f.client,{channel:'project-agent:start-familiarize'})).toEqual({ok:true});
  expect(await runProjectCardAction(f.host,f.client,{channel:'project-memory:restore',payload:{id:'item',resolveConflict:true}})).toEqual({ok:true});
  expect(f.calls.slice(1)).toEqual([['confirm','local'],['familiarize','workspace'],['memory',{workspaceId:'workspace',id:'item'}]]);
  expect(await runProjectCardAction(f.host,f.client,{channel:'unknown'})).toEqual({ok:false,error:'invalid_action'});
});
