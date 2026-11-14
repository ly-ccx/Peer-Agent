import {installFr1Recorder}from'./fr1-recorder.mjs';
import {createFr1Profiler}from'./fr1-profiler.mjs';
/** Runs at the proved Store object; preserves the outer trusted authorizers and original payloads. */
export function fr1InstallDeclaration(){return `function(supervisor,ports,directory,options){
 if(Object.hasOwn(globalThis,'__ri00Fr1'))throw Error('fr1_owner_exists');
 const electron=process.getBuiltinModule('module').createRequire(options.electronRequireBase||process.resourcesPath+'/app.asar/package.json')('electron');
 const mapped=[['project-agent:list','list'],['project-agent:get','get'],['project-agent:list-sessions','listSessions'],['project-agent:get-session','getSession'],['project-agent:list-obligation-grants','listObligationGrants']];
 const bindings=mapped.map(([channel,key])=>({object:ports,key,kind:'ipc-'+key}));bindings.push({object:directory,key:'list',kind:'directory-list'});
 for(const[channel,key]of mapped){const slot={};Object.defineProperty(slot,'invoke',{configurable:true,get:()=>electron.ipcMain._invokeHandlers.get(channel),set:f=>electron.ipcMain._invokeHandlers.set(channel,f)});bindings.push({object:slot,key:'invoke',kind:'transport-'+key,transport:true});}
 if(options.ownedFunctional&&globalThis.__fr1OwnedChecks)for(const key of ['asyncValue','throwOriginal','block'])bindings.push({object:globalThis.__fr1OwnedChecks,key,kind:'fixture-'+key});
 const binding=globalThis[options.notificationName];if(typeof binding!=='function')throw Error('fr1_notice_missing');
 const foreground=event=>{const w=electron.BrowserWindow.getFocusedWindow();if(!event)return Boolean(w);return Boolean(w&&event.sender===w.webContents&&event.senderFrame===event.sender.mainFrame);};
 const profilerFactory=(${createFr1Profiler.toString()});
 const recorder=(${installFr1Recorder.toString()})({store:this,roots:['list','listByWorkspaceIds','get'].map(key=>({object:supervisor,key,kind:key})),entries:bindings,
  foreground:options.ownedFunctional?()=>true:foreground,notify:value=>{if(globalThis[options.notificationName]!==binding)throw Error('fr1_notice_owner_changed');binding(JSON.stringify(value));},
  expectedWorkspaceId:options.expectedWorkspaceId,ownerId:options.ownerId,epoch:options.epoch,identityComplete:options.identityComplete,durationMs:options.durationMs,leaseMs:options.leaseMs,profilerFactory,closeInspectorOnWatchdog:!options.ownedFunctional,cleanupNotice:()=>{if(globalThis[options.notificationName]===binding){delete globalThis[options.notificationName];return true;}return false;}});
 globalThis.__ri00Fr1=recorder;return recorder.state();
}`;}
