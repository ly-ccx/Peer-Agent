import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileFr1SelfWindows} from './fr1-stage-replay.mjs';

function fixture(){
  const clocks=[],stages=[];let id=0,time=0;
  function c(role,user,isDelta=false){const x={id:++id,role,user,system:0,isDelta,beginWall:++time,endWall:++time};clocks.push(x);return x;}
  function segment(name,span,startRole,endRole,startCpu,endCpu,delta=false){c(startRole,startCpu,delta);const b=c('boundary-begin',100);
    const e=c('boundary-end',110);stages.push({id:stages.length+1,rootId:1,name,spanPosition:span,beginClockWall:b.beginWall,endClockEndWall:e.endWall,beginUser:100,beginSystem:0,endUser:110,endSystem:0});c(endRole,endCpu);}
  segment('root.pre',null,'original-1','original-1',10,30);
  segment('span.pre',0,'original-1','original-7',40,70);
  segment('span.post',0,'original-8','original-1',15,105,true);
  segment('root.post',null,'original-1','original-1',120,140);
  segment('root.keep',null,'original-1','original-1',150,170);
  return{meter:{clocks,stages},root:{id:1,preSelfMs:.020,postSelfMs:.020,evidence:[{selfMs:.050}],planCounterWallUpperMs:.005,instrumentationCpuMs:.095},state:{lastRootSelfCpuMs:.115}};
}
test('original delta snapshot reconstructs only its proved span start and closes CPU arithmetic',()=>{
  const f=fixture(),a=reconcileFr1SelfWindows(f.meter,f.root,f.state);assert.equal(a.windows.length,5);
  assert.ok(Math.abs(a.totalCpuMs-.110)<1e-10);assert.equal(a.clocks[0].count,10);assert.equal(a.clocks[1].count,10);
  assert.equal(a.clocks[0].exactCpuUnknown,true);assert.ok(Math.abs(a.windows.find(x=>x.name==='span.post').cpuMs-.020)<1e-10);
});
test('missing native boundary cannot be filled by a nearby unrelated snapshot',()=>{
  const f=fixture();f.meter.clocks=f.meter.clocks.filter(x=>x.role!=='original-7');assert.throws(()=>reconcileFr1SelfWindows(f.meter,f.root,f.state));
});
test('a mismatching legacy charge is retained as failure rather than proportionally fitted',()=>{
  const f=fixture();f.state.lastRootSelfCpuMs+=.1;assert.throws(()=>reconcileFr1SelfWindows(f.meter,f.root,f.state),/mismatch/);
});
