// Isolated smoke-test composition: production UI, preload, IPC and runtime.
// Never connects to the user's data home or running Peer instance.
import { app, BrowserWindow, ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { executeProjectedModelTool } from '../electron/main/chat-runtime/projected-tool-executor.mjs';
import { createLocalToolHost } from '../electron/main/runtime-gateway/local-tool-host.mjs';
import { getApplicationShellTasks, disposeApplicationShellTasks } from '../electron/main/runtime-gateway/application-shell-tasks.mjs';
import { disposeApplicationShellConversation, disposeApplicationShellSessions } from '../electron/main/runtime-gateway/application-shell-sessions.mjs';
import { createRuntimeHostIpcRegistrations } from '../electron/main/ipc/register-runtime-host-ipc.mjs';

const home = process.env.PEER_BACKGROUND_SMOKE_HOME;
if (!home || process.env.PEER_AGENT_HOME !== home) throw new Error('Isolated test home required');
app.setPath('userData', home);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite'))('esbuild');
const host = createLocalToolHost({ workspaceRoot: home, userDataPath: home, sessionStore: { getSession: () => null } });
const manager = getApplicationShellTasks(home);
let denyNextStop = false;
let deferredStopMode = null;
let releaseStop = null;
let stopCalls = 0;
for (const owner of createRuntimeHostIpcRegistrations({
  shell: {
    openPath() {}, listEditors: () => [], setDefaultEditor() {},
    listTasks: host.listShellTasks, stopActiveTask: host.stopActiveShellTask,
    stopTask: async (id) => {
      stopCalls += 1;
      const mode = deferredStopMode;
      deferredStopMode = null;
      if (mode) await new Promise((resolve) => { releaseStop = resolve; });
      if (denyNextStop || mode === 'deny') { denyNextStop = false; return { stopped: false, reason: 'test_stop_denied' }; }
      // An acknowledgement alone deliberately leaves the real process running.
      if (mode === 'ack') return { stopped: true };
      return host.stopShellTask(id);
    },
    listPermissionRules: () => [], addPermissionRule() {},
  },
  clientTool: { execute() { throw new Error('Unused test port'); } },
})) owner.register(ipcMain);
ipcMain.on('settings:get-sync', (event) => { event.returnValue = {}; });

let callIndex = 0;
async function exec(command, source, runInBackground = false) {
  return executeProjectedModelTool({
    name: 'bash', args: { command, runInBackground }, workspacePath: home,
    toolCallId: `smoke-call-${++callIndex}`, toolContext: { conversationId: source, mode: 'chat' },
    goalPlanStore: { listPlansByConversation: () => [{ status: 'executing' }] },
    requestPermission: async () => ({ granted: true }),
    shellApprovalDecider: async () => ({ granted: true, reason: 'isolated_test' }), locale: 'en-US',
  });
}
globalThis.peerBackgroundSmoke = {
  async launch(source) {
    const code = "const h=require('node:http');const s=h.createServer((req,res)=>{console.log('request:'+req.url);res.end('managed-smoke-ok')});s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))";
    const result = await exec(`${JSON.stringify(process.env.PEER_BACKGROUND_SMOKE_NODE)} -e ${JSON.stringify(code)}`, source, true);
    if (!result.success) throw new Error(result.output);
    return result.execution.result.outputPreview.backgroundTaskId;
  },
  list: () => manager.listTasks(),
  switchConversation: (source) => exec('printf switched', source),
  deleteSource: (source) => disposeApplicationShellConversation(home, source),
  denyStop: () => { denyNextStop = true; },
  deferStop: (mode) => { deferredStopMode = mode; },
  releaseStop: () => { releaseStop?.(); releaseStop = null; },
  stopCalls: () => stopCalls,
  stopDirect: (id) => host.stopShellTask(id),
  dispose: () => Promise.all([disposeApplicationShellTasks(home), disposeApplicationShellSessions(home)]),
};

// Do not await readiness at ESM top level: Electron waits for module evaluation
// before emitting ready, so that would deadlock the isolated test launcher.
app.whenReady().then(async () => {
  const result = await build({
    stdin: {
      contents: process.env.PEER_BACKGROUND_VISUAL_FIXTURE === '1'
        ? "import '../../scripts/background-runtime-ui-fixture';"
        : "import React from 'react';import {createRoot} from 'react-dom/client';import {GlobalBackgroundTasksButton,BackgroundRunsProvider} from './workbench/GlobalBackgroundTasksButton';function Fixture(){const [generation,setGeneration]=React.useState(0);globalThis.remountBackgroundHeader=()=>setGeneration(v=>v+1);return <BackgroundRunsProvider isZh={true}><header key={generation} data-generation={generation} className='chat-header' style={{position:'fixed',top:0,left:0,width:'100%'}}><span>对话</span><div className='chat-header-right'><GlobalBackgroundTasksButton/><button className='chat-header-action-btn' aria-label='搜索'>⌕</button></div></header><div className='sidebar-bottom' style={{position:'fixed',bottom:0,left:0,width:264}}><button className='sidebar-nav-btn'>设置</button><span data-testid='version'>v0.0.11</span></div></BackgroundRunsProvider>;}createRoot(document.getElementById('root')).render(<Fixture/>);",
      loader: 'tsx', resolveDir: path.join(desktop, 'renderer/src'),
    }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const assets = path.join(desktop, 'dist/assets');
  const css = readdirSync(assets).filter((name) => name.endsWith('.css')).map((name) => readFileSync(path.join(assets, name), 'utf8')).join('\n');
  const win = new BrowserWindow({ width: 1120, height: 850, show: true, webPreferences: {
    preload: path.join(desktop, 'electron/preload/preload.cjs'), contextIsolation: true, nodeIntegration: false,
  } });
  const html = `<html data-theme="dark"><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
}).catch((error) => { console.error(error); app.exit(1); });
