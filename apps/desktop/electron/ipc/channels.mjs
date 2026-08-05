// Canonical Electron transport and caller-policy catalog.
// Payload/result schemas remain in @peer-agent/protocol. Preload source uses the stable key;
// the generated sandbox preload receives only a frozen key -> transport-channel map.

const MAIN_WINDOW_ONLY = Object.freeze(['main']);
const ALL_APP_WINDOW_ROLES = Object.freeze([
  'main',
  'quick-chat',
  'quick-chat-popover',
  'permission-drag-float',
]);
const QUICK_CHAT_CHANNELS = new Set([
  'chat:send',
  'conversations:append-message',
  'conversations:create',
  'conversations:update-mode',
  'conversations:update-model-effort',
  'llm:list',
  'quick-chat-popover:hide',
  'quick-chat-popover:show',
  'quick-chat:hide',
  'quick-chat:set-content-height',
  'quick-chat:submit',
  'settings:get-sync',
  'settings:update',
  'workspace:list',
  'workspace:set-active',
]);
const QUICK_CHAT_POPOVER_CHANNELS = new Set([
  'quick-chat-popover:hide',
  'quick-chat-popover:select',
  'settings:get-sync',
]);

function allowedWindowRolesFor(channel, rendererToMain) {
  if (!rendererToMain) return Object.freeze([]);
  if (channel === 'settings:get-sync') return ALL_APP_WINDOW_ROLES;
  const roles = ['main'];
  if (
    channel === 'browser:start-app-drag'
    || channel === 'browser:hide-fda-drag-float-sync'
    || channel === 'browser:fda-drag-float-dragging'
  ) {
    roles.push('permission-drag-float');
  }
  if (QUICK_CHAT_CHANNELS.has(channel)) roles.push('quick-chat');
  if (QUICK_CHAT_POPOVER_CHANNELS.has(channel)) roles.push('quick-chat-popover');
  return roles.length === 1 ? MAIN_WINDOW_ONLY : Object.freeze(roles);
}

const INVOKE_CHANNELS = Object.freeze([
  'appshot:capture',
  'appshot:open-screen-settings',
  'appshot:permission-status',
  'automations:bootstrap',
  'automations:create',
  'automations:get',
  'automations:list',
  'automations:proposal:act',
  'automations:run-now',
  'automations:runs:cancel',
  'automations:runs:get',
  'automations:runs:list',
  'automations:runs:retry',
  'automations:runtime:set-paused',
  'automations:update',
  'bootstrap:get',
  'browser:capture-page',
  'browser:clear-site-data',
  'browser:get-app-drag-target',
  'browser:hide-fda-drag-float',
  'browser:import-site-session',
  'browser:list-session-sites',
  'browser:list-session-sources',
  'browser:open-full-disk-access-settings',
  'browser:panel-reveal-ack',
  'browser:register-webcontents',
  'browser:session-import-preflight',
  'browser:unregister-webcontents',
  'capabilities:list',
  'chat:abort',
  'chat:compact',
  'chat:compaction:get',
  'chat:context:restored',
  'chat:send',
  'chat:stream:list-active',
  'chat:stream:reattach',
  'client-tool:execute',
  'conversation:set-active',
  'conversations:add-usage',
  'conversations:append-message',
  'conversations:archive',
  'conversations:auto-archive',
  'conversations:create',
  'conversations:delete',
  'conversations:get',
  'conversations:list',
  'conversations:pin',
  'conversations:reorder-pinned',
  'conversations:replace-messages',
  'conversations:restore',
  'conversations:search',
  'conversations:unpin',
  'conversations:update-last-message',
  'conversations:update-mode',
  'conversations:update-model-effort',
  'conversations:update-title',
  'developer-settings:diagnostics',
  'developer-settings:get',
  'developer-settings:reset',
  'developer-settings:update',
  'file:read',
  'file:write',
  'fs:exists',
  'fs:mkdir',
  'fs:read-dir',
  'fs:watch-dirs',
  'git:diff',
  'goalPlans:approve',
  'goalPlans:awaiting-counts',
  'goalPlans:create',
  'goalPlans:delete',
  'goalPlans:get',
  'goalPlans:list',
  'goalPlans:record-manual-confirmation',
  'goalPlans:record-task-evidence',
  'goalPlans:revise',
  'goalPlans:set-status',
  'goalRunner:clear',
  'goalRunner:get-state',
  'goalRunner:pause',
  'goalRunner:resume',
  'goalRunner:start',
  'host:restart',
  'llm:add',
  'llm:add-model',
  'llm:channels:list',
  'llm:chat:list',
  'llm:complete',
  'llm:duplicate',
  'llm:duplicate-model',
  'llm:groups:list',
  'llm:list',
  'llm:models:fetch',
  'llm:models:list',
  'llm:oauth:cancel',
  'llm:oauth:open-pending',
  'llm:oauth:start',
  'llm:quota',
  'llm:service-templates:list',
  'llm:remove',
  'llm:remove-group',
  'llm:set-default',
  'llm:test',
  'llm:update',
  'locale:set',
  'mcp:connect-and-register',
  'mcp:delete-credential',
  'mcp:finish-oauth',
  'mcp:get-prompt',
  'mcp:install',
  'mcp:list-capabilities',
  'mcp:list-credentials',
  'mcp:list-installed',
  'mcp:put-credential',
  'mcp:read-resource',
  'mcp:refresh-manifest',
  'mcp:set-enabled',
  'mcp:set-tool-visibility',
  'mcp:start-oauth',
  'mcp:test-connection',
  'mcp:uninstall',
  'mcp:upsert-server',
  'os:startup-permissions',
  'password-vault:delete',
  'password-vault:fill',
  'password-vault:list',
  'password-vault:reveal',
  'password-vault:upsert',
  'pending-task:clear',
  'pending-task:consume',
  'pending-task:peek',
  'pending-task:write',
  'permission:approve',
  'permission:deny',
  'projects:list',
  'prompt-context-epochs:chain',
  'prompt-context-epochs:events',
  'prompt-context-epochs:list',
  'prompt-snapshots:get',
  'prompt-snapshots:list',
  'quick-chat-popover:hide',
  'quick-chat-popover:select',
  'quick-chat-popover:show',
  'quick-chat:hide',
  'quick-chat:set-content-height',
  'quick-chat:set-task-card-visible',
  'quick-chat:submit',
  'runtime-projection:get',
  'session:get',
  'settings:export',
  'settings:get',
  'settings:import',
  'settings:update',
  'shell:open-path',
  'shell:permissions:add',
  'shell:permissions:list',
  'shell:tasks:list',
  'shell:tasks:stop',
  'shell:tasks:stop-active',
  'shortcuts:reset',
  'shortcuts:status',
  'shortcuts:update',
  'skills:disable',
  'skills:enable',
  'skills:get-detail',
  'skills:link',
  'skills:list',
  'skills:list-available',
  'skills:refresh',
  'skills:unlink',
  'skills:upload',
  'updater:check',
  'updater:download',
  'updater:get-status',
  'updater:install',
  'updater:open-installer',
  'updater:open-release-page',
  'updater:set-channel',
  'usage:daily',
  'usage:day',
  'usage:stats',
  'workspace:add',
  'workspace:ensure-default',
  'workspace:info',
  'workspace:list',
  'workspace:remove',
  'workspace:set-active',
]);

const SEND_SYNC_CHANNELS = Object.freeze([
  'browser:hide-fda-drag-float-sync',
  'browser:start-app-drag',
  'settings:get-sync',
]);

const SEND_CHANNELS = Object.freeze([
  'browser:fda-drag-float-dragging',
]);

const EVENT_CHANNELS = Object.freeze([
  'appearance:changed',
  'automations:changed',
  'automations:open-run',
  'browser:panel-reveal-request',
  'chat:compaction',
  'chat:stream:aborted',
  'chat:stream:active-changed',
  'chat:stream:connection-recovery',
  'chat:stream:delta',
  'chat:stream:done',
  'chat:stream:error',
  'chat:stream:permission-request',
  'chat:stream:provider-recovery',
  'chat:stream:thinking',
  'chat:stream:tool-call',
  'chat:stream:tool-progress',
  'chat:stream:tool-result',
  'chat:stream:usage',
  'conversations:changed',
  'fs:dir-changed',
  'goalPlans:changed',
  'goalRunner:changed',
  'llm:oauth:authorized',
  'llm:oauth:pending',
  'llm:oauth:refreshed',
  'quick-chat-popover:state',
  'quick-chat:conversation-created',
  'quick-chat:open-conversation',
  'quick-chat:popover-closed',
  'quick-chat:popover-selected',
  'quick-chat:shown',
  'runtime:event',
  'tray:more',
  'tray:new-chat',
  'updater:event',
  'window:fullscreen-changed',
  'workspaces:changed',
]);

const TRANSPORT_GROUPS = Object.freeze([
  ['invoke', INVOKE_CHANNELS],
  ['send-sync', SEND_SYNC_CHANNELS],
  ['send', SEND_CHANNELS],
  ['event', EVENT_CHANNELS],
]);

const PROVIDER_CONFIGURATION_CHANNELS = new Set([
  'llm:add',
  'llm:add-model',
  'llm:channels:list',
  'llm:chat:list',
  'llm:complete',
  'llm:duplicate',
  'llm:duplicate-model',
  'llm:groups:list',
  'llm:list',
  'llm:service-templates:list',
  'llm:remove',
  'llm:remove-group',
  'llm:set-default',
  'llm:test',
  'llm:update',
]);
const PROVIDER_ACCESS_CHANNELS = new Set([
  'llm:models:fetch',
  'llm:models:list',
  'llm:oauth:cancel',
  'llm:oauth:open-pending',
  'llm:oauth:start',
  'llm:quota',
]);
const FILE_ACCESS_CHANNELS = new Set([
  'file:read',
  'file:write',
  'fs:exists',
  'fs:mkdir',
  'fs:read-dir',
  'fs:watch-dirs',
  'git:diff',
]);

function ownerFor(channel) {
  if (PROVIDER_CONFIGURATION_CHANNELS.has(channel)) return 'provider-configuration-ipc';
  if (PROVIDER_ACCESS_CHANNELS.has(channel)) return 'provider-access-ipc';
  if (FILE_ACCESS_CHANNELS.has(channel)) return 'file-access-ipc';
  return `${channel.split(':', 1)[0]}-ipc`;
}

const entries = TRANSPORT_GROUPS.flatMap(([transport, channels]) =>
  channels.map((channel) => {
    const rendererToMain = transport !== 'event';
    return [channel, Object.freeze({
      key: channel,
      channel,
      transport,
      direction: rendererToMain ? 'renderer-to-main' : 'main-to-renderer',
      owner: ownerFor(channel),
      allowedWindowRoles: allowedWindowRolesFor(channel, rendererToMain),
      framePolicy: rendererToMain ? 'top-frame' : null,
      originPolicy: rendererToMain ? 'app-origin' : null,
      sync: transport === 'send-sync',
    })];
  }),
);

const uniqueChannels = new Set(entries.map(([channel]) => channel));
if (uniqueChannels.size !== entries.length) {
  throw new Error('Desktop IPC catalog contains duplicate channel definitions');
}

export const DESKTOP_IPC_CATALOG = Object.freeze(Object.fromEntries(entries));

export const DESKTOP_IPC_CHANNELS = Object.freeze(Object.fromEntries(
  entries.map(([key, value]) => [key, value.channel]),
));

export function getDesktopIpcPolicy(channel) {
  return DESKTOP_IPC_CATALOG[channel] ?? null;
}
