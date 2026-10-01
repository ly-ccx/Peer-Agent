import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,mkdirSync,symlinkSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeGit } from './git-probe.mjs';
import { probeFile,expandWatchPaths } from './file-probe.mjs';
import { probeCi } from './ci-probe.mjs';
import { runReadProcess } from './read-process.mjs';

test('real Git ref and branch changes are factual digests; option injection is rejected',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'watch-git-'));
 try{
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
  git(['init','-b','main']);git(['config','user.email','test@local.invalid']);git(['config','user.name','Test']);git(['commit','--allow-empty','-m','first']);
  const first=await probeGit({workspacePath:root});assert.equal(first.ok,true);
  assert.equal((await probeGit({workspacePath:root})).digest,first.digest);
  git(['checkout','-b','other']);assert.notEqual((await probeGit({workspacePath:root})).digest,first.digest);
  git(['commit','--allow-empty','-m','next']);assert.notEqual((await probeGit({workspacePath:root})).value,first.value);
  assert.equal((await probeGit({workspacePath:root,ref:'--output=bad'})).ok,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('file hash, bounded patterns and realpath checks refuse traversal, ignored paths and escaped symlinks',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'watch-file-')),outside=mkdtempSync(path.join(os.tmpdir(),'watch-outside-'));
 try{
  writeFileSync(path.join(root,'a.mjs'),'one');mkdirSync(path.join(root,'src'));writeFileSync(path.join(root,'src/b.mjs'),'two');
  mkdirSync(path.join(root,'node_modules'));writeFileSync(path.join(root,'node_modules/secret.mjs'),'ignored');
  writeFileSync(path.join(outside,'secret'),'private');symlinkSync(path.join(outside,'secret'),path.join(root,'escape'));
  const first=probeFile({workspacePath:root,relative:'a.mjs'});assert.equal(first.ok,true);
  writeFileSync(path.join(root,'a.mjs'),'changed');assert.notEqual(probeFile({workspacePath:root,relative:'a.mjs'}).digest,first.digest);
  assert.equal(probeFile({workspacePath:root,relative:'../secret'}).ok,false);
  assert.equal(probeFile({workspacePath:root,relative:'escape'}).unavailableReason,'file_outside_workspace');
  assert.equal(probeFile({workspacePath:root,relative:'node_modules/secret.mjs'}).ok,false);
  assert.deepEqual(expandWatchPaths(root,['**/*.mjs']).files,['a.mjs','src/b.mjs']);
  assert.deepEqual(expandWatchPaths(root,['src']).files,['src/b.mjs']);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('CI adapter uses only fixed readonly gh args, hides credentials/errors and degrades without auth',async()=>{
 const calls=[],run=async(command,args)=>{calls.push([command,args]);return command==='git'?{ok:true,stdout:'main\n'}:args[0]==='auth'?{ok:true}:{ok:true,stdout:JSON.stringify([{databaseId:1,status:'completed',conclusion:'failure',headSha:'a',headBranch:'main',workflowName:'CI',credential:'never admitted'}])};};
 const first=await probeCi({workspacePath:'/tmp',run});assert.equal(first.ok,true);assert.equal(first.severity,'urgent');assert.equal(first.succeeded,false);
 assert.equal(JSON.stringify(first).includes('credential'),false);assert.deepEqual(calls.map(c=>c[1].slice(0,2)),[['auth','status'],['symbolic-ref','--quiet'],['run','list']]);
 assert.equal((await probeCi({workspacePath:'/tmp',run:async()=>({ok:false,reason:'unavailable',stderr:'sensitive'})})).unavailableReason,'gh_unavailable');
 assert.equal((await probeCi({workspacePath:'/tmp',run:async()=>({ok:false,reason:'nonzero',stderr:'sensitive'})})).unavailableReason,'gh_auth_required');
  assert.equal((await probeCi({workspacePath:'/tmp',workflow:'--bad',run})).ok,false);
  const completed=conclusion=>({databaseId:1,status:'completed',conclusion,headSha:'a',headBranch:'main',workflowName:'CI'});
  const rowsRun=rows=>async(command,args)=>command==='git'?{ok:true,stdout:'main\n'}:args[0]==='auth'?{ok:true}:{ok:true,stdout:JSON.stringify(rows)};
  assert.equal((await probeCi({workspacePath:'/tmp',run:rowsRun([completed('cancelled')])})).value,'unknown');
  assert.equal((await probeCi({workspacePath:'/tmp',run:rowsRun([{...completed('success'),databaseId:2},completed('failure')])})).succeeded,true);
});
test('process abort waits for actual process closure and stdout is bounded',async()=>{
 const abort=new AbortController(),started=Date.now();
 const flight=runReadProcess(process.execPath,['-e',"process.on('SIGTERM',()=>setTimeout(()=>process.exit(),50));setInterval(()=>{},10)"],{cwd:os.tmpdir(),signal:abort.signal});
 setTimeout(()=>abort.abort(),150);const result=await flight;assert.equal(result.reason,'cancelled');assert.ok(Date.now()-started>=150);
 assert.equal((await runReadProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(20000))"],{cwd:os.tmpdir(),maxBytes:100})).reason,'output_limit');
});
