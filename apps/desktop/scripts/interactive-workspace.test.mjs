import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { build, transformWithEsbuild } from 'vite';
const desktop = fileURLToPath(new URL('..', import.meta.url)), repo = path.resolve(desktop, '../..');
const require = createRequire(new URL('../package.json', import.meta.url));
const href = file => pathToFileURL(path.join(repo, file)).href;

async function renderer(output) {
  const entry = '\0peer-interactive-workspace.tsx';
  await build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), base: './', mode: 'production', logLevel: 'error',
    plugins: [{ name: 'peer-interactive-workspace-fixture', resolveId(id, importer) {
      if (id === entry) return entry;
      if (importer === entry && id.startsWith('./')) return path.resolve(desktop, id);
    }, load(id) { if (id === entry) return transformWithEsbuild(`
      import React from 'react';import{createRoot}from'react-dom/client';
      import{WorkbenchProvider}from'./renderer/src/workbench/WorkbenchContext.tsx';
      import{BotResourceLayout}from'./renderer/src/workbench/ResourceWorkspaceContext.tsx';
      import{EvidenceDeliveries}from'./renderer/src/project-agent/drawer/EvidenceDeliveries.tsx';
      import{NativeResourceWindow}from'./renderer/src/workbench/NativeResourceWindow.tsx';
      import{ConfirmProvider}from'./renderer/src/app/components/ConfirmProvider.tsx';
      import{ResourceEditAppFrame}from'./renderer/src/workbench/editing/ResourceEditContinuity.tsx';
      import'./renderer/src/styles.css';
      if(window.peerResource)createRoot(document.getElementById('root')).render(<NativeResourceWindow/>);
      else{const{fixture}=await window.peerAgent.getBootstrap();const data=await window.peerAgent.projectAgentReadEvidence({context:{workspaceId:fixture.owner.workspaceId},evidenceRef:fixture.evidenceRef});
        createRoot(document.getElementById('root')).render(<ConfirmProvider><ResourceEditAppFrame><WorkbenchProvider conversationId={fixture.owner.conversationId} isPageActive resourceMode layoutHost="bot">
          <BotResourceLayout owner={fixture.owner} active isZh={false}><div className="bot-main" style={{padding:24}}><h1>Trial delivery</h1><textarea aria-label="Conversation draft" defaultValue="Keep this draft"/><EvidenceDeliveries deliveries={data.deliveries} isZh={false}/></div></BotResourceLayout>
        </WorkbenchProvider></ResourceEditAppFrame></ConfirmProvider>);}
    `, 'interactive-workspace-fixture.tsx', { loader: 'tsx', jsx: 'automatic' }); } }], build: { outDir: output, emptyOutDir: true, target: 'esnext', cssCodeSplit: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'fixture.js' } } } });
  const css = readdirSync(path.join(output, 'assets')).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="./assets/${name}">`).join('');
  writeFileSync(path.join(output, 'index.html'), `<!doctype html><html data-theme="light"><meta charset="utf-8">${css}<style>html,body,#root{height:100%;margin:0}.bot-resource-layout{height:100%}.bot-main{height:100%;overflow:auto;box-sizing:border-box}</style><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
}

test('the main workspace opens canonical interactive deliveries, restores result tabs and hands off the exact fixed result', { timeout: 150_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-workspace-')), output = path.join(root, 'renderer');
  await renderer(output);
  const location = pathToFileURL(path.join(output, 'index.html')).href, mainFile = path.join(root, 'main.mjs');
  writeFileSync(mainFile, `
    import{app,BrowserWindow,ipcMain}from'electron';
    import{validateDraft}from${JSON.stringify(pathToFileURL(require.resolve('@peer-agent/interactive-content')).href)};
    import{createInteractiveResultStore,createInteractiveStateStore}from${JSON.stringify(href('packages/runtime-node/dist/interactive-results-public.js'))};
    import{createDesktopInteractiveApplication}from${JSON.stringify(href('apps/desktop/electron/main/interactive-results/application-service.mjs'))};
    import{createEvidenceDeliveryProjection}from${JSON.stringify(href('apps/desktop/electron/main/project-agent/evidence-deliveries.mjs'))};
    import{createEvidenceReader}from${JSON.stringify(href('apps/desktop/electron/main/project-agent/evidence-reader.mjs'))};
    import{createResourceWindowController}from${JSON.stringify(href('apps/desktop/electron/main/resource-window-controller.mjs'))};
    import{createTrustedWindowRegistry}from${JSON.stringify(href('apps/desktop/electron/main/ipc/trusted-window-registry.mjs'))};
    import{createCatalogIpcMain}from${JSON.stringify(href('apps/desktop/electron/main/ipc/catalog-ipc-main.mjs'))};
    import{registerIpcOwners}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-all.mjs'))};
    import{createResourceWindowIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-resource-window-ipc.mjs'))};
    import{createInteractiveResultsIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-interactive-results-ipc.mjs'))};
    app.setPath('userData',${JSON.stringify(path.join(root, 'app-data'))});await app.whenReady();
    const owner={workspaceId:'workspace-bot',conversationId:'workspace-parent'},resultStore=createInteractiveResultStore({rootDir:${JSON.stringify(path.join(root, 'runtime'))},assertCompatibility:()=>true}),stateStore=createInteractiveStateStore({resultStore}),runtime={resultStore,stateStore};
    const program='$x=2\\n$name="Workspace trial"\\nroot=Col([Title($name),Input("name","Trial name",$name),NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x),'+Array.from({length:32},(_,i)=>'Text("Saved model observation '+i+'. Fixed content preserves the reading position while changing local conditions.")').join(',')+'])';
    const draft={publication:{kind:'create'},title:'Workspace trial',textFallback:'Unverified saved model trial.',program,inputs:[]};
    const receipt=resultStore.commitPublication({owner,source:{conversationId:'worker',sessionId:'session',planId:'plan',executionEpoch:'epoch',toolCallId:'publication'},draft,content:await validateDraft(draft),provenance:[],dataLevel:'D3_private',grant:{toolCallId:'publication',grantId:'fixture-grant',granted:true}},()=>true);resultStore.markIndexed(receipt.callRef,receipt.indexEntry);
    const windows=createTrustedWindowRegistry(),source=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(path.join(desktop, 'electron/preload/preload.cjs'))}}});
    source.show=()=>{};windows.registerWindow({window:source,role:'main',allowedLocations:[${JSON.stringify(location)}]});
    let host,settingsWrites=[],fileReads=0,legacyHistoryWrites=0,blockedCloses=0,closeAttempts=0,navigations=0;
    source.on('will-prevent-unload',()=>{blockedCloses++});
    source.webContents.on('did-start-navigation',(_event,_url,_sameDocument,mainFrame)=>{if(mainFrame)navigations++});
    const initial={locale:'en-US',workbench:{activeTab:{'workspace-parent':'launcher'},documentSessions:{},browserSessions:{}}};
    const interactive=createDesktopInteractiveApplication({getRole:sender=>windows.getRole(sender),getOwner:workspaceId=>workspaceId===owner.workspaceId?owner:null,getNativeBinding:sender=>host.interactiveBinding(sender),getRuntime:()=>runtime});
    const nativeWindows=[];function QuietWindow(options){const win=new BrowserWindow(options);win.show=()=>{};nativeWindows.push(win);return win}QuietWindow.fromWebContents=contents=>BrowserWindow.fromWebContents(contents);
    host=createResourceWindowController({BrowserWindow:QuietWindow,trustedWindows:windows,rendererLocation:${JSON.stringify(location)},preloadPath:${JSON.stringify(path.join(desktop, 'electron/preload/resource-window.cjs'))},interactiveResources:interactive,getOwner:()=>owner,getLocale:()=> 'en',readHistory:()=>undefined,writeHistory:()=>{legacyHistoryWrites++},resolveDocument:()=>{throw Error('unexpected file lookup')},fileAccess:{readFile:()=>{fileReads++;throw Error('unexpected file read')}}});
    const ipc=createCatalogIpcMain({ipcMain,authorize:windows.authorize});registerIpcOwners({ipc,registrations:[...createResourceWindowIpcRegistrations({resourceWindows:host}),...createInteractiveResultsIpcRegistrations({interactiveResults:interactive})]});
    ipc.on('settings:get-sync',event=>{event.returnValue=initial});ipc.handle('settings:get',()=>initial);ipc.handle('settings:update',(_event,partial)=>{settingsWrites.push(partial);return initial});
    ipc.handle('bootstrap:get',()=>({fixture:{owner:{...owner,path:'/isolated-project'},evidenceRef:receipt.indexEntry.evidenceRef}}));
    const readEvidence=createEvidenceReader({findRecords:refs=>refs.includes(receipt.indexEntry.evidenceRef)?[receipt.indexEntry]:[],projectDeliveries:createEvidenceDeliveryProjection({getConversationId:()=>owner.conversationId,getPlan:()=>({planId:'plan',conversationId:'worker',delegationOrigin:{workspaceId:owner.workspaceId,sessionId:'session'}}),getSession:()=>({sessionId:'session',workspaceId:owner.workspaceId,report:{planId:'plan'}})}),readMessages:()=>[],readArtifact:()=>{throw Error('unexpected artifact body read')}});
    ipc.handle('project-agent:read-evidence',(_event,request)=>({ok:true,evidenceRef:request.evidenceRef,...readEvidence(request.evidenceRef,{context:request.context})}));
    ipc.handle('resource-edit:list',()=>({ok:true,drafts:[],operations:[],staleCount:0}));
    globalThis.workspaceFixture={snapshot:()=>stateStore.read(receipt.reference,()=>true),layout:()=>interactive.readLayout(source.webContents,{owner}),
      closeSource:()=>{closeAttempts++;source.close()},
      facts:()=>({settingsWrites,fileReads,legacyHistoryWrites,blockedCloses,closeAttempts,navigations,sourceAlive:!source.isDestroyed(),versions:Number(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM versions').get().n),operations:Number(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM operations').get().n)}),
      remoteReading(top){const current=interactive.readLayout(source.webContents,{owner});if(!current.ok||!current.snapshot)throw Error('missing layout');const {order,recent,interactive:session,revision}=current.snapshot;return interactive.writeLayout(source.webContents,{owner,expectedRevision:revision,order,recent,interactive:{...session,tabs:session.tabs.map(tab=>({...tab,navigation:{top,left:0}}))}})},
    };
    await source.loadURL(${JSON.stringify(location)});
    app.on('before-quit',()=>{interactive.dispose();host.dispose();ipc.dispose();windows.dispose();stateStore.close();resultStore.close()});
  `);
  const launcher = path.join(root, 'main.cjs');
  writeFileSync(launcher, `const{app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'app-data'))});import('./main.mjs').catch(error=>{console.error(error);app.exit(1)});`);
  const electron = await _electron.launch({ executablePath: process.env.PEER_TEST_ELECTRON ?? require('electron'), args: [launcher], timeout: 30_000, env: { ...process.env, NODE_ENV: 'production' } });
  const errors = [], external = [];
  const observe = page => { page.on('pageerror', error => errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); }); page.on('websocket', socket => external.push(socket.url()));
    page.on('dialog', dialog => { void dialog.dismiss().catch(error => { if (!error.message.includes('No dialog is showing')) errors.push(error.message); }); }); };
  electron.context().on('page', observe); electron.windows().forEach(observe);
  await electron.context().route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
  let page;
  try {
    page = await electron.firstWindow(); await page.getByText('Trial delivery', { exact: true }).waitFor();
    await page.getByText('Deliveries', { exact: true }).click();
    await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    await page.getByLabel('Divisor', { exact: true }).fill('5'); await page.getByText('Conditions saved', { exact: true }).waitFor();
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.snapshot())).values.$x, 5);
    await page.locator('.resource-interactive-body').evaluate(node => { node.scrollTop = 440; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    await page.waitForFunction(async () => { const reply = await window.peerAgent.resourcePresentation.readLayout({ owner: { workspaceId: 'workspace-bot', conversationId: 'workspace-parent' } }); return reply.ok && reply.snapshot?.interactive.tabs[0]?.navigation?.top >= 400; });
    await page.screenshot({ path: path.join(root, 'workspace-saved-light.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close tab: Workspace trial', exact: true }).click();
    await page.getByLabel('Divisor', { exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Divisor', { exact: true }).inputValue(), '5');
    await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    const nativeOpening = electron.waitForEvent('window'); await page.getByRole('button', { name: 'Open separate view', exact: true }).click();
    const native = await nativeOpening; await native.waitForURL(url => url.href.startsWith(location)); await native.getByLabel('Divisor', { exact: true }).waitFor();
    assert.equal(await native.getByLabel('Divisor', { exact: true }).inputValue(), '5');
    await native.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    await native.getByRole('button', { name: 'Continue calculation here', exact: true }).click();
    await native.getByLabel('Divisor', { exact: true }).fill('4'); await native.getByText('Conditions saved', { exact: true }).waitFor();
    await native.getByRole('button', { name: 'Return to source conversation', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.interactive-field input')?.disabled === true);
    assert.equal(await page.getByLabel('Conversation draft', { exact: true }).inputValue(), 'Keep this draft');
    await page.getByRole('button', { name: 'Continue calculation here', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('label')).some(label => label.textContent === 'Divisor' && label.control?.value === '4'));
    await page.getByLabel('Divisor', { exact: true }).fill('3'); await page.getByText('Conditions saved', { exact: true }).waitFor();
    await electron.evaluate(() => globalThis.workspaceFixture.remoteReading(120));
    await page.locator('.resource-interactive-body').evaluate(node => { node.scrollTop = 700; node.dispatchEvent(new Event('scroll')); });
    await page.getByRole('button', { name: 'Use saved layout', exact: true }).waitFor();
    await page.locator('.resource-interactive-body').evaluate(node => { node.scrollTop = 900; node.dispatchEvent(new Event('scroll')); });
    await page.getByRole('button', { name: 'Use saved layout', exact: true }).click();
    await page.waitForFunction(() => { const top = document.querySelector('.resource-interactive-body')?.scrollTop; return top >= 100 && top < 200; });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: path.join(root, 'workspace-restored-dark.png'), animations: 'disabled' });
    const layout = await electron.evaluate(() => globalThis.workspaceFixture.layout());
    assert.equal(layout.ok, true); assert.equal(layout.snapshot.interactive.tabs.length, 1); assert.equal(layout.snapshot.interactive.tabs[0].navigation.top, 120);
    const name = page.getByLabel('Trial name', { exact: true }); await name.focus();
    await name.evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '中断输入'); node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
    await electron.evaluate(() => globalThis.workspaceFixture.closeSource());
    await page.getByText('Conditions or layout are not confirmed saved. This window is preserved. Finish input or resolve saving before closing or reloading.', { exact: true }).waitFor();
    assert.equal(page.isClosed(), false);
    await page.getByRole('button', { name: 'Collapse workspace', exact: true }).click();
    await page.getByText('Unsaved conditions', { exact: false }).click();
    const retained = page.getByLabel('Preserved interactive input', { exact: true });
    assert.ok((await retained.inputValue()).includes('中断输入'));
    assert.ok((await retained.inputValue()).includes('Trial name: 中断输入'));
    await page.screenshot({ path: path.join(root, 'workspace-interrupted-input.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Preserve interrupted input and retry saving', exact: true }).click();
    await retained.waitFor({ state: 'detached' });
    const checkpoint = await electron.evaluate(() => globalThis.workspaceFixture.snapshot());
    assert.equal(checkpoint.inputDrafts.$name, '中断输入'); assert.equal(checkpoint.values.$name, 'Workspace trial');
    assert.deepEqual(errors, []);
    const nativeClosed = native.waitForEvent('close'); await native.getByRole('button', { name: 'Close this window', exact: true }).click(); await nativeClosed;
    const surfaceChunk = readdirSync(path.join(output, 'assets')).find(name => /^InteractiveSurface-.*\.js$/.test(name));
    assert.ok(surfaceChunk); const chunk = path.join(output, 'assets', surfaceChunk), missing = `${chunk}.unavailable`;
    renameSync(chunk, missing);
    try {
      await page.reload(); await page.getByText('Deliveries', { exact: true }).click();
      await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
      await page.getByText('The calculation view could not load. Your input and fixed result are preserved. Save drafts before reopening.', { exact: true }).waitFor();
      await page.getByText('Saved model summary, unverified', { exact: true }).waitFor();
      await page.getByLabel('Conversation draft', { exact: true }).fill('Keep exact draft after fallback');
      await page.screenshot({ path: path.join(root, 'workspace-chunk-unavailable.png'), animations: 'disabled' });
      renameSync(missing, chunk);
      const beforeRecovery = await electron.evaluate(() => globalThis.workspaceFixture.facts());
      const recoveredWindow = electron.waitForEvent('window');
      await page.getByRole('button', { name: 'Save drafts and open separate view', exact: true }).click();
      const recovered = await recoveredWindow; await recovered.getByLabel('Divisor', { exact: true }).waitFor();
      assert.equal(await recovered.getByLabel('Divisor', { exact: true }).inputValue(), '3');
      assert.equal(await recovered.getByLabel('Trial name', { exact: true }).inputValue(), '中断输入');
      assert.equal(await page.getByLabel('Conversation draft', { exact: true }).inputValue(), 'Keep exact draft after fallback');
      assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.facts())).navigations, beforeRecovery.navigations, 'main fallback must not reload the app');
      assert.ok(errors.length > 0 && errors.every(message => /ERR_FILE_NOT_FOUND|Failed to fetch dynamically imported module:.*InteractiveSurface-/.test(message)), JSON.stringify(errors));
    } finally { if (existsSync(missing)) renameSync(missing, chunk); }
    const facts = await electron.evaluate(() => globalThis.workspaceFixture.facts());
    assert.equal(facts.fileReads, 0); assert.equal(facts.legacyHistoryWrites, 0); assert.equal(facts.versions, 1); assert.equal(facts.operations, 1);
    assert.equal(facts.closeAttempts, 1); assert.equal(facts.sourceAlive, true);
    assert.equal(JSON.stringify(facts.settingsWrites).includes('interactive'), false);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('interactive-result://') || value.includes('interactiveReference'))), false);
    assert.deepEqual(external, []);
  } catch (error) {
    if (page && !page.isClosed()) { console.log('Workspace fixture diagnostics:', JSON.stringify({ text: (await page.locator('body').innerText()).slice(0, 2600), errors, root })); await page.screenshot({ path: path.join(root, 'workspace-failed.png'), animations: 'disabled' }); }
    throw error;
  } finally { await electron.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy()}).catch(()=>{}); await electron.close(); }
  console.log(`Interactive workspace screenshots: ${root}`);
});
