import {expect,test} from 'bun:test';
import {act} from 'react';
import {createRoot} from '@opentui/react';
import {createTestRenderer} from '@opentui/core/testing';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {TuiHost} from './tui-host.ts';
import type {ChatModelInput,ChatModelPort} from './chat-controller.ts';
import {App} from './app.tsx';
import {ProjectApp} from './project-agent/ProjectApp.tsx';
import {createTuiProjectHost} from './project-agent/tui-project-host.ts';
import {createTuiProjectClient} from './project-agent/tui-project-client.ts';
import {createTuiThemeStore} from './tui-theme.ts';

for(const entry of ['direct','project-classic'])for(const key of ['RETURN','LINEFEED','ctrl-m'])test(`classic composer submits a pasted image and Chinese text with ${key} / ${entry}`,async()=>{
  const previousAct=(globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-send-key-'));
  const previous=process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME=root;
  const image=path.join(root,'screen.png');
  writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8RkAAAAASUVORK5CYII=','base64'));
  const inputs:ChatModelInput[]=[];
  const host:TuiHost={workspaceRoot:root,capabilities:[],toolDefinitions:[],getAccessLevel:()=> 'full_local',setAccessLevel:()=> 'full_local',
    execute:async()=>{throw new Error('unexpected execution');},executeRead:async()=>{throw new Error('unexpected execution');},executeShell:async()=>{throw new Error('unexpected execution');},
    subscribe:()=>()=>{},subscribeApproval:listener=>{listener(null);return()=>{};},dispose:async()=>{}};
  const model:ChatModelPort={initialize:request=>{inputs.push(request.input);return {messages:[],modelMessages:[],toolExecutions:[]};},
    runTurn:async state=>({kind:'completed',state,output:'scripted reply'}),applyToolResults:state=>state};
  const projectHost=entry==='project-classic'?createTuiProjectHost({dataHome:root,workspacePath:root,autoStart:false,getSettings:()=>({memory:{enabled:false}}),executeTurn:async()=>({ok:true,text:'scripted',toolCalls:[]})}):null;
  const projectClient=projectHost?createTuiProjectClient({dataHome:root,host:projectHost,autoStart:false}):null;
  let projectClosed=false;
  if(projectHost&&projectClient){const w=projectHost.registry.ensureForPath(root);projectHost.lifecycle.ensureBot(w.workspaceId);await projectClient.select(w.workspaceId);}
  const setup=await createTestRenderer({width:147,height:79});
  const rendererRoot=createRoot(setup.renderer);
  const classic=<App host={host} model={model} modelLabel="scripted" onQuit={()=>{}}/>;
  try {
    await act(async()=>{
      rendererRoot.render(projectHost&&projectClient
        ?<ProjectApp host={projectHost} client={projectClient} initialView="conversation" workspacePath={root} locale="zh-CN" themeStore={createTuiThemeStore({userDataPath:root})} onQuit={()=>{}} onClassic={async()=>{rendererRoot.unmount();projectClient.close();await projectHost.close();projectClosed=true;rendererRoot.render(classic);}}/>
        :classic);
      await Bun.sleep(20);
    });
    await setup.flush();
    if(entry==='project-classic'){await act(async()=>{await setup.mockInput.typeText('/classic');setup.mockInput.pressKey('RETURN');await Bun.sleep(50);});await setup.flush();}
    await act(async()=>{await setup.mockInput.pasteBracketedText(image);await Bun.sleep(20);await setup.mockInput.typeText('这个新建机器人的字体太难看了，应该先命名然后选择文件夹？');});
    await setup.flush();await setup.renderOnce();
    expect(setup.captureCharFrame().includes('[Image')).toBe(true);
    await act(async()=>{if(key==='ctrl-m')setup.mockInput.pressKey('m',{ctrl:true});else setup.mockInput.pressKey(key);await Bun.sleep(80);});
    await setup.flush();await setup.renderOnce();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.content).toContain('这个新建机器人');
    expect(inputs[0]?.images).toHaveLength(1);
    expect(setup.captureCharFrame()).toContain('YOU');
  } finally {
    await act(async()=>rendererRoot.unmount());setup.renderer.destroy();
    projectClient?.close();if(projectHost&&!projectClosed)await projectHost.close();
    if(previous===undefined)delete process.env.PEER_AGENT_HOME;else process.env.PEER_AGENT_HOME=previous;
    rmSync(root,{recursive:true,force:true});
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT=previousAct;
  }
});
