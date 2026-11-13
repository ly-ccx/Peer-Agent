/** lsof -Fn output for ONE PID. No default debug port and no process-to-process guessing. */
export function loopbackListenerPorts(text){
 const ports=new Set();for(const line of text.split('\n')){if(!line.startsWith('n'))continue;const match=/^n(?:127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(line);if(!match)throw Error('inspector_listener_not_loopback');const p=Number(match[1]);if(p<1||p>65535)throw Error('inspector_listener_port_invalid');ports.add(p);}return [...ports].sort((a,b)=>a-b);
}
export function newlyOwnedPorts(before,after){const old=new Set(before),fresh=after.filter(p=>!old.has(p));if(fresh.length>4)throw Error('inspector_new_listener_cap');return fresh;}
