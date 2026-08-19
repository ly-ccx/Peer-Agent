function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createDesktopIpcRegistrations({
  about,
  appshot,
  shortcuts,
  quickChat,
  bootstrap,
  updater,
} = {}) {
  const captureAppshot = assertFunction(appshot?.capture, 'appshot.capture');
  const getAppshotPermissionStatus = assertFunction(
    appshot?.getPermissionStatus,
    'appshot.getPermissionStatus',
  );
  const openScreenSettings = assertFunction(appshot?.openScreenSettings, 'appshot.openScreenSettings');

  const getShortcutStatus = assertFunction(shortcuts?.status, 'shortcuts.status');
  const updateShortcut = assertFunction(shortcuts?.update, 'shortcuts.update');
  const resetShortcut = assertFunction(shortcuts?.reset, 'shortcuts.reset');

  const hideQuickChat = assertFunction(quickChat?.hide, 'quickChat.hide');
  const showQuickChatPopover = assertFunction(quickChat?.showPopover, 'quickChat.showPopover');
  const setQuickChatTaskCardVisible = assertFunction(
    quickChat?.setTaskCardVisible,
    'quickChat.setTaskCardVisible',
  );
  const setQuickChatContentHeight = assertFunction(
    quickChat?.setContentHeight,
    'quickChat.setContentHeight',
  );
  const hideQuickChatPopover = assertFunction(quickChat?.hidePopover, 'quickChat.hidePopover');
  const selectQuickChatPopover = assertFunction(quickChat?.selectPopover, 'quickChat.selectPopover');
  const submitQuickChat = assertFunction(quickChat?.submit, 'quickChat.submit');

  const getBootstrap = assertFunction(bootstrap?.getBootstrap, 'bootstrap.getBootstrap');
  const getSession = assertFunction(bootstrap?.getSession, 'bootstrap.getSession');
  const listCapabilities = assertFunction(bootstrap?.listCapabilities, 'bootstrap.listCapabilities');
  const listProjects = assertFunction(bootstrap?.listProjects, 'bootstrap.listProjects');
  const getRuntimeProjection = assertFunction(
    bootstrap?.getRuntimeProjection,
    'bootstrap.getRuntimeProjection',
  );

  const openProductLink = assertFunction(about?.openLink, 'about.openLink');
  const getUpdaterStatus = assertFunction(updater?.getStatus, 'updater.getStatus');
  const checkForUpdates = assertFunction(updater?.check, 'updater.check');
  const downloadUpdate = assertFunction(updater?.download, 'updater.download');
  const installUpdate = assertFunction(updater?.install, 'updater.install');
  const openInstaller = assertFunction(updater?.openInstaller, 'updater.openInstaller');
  const openReleasePage = assertFunction(updater?.openReleasePage, 'updater.openReleasePage');
  const setUpdaterChannel = assertFunction(updater?.setChannel, 'updater.setChannel');

  return Object.freeze([
    owner('about-ipc', (ipc) => {
      ipc.handle('about:open-link', (_event, payload = {}) => {
        const kind = typeof payload === 'string' ? payload : payload.kind;
        return openProductLink(kind);
      });
    }),
    owner('appshot-ipc', (ipc) => {
      ipc.handle('appshot:capture', () => captureAppshot());
      ipc.handle('appshot:permission-status', () => getAppshotPermissionStatus());
      ipc.handle('appshot:open-screen-settings', () => openScreenSettings());
    }),
    owner('shortcuts-ipc', (ipc) => {
      ipc.handle('shortcuts:status', () => getShortcutStatus());
      ipc.handle('shortcuts:update', (_event, actionOrAccelerator, accelerator) =>
        updateShortcut(actionOrAccelerator, accelerator));
      ipc.handle('shortcuts:reset', (_event, action) => resetShortcut(action));
    }),
    owner('quick-chat-ipc', (ipc) => {
      ipc.handle('quick-chat:hide', () => {
        hideQuickChat();
        return { ok: true };
      });
      ipc.handle('quick-chat:set-task-card-visible', (_event, payload = {}) => ({
        ok: setQuickChatTaskCardVisible(payload.visible === true),
      }));
      ipc.handle('quick-chat:set-content-height', (_event, payload = {}) =>
        setQuickChatContentHeight(payload?.height));
      ipc.handle('quick-chat:submit', (_event, payload = {}) => {
        submitQuickChat(payload);
        return { ok: true };
      });
    }),
    owner('quick-chat-popover-ipc', (ipc) => {
      ipc.handle('quick-chat-popover:show', (_event, payload = {}) => ({
        ok: showQuickChatPopover(payload),
      }));
      ipc.handle('quick-chat-popover:hide', () => {
        hideQuickChatPopover();
        return { ok: true };
      });
      ipc.handle('quick-chat-popover:select', (_event, value) => ({
        ok: selectQuickChatPopover(value),
      }));
    }),
    owner('bootstrap-ipc', (ipc) => {
      ipc.handle('bootstrap:get', () => getBootstrap());
    }),
    owner('session-ipc', (ipc) => {
      ipc.handle('session:get', () => getSession());
    }),
    owner('capabilities-ipc', (ipc) => {
      ipc.handle('capabilities:list', () => listCapabilities());
    }),
    owner('projects-ipc', (ipc) => {
      ipc.handle('projects:list', () => listProjects());
    }),
    owner('runtime-projection-ipc', (ipc) => {
      ipc.handle('runtime-projection:get', () => getRuntimeProjection());
    }),
    owner('updater-ipc', (ipc) => {
      ipc.handle('updater:get-status', () => getUpdaterStatus());
      ipc.handle('updater:check', () => checkForUpdates());
      ipc.handle('updater:download', () => downloadUpdate());
      ipc.handle('updater:install', () => installUpdate());
      ipc.handle('updater:open-installer', () => openInstaller());
      ipc.handle('updater:open-release-page', () => openReleasePage());
      ipc.handle('updater:set-channel', (_event, preference) => setUpdaterChannel(preference));
    }),
  ]);
}
