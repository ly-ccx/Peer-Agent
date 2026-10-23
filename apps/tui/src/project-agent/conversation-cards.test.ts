import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {projectConversationCards} from './conversation-cards.ts';
import {createTuiProjectClient} from './tui-project-client.ts';
import type {createTuiProjectHost} from './tui-project-host.ts';
import {cardAction,createCardNumbers} from './commands.ts';

const failure={cardId:'card:agent_unavailable:old',kind:'agent_unavailable',content:'original network failure',
  actions:[{id:'retry',channel:'project-agent:retry',payload:{turnId:'old'}}]};

test('live recovery retires persisted retry actions without changing the stored transcript',()=>{
  const messages=[{id:'failed',kind:'system_card',turnId:'old',cards:[failure]}];
  const current={...failure,resolvedState:'resolved',failureStatus:{phase:'recovered'},actions:[]};
  const projected=projectConversationCards(messages,[current]);
  expect(projected[0].cards).toEqual([current]);
  const cards=createCardNumbers().project('workspace',projected);
  expect(cards).toEqual([]);
  expect(cardAction({kind:'card',operation:'action',number:1,option:1,text:''},cards)).toBeNull();
  expect(messages[0].cards[0]).toBe(failure);
  expect(failure.actions).toHaveLength(1);
});

test('turn references attach legacy failures once and off-page questions remain reachable',()=>{
  const current={...failure,resolvedState:'open',refs:{turnId:'old'}};
  const question={cardId:'question',kind:'question',resolvedState:'open',refs:{replyMessageId:'earlier-reply'},
    actions:[{id:'answer',payload:{answerTo:'question'}}]};
  const projected=projectConversationCards([{id:'legacy',kind:'system_card',turnId:'old',card:'agent_unavailable'}],[current,question]);
  expect(projected).toHaveLength(2);
  expect(projected[0].cards).toEqual([current]);
  expect(projected[1].cards).toEqual([question]);
  expect(projectConversationCards([{id:'reply',kind:'agent_reply',cards:[question]}],[question])).toHaveLength(1);
});

test('client polling replaces raw cards when runtime recovery changes',async()=>{
  const dataHome=mkdtempSync(path.join(os.tmpdir(),'peer-card-projection-'));
  const raw={id:'failed',kind:'system_card',cards:[failure]};
  let live:any={...failure,resolvedState:'open'};
  const host={workspaceId:()=> 'workspace',holdsLease:()=>false,
    directory:{readInteractions:async()=>({ok:true,messages:[raw],nextCursor:null}),
      readConversation:()=>({ok:true,cards:[live]}),list:()=>[],listSessions:()=>[]},
    approvals:{list:()=>[]}} as unknown as ReturnType<typeof createTuiProjectHost>;
  const client=createTuiProjectClient({dataHome,host,autoStart:false});
  try {
    expect(createCardNumbers().project('workspace',(await client.poll(true)).messages)).toHaveLength(1);
    live={...failure,resolvedState:'resolved',failureStatus:{phase:'superseded'},actions:[]};
    const next=await client.poll(true);
    expect(next.messages[0].cards[0]).toEqual(live);
    expect(createCardNumbers().project('workspace',next.messages)).toEqual([]);
    expect(raw.cards[0].actions).toHaveLength(1);
  } finally {client.close();rmSync(dataHome,{recursive:true,force:true});}
});
