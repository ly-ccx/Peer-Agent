import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redirectOwnedObligationLog } from './e3-owned-log-sink.mjs';

/** Adds real read-only Directory/application/registration modules to the existing frozen read host. No runtime owner is started. */
export async function createE3EntryReadGraph(host,config,ipcMain) {
  const logSink=redirectOwnedObligationLog(config.fixtureRoot,config.output);
  const from=relative=>import(pathToFileURL(path.join(config.moduleRoot,relative)).href);
  const [{createBotDirectory},{createProjectAgentApplicationService},{createProjectAgentIpcRegistrations}]=await Promise.all([
    from('packages/runtime-node/dist/project-agent/bot-directory.mjs'),
    from('apps/desktop/electron/main/project-agent/project-agent-application-service.mjs'),
    from('apps/desktop/electron/main/ipc/register-project-agent-ipc.mjs'),
  ]);
  const supervisor=host.readPorts.supervisor,target=host.payload.workspaceId;
  const directory=createBotDirectory({rootDir:config.fixtureRoot,
    // Only the frozen target workspace reads the actual Supervisor. Other catalog rows have explicit empty session substitutes.
    listSessions:workspaceId=>workspaceId===target?supervisor.list({workspaceId}):[],
    readSessionsBatch:ids=>{
      const result=supervisor.listByWorkspaceIds(ids.filter(id=>id===target));
      for(const id of ids)if(!result.has(id))result.set(id,[]);return result;
    },getSession:sessionId=>supervisor.get({sessionId}),
  });
  const application=createProjectAgentApplicationService({enabled:()=>true,directory,sessions:supervisor});
  application.listObligationGrants=host.service.listObligationGrants;
  const registered=[];
  for(const registration of createProjectAgentIpcRegistrations({projectAgent:application}))registration.register({
    handle(channel,callback){
      // This owned transport models the named callback wrapper only; it is not a trusted-window/authentication qualification.
      ipcMain.handle(channel,function(...args){return Reflect.apply(callback,this,args);});registered.push(channel);
    },
  });
  const allowed=new Set(['project-agent:list','project-agent:get','project-agent:list-sessions','project-agent:get-session','project-agent:list-obligation-grants']);
  return {directory,application,proofScope:{actualProductionModules:true,targetOnlySessionReads:true,otherMessagesApprovalsAndCards:'empty-read-only-substitutes',
      noRunnerOrLease:true,notFullDesktopAuthorizationOrPerformance:true},
    invoke(channel,payload){if(!allowed.has(channel))throw Error('e3_entry_read_only_channel_required');return ipcMain._invokeHandlers.get(channel)({},payload);},
    logSink,
    close(){application.dispose();for(const channel of registered)ipcMain.removeHandler(channel);return logSink.close();},
  };
}
