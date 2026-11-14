/** Exact boundary arithmetic, not causal attribution or per-function instruction accounting. */
export function decodePassWork(work){
 if(!work||work.failed||work.slots!==26||work.values?.length!==26*44)throw Error('pass_work_incomplete');
 const {numer,denom,levels}=work;if(!Number.isInteger(levels)||levels<1||levels>8||!(numer>0&&denom>0))throw Error('pass_work_layout');
 const a=work.values.map(BigInt),snap=i=>a.slice(i*44,(i+1)*44),tid=a[0];
 for(let i=0;i<26;i++){const s=snap(i);if(s[0]!==tid||s[1]!==BigInt(levels)||s[3]<s[2])throw Error('pass_work_identity');}
 const delta=(lo,hi)=>{const x=snap(lo),y=snap(hi),perLevel=[];for(let l=0;l<levels;l++){const d=[];for(let k=0;k<5;k++){const off=4+l*5+k,v=y[off]-x[off];if(v<0n)throw Error('pass_work_counter_reversed');d.push(v);}perLevel.push(d);}
  return {perLevel:perLevel.map(d=>d.map(String)),instructions:perLevel.reduce((n,d)=>n+d[0],0n).toString(),cycles:perLevel.reduce((n,d)=>n+d[1],0n).toString(),cpuMs:Number(perLevel.reduce((n,d)=>n+d[2]+d[3],0n))*numer/denom/1e6};};
 const root=delta(0,25),passes=Array.from({length:12},(_,i)=>delta(1+i*2,2+i*2));
 const instructions=BigInt(root.instructions)-passes.reduce((n,d)=>n+BigInt(d.instructions),0n),cycles=BigInt(root.cycles)-passes.reduce((n,d)=>n+BigInt(d.cycles),0n);
 if(instructions<0n||cycles<0n)throw Error('pass_work_overlapping_or_reversed');
 // Also verify ordering across adjacent calls, not merely each positive span.
 for(let i=1;i<26;i++)delta(i-1,i);
 return{root,passes,remainder:{instructions:String(instructions),cycles:String(cycles),cpuMs:root.cpuMs-passes.reduce((n,d)=>n+d.cpuMs,0)},
  boundaryWallMs:Number(Array.from({length:26},(_,i)=>snap(i)[3]-snap(i)[2]).reduce((n,x)=>n+x,0n))*numer/denom/1e6,counterCpuUpperMs:work.counterCpuUpperMs,notFunctionInstructions:true};
}
