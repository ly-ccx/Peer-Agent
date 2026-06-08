export type ClientApi = NonNullable<Window['zeusAtlas']>;

function desktopOnly(method: string): never {
  throw new Error(`Zeus Atlas desktop preload is not available. ${method} must run inside Electron.`);
}

function unavailableMethod<T extends (...args: never[]) => unknown>(method: string): T {
  return ((..._args: Parameters<T>) => desktopOnly(method)) as unknown as T;
}

const unavailableChatApi = new Proxy({}, {
  get(_target, property) {
    return unavailableMethod(`chat.${String(property)}`);
  },
}) as ClientApi['chat'];

const unavailableApi: ClientApi = {
  searchStaff: unavailableMethod('searchStaff'),
  getBootstrap: unavailableMethod('getBootstrap'),
  getClientSession: unavailableMethod('getClientSession'),
  listCapabilities: unavailableMethod('listCapabilities'),
  listProjects: unavailableMethod('listProjects'),
  getCloudRuntime: unavailableMethod('getCloudRuntime'),
  probeCloudContracts: unavailableMethod('probeCloudContracts'),
  getDeveloperSettings: unavailableMethod('getDeveloperSettings'),
  updateDeveloperSettings: unavailableMethod('updateDeveloperSettings'),
  resetDeveloperSettings: unavailableMethod('resetDeveloperSettings'),
  getDeveloperDiagnostics: unavailableMethod('getDeveloperDiagnostics'),
  getRuntimeProjection: unavailableMethod('getRuntimeProjection'),
  publishRuntimeProjection: unavailableMethod('publishRuntimeProjection'),
  getAuthState: unavailableMethod('getAuthState'),
  login: unavailableMethod('login'),
  cancelLogin: unavailableMethod('cancelLogin'),
  logout: unavailableMethod('logout'),
  setLocale: unavailableMethod('setLocale'),
  approveLocalAction: unavailableMethod('approveLocalAction'),
  denyLocalAction: unavailableMethod('denyLocalAction'),
  executeClientToolCall: unavailableMethod('executeClientToolCall'),
  runHealthCheck: unavailableMethod('runHealthCheck'),
  listShellTasks: unavailableMethod('listShellTasks'),
  stopActiveShellTask: unavailableMethod('stopActiveShellTask'),
  stopShellTask: unavailableMethod('stopShellTask'),
  listShellPermissionRules: unavailableMethod('listShellPermissionRules'),
  addShellPermissionRule: unavailableMethod('addShellPermissionRule'),
  listSkills: unavailableMethod('listSkills'),
  refreshSkills: unavailableMethod('refreshSkills'),
  uploadSkill: unavailableMethod('uploadSkill'),
  enableSkill: unavailableMethod('enableSkill'),
  disableSkill: unavailableMethod('disableSkill'),
  mcpListInstalled: unavailableMethod('mcpListInstalled'),
  mcpInstall: unavailableMethod('mcpInstall'),
  mcpUninstall: unavailableMethod('mcpUninstall'),
  mcpListAoneMarket: unavailableMethod('mcpListAoneMarket'),
  mcpListAoneMcpServers: unavailableMethod('mcpListAoneMcpServers'),
  mcpGetAoneMcpDetail: unavailableMethod('mcpGetAoneMcpDetail'),
  mcpListDingtalkMarket: unavailableMethod('mcpListDingtalkMarket'),
  mcpGetDingtalkDetail: unavailableMethod('mcpGetDingtalkDetail'),
  mcpProbe: unavailableMethod('mcpProbe'),
  mcpDingtalkActivate: unavailableMethod('mcpDingtalkActivate'),
  mcpDingtalkAuthStatus: unavailableMethod('mcpDingtalkAuthStatus'),
  mcpConnectAndRegister: unavailableMethod('mcpConnectAndRegister'),
  skillListDingtalkMarket: unavailableMethod('skillListDingtalkMarket'),
  skillListAoneMarket: unavailableMethod('skillListAoneMarket'),
  skillAoneEnsureAuth: unavailableMethod('skillAoneEnsureAuth'),
  skillAoneLogin: unavailableMethod('skillAoneLogin'),
  skillInstallAone: unavailableMethod('skillInstallAone'),
  skillInstallDingtalk: unavailableMethod('skillInstallDingtalk'),
  initialSettings: {},
  getSettings: unavailableMethod('getSettings'),
  updateSettings: unavailableMethod('updateSettings'),
  exportConfig: unavailableMethod('exportConfig'),
  importConfig: unavailableMethod('importConfig'),
  chat: unavailableChatApi,
};

export const clientApi: ClientApi = window.zeusAtlas ?? unavailableApi;
