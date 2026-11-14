/** Inspect only named read-port bindings. Never return scope contents or primitive values. */
export function inspectNamedReadBindings(post) {
  const properties = async objectId => (await post('Runtime.getProperties', { objectId, ownProperties: true }));
  async function property(objectId, key) {
    const reply = await properties(objectId);
    const value = reply.result.find(row => row.name === key)?.value;
    if (!value?.objectId) throw new Error(`read_port_property_missing:${key}`);
    return value.objectId;
  }
  async function closure(objectId, key, optional = false, discovery = null) {
    const reply = await properties(objectId);
    const scopes = reply.internalProperties?.find(row => row.name === '[[Scopes]]')?.value.objectId;
    if (!scopes) { if(discovery)discovery.state='scopes-unavailable';if(optional)return; throw new Error('read_port_scopes_unavailable'); }
    const scopeList = await properties(scopes);
    for (const item of scopeList.result) {
      if (!/^\d+$/.test(item.name) || !item.value?.objectId) continue;
      const entries = await properties(item.value.objectId);
      const binding = entries.result.find(row => row.name === key);
      if(binding){
        const value=binding.value;
        if(discovery)discovery.state=value?.subtype||value?.type||'unavailable';
        if(value?.objectId)return value.objectId;
        if(optional)return;
        throw new Error(`read_port_binding_not_an_object:${key}`);
      }
    }
    if(discovery)discovery.state='binding-unavailable';
    if(!optional)throw new Error(`read_port_binding_missing:${key}`);
  }
  return {property,closure};
}

export async function readPortReferences(post) {
  const {property,closure}=inspectNamedReadBindings(post);
  const evaluation = await post('Runtime.evaluate', { expression: `process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron').ipcMain._invokeHandlers.get('project-agent:list-obligation-grants')`, objectGroup: 'ri00-read-ports' });
  if (evaluation.exceptionDetails || !evaluation.result?.objectId) throw new Error('read_port_handler_unavailable');
  const callback = await closure(evaluation.result.objectId, 'callback');
  const ports = await closure(callback, 'ports');
  const grant = await property(ports, 'listObligationGrants');
  const supervisor = await closure(grant, 'sessions');
  let list = await property(supervisor, 'list'),goalPlanStore;
  // The isolated read host retains an owned observation wrapper around the same
  // production method. Follow only its two named original-function bindings.
  for(let i=0;i<8;i++){
    goalPlanStore=await closure(list,'goalPlanStore',true);if(goalPlanStore)break;
    const original=await closure(list,'listed',true)||await closure(list,'original',true);if(!original)break;list=original;
  }
  if(!goalPlanStore)throw new Error('read_port_binding_missing:goalPlanStore');
  const references = [
    { objectId: supervisor, module: 'SessionSupervisor', methods: ['list'] },
    { objectId: goalPlanStore, module: 'GoalPlanStore', methods: ['getPlan', 'listEvidenceIndex'] },
  ];
  // Desktop's host fact port is separate from GoalPlanStore's optional UI-delivery port.
  const discovery={sessionFacts:{},uiDelivery:{},previewProvider:{}};
  const hostFacts=await closure(list,'hostFacts',true);
  const facts = await closure(hostFacts||list, 'readSessionFacts', true,discovery.sessionFacts);
  const delivery = facts && await closure(facts, 'readUiDelivery', true,discovery.uiDelivery);
  const provider = delivery && await closure(delivery, 'desktopPreviewProvider', true,discovery.previewProvider);
  if(provider){
    const authority = await property(provider, 'authority');
    references.push({objectId:authority,module:'UiDeliveryAuthority',methods:['read']});
  }
  references.discovery=discovery;
  return references;
}
