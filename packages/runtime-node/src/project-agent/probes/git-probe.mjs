import { createHash } from 'node:crypto';
import { runReadProcess } from './read-process.mjs';

export async function probeGit({workspacePath,ref='HEAD',on='new_commits',signal,run=runReadProcess}={}) {
  if(typeof ref!=='string'||!ref||ref.length>200||ref.startsWith('-')||/[\s\x00-\x1f]/.test(ref))return {ok:false,unavailableReason:'git_ref_invalid'};
  const head=await run('git',['-C',workspacePath,'rev-parse','--verify',`${ref}^{commit}`],{cwd:workspacePath,signal,maxBytes:4096});
  if(!head.ok)return {ok:false,unavailableReason:head.reason==='cancelled'?'cancelled':'git_ref_unavailable'};
  const branch=await run('git',['-C',workspacePath,'symbolic-ref','--quiet','--short','HEAD'],{cwd:workspacePath,signal,maxBytes:4096});
  if(signal?.aborted)return {ok:false,unavailableReason:'cancelled'};
  const revision=head.stdout.trim();if(!/^[a-f0-9]{40,64}$/i.test(revision))return {ok:false,unavailableReason:'git_ref_invalid'};
  const value=on==='new_tag'?`${ref}:${revision}`:`${branch.ok?branch.stdout.trim():'detached'}:${revision}`;
  return {ok:true,digest:createHash('sha256').update(value).digest('hex'),summary:`Git ${ref}: ${revision.slice(0,12)}`,value,succeeded:true,severity:'info'};
}
