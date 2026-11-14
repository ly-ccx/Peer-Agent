/** Serialized only into a private owned diagnostic. No product/Inspector capability is exposed. */
export function createFr1StageMeter({owner, maxStages=512, maxClocks=2048,
  clock=process.threadCpuUsage.bind(process),monotonic=performance.now.bind(performance)}={}) {
  const nativeClock=clock, now=monotonic;
  const stages=[],clocks=[],open=[];let enabled=true,stageSeq=0,clockSeq=0,invalid=null;
  const fail=reason=>{invalid??=reason;enabled=false;};
  function read(role,previous) {
    const beginWall=now(), value=nativeClock(previous),endWall=now();
    if(enabled){
      if(clocks.length>=maxClocks)fail('clock-cap');
      else clocks.push({id:++clockSeq,role,parent:open.at(-1)?.id??null,beginWall,endWall,
        user:value.user,system:value.system,isDelta:previous!==undefined});
    }
    return {value,beginWall,endWall,id:enabled?clockSeq:null};
  }
  return {
    owner,
    originalClock(previous,site){return read('original-'+site,previous).value;},
    begin(name,rootId,spanPosition){
      if(!enabled)return;
      if(stages.length+open.length>=maxStages){fail('stage-cap');return;}
      const parent=open.at(-1),row={id:++stageSeq,parent:parent?.id??null,name,
        rootId:rootId??parent?.rootId??null,spanPosition:spanPosition??parent?.spanPosition??null,
        beginEntryWall:now(),closed:false};
      const c=read('boundary-begin');if(!enabled)return;
      row.beginClockId=c.id;row.beginClockWall=c.beginWall;row.beginClockEndWall=c.endWall;
      row.beginUser=c.value.user;row.beginSystem=c.value.system;open.push(row);row.beginExitWall=now();
    },
    end(name){
      if(!enabled)return;
      const entryWall=now(),row=open.at(-1);
      if(!row||row.name!==name){fail('stage-order:'+name);return;}
      const c=read('boundary-end');if(!enabled)return;
      row.endEntryWall=entryWall;row.endClockId=c.id;row.endClockWall=c.beginWall;row.endClockEndWall=c.endWall;
      row.endUser=c.value.user;row.endSystem=c.value.system;row.closed=true;open.pop();stages.push(row);
    },
    endIfOpen(name){if(open.at(-1)?.name===name)this.end(name);},
    freeze(){enabled=false;return {owner,pid:process.pid,stages:[...stages,...open.map(x=>({...x,closed:false}))],clocks,
      invalid,openStages:open.map(x=>x.id),limits:{maxStages,maxClocks},clockUnits:'microseconds',runtime:{node:process.versions.node,uv:process.versions.uv},
      observerNeutralityProven:false,notFunctionalQualification:true};},
    clockControl(){
      if(enabled||open.length)throw Error('stage_clock_control_requires_frozen_closed_meter');
      const start=now(),begin=nativeClock(),pairs=[];
      for(let i=0;i<64;i++){
        const a=now(),c0=nativeClock(),b=now(),c1=nativeClock(),c=now();
        const p0=now(),pCpu0=nativeClock(),p1=now(),p2=now(),pCpu1=nativeClock(),p3=now();
        pairs.push({i,beginWall:a,middleWall:b,endWall:c,beginUser:c0.user,beginSystem:c0.system,endUser:c1.user,endSystem:c1.system,
          performancePair:{beginWall:p0,firstWall:p1,secondWall:p2,endWall:p3,beginUser:pCpu0.user,beginSystem:pCpu0.system,endUser:pCpu1.user,endSystem:pCpu1.system}});
      }
      const total=nativeClock(begin),wallMs=now()-start,cpuMs=(total.user+total.system)/1000;
      return{pairs,userMs:total.user/1000,systemMs:total.system/1000,cpuMs,wallMs,
        withinBudget:cpuMs<=50&&wallMs<=200,exactClockCpu:false,noHistoricalOrGateSubtraction:true};
    }
  };
}
