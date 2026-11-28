import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installMotionCapture } from './motion-capture.mjs';

// Virtual browser time makes missing input/frames and the CI late-click trace
// deterministic. Real components, native events and CSS have separate Electron coverage.
function browser(kind,expectedClicks) {
  let now=0,next=0,frames=true;const tasks=new Map(),listeners=new Set();
  const schedule=(callback,ms)=>{const id=++next;tasks.set(id,{at:now+ms,callback});return id};
  const trigger={addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f),querySelector:()=>({})};
  const panel={dataset:{motionOpen:'true'},inert:false};
  const node={...trigger,open:true,querySelector:()=>trigger,getBoundingClientRect:()=>({height:100})};
  const context=vm.createContext({performance:{now:()=>now},setTimeout:schedule,clearTimeout:id=>tasks.delete(id),
    requestAnimationFrame:f=>frames?schedule(()=>f(now),16):0,cancelAnimationFrame:id=>tasks.delete(id),
    getComputedStyle:()=>({opacity:'1',contentVisibility:'visible',transform:'none'}),document:{querySelector:()=>panel},node,options:{kind,expectedClicks}});
  vm.runInContext(`(${installMotionCapture})(node,options)`,context);
  let result;node.__rcMotionCapture.then(v=>{result=JSON.parse(JSON.stringify(v))});
  return {get result(){return result},get listeners(){return listeners.size},get pending(){return tasks.size},
    click(){for(const f of listeners)f()},stopFrames(){frames=false},
    async advance(ms){const end=now+ms;while(true){const entry=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!entry)break;tasks.delete(entry[0]);now=entry[1].at;entry[1].callback();}now=end;await Promise.resolve();}
  };
}
for(const kind of ['disclosure','panel']) {
  test(`${kind}: a5900ms real input gets at least480ms of observation`,async()=>{
    const b=browser(kind,1);await b.advance(5900);b.click();await b.advance(100);
    assert.equal(b.result,undefined,'input deadline cannot end the later observation');
    await b.advance(379);assert.equal(b.result,undefined);await b.advance(33);
    assert.equal(b.result.timedOut,false);assert.equal(b.result.clicks,1);assert.ok(b.result.observationMs>=480);
    assert.equal(b.listeners,0);assert.equal(b.pending,0);
  });
  test(`${kind}: all reversal clicks still share the original input bound`,async()=>{
    const b=browser(kind,2);await b.advance(5900);b.click();await b.advance(85);b.click();await b.advance(480+32);
    assert.equal(b.result.timedOut,false);assert.equal(b.result.clicks,2);assert.ok(b.result.observationMs>=480);
    assert.equal(b.pending,0);
    const missing=browser(kind,2);await missing.advance(5900);missing.click();await missing.advance(100);
    assert.equal(missing.result.timeoutPhase,'input');assert.equal(missing.result.clicks,1);assert.equal(missing.listeners,0);assert.equal(missing.pending,0);
  });
  test(`${kind}: no input and stalled observation remain bounded and release their callbacks`,async()=>{
    const missing=browser(kind,1);await missing.advance(6000);
    assert.equal(missing.result.timeoutPhase,'input');assert.equal(missing.result.clicks,0);assert.equal(missing.pending,0);assert.equal(missing.listeners,0);
    const stalled=browser(kind,1);stalled.stopFrames();await stalled.advance(16);stalled.click();await stalled.advance(5999);
    assert.equal(stalled.result,undefined);await stalled.advance(1);
    assert.equal(stalled.result.timeoutPhase,'observation');assert.equal(stalled.result.clicks,1);assert.equal(stalled.pending,0);assert.equal(stalled.listeners,0);
  });
}
