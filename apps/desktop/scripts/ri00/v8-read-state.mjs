/** Serialized, synchronous metadata query; no optimization/deoptimization or GC intrinsic is used.
 * Audited against V8 14.6.202.34 runtime-test.cc / runtime.h. The parser gate is restored
 * before returning, including failed queries. Only named, plain production JS functions enter.
 */
export function readV8FunctionState(normalizer,retain,optional,refList,stringArray,getPlan,pathJoin,pathNormalize,readCache,debugLayout=false){
  const version=process.versions.v8;
  if(version.split('-')[0]!=='14.6.202.34')return {ok:false,reason:'unaudited_v8_version',version};
  if(debugLayout&&!globalThis.__ri00CpuGuard)return {ok:false,reason:'layout_print_requires_owned_fixture',version};
  const functions={readEvidenceIndex:this,normalizeEvidenceIndexRecord:normalizer,retainInteractiveEvidence:retain,normalizeOptionalString:optional,
    normalizeEvidenceRefList:refList,normalizeStringArray:stringArray,getPlan,pathJoin,pathNormalize};
  const crypto=process.getBuiltinModule('crypto'),v8=process.getBuiltinModule('v8');
  for(const fn of Object.values(functions))if(typeof fn!=='function'||fn.name.startsWith('bound ')||Function.prototype.toString.call(fn).includes('[native code]'))
    return {ok:false,reason:'plain_js_function_required',version};
  // A previously compiled Function body can be returned from V8's compilation cache
  // after the flag has been disabled. Fresh source is required to test the parser.
  const allowed=()=>{try{Function('f',`return %GetOptimizationStatus(f); // ${crypto.randomUUID()}`);return true;}catch{return false;}};
  const originalAllowed=allowed(),beforeTag=v8.cachedDataVersionTag(),result={kind:'v8-read-metadata-only',version,originalNativeSyntaxAllowed:originalAllowed,
    functions:{},protectors:{},failures:[],beforeTag};
  try{
    if(!originalAllowed)v8.setFlagsFromString('--allow-natives-syntax');
    const status=Function('f','return %GetOptimizationStatus(f);');
    for(const [name,fn]of Object.entries(functions))result.functions[name]={status:status(fn)};
    for(const name of ['ArraySpeciesProtector','ArrayIteratorProtector','MapIteratorProtector','SetIteratorProtector','StringIteratorProtector','NoElementsProtector','StringWrapperToPrimitiveProtector'])
      result.protectors[name]=Function(`return %${name}();`)();
    const records=readCache?.records;
    if(Array.isArray(records)&&records.length){
      const young=Function('value','return %InYoungGeneration(value);'),fast=Function('value','return %HasFastProperties(value);');
      const elements={};
      for(const name of ['HasFastElements','HasHoleyElements','HasDictionaryElements','HasPackedElements','HasCowElements','HasElementsInALargeObjectSpace'])elements[name]=Function('value',`return %${name}(value);`)(records);
      const sample={count:0,rawYoung:0,rawFast:0,outputYoung:0,outputFast:0,artifactRefsYoung:0,artifactRefsCount:0};
      // Query each fresh record immediately, before another record can cause a collection.
      // This is a separate, bounded read, outside all performance timings.
      for(let i=0;i<Math.min(256,records.length);i++){
        const raw=records[Math.floor(i*records.length/Math.min(256,records.length))];
        if(!raw||typeof raw!=='object')continue;
        sample.rawYoung+=Number(young(raw));sample.rawFast+=Number(fast(raw));
        const output=normalizer(raw);if(!output||typeof output!=='object')continue;
        sample.count++;sample.outputYoung+=Number(young(output));sample.outputFast+=Number(fast(output));
        if(Array.isArray(output.artifactRefs)){sample.artifactRefsCount++;sample.artifactRefsYoung+=Number(young(output.artifactRefs));}
      }
      result.allocation={kind:'immediate-generation-sample-not-retained-heap-size',rawRows:records.length,elements,sample};
      if(debugLayout){
        // Raw values/addresses remain in the owned fixture's private output only.
        // The controller rejects this option for all actual-process modes.
        const print=Function('value','%DebugPrint(value);');
        for(const index of [0,Math.floor(records.length/2),records.length-1]){
          process.stdout.write(`ri00-layout-raw-${index}\n`);print(records[index]);
          process.stdout.write(`ri00-layout-output-${index}\n`);print(normalizer(records[index]));
        }
        process.stdout.write('ri00-layout-normalizer-feedback\n');print(normalizer);
        process.stdout.write('ri00-layout-retain-feedback\n');print(retain);
        result.privateLayoutPrinted=true;
      }
    }else result.allocation={kind:'cache-not-populated'};
    result.ok=true;
  }catch(error){result.ok=false;result.failures.push({name:error.name,code:error.code||null});}
  finally{
    if(!originalAllowed)v8.setFlagsFromString('--no-allow-natives-syntax');
    result.nativeSyntaxRestored=allowed()===originalAllowed;result.afterTag=v8.cachedDataVersionTag();
    result.flagIdentityRestored=result.beforeTag===result.afterTag;
    result.ok=result.ok&&result.nativeSyntaxRestored&&result.flagIdentityRestored;
  }
  for(const [name,fn]of Object.entries(functions)){
    if(!result.functions[name])continue;
    const row=result.functions[name],bits=row.status;
    row.sourceSha256=crypto.createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');
    row.attachedOptimized=Boolean(bits&(1<<3));row.maglev=Boolean(bits&(1<<4));row.turbofan=Boolean(bits&(1<<5));row.interpreted=Boolean(bits&(1<<6));
    row.baseline=Boolean(bits&(1<<14));row.tieringInProgress=Boolean(bits&(1<<9));row.markedForDeoptimization=Boolean(bits&(1<<13));
  }
  return result;
}
