/** Inspect only named read-port bindings. Never return scope contents or primitive values. */
export async function readPortReferences(post) {
  const properties = async objectId => (await post('Runtime.getProperties', { objectId, ownProperties: true }));
  async function property(objectId, key) {
    const reply = await properties(objectId);
    const value = reply.result.find(row => row.name === key)?.value;
    if (!value?.objectId) throw new Error(`read_port_property_missing:${key}`);
    return value.objectId;
  }
  async function closure(objectId, key) {
    const reply = await properties(objectId);
    const scopes = reply.internalProperties?.find(row => row.name === '[[Scopes]]')?.value.objectId;
    if (!scopes) throw new Error('read_port_scopes_unavailable');
    const scopeList = await properties(scopes);
    for (const item of scopeList.result) {
      if (!/^\d+$/.test(item.name) || !item.value?.objectId) continue;
      const entries = await properties(item.value.objectId);
      const value = entries.result.find(row => row.name === key)?.value;
      if (value?.objectId) return value.objectId;
    }
    throw new Error(`read_port_binding_missing:${key}`);
  }
  const evaluation = await post('Runtime.evaluate', { expression: `process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron').ipcMain._invokeHandlers.get('project-agent:list-obligation-grants')`, objectGroup: 'ri00-read-ports' });
  if (evaluation.exceptionDetails || !evaluation.result?.objectId) throw new Error('read_port_handler_unavailable');
  const callback = await closure(evaluation.result.objectId, 'callback');
  const ports = await closure(callback, 'ports');
  const grant = await property(ports, 'listObligationGrants');
  const supervisor = await closure(grant, 'sessions');
  const list = await property(supervisor, 'list');
  const goalPlanStore = await closure(list, 'goalPlanStore');
  return [
    { objectId: supervisor, module: 'SessionSupervisor', methods: ['list'] },
    { objectId: goalPlanStore, module: 'GoalPlanStore', methods: ['getPlan', 'listEvidenceIndex'] },
  ];
}
