import{createDenseResidualProbe}from'./dense-residual-probe.mjs';
import{createReadTicketQueue}from'./read-ticket-queue.mjs';

/** A single identical installer source is used by owned hosts and any later Inspector adapter. */
export function e3InstallerSource(){
 return `function(supervisor,payload,options){
  const probe=(${createDenseResidualProbe.toString()}).call(this,supervisor,payload,{...options,longWatch:true,eventLoopReads:true,exposureLedger:true});
  try{const queue=(${createReadTicketQueue.toString()})(probe,options.queue);return {probe,queue};}
  catch(error){probe.stop('queue-install-failed');throw error;}
 }`;
}
