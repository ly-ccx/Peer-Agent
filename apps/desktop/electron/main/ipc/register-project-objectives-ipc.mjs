function owner(name,register){return Object.freeze({owner:name,register});}
export function createProjectObjectivesIpcRegistrations({objectives}={}) {
  for(const name of ['list','update','pause','resume','delete'])if(typeof objectives?.[name]!=='function')throw TypeError(`objectives.${name} required`);
  return Object.freeze([owner('project-objectives-ipc', (ipc) => {
    ipc.handle('project-objectives:list',(_event,payload)=>objectives.list(payload));
    ipc.handle('project-objectives:update',(_event,payload)=>objectives.update(payload));
    ipc.handle('project-objectives:pause',(_event,payload)=>objectives.pause(payload));
    ipc.handle('project-objectives:resume',(_event,payload)=>objectives.resume(payload));
    ipc.handle('project-objectives:delete',(_event,payload)=>objectives.delete(payload));
  })]);
}
