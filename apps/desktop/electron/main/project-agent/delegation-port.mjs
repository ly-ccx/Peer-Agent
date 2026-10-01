/** 调度 Provider 调用时读取桌面安装的监督者，避免启动顺序形成第二套运行时。 */
let current = null;
export function installDelegation(port) {
  current = port?.supervisor ? port : null;
  return () => { if (current === port) current = null; };
}
export function delegationStoreDir() { return current?.storeDir || ''; }
export function liveDelegationSupervisor() {
  return Object.fromEntries(['spawn', 'list', 'get', 'cancel', 'message'].map((name) => [name, (...args) => (
    typeof current?.supervisor?.[name] === 'function' ? current.supervisor[name](...args) : { error: 'supervisor_unavailable' }
  )]));
}
