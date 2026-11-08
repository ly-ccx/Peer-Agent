import { app, BrowserWindow, ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDelegationProvider } from '../../../packages/runtime-node/src/project-agent/delegation-provider.mjs';
import { createExecutionObligationService } from '../../../packages/runtime-node/src/project-agent/execution-obligation.mjs';
import { createExecutionScheduler } from '../../../packages/runtime-node/src/project-agent/execution-scheduler.mjs';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { validateDelegationInput } from '../../../packages/runtime-node/src/project-agent/tool-specs.mjs';
import { createProjectAgentApplicationService } from '../electron/main/project-agent/project-agent-application-service.mjs';
import { readPersistedObligationGrants } from '../../../packages/runtime-node/src/project-agent/execution-obligation.mjs';

const home = process.env.PEER_AGENT_HOME;
if (!home) throw new Error('Isolated test home required');
app.setPath('userData', home);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite'))('esbuild');
const epoch = 'syn-host-now:2026-11-08T04:00:00.000Z';
const oldEpoch = 'syn-host-old:2026-11-07T08:00:00.000Z';
const recorder = { bootId: 'boot-now', pid: 4242, pidStart: 'linux:100', hostId: 'host-old', acquiredAt: '2026-11-07T08:00:00.000Z' };
const untitled = '07ed2604-1111-4111-8111-111111111111';
const titles = { 'legacy-a': '旧记录甲', 'legacy-b': '旧记录乙', 'dead-a': '死亡记录甲', 'dead-b': '死亡记录乙', 'reject-me': '单独拒绝', 'legacy-open': '无归属旧授权', 'foreign': '其他机器人', [untitled]: '' };

function plan(id) {
  return { planId: `plan-${id}`, conversationId: `child-${id}`, title: titles[id], status: 'paused', targetWorkspacePath: home,
    createdAt: '2026-11-07T08:00:00.000Z', runner: { status: 'running' },
    delegationOrigin: { sessionId: id, workspaceId: 'workspace', parentConversationId: id === 'foreign' ? 'other-bot' : 'parent', phase: 'paused',
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
const mode = process.env.PEER_OBLIGATION_CARD_MODE || 'seed';
const runtimeRoot = path.join(home, 'runtime');
const application = createProjectAgentApplicationService({
  enabled: () => true,
  sessions: {
    list: () => [...plans.values()].map(row => ({ sessionId: row.delegationOrigin.sessionId, workspaceId: 'workspace', title: row.title, origin: row.delegationOrigin })),
    listPendingObligationGrants: () => ({ ok: false, code: 'obligation_store_unreadable' }),
    confirmObligationGrant: input => service.confirm(input),
    revokeObligationGrant: input => service.revoke(input),
    resolveExecutionObligation: input => service.resolve(input),
  },
  readPersistedObligationGrants: workspaceId => readPersistedObligationGrants({ rootDir: runtimeRoot, workspaceId }),
  obligationBinding: () => mode === 'broken' || mode === 'blocked' ? 'absent' : 'registered',
  readRecovery: () => mode === 'blocked'
    ? { status: 'failed', phase: 'inputs', error: 'coordination_legacy_changed', legacy: { check: 'writer_fence_unrecognized', seal: 'present', change: 'metadata', file: 'writer_fence' } }
    : mode === 'broken' ? { status: 'failed', phase: 'execution', error: 'coordination_schema_unsupported' } : null,
  openObligationRuntime: async () => {
    if (mode !== 'blocked') return;
    throw Object.assign(new Error('coordination_legacy_changed'), { code: 'coordination_legacy_changed', legacy: { check: 'writer_fence_unrecognized', seal: 'present', change: 'metadata', file: 'writer_fence' } });
  },
});

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
  async decide() {
    const snap = store.read();
    const grant = Object.values(snap.obligationGrants || {}).find(row => row.items?.some(item => item.sessionId === untitled));
    return application.decideObligation({ workspaceId: 'workspace', grantId: grant?.grantId, decision: 'confirm', parentConversationId: 'parent' });
  },
  snapshot() {
    const snap = store.read();
    return {
      grants: Object.values(snap.obligationGrants || {}).map(grant => ({ grantId: grant.grantId, status: grant.status, count: grant.items?.length || 0 })),
      indexed: Object.values(snap.obligationDispositions || {}).filter(row => row.phase === 'indexed').map(row => row.sessionId).sort(),
    };
  },
};

app.on('window-all-closed', () => { app.quit(); });
app.whenReady().then(async () => {
  mkdirSync(runtimeRoot, { recursive: true });
  await store.prepare();
  if (mode === 'seed') {
    const inspected = await tool('inspect_execution_obligation', 'local.delegation.inspect_execution_obligation', { sessionIds: Object.keys(titles) });
    if (inspected?.ok !== true) throw new Error(inspected?.error || 'inspect failed');
    const four = await tool('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFrom(inspected, ['legacy-a', 'legacy-b', 'dead-a', 'dead-b']));
    const one = await tool('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFrom(inspected, ['reject-me']));
    const legacy = await service.requestAuthorization({ workspaceId: 'workspace', role: 'project_agent', items: requestFrom(inspected, ['legacy-open']).items });
    const unnamed = await tool('request_obligation_authorization', 'local.delegation.request_obligation_authorization', requestFrom(inspected, [untitled]));
    const other = { ...context, conversationId: 'other-bot' };
    const foreignInspect = outputOf(await provider.executeCapability({ call: { toolCallId: 'inspect-foreign', capabilityId: 'local.delegation.inspect_execution_obligation', arguments: { sessionIds: ['foreign'] } } }, other));
    const foreign = outputOf(await provider.executeCapability({ call: { toolCallId: 'foreign', capabilityId: 'local.delegation.request_obligation_authorization', arguments: requestFrom(foreignInspect, ['foreign']) } }, other));
    const failed = [['four', four], ['one', one], ['legacy', legacy], ['unnamed', unnamed], ['foreign', foreign]].find(([, result]) => result?.ok !== true);
    if (failed) throw new Error(`${failed[0]}:${failed[1]?.error || 'request failed'}`);
  }
  if (mode === 'broken') {
    const pointer = path.join(runtimeRoot, 'workspace', '.read-models', 'coordination-current.json');
    if (existsSync(pointer)) renameSync(pointer, `${pointer}.hidden`);
  }
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
  const tokens = readFileSync(path.join(desktop, 'renderer/src/styles/tokens.css'), 'utf8');
  const forms = readFileSync(path.join(desktop, 'renderer/src/ui/forms/forms.css'), 'utf8');
  const cardCss = readFileSync(path.join(desktop, 'renderer/src/project-agent/styles/obligation-grant-card.css'), 'utf8');
  const html = `<html data-theme="light"><meta charset="utf-8"><style>${tokens}${forms}${cardCss} body{margin:0;background:var(--paper-base);color:var(--graphite-base);font-family:sans-serif} .bot-convo{--bot-column-width:min(50rem,calc(100% - 3rem));--bot-column-gutter:1.5rem;display:flex;flex-direction:column;min-height:100vh}</style><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const pageFile = path.join(home, 'obligation-card.html');
  writeFileSync(pageFile, html);
  await win.loadFile(pageFile);
}).catch(error => { console.error(error); app.exit(1); });
