import { createE3EntryAdapter } from './e3-entry-adapter.mjs';
import { createDenseResidualProbe } from './dense-residual-probe.mjs';
import { createReadTicketQueue } from './read-ticket-queue.mjs';

export function e3SiteInstallerSource() {
  return `function(supervisor,payload,options,bindings){
    let probe,entries;
    entries=(${createE3EntryAdapter.toString()})(bindings.entries,bindings.readers,{epoch:options.queue.epoch,
      onFatal:reason=>{if(probe)probe.stop(reason);else entries?.stop(reason);}});
    try{
      probe=(${createDenseResidualProbe.toString()}).call(this,supervisor,payload,{...options,longWatch:true,eventLoopReads:true,exposureLedger:true,entryLedger:entries});
      const queue=(${createReadTicketQueue.toString()})(probe,options.queue);
      return {probe,queue,entries,renew(){if(!entries.verifyOwners({skipLayered:true})){probe.stop('entry-owner-changed');throw Error('e3_entry_owner_changed');}return probe.renew();}};
    }catch(error){probe?.stop('site-install-failed');entries.stop('site-install-failed');throw error;}
  }`;
}

export function e3SiteCallDeclaration() {
  return `function(supervisor,payload,options,ports,directory){
    const bindings={entries:['list','get','listSessions','getSession','listObligationGrants'].map(key=>({object:ports,key,kind:'ipc-'+key})),
      readers:[{object:this,key:'getPlan',port:'plan',layered:true},{object:this,key:'listEvidenceIndex',port:'index',layered:true},
        ...['list','listByWorkspaceIds','get'].map(key=>({object:supervisor,key,port:'supervisor-'+key,layered:key!=='get'}))]};
    bindings.entries.push({object:directory,key:'list',kind:'directory-list'});
    globalThis.__e3Owned=(${e3SiteInstallerSource()}).call(this,supervisor,payload,options,bindings);return true;
  }`;
}

/** Installation qualification only: no event loop turn or business query between install and restoration. */
export function e3SynchronousAssemblySource(){return `function(supervisor,payload,options,ports,directory){
 if(Object.hasOwn(globalThis,'__e3Owned')||Object.hasOwn(globalThis,options.notificationName))throw Error('site_assembly_owner_exists');
 const notice=()=>{};globalThis[options.notificationName]=notice;let site,stopped;
 try{(${e3SiteCallDeclaration()}).call(this,supervisor,payload,options,ports,directory);site=globalThis.__e3Owned;site.renew();stopped=site.probe.stop('controller');
  if(stopped.controlledRows||stopped.naturalRows||stopped.outsideRows)throw Error('site_assembly_business_read_detected');
  return{stopped,sameSynchronousCall:true};
 }finally{if(site&&!stopped)site.probe.stop('assembly-failed');if(globalThis.__e3Owned===site)delete globalThis.__e3Owned;if(globalThis[options.notificationName]===notice)delete globalThis[options.notificationName];}
}`;}
