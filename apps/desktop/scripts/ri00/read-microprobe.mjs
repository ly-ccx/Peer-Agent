/** Identical CDP function in each host; selected names/content never leave the process. */
export function readMicroprobe() {
  const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
  const crypto = process.getBuiltinModule('crypto'), v8 = process.getBuiltinModule('v8');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  const directory = this.getStoreDir();
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'index.json').sort().slice(0, 200);
  const ids = names.map(name => name.slice(0, -5));
  const files=ids.map(id=>path.join(directory,`${id}.json`)),missing=ids.map(id=>path.join(directory,`${id}.ri00-missing`));
  const flatDirectory=Buffer.from(directory,'utf8').toString('utf8');
  const stamps=names.map(name=>{const s=fs.statSync(path.join(directory,name),{bigint:true});return [name,...['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key]))]});
  const frozen={tasks:0,runners:0};
  const facts=ids.map(id=>{const p=this.getPlan(id);if(Object.isFrozen(p?.tasks))frozen.tasks++;if(Object.isFrozen(p?.runner))frozen.runners++;
    return [id,p?.status,p?.runner?.status,p?.tasks?.length,p?.updatedAt]});
  for (const id of ids) this.getPlan(id); // Warm this exact selected set in each context.
  const cases = {};
  for (const [name, inputs, fn] of [
    ['pathJoin',ids,id=>path.join(directory,`${id}.json`)],
    ['pathJoinFlat',ids,id=>path.join(flatDirectory,`${id}.json`)],
    ['pathJoinConstant',ids,()=>path.join('/tmp/ri00-root','plan-example.json')],
    ['normalizeConstant',ids,()=>path.normalize('/tmp/ri00-root/plan-example.json')],
    ['splitConstant',ids,()=>'/tmp/ri00-root/plan-example.json'.split('/')],
    ['exists',files,file => fs.existsSync(file)],
    ['missing',missing,file => fs.existsSync(file)],
    ['stat',files,file => fs.statSync(file).size],
    ['getPlan',ids,id => this.getPlan(id)],
  ]) {
    const values = [];
    for (let round = 0; round < 3; round++) { const started = now(); for (const input of inputs) fn(input); values.push(now() - started); }
    cases[name] = values;
  }
  return { at: new Date().toISOString(), selectedFiles: names.length, selectedNamesSha256: hash(JSON.stringify(names)),
    sourceStampsSha256:hash(JSON.stringify(stamps)),selectedFactsSha256:hash(JSON.stringify(facts)),frozen,cases,
    electron: process.versions.electron, node: process.versions.node, noAsar: process.noAsar === true,
    cachedDataVersionTag: v8.cachedDataVersionTag(), heap: v8.getHeapStatistics(), heapSpaces: v8.getHeapSpaceStatistics(),
    heapCode:v8.getHeapCodeStatistics(),pathFunctions:Object.fromEntries(['join','resolve','normalize'].map(key=>[key,hash(Function.prototype.toString.call(path[key]))])),
    fsFunctions: Object.fromEntries(['existsSync','statSync'].map(key => [key, hash(Function.prototype.toString.call(fs[key]))])) };
}
