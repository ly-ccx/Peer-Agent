import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { build } from 'vite';

const desktop = fileURLToPath(new URL('..', import.meta.url)), repo = path.resolve(desktop, '../..');
const require = createRequire(new URL('../package.json', import.meta.url));
const href = file => pathToFileURL(path.join(repo, file)).href;

async function buildNative(output) {
  const entry = '\0peer-interactive-native.tsx';
  await build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), base: './', mode: 'production', logLevel: 'error',
    plugins: [{ name: 'peer-interactive-native-fixture', resolveId(id, importer) {
      if (id === entry) return entry;
      if (importer === entry && id.startsWith('./')) return path.resolve(desktop, id);
    }, load(id) { if (id === entry) return `import React from 'react';import{createRoot}from'react-dom/client';import{NativeResourceWindow}from'./renderer/src/workbench/NativeResourceWindow.tsx';import'./renderer/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(NativeResourceWindow));`; } }],
    build: { outDir: output, emptyOutDir: true, target: 'esnext', cssCodeSplit: false, rollupOptions: { input: entry, output: { entryFileNames: 'fixture.js' } } } });
  const css = readdirSync(path.join(output, 'assets')).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="./assets/${name}">`).join('');
  writeFileSync(path.join(output, 'index.html'), `<!doctype html><html data-theme="light"><meta charset="utf-8">${css}<body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
}

test('native resource window uses actual preload, authorized IPC, domain state and close/reopen checkpoints', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-native-')), output = path.join(root, 'renderer');
  await buildNative(output);
  const mainFile = path.join(root, 'main.mjs'), location = pathToFileURL(path.join(output, 'index.html')).href;
  writeFileSync(mainFile, `
    import{app,BrowserWindow,ipcMain}from'electron';
    import{validateDraft}from${JSON.stringify(pathToFileURL(require.resolve('@peer-agent/interactive-content')).href)};
    import{createInteractiveResultStore,createInteractiveStateStore}from${JSON.stringify(href('packages/runtime-node/dist/interactive-results-public.js'))};
    import{createDesktopInteractiveApplication}from${JSON.stringify(href('apps/desktop/electron/main/interactive-results/application-service.mjs'))};
    import{createResourceWindowController}from${JSON.stringify(href('apps/desktop/electron/main/resource-window-controller.mjs'))};
    import{createTrustedWindowRegistry}from${JSON.stringify(href('apps/desktop/electron/main/ipc/trusted-window-registry.mjs'))};
    import{createCatalogIpcMain}from${JSON.stringify(href('apps/desktop/electron/main/ipc/catalog-ipc-main.mjs'))};
    import{registerIpcOwners}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-all.mjs'))};
    import{createResourceWindowIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-resource-window-ipc.mjs'))};
    import{createInteractiveResultsIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-interactive-results-ipc.mjs'))};
    app.setPath('userData',${JSON.stringify(path.join(root, 'app-data'))});
    await app.whenReady();
    const resultStore=createInteractiveResultStore({rootDir:${JSON.stringify(path.join(root, 'project-runtime'))},assertCompatibility:()=>true});
    const stateStore=createInteractiveStateStore({resultStore}),runtime={resultStore,stateStore},owner={workspaceId:'native-bot',conversationId:'native-parent'};
    const program='$x=2\\n$name="Native trial"\\nroot=Col([Title($name),Input("name","Trial name",$name),NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x),'+Array.from({length:32},(_,i)=>'Text("Fixed saved model observation '+i+'. This text provides a stable reading position for the isolated native result.")').join(',')+'])';
    const draft={publication:{kind:'create'},title:'Native trial',textFallback:'Unverified saved model trial.',program,inputs:[]};
    const receipt=resultStore.commitPublication({owner,source:{conversationId:'worker',sessionId:'session',planId:'plan',executionEpoch:'epoch',toolCallId:'publication'},draft,content:await validateDraft(draft),provenance:[],dataLevel:'D3_private',grant:{toolCallId:'publication',grantId:'fixture-grant',granted:true}},()=>true);
    resultStore.markIndexed(receipt.callRef,receipt.indexEntry);
    const windows=createTrustedWindowRegistry(),source=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await source.loadURL('data:text/html,<html><body>Isolated source</body></html>');
    windows.registerWindow({window:source,role:'main',allowedLocations:[${JSON.stringify(location)}]});
    let host,legacyWrites=0,fileReads=0;const resource={kind:'interactive',reference:receipt.reference};
    const interactive=createDesktopInteractiveApplication({getRole:sender=>windows.getRole(sender),getOwner:workspaceId=>workspaceId===owner.workspaceId?owner:null,getNativeBinding:sender=>host.interactiveBinding(sender),getRuntime:()=>runtime});
    const nativeWindows=[];function QuietWindow(options){const win=new BrowserWindow(options);win.show=()=>{};nativeWindows.push(win);return win}QuietWindow.fromWebContents=contents=>BrowserWindow.fromWebContents(contents);
    host=createResourceWindowController({BrowserWindow:QuietWindow,trustedWindows:windows,rendererLocation:${JSON.stringify(location)},preloadPath:${JSON.stringify(path.join(desktop, 'electron/preload/resource-window.cjs'))},interactiveResources:interactive,getOwner:()=>owner,getLocale:()=> 'en',readHistory:()=>undefined,writeHistory:()=>{legacyWrites++},resolveDocument:()=>{throw Error('unexpected file lookup')},fileAccess:{readFile:()=>{fileReads++;throw Error('unexpected file read')}}});
    const ipc=createCatalogIpcMain({ipcMain,authorize:windows.authorize});registerIpcOwners({ipc,registrations:[...createResourceWindowIpcRegistrations({resourceWindows:host}),...createInteractiveResultsIpcRegistrations({interactiveResults:interactive})]});
    let current;
    globalThis.nativeFixture={async open(){current=await host.open(source.webContents,{resource,sourceTabId:'fixed-result',navigation:{top:0,left:0}});if(!current.ok)throw Error(JSON.stringify(current));return current},
      snapshot:()=>stateStore.read(receipt.reference,()=>true),history:()=>host.history(source.webContents,{workspaceId:owner.workspaceId}),
      async restore(id){current=await host.restore(source.webContents,{workspaceId:owner.workspaceId,id});return current},
      close(){const win=nativeWindows.findLast(win=>!win.isDestroyed());if(!win)throw Error('native window missing');let emitted=false;win.once('close',()=>{emitted=true});const binding=host.bootstrap(win.webContents);const reply=host.close(win.webContents,binding.context);return{emitted,phase:binding.context?.phase,status:binding.status,ok:reply.ok}},
      facts:()=>({legacyWrites,fileReads,versions:Number(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM versions').get().n),operations:Number(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM operations').get().n)}),
      corrupt(){resultStore.storage.connect(owner.workspaceId,true).db.prepare('UPDATE states SET snapshot=?').run('{}')}};
    app.on('before-quit',()=>{interactive.dispose();host.dispose();ipc.dispose();windows.dispose();stateStore.close();resultStore.close()});
  `);
  const launcher = path.join(root, 'main.cjs');
  writeFileSync(launcher, `const{app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'app-data'))});import('./main.mjs').catch(error=>{console.error(error);app.exit(1)});`);
  const electron = await _electron.launch({ executablePath: process.env.PEER_TEST_ELECTRON ?? require('electron'), args: [launcher], timeout: 30_000, env: { ...process.env, NODE_ENV: 'production' } });
  const errors = [], external = [];
  try {
    await electron.firstWindow();
    electron.context().on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('websocket', socket => external.push(socket.url())); });
    await electron.context().route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
    const openingWindow = electron.waitForEvent('window');
    await electron.evaluate(async () => { while (!globalThis.nativeFixture) await new Promise(resolve => setTimeout(resolve, 10)); await globalThis.nativeFixture.open(); });
    let page = await openingWindow; await page.waitForURL(url => url.href.startsWith(location));
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    const divisor = page.getByLabel('Divisor', { exact: true }); await divisor.fill('5');
    await page.waitForFunction(() => document.querySelector('.interactive-metric dd')?.textContent === '2');
    await page.getByText('Conditions saved', { exact: true }).waitFor();
    assert.equal((await electron.evaluate(() => globalThis.nativeFixture.snapshot())).values.$x, 5);
    assert.deepEqual(await page.evaluate(() => [typeof window.peerAgent, typeof window.require, typeof window.process, Object.isFrozen(window.peerResource.interactiveResults)]), ['undefined', 'undefined', 'undefined', true]);
    await page.locator('.resource-interactive-body').evaluate(node => { node.scrollTop = 450; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    const label = page.getByLabel('Trial name', { exact: true }); await label.focus();
    await label.evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '中文试算'); node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
    const closing = await electron.evaluate(() => globalThis.nativeFixture.close());
    assert.deepEqual(closing, { emitted: true, phase: 'ready', status: undefined, ok: true });
    await page.getByText('The previous close was blocked because input or reading position was not safely saved. Confirm saving, then close again.', { exact: true }).waitFor();
    assert.equal(page.isClosed(), false);
    await label.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文试算' })));
    await page.waitForFunction(() => document.querySelector('.interactive-title')?.textContent === '中文试算');
    await page.getByText('Conditions saved', { exact: true }).waitFor();
    await page.locator('.resource-interactive-body').evaluate(node => { node.scrollTop = 450; node.dispatchEvent(new Event('scroll')); });
    await page.screenshot({ path: path.join(root, 'native-saved-light.png'), animations: 'disabled' });
    const closed = page.waitForEvent('close'); await electron.evaluate(() => globalThis.nativeFixture.close()); await closed;
    const history = await electron.evaluate(() => globalThis.nativeFixture.history());
    assert.equal(history.ok, true); assert.equal(history.entries.length, 1); assert.ok(history.entries[0].request.navigation.top >= 400);
    const restoredWindow = electron.waitForEvent('window').catch(() => null);
    const restoration = await electron.evaluate((_electron, id) => globalThis.nativeFixture.restore(id), history.entries[0].id);
    assert.equal(restoration.ok, true, JSON.stringify(restoration));
    page = await restoredWindow; assert.ok(page); await page.waitForURL(url => url.href.startsWith(location));
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Divisor', { exact: true }).inputValue(), '5'); assert.equal(await page.getByLabel('Trial name', { exact: true }).inputValue(), '中文试算');
    await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.setViewportSize({ width: 480, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'native-restored-dark.png'), animations: 'disabled' });
    const surfaceChunk = readdirSync(path.join(output, 'assets')).find(name => /^InteractiveSurface-.*\.js$/.test(name));
    assert.ok(surfaceChunk, 'the SDK surface remains a separate optional chunk');
    const chunk = path.join(output, 'assets', surfaceChunk), unavailable = `${chunk}.unavailable`;
    const closedForFailure = page.waitForEvent('close'); await electron.evaluate(() => globalThis.nativeFixture.close()); await closedForFailure;
    renameSync(chunk, unavailable);
    try {
      const retryWindow = electron.waitForEvent('window').catch(() => null);
      const reopened = await electron.evaluate((_electron, id) => globalThis.nativeFixture.restore(id), history.entries[0].id);
      assert.equal(reopened.ok, true, JSON.stringify(reopened)); page = await retryWindow; assert.ok(page);
      await page.getByText('The calculation view could not load. Your input and fixed result are preserved. Save drafts before reopening.', { exact: true }).waitFor();
      await page.getByText('Saved model summary, unverified', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Divisor', { exact: true }).count(), 0);
      assert.equal((await electron.evaluate(() => globalThis.nativeFixture.snapshot())).values.$x, 5);
      assert.equal((await electron.evaluate(() => globalThis.nativeFixture.history())).entries[0].request.navigation.top >= 400, true);
      await page.screenshot({ path: path.join(root, 'native-chunk-unavailable.png'), animations: 'disabled' });
      renameSync(unavailable, chunk);
      await page.getByRole('button', { name: 'Save drafts and reload view', exact: true }).click();
      await page.getByLabel('Divisor', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Divisor', { exact: true }).inputValue(), '5');
      assert.equal(await page.getByLabel('Trial name', { exact: true }).inputValue(), '中文试算');
      await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    } finally { if (existsSync(unavailable)) renameSync(unavailable, chunk); }
    await electron.evaluate(() => globalThis.nativeFixture.corrupt()); await page.reload();
    await page.getByText('Saved model summary, unverified', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Divisor', { exact: true }).count(), 0);
    const preserved = await electron.evaluate(() => globalThis.nativeFixture.history());
    assert.ok(preserved.entries[0].request.navigation.top >= 400, 'unavailable content must not replace the prior reading point with the loading/fallback geometry');
    await page.getByText('Saved model summary, unverified', { exact: true }).waitFor();
    await page.getByText('Unverified saved model trial.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Divisor', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(root, 'native-state-corrupt.png'), animations: 'disabled' });
    assert.deepEqual(await electron.evaluate(() => globalThis.nativeFixture.facts()), { legacyWrites: 0, fileReads: 0, versions: 1, operations: 1 });
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
  } catch (error) {
    const page = electron.windows().find(page => page.url().startsWith(location));
    if (page && !page.isClosed()) {
      console.log('Native fixture diagnostics:', JSON.stringify({ text: (await page.locator('body').innerText()).slice(0, 1600), errors, root }));
      await page.screenshot({ path: path.join(root, 'native-failed.png'), animations: 'disabled' });
    }
    throw error;
  } finally { await electron.close(); }
  console.log(`Interactive native resource screenshots: ${root}`);
});
