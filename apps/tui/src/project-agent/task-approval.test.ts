import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTuiHost} from '../tui-host.ts';
test('task approval survives runtime disposal but never crosses plan or workspace identity',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-task-approval-')),sessionApprovals=new Set<string>();
  const make=()=>createTuiHost({workspaceRoot:root,userDataPath:path.join(root,'data'),accessLevel:'restricted_local',sessionApprovals});
  const context=(workspaceId='w',planId='p')=>({sessionId:'same-runtime-session',turnId:'turn',turnIndex:0,mode:'chat' as const,
    project:{workspaceId,sessionId:'task',planId,holdsLease:()=>true}});
  let first=make(),second:ReturnType<typeof make>|undefined;
  try{
    const unsubscribe=first.subscribeApproval(row=>row?.resolve('allow-session'));
    expect((await first.executeShell('touch first.txt',context())).result.status).toBe('completed');
    unsubscribe();await first.dispose();second=make();let asked=0;
    const stop=second.subscribeApproval(row=>{if(row){asked++;row.resolve('deny');}});
    expect((await second.executeShell('touch same-task.txt',context())).result.status).toBe('completed');expect(asked).toBe(0);
    expect((await second.executeShell('touch different-plan.txt',context('w','other'))).result.status).toBe('denied');
    expect((await second.executeShell('touch different-workspace.txt',context('other','p'))).result.status).toBe('denied');
    expect(asked).toBe(2);expect(existsSync(path.join(root,'different-plan.txt'))).toBe(false);
    sessionApprovals.clear();expect((await second.executeShell('touch after-handoff.txt',context())).result.status).toBe('denied');
    stop();
  }finally{await first.dispose();await second?.dispose();rmSync(root,{recursive:true,force:true});}
});
