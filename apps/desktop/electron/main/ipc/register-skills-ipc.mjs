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
    uninstall: assertFunction(skills?.uninstall, 'skills.uninstall'),
    marketplaceList: assertFunction(skills?.marketplaceList, 'skills.marketplaceList'),
    marketplaceGetDetail: assertFunction(skills?.marketplaceGetDetail, 'skills.marketplaceGetDetail'),
    marketplaceInstall: assertFunction(skills?.marketplaceInstall, 'skills.marketplaceInstall'),
    skillHubQuery: assertFunction(skills?.skillHubQuery, 'skills.skillHubQuery'),
    skillHubGetDetail: assertFunction(skills?.skillHubGetDetail, 'skills.skillHubGetDetail'),
    skillHubGetStatus: assertFunction(skills?.skillHubGetStatus, 'skills.skillHubGetStatus'),
    skillHubSync: assertFunction(skills?.skillHubSync, 'skills.skillHubSync'),
    skillHubInstall: assertFunction(skills?.skillHubInstall, 'skills.skillHubInstall'),
    skillHubListCategories: assertFunction(skills?.skillHubListCategories, 'skills.skillHubListCategories'),
    qoderQuery: assertFunction(skills?.qoderQuery, 'skills.qoderQuery'),
    qoderGetDetail: assertFunction(skills?.qoderGetDetail, 'skills.qoderGetDetail'),
    qoderInstall: assertFunction(skills?.qoderInstall, 'skills.qoderInstall'),
    qoderListTaxonomies: assertFunction(skills?.qoderListTaxonomies, 'skills.qoderListTaxonomies'),
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
      ipc.handle('skills:uninstall', (_event, { skillId }) => ports.uninstall(skillId));
      ipc.handle('skills:marketplace:list', () => ports.marketplaceList());
      ipc.handle('skills:marketplace:get-detail', (_event, { catalogId } = {}) => ports.marketplaceGetDetail(catalogId));
      ipc.handle('skills:marketplace:install', (_event, { catalogId } = {}) => ports.marketplaceInstall(catalogId));
      ipc.handle('skills:skillhub:query', (_event, query = {}) => ports.skillHubQuery(query));
      ipc.handle('skills:skillhub:get-detail', (_event, identity = {}) => ports.skillHubGetDetail(identity));
      ipc.handle('skills:skillhub:get-status', () => ports.skillHubGetStatus());
      ipc.handle('skills:skillhub:sync', (_event, options = {}) => ports.skillHubSync(options));
      ipc.handle('skills:skillhub:install', (_event, identity = {}) => ports.skillHubInstall(identity));
      ipc.handle('skills:skillhub:list-categories', () => ports.skillHubListCategories());
      ipc.handle('skills:qoder:query', (_event, query = {}) => ports.qoderQuery(query));
      ipc.handle('skills:qoder:get-detail', (_event, identity = {}) => ports.qoderGetDetail(identity));
      ipc.handle('skills:qoder:install', (_event, identity = {}) => ports.qoderInstall(identity));
      ipc.handle('skills:qoder:list-taxonomies', () => ports.qoderListTaxonomies());
    }),
  ]);
}
