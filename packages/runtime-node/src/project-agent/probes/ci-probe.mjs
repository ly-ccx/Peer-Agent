import { createHash } from 'node:crypto';
import { runReadProcess } from './read-process.mjs';
const FIELDS='databaseId,status,conclusion,headSha,headBranch,workflowName';
export async function probeCi({workspacePath,workflow,signal,run=runReadProcess}={}) {
  if(workflow!==undefined&&(typeof workflow!=='string'||!workflow.trim()||workflow.length>200||workflow.startsWith('-')||/[\x00-\x1f]/.test(workflow)))return {ok:false,unavailableReason:'ci_workflow_invalid'};
  const authenticated=await run('gh',['auth','status'],{cwd:workspacePath,signal});
  if(!authenticated.ok)return {ok:false,unavailableReason:authenticated.reason==='cancelled'?'cancelled':authenticated.reason==='unavailable'?'gh_unavailable':'gh_auth_required'};
  const branchResult=await run('git',['symbolic-ref','--quiet','--short','HEAD'],{cwd:workspacePath,signal,maxBytes:4096});
  const branch=branchResult.stdout?.trim();
  if(!branchResult.ok||!branch||branch.startsWith('-')||/[\s\x00-\x1f]/.test(branch))return {ok:false,unavailableReason:branchResult.reason==='cancelled'?'cancelled':'ci_branch_unavailable'};
  const args=['run','list','--branch',branch,'--limit','10','--json',FIELDS,...(workflow?['--workflow',workflow]:[])];
  const result=await run('gh',args,{cwd:workspacePath,signal});
  if(!result.ok)return {ok:false,unavailableReason:result.reason==='cancelled'?'cancelled':'gh_query_failed'};
  let rows;try{rows=JSON.parse(result.stdout);}catch{return {ok:false,unavailableReason:'gh_result_invalid'};}
  if(!Array.isArray(rows)||rows.length>10||rows.some(row=>!Number.isInteger(row.databaseId)||typeof row.status!=='string'||typeof row.headSha!=='string'))return {ok:false,unavailableReason:'gh_result_invalid'};
  const runs=rows.map(row=>Object.fromEntries(FIELDS.split(',').map(key=>[key,typeof row[key]==='string'?row[key].slice(0,200):row[key]??null])));
  const latestByWorkflow=[...new Map(runs.slice().reverse().map(row=>[row.workflowName,row])).values()];
  const failed=latestByWorkflow.some(row=>row.status==='completed'&&['failure','timed_out','action_required'].includes(row.conclusion));
  const succeeded=latestByWorkflow.length>0&&latestByWorkflow.every(row=>row.status==='completed'&&row.conclusion==='success');
  const pending=latestByWorkflow.some(row=>row.status!=='completed');
  return {ok:true,digest:createHash('sha256').update(JSON.stringify(runs)).digest('hex'),summary:failed?'CI has failed runs':succeeded?'CI checks passed':pending?'CI checks are in progress':runs.length?'CI checks completed without success':'No CI runs found',
    value:failed?'failure':succeeded?'success':pending?'pending':'unknown',succeeded,severity:failed?'urgent':'info',runs};
}
