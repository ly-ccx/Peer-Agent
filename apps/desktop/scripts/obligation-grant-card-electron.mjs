import { app, BrowserWindow, ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDelegationProvider } from '../../../packages/runtime-node/src/project-agent/delegation-provider.mjs';
import { createExecutionObligationService } from '../../../packages/runtime-node/src/project-agent/execution-obligation.mjs';
import { createExecutionScheduler } from '../../../packages/runtime-node/src/project-agent/execution-scheduler.mjs';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { validateDelegationInput } from '../../../packages/runtime-node/src/project-agent/tool-specs.mjs';
import { createProjectAgentApplicationService } from '../electron/main/project-agent/project-agent-application-service.mjs';

const home = process.env.PEER_AGENT_HOME;
if (!home) throw new Error('Isolated test home required');
app.setPath('userData', home);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite'))('esbuild');
const epoch = 'syn-host-now:2026-11-08T04:00:00.000Z';
const oldEpoch = 'syn-host-old:2026-11-07T08:00:00.000Z';
const recorder = { bootId: 'boot-now', pid: 4242, pidStart: 'linux:100', hostId: 'host-old', acquiredAt: '2026-11-07T08:00:00.000Z' };
const titles = { 'legacy-a': '旧记录甲', 'legacy-b': '旧记录乙', 'dead-a': '死亡记录甲', 'dead-b': '死亡记录乙', 'reject-me': '单独拒绝' };

function plan(id) {
  return { planId: `plan-${id}`, conversationId: `child-${id}`, title: titles[id], status: 'paused', targetWorkspacePath: home,
    createdAt: '2026-11-07T08:00:00.000Z', runner: { status: 'running' },
    delegationOrigin: { sessionId: id, workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      cancellation: { operationId: `cancel-${id}`, phase: 'awaiting_outcome' },
      executionControl: { kind: 'cancel', operationId: `cancel-${id}`, phase: 'reconciling', nextAction: 'execution_stop_unconfirmed',
        revision: 4, hostEpoch: oldEpoch, sessionId: id, planId: `plan-${id}`,
        ...(id.startsWith('dead') ? { recorder } : {}) } } };
}

const plans = new Map(Object.keys(titles).map(id => { const row = plan(id); return [row.planId, row]; }));
const store = createWorkCoordinationStore({ rootDir: path.join(home, 'runtime'), workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => epoch, formatVersion: 2, fenceLegacyWrites: true });
const scheduler = createExecutionScheduler({ rootDir: path.join(home, 'runtime') });
scheduler.configure({ ownsWorkspace: () => true, currentPlan: item => plans.get(item.planId) || item });
let windows = [];
const service = createExecutionObligationService({
  plans: () => [...plans.values()], readControl: item => item.delegationOrigin.executionControl,
  scheduler, canManage: () => true, storeFor: () => store,
  identity: () => ({ bootId: 'boot-now', pid: 7, pidStart: 'linux:7', lookup: () => null }),
  writerEpochFor: () => epoch, now: () => '2026-11-08T05:00:00.000Z',
  onChanged: fact => { for (const win of windows) win.webContents.send('project-agent:obligation-grants', fact); },
});
const provider = createDelegationProvider({ supervisor: {
  inspectExecutionObligations: input => service.inspect(input),
  requestObligationAuthorization: input => service.requestAuthorization(input),
  resolveExecutionObligation: input => service.resolve(input),
  listPendingObligationGrants: (workspaceId, parentConversationId) => ({ ok: true, grants: service.pendingGrants(workspaceId, parentConversationId) }),
  confirmObligationGrant: input => service.confirm(input),
  revokeObligationGrant: input => service.revoke(input),
} });
const context = { mode: 'project_agent', role: 'project_agent', workspaceId: 'workspace', conversationId: 'parent', turnId: 'turn-card', toolCallOrdinal: 1 };
let failList = false;
const application = createProjectAgentApplicationService({ enabled: () => true, sessions: provider && {
  listPendingObligationGrants: (workspaceId, parentConversationId) => ({ ok: true, grants: service.pendingGrants(workspaceId, parentConversationId) }),
  confirmObligationGrant: input => service.confirm(input),
  revokeObligationGrant: input => service.revoke(input),
  resolveExecutionObligation: input => service.resolve(input),
} });

function outputOf(result) {
  return result?.result?.output;
}
async function tool(name, capabilityId, args) {
  const validated = validateDelegationInput(name, args);
  if (!validated.ok) throw new Error(validated.message || validated.error);
  return outputOf(await provider.executeCapability({ call: { toolCallId: name, capabilityId, arguments: validated.value } }, context));
}
function requestFrom(inspected, ids) {
  return { items: inspected.items.filter(item => ids.includes(item.sessionId)).map(item => ({
    obligationId: item.obligationId, sessionId: item.sessionId, operationId: item.operationId,
    evidenceRevision: item.evidenceRevision, actions: [...item.allowedActions],
  })) };
}

ipcMain.on('settings:get-sync', event => { event.returnValue = { locale: 'zh-CN' }; });
ipcMain.handle('project-agent:list-obligation-grants', async (_event, payload) => {
  if (failList) return { ok: false, code: 'UNAVAILABLE' };
  return application.listObligationGrants(payload);
});
ipcMain.handle('project-agent:decide-obligation', async (_event, payload) => application.decideObligation(payload));

globalThis.peerObligationCard = {
  failList(value) { failList = value === true; },
  notify() { for (const win of windows) win.webContents.send('project-agent:obligation-grants', { workspaceId: 'workspace' }); },
  snapshot() {
    const snap = store.read();
    return {
      grants: Object.values(snap.obligationGrants || {}).map(grant => ({ grantId: grant.grantId, status: grant.status, count: grant.items?.length || 0 })),
      indexed: Object.values(snap.obligationDispositions || {}).filter(row => row.phase === 'indexed').map(row => row.sessionId).sort(),
    };
  },
};

app.whenReady().then(async () => {
  mkdirSync(path.join(home, 'runtime'), { recursive: true });
  await store.prepare();
  const inspected = await tool('inspect_execution_obligation', 'local.delegation.inspect_execution_obligation', { sessionIds: Object.keys(titles) });
  if (inspected?.ok !== true) throw new Error(inspected?.error || 'inspect failed');
  const four = await tool('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFrom(inspected, ['legacy-a', 'legacy-b', 'dead-a', 'dead-b']));
  const one = await tool('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFrom(inspected, ['reject-me']));
  if (four?.ok !== true || one?.ok !== true) throw new Error(four?.error || one?.error || 'request failed');
  const result = await build({
    stdin: { contents: "import '../../scripts/obligation-grant-card-ui-fixture';", loader: 'tsx', resolveDir: path.join(desktop, 'renderer/src') },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty', '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl', '.webp': 'dataurl' },
    plugins: [{ name: 'stub-assets', setup(builder) {
      builder.onResolve({ filter: /\/ui\/icons$/ }, () => ({ path: 'icons', namespace: 'stub' }));
      builder.onResolve({ filter: /\?raw$/ }, () => ({ path: 'raw', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function PeerIcon(){return null} export default ""', loader: 'js' }));
    } }],
  });
  const win = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: {
    preload: path.join(desktop, 'electron/preload/preload.cjs'), contextIsolation: true, nodeIntegration: false,
  } });
  windows = [win];
  const cardCss = readFileSync(path.join(desktop, 'renderer/src/project-agent/styles/obligation-grant-card.css'), 'utf8');
  const html = `<html data-theme="light"><meta charset="utf-8"><style>${cardCss} body{font-family:sans-serif;margin:16px}</style><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const pageFile = path.join(home, 'obligation-card.html');
  writeFileSync(pageFile, html);
  await win.loadFile(pageFile);
}).catch(error => { console.error(error); app.exit(1); });
