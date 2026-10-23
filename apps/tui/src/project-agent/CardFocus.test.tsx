import {expect,test} from 'bun:test';
import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTuiThemeStore} from '../tui-theme.ts';
import {createTuiProjectHost} from './tui-project-host.ts';import {createTuiProjectClient} from './tui-project-client.ts';import {ProjectApp} from './ProjectApp.tsx';

/**
 * 对话视图里的「需要你回答」卡片必须能被键盘操作。
 * 回归点：Tab 曾只把 view 切到 cards，对话视图内完全没有焦点，选项无法选择。
 */
async function harness() {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-card-focus-')),workspace=path.join(root,'project');mkdirSync(workspace);
  writeFileSync(path.join(root,'llm-providers.json'),JSON.stringify([{id:'configured',provider:'openai',model:'fixture',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsStructured:true,isDefault:true}]));
  const host=createTuiProjectHost({dataHome:root,workspacePath:workspace,autoStart:false,getSettings:()=>({memory:{enabled:false}}),executeTurn:async()=>({ok:true,text:'scripted UI reply',toolCalls:[]})});
  const client=createTuiProjectClient({dataHome:root,host,autoStart:false});
  const entry=host.registry.ensureForPath(workspace);
  host.lifecycle.ensureBot(entry.workspaceId);
  await client.select(entry.workspaceId);
  const setup=await testRender(<ProjectApp host={host} client={client} initialView="conversation" workspacePath={workspace} locale="en-US" themeStore={createTuiThemeStore({userDataPath:root})} onClassic={async()=>{}} onQuit={()=>{}}/>,{width:90,height:30});
  async function frame(){await act(async()=>{await Bun.sleep(25);});await setup.flush();await setup.renderOnce();return setup.captureCharFrame();}
  return {
    host,client,setup,frame,
    press:async(key:Parameters<typeof setup.mockInput.pressKey>[0])=>{await act(async()=>{setup.mockInput.pressKey(key);await Bun.sleep(20);});},
    async close(){await act(async()=>{setup.renderer.destroy();});client.close();await host.close();rmSync(root,{recursive:true,force:true});},
  };
}

test('the familiarize card is operable from the conversation view, not only via /cards',async()=>{
  const f=await harness();
  try{
    // 让快照带上一张待处理的熟悉项目卡片。
    f.host.lifecycle.ensureBot(f.host.workspaceId());
    await act(async()=>{await f.host.tick();await f.client.poll();});
    const withCard=await f.frame();
    expect(withCard).toContain('familiarize myself with this project');

    // Tab 进入卡片焦点：提示切换成焦点键位，输入框让出键盘。
    await f.press('TAB');
    const focused=await f.frame();
    expect(focused).toContain('option');
    expect(focused).toContain('Esc back to typing');

    // Esc 退回输入框，提示回到未聚焦态。
    await f.press('ESCAPE');
    const released=await f.frame();
    expect(released).toContain('Tab to select cards');
  }finally{await f.close();}
},30000);

test('Enter in card focus actually runs the selected action',async()=>{
  const f=await harness();
  try{
    f.host.lifecycle.ensureBot(f.host.workspaceId());
    await act(async()=>{await f.host.tick();await f.client.poll();});
    expect(await f.frame()).toContain('familiarize myself with this project');

    // 用 spy 证明回车真的走到了卡片动作，而不只是视觉变化。
    let started=0;
    const realStart=(f.host.lifecycle as any).startFamiliarize.bind(f.host.lifecycle);
    (f.host.lifecycle as any).startFamiliarize=async(...args:any[])=>{started+=1;return await realStart(...args);};

    await f.press('TAB');
    expect(await f.frame()).toContain('Esc back to typing');
    await f.press('RETURN');
    await act(async()=>{await Bun.sleep(120);});
    expect(started).toBe(1);
  }finally{await f.close();}
},30000);

test('typing while the card has focus returns the keyboard to the composer',async()=>{
  const f=await harness();
  try{
    f.host.lifecycle.ensureBot(f.host.workspaceId());
    await act(async()=>{await f.host.tick();await f.client.poll();});
    expect(await f.frame()).toContain('familiarize myself with this project');

    await f.press('TAB');
    expect(await f.frame()).toContain('Esc back to typing');

    // 焦点在卡片上时直接打字：应把键盘交回输入框，而不是吞掉这次输入。
    await f.press('x');
    const afterTyping=await f.frame();
    expect(afterTyping).toContain('Tab to select cards');
    expect(afterTyping).not.toContain('Esc back to typing');
  }finally{await f.close();}
},30000);
