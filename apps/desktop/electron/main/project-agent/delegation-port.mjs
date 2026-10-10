/** 调度 Provider 调用时读取桌面安装的监督者，避免启动顺序形成第二套运行时。 */
let current = null;
export function installDelegation(port) {
  current = port?.supervisor ? port : null;
  return () => { if (current === port) current = null; };
}
export function delegationStoreDir() { return current?.storeDir || ''; }
export function liveDelegationSupervisor() {
  return Object.fromEntries(['spawn', 'list', 'get', 'cancel', 'message', 'resume', 'reprioritize', 'controlWork', 'coordinateWork', 'coordinationFacts'].map((name) => [name, (...args) => (
    typeof current?.supervisor?.[name] === 'function' ? current.supervisor[name](...args) : { error: 'supervisor_unavailable' }
  )]));
}

export function liveObjectiveService() {
  return Object.fromEntries(['create','update','pause','resume','list','get','close','prepareSpawn','linkSession'].map(name => [name, (...args) => (
    typeof current?.objectives?.[name] === 'function' ? current.objectives[name](...args) : {ok:false,error:'objectives_unavailable'}
  )]));
}
