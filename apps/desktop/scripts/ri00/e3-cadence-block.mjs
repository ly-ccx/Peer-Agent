/** Shared by real Inspector seam validation and the experiment. B does not schedule a zero-duration timer. */
export async function executeCadenceBlock({read,calibrate,guard,now=()=>performance.now(),wait=ms=>new Promise(r=>setTimeout(r,ms))},spec,label){const b={label,arm:spec.arm,role:spec.role,points:[],markers:[],sequence:[],calibration:[],waits:[]};
 for(const action of spec.reads){guard();const start=now();while(now()-start<action.waitBeforeMs)await wait(Math.max(1,action.waitBeforeMs-(now()-start)));b.waits.push({scheduledMs:action.waitBeforeMs,actualMs:now()-start});const p=await read(action.kind,'cadence-root');b.sequence.push(p);(action.kind==='dense'?b.points:b.markers).push(p);guard();}
 for(let i=0;i<spec.hashCalls;i++){guard();b.calibration.push(await calibrate());guard();}return b;
}
