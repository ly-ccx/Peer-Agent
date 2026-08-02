function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createSkillsIpcRegistrations({ skills } = {}) {
  const ports = {
    list: assertFunction(skills?.list, 'skills.list'),
    getDetail: assertFunction(skills?.getDetail, 'skills.getDetail'),
    refresh: assertFunction(skills?.refresh, 'skills.refresh'),
    upload: assertFunction(skills?.upload, 'skills.upload'),
    enable: assertFunction(skills?.enable, 'skills.enable'),
    disable: assertFunction(skills?.disable, 'skills.disable'),
    listAvailable: assertFunction(skills?.listAvailable, 'skills.listAvailable'),
    link: assertFunction(skills?.link, 'skills.link'),
    unlink: assertFunction(skills?.unlink, 'skills.unlink'),
  };

  return Object.freeze([
    owner('skills-ipc', (ipc) => {
      ipc.handle('skills:list', () => ports.list());
      ipc.handle('skills:get-detail', (_event, { skillId } = {}) => ports.getDetail(skillId));
      ipc.handle('skills:refresh', () => ports.refresh());
      ipc.handle('skills:upload', (_event, { zipBase64 }) => ports.upload(zipBase64));
      ipc.handle('skills:enable', (_event, { skillId }) => ports.enable(skillId));
      ipc.handle('skills:disable', (_event, { skillId }) => ports.disable(skillId));
      ipc.handle('skills:list-available', () => ports.listAvailable());
      ipc.handle('skills:link', (_event, { skillId }) => ports.link(skillId));
      ipc.handle('skills:unlink', (_event, { skillId }) => ports.unlink(skillId));
    }),
  ]);
}
