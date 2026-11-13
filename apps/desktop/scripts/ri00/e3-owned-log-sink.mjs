import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

/** Owned fixture only: production diagnostic logs go to the private output; canonical paths keep the source guard. */
export function redirectOwnedObligationLog(fixtureRoot,output) {
  const sourceRoot=fs.realpathSync(fixtureRoot),outputRoot=fs.realpathSync(output),destination=path.join(outputRoot,'logs');
  const sources=[path.join(sourceRoot,'logs'),path.resolve(fixtureRoot,'logs')];
  if(outputRoot===sourceRoot||outputRoot.startsWith(sourceRoot+path.sep))throw Error('e3_owned_log_output_required');
  const installed=[],state={redirected:0,restored:null};
  const redirect=value=>{
    if(typeof value!=='string')return value;
    const resolved=path.resolve(value);
    for(const source of sources){const relative=path.relative(source,resolved);
      if(relative===''||/^obligation\.log(?:\.[1-3])?$/.test(relative)){state.redirected++;return path.join(destination,relative);}}
    return value;
  };
  for(const name of['mkdirSync','statSync','appendFileSync','renameSync','unlinkSync']){
    const original=fs[name],wrapped=function(...args){args[0]=redirect(args[0]);if(name==='renameSync')args[1]=redirect(args[1]);return Reflect.apply(original,this,args);};
    fs[name]=wrapped;installed.push({name,original,wrapped});
  }
  syncBuiltinESMExports();
  return {state,close(){let restored=true;for(const i of installed){if(fs[i.name]===i.wrapped)fs[i.name]=i.original;else if(fs[i.name]!==i.original)restored=false;}state.restored=restored;syncBuiltinESMExports();return {...state};}};
}
