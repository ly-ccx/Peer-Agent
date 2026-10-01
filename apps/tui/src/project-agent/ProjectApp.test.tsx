import {expect,test} from 'bun:test';
import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTuiThemeStore} from '../tui-theme.ts';
import {createTuiProjectHost} from './tui-project-host.ts';import {createTuiProjectClient} from './tui-project-client.ts';import {ProjectApp} from './ProjectApp.tsx';
async function harness() {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-terminal-surface-')),workspace=path.join(root,'project');mkdirSync(workspace);
  writeFileSync(path.join(root,'llm-providers.json'),JSON.stringify([{id:'configured',provider:'openai',model:'fixture',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsStructured:true,isDefault:true}]));
  const host=createTuiProjectHost({dataHome:root,workspacePath:workspace,autoStart:false,getSettings:()=>({memory:{enabled:false}}),executeTurn:async()=>({ok:true,text:'scripted UI reply',toolCalls:[]})});
  const client=createTuiProjectClient({dataHome:root,host,autoStart:false});let classic=0;
  const setup=await testRender(<ProjectApp host={host} client={client} initialView="bind" workspacePath={workspace} locale="en-US" themeStore={createTuiThemeStore({userDataPath:root})} onClassic={async()=>{classic++;}} onQuit={()=>{}}/>,{width:90,height:30});
  async function frame(){await act(async()=>{await Bun.sleep(25);});await setup.flush();await setup.renderOnce();return setup.captureCharFrame();}
  return {host,client,setup,frame,press:async(key:Parameters<typeof setup.mockInput.pressKey>[0])=>{await act(async()=>{setup.mockInput.pressKey(key);await Bun.sleep(20);});},type:async(text:string)=>{await act(async()=>{await setup.mockInput.typeText(text);});},classic:()=>classic,async close(){await act(async()=>{setup.renderer.destroy();});client.close();await host.close();rmSync(root,{recursive:true,force:true});}};
}
test('binding refusal enters classic without creating any bot',async()=>{
  const f=await harness();try{expect(await f.frame()).toContain('Bind this directory');await f.press('n');await f.frame();
    expect(f.classic()).toBe(1);expect(f.host.directory.list()).toHaveLength(0);
  }finally{await f.close();}
});
test('binding, message submission, list navigation and cards work through the actual terminal renderer',async()=>{
  const f=await harness();try{
    await f.frame();await f.press('y');expect(await f.frame()).toContain('Running here');expect(f.host.directory.list()).toHaveLength(1);
    await f.type('hello');await f.press('RETURN');await act(async()=>{await Bun.sleep(1100);});
    const reply=await f.frame();expect(reply).toContain('hello');expect(reply).toContain('scripted UI reply');
    await f.type('/bots');await f.press('RETURN');expect(await f.frame()).toContain('Up/down to select');
    await f.press('RETURN');await f.frame();
    await f.type('/cards');await f.press('RETURN');expect(await f.frame()).toContain('Needs you');
    await f.press('ESCAPE');await f.frame();
    await f.type('/classic');await f.press('RETURN');await f.frame();expect(f.classic()).toBe(1);
  }finally{await f.close();}
});
