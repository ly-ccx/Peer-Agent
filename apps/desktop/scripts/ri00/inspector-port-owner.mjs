/** lsof -Fn output for ONE PID. No default debug port and no process-to-process guessing. */
export function loopbackListenerPorts(text){
 const ports=new Set();for(const line of text.split('\n')){if(!line.startsWith('n'))continue;const match=/^n(?:127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(line);if(!match)throw Error('inspector_listener_not_loopback');const p=Number(match[1]);if(p<1||p>65535)throw Error('inspector_listener_port_invalid');ports.add(p);}return [...ports].sort((a,b)=>a-b);
}
export function newlyOwnedPorts(before,after){const old=new Set(before),fresh=after.filter(p=>!old.has(p));if(fresh.length>4)throw Error('inspector_new_listener_cap');return fresh;}

/** Metadata discovery only. The caller must still verify CDP process.pid before any installation or close. */
export async function discoverFreshInspector({beforePorts,listeners,readList,attempts=10,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 for(let i=0;i<attempts;i++){const matches=[];for(const port of newlyOwnedPorts(beforePorts,await listeners())){
   let list;try{list=await readList(port);}catch{continue;}
   for(const node of list){if(node.type!=='node'||!node.webSocketDebuggerUrl)continue;const u=new URL(node.webSocketDebuggerUrl);if(!['127.0.0.1','[::1]'].includes(u.hostname)||Number(u.port)!==port)throw Error('inspector_endpoint_owner_invalid');matches.push({port,url:node.webSocketDebuggerUrl});}
  }if(matches.length>1)throw Error('inspector_endpoint_ambiguous');if(matches.length===1)return matches[0];await wait(50);
 }throw Error('inspector_endpoint_not_found');
}
