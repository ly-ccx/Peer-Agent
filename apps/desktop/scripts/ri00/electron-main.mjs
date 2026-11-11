import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createTrace } from './trace.mjs';
import { createReadHost, installReadMetrics } from './read-host.mjs';

const configAt = process.argv.indexOf('--ri00-config');
if (configAt < 0 || !process.argv[configAt + 1]) throw new Error('ri00_config_required');
const config = JSON.parse(fs.readFileSync(process.argv[configAt + 1], 'utf8'));
process.env.PEER_AGENT_HOME = config.fixtureRoot;
app.setPath('userData', path.join(config.output, 'electron-user-data'));
const trace = createTrace({ enabled: config.instrumented });
const restoreReadMetrics = config.instrumented ? installReadMetrics(trace, config.fixtureRoot) : () => {};
async function start() {
const load = relative => import(pathToFileURL(path.join(config.moduleRoot, relative)).href);
const [{ createCatalogIpcMain }, { createTrustedWindowRegistry }, { createProjectAgentIpcRegistrations }] = await Promise.all([
  load('apps/desktop/electron/main/ipc/catalog-ipc-main.mjs'),
  load('apps/desktop/electron/main/ipc/trusted-window-registry.mjs'),
  load('apps/desktop/electron/main/ipc/register-project-agent-ipc.mjs'),
]);
const host = await createReadHost({ ...config, trace });
let stage = 'transport-control';
let observations = [], gaps = [], sequence = 0;
const clock = () => performance.timeOrigin + performance.now();
const registry = createTrustedWindowRegistry();
const adapter = {
  handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      const row = { sequence: ++sequence, stage, enteredMain: clock() };
      return trace.request(stage, async () => {
        let value;
        const started = performance.now();
        try { value = trace.sync('Gateway.handlerSync', () => fn(event, ...args)); }
        finally { row.handlerSyncMs = performance.now() - started; }
        try { return await value; }
        finally { row.settledMain = clock(); observations.push(row); }
      });
    });
  },
  on: ipcMain.on.bind(ipcMain), removeHandler: ipcMain.removeHandler.bind(ipcMain),
  removeListener: ipcMain.removeListener.bind(ipcMain),
};
const catalog = createCatalogIpcMain({ ipcMain: adapter,
  authorize: input => trace.sync('Gateway.authorize', () => registry.authorize(input)) });
const registrations = createProjectAgentIpcRegistrations({ projectAgent: {
  ...host.service,
  listObligationGrants: payload => stage === 'transport-control'
    ? { ok: true, grants: [], writer: { ok: true } }
    : trace.sync('ApplicationService.listObligationGrants', () => host.service.listObligationGrants(payload)),
} });
for (const registration of registrations) registration.register(catalog.createOwner(registration.owner));

  const html = path.join(config.output, 'fixture.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><input id="draft"><div id="history" style="height:300px;overflow:auto"></div><script>window.frameGaps=[];let last=null;function frame(at){if(last!==null)frameGaps.push(at-last);last=at;requestAnimationFrame(frame)}requestAnimationFrame(frame);document.getElementById("history").innerHTML="<p>readonly baseline</p>".repeat(500)</script>');
  const window = new BrowserWindow({ show: false, width: 1100, height: 760,
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  registry.registerWindow({ window, role: 'main', allowedLocations: [pathToFileURL(html).href] });
  await window.loadFile(html);
  let last = performance.now();
  const heartbeat = setInterval(() => { const at = performance.now(); gaps.push(at - last); last = at; }, 2);
  heartbeat.unref();
  globalThis.ri00 = {
    payload: host.payload,
    runtime: { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch },
    setTrace(enabled) { if (!config.instrumented) throw new Error('trace_not_installed'); trace.setEnabled(enabled); },
    start(next) { stage = next; observations = []; gaps = []; trace.take(); last = performance.now();
      Object.assign(host.fixtureObservation, { listCalls: 0, minSessions: null, maxSessions: 0 }); },
    take() { return { observations, gaps, requests: trace.take(), fixtureObservation: host.fixtureObservation }; },
  };
  app.on('will-quit', () => { clearInterval(heartbeat); catalog.dispose(); registry.dispose(); restoreReadMetrics(); host.close(); });
}
app.whenReady().then(start).catch(error => { fs.writeFileSync(path.join(config.output, 'main-error.private.txt'), error.stack); app.exit(1); });
