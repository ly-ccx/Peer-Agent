import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { build } from 'vite';

const desktop = fileURLToPath(new URL('..', import.meta.url)), require = createRequire(new URL('../package.json', import.meta.url));
const rowCount = 500;
const program = '$divisor=2\n$label="Trial"\n$mode="all"\n$include=true\n$budget=100\nrows=$mode=="all" ? @Data("facts") : @RowsWhere(@Data("facts"),"cost","gt",480)\nroot=Col([Title($label),Input("label","Trial name",$label),NumberInput("divisor","Divisor",$divisor,0,10,1),Select("mode","Rows",$mode,[{value:"all",label:"All"},{value:"expensive",label:"Above 480"}]),Checkbox("include","Include calculation",$include),Slider("budget","Budget",$budget,0,1000,1),Metric("Trial total",$include ? $budget/$divisor : 0),Table("Observations",[{key:"id",label:"ID"},{key:"cost",label:"Cost"}],rows,"id"),Chart("Costs","bar","id",[{key:"cost",label:"Cost"}],rows),Button("Reset budget",@Reset($budget)),SourceReference("facts","Fixed observations"),Divider(),Card("Chart detail",[Row([Text("Synthetic planning values"),Caption("Use the data tables for exact values")]),Chart("Cost trend","line","id",[{key:"cost",label:"Cost"}],rows)])])';

async function buildFixture(output, mode) {
  const entryId = '\0peer-interactive-fixture.tsx';
  const contents = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {validateDraft,digestJSON,validateState} from '@peer-agent/interactive-content';
    import {InteractiveResource} from './renderer/src/workbench/interactive/InteractiveResource.tsx';
    import {interactiveSessionRegistry} from './renderer/src/workbench/interactive/interactiveSessionRegistry.ts';
    import './renderer/src/styles.css';
    (async()=>{
      const content=await validateDraft({title:'Fixed observations',textFallback:'Model trial, unverified.',program:${JSON.stringify(program)}},
        {bindings:{facts:Array.from({length:${rowCount}},(_,id)=>({id,cost:id+1}))}});
      const owner={workspaceId:'fixture-bot',conversationId:'fixture-parent'};
      const reference={owner,resultId:'fixture-result',contentVersion:'sha256:'+'a'.repeat(64)};
      let state={result:reference,specHash:content.specHash,stateSchemaHash:content.stateSchemaHash,stateRevision:0,values:content.initialValues,inputDrafts:{},stateDigest:await digestJSON({values:content.initialValues,inputDrafts:{}}),updatedAt:new Date().toISOString(),requestId:'initial'};
      const handle={viewId:'fixture-view',windowId:'fixture-window',generation:'fixture-generation'};
      const writer={viewId:handle.viewId,generation:'fixture-writer',token:'fixture-token'};
      const provenance=[{bindingId:'facts',source:{kind:'model-data',contentDigest:'sha256:'+'b'.repeat(64)},truncated:false,redacted:false,dataLevel:'D3_private'}];
      const opened={handle,result:{reference,content,provenance},state};
      let rejectSave=false;
      const api={open:async()=>({ok:true,...opened}),readState:async()=>({ok:true,state}),acquire:async()=>({ok:true,writer}),
        save:async request=>{
          if(rejectSave){rejectSave=false;return{ok:false,code:'interactive_save_unavailable'};}
          if(request.expectedRevision!==state.stateRevision)return{ok:false,code:'interactive_state_conflict'};
          const values=validateState(request.values,content.stateSchema,request.inputDrafts);
          state={...state,...values,stateRevision:state.stateRevision+1,stateDigest:await digestJSON(values),requestId:request.requestId,updatedAt:new Date().toISOString()};return{ok:true,state};},release:async()=>({ok:true})};
      const registry=interactiveSessionRegistry(api);
      const session=()=>registry.get(reference).session;
      const recovery=[];
      globalThis.interactiveFixture={snapshot:()=>session().snapshot(),setBudget:value=>session().editValue('$budget',value),recovery,
        fail:()=>{globalThis.fixtureSdkFault=true;rejectSave=true;session().editValue('$budget',321);}};
      const onRecoverView=async()=>{recovery.push({budget:state.values.$budget,revision:state.stateRevision});return true;};
      createRoot(document.getElementById('root')).render(React.createElement('main',{style:{padding:24,maxWidth:1000,margin:'0 auto'}},
        React.createElement(InteractiveResource,{reference,api,active:true,isZh:false,onRecoverView})));
    })().catch(error=>{document.getElementById('root').textContent='Fixture failed: '+error.stack;throw error;});`;
  await build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), base: './', mode, logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    plugins: [{ name: 'peer-interactive-isolated-component', enforce: 'pre', resolveId(id, importer) {
      if (id === entryId) return entryId;
      if (importer === entryId && id.startsWith('./')) return path.resolve(desktop, id);
    }, load(id) { if (id === entryId) return contents; }, transform(code, id) {
      if (id.endsWith('/interactive/InteractiveSurface.tsx')) {
        assert.ok(code.includes('<Renderer.Content />'), 'fault injection must wrap the real SDK content');
        return code.replace('<Renderer.Content />', '<FixtureSdkMount />')
          + '\nfunction FixtureSdkMount() { if (globalThis.fixtureSdkFault) throw Error("fixture SDK mount failure"); return <Renderer.Content />; }\n';
      }
    } }],
    build: { outDir: output, emptyOutDir: true, target: 'esnext', cssCodeSplit: false, rollupOptions: { input: entryId,
      output: { entryFileNames: 'fixture.js', format: 'iife', inlineDynamicImports: true } } } });
  const css = readdirSync(path.join(output, 'assets')).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="./assets/${name}">`).join('');
  writeFileSync(path.join(output, 'index.html'), `<!doctype html><html data-theme="light"><meta charset="utf-8">${css}<style>html,body,#root{min-width:0;min-height:100%;height:auto;overflow:auto}body{margin:0;background:var(--paper-sheet)}</style><body><div id="root"></div><script src="./fixture.js"></script></body></html>`);
}

test('the real SDK mounts Peer controls without tools or telemetry and recovers a production render fault', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-renderer-'));
  for (const mode of ['production', 'development']) {
    const output = path.join(root, mode); await buildFixture(output, mode);
    const main = path.join(output, 'main.cjs');
    writeFileSync(main, `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, `data-${mode}`))});app.whenReady().then(()=>new BrowserWindow({width:1100,height:900,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}).loadURL('data:text/html,<!doctype html><html><body></body></html>'));`);
    const app = await _electron.launch({ executablePath: process.env.PEER_TEST_ELECTRON ?? require('electron'), args: [main] });
    try {
      const page = await app.firstWindow(), external = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('websocket', socket => external.push(socket.url()));
      await page.route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
      await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
      await page.getByLabel('Divisor', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.interactive-metric dd')?.textContent === '50');
      const divisor = page.getByLabel('Divisor', { exact: true }), element = await divisor.elementHandle();
      await divisor.fill('0');
      await page.getByText('These conditions divide by zero. Adjust the inputs.', { exact: true }).waitFor();
      assert.equal(await page.locator('.interactive-metric').isVisible(), false);
      assert.equal(await divisor.inputValue(), '0');
      assert.equal(await element.evaluate(node => node === document.activeElement), true);
      await divisor.fill('5');
      await page.waitForFunction(() => document.querySelector('.interactive-metric dd')?.textContent === '20');
      assert.equal(await divisor.evaluate((node, old) => node === old, element), true);
      await page.getByLabel('Rows', { exact: true }).selectOption('expensive');
      await page.waitForFunction(() => document.querySelector('.interactive-table tbody')?.children.length === 20);
      await page.getByLabel('Rows', { exact: true }).selectOption('all');
      await page.waitForFunction(() => document.querySelector('.interactive-table tbody')?.children.length === 100);
      await page.getByRole('button', { name: 'Next', exact: true }).first().click();
      const firstDataRow = page.getByRole('table', { name: 'Observations', exact: true }).locator('tbody tr').first();
      assert.equal(await firstDataRow.locator('td').first().innerText(), '100');
      assert.equal(await page.getByRole('img', { name: 'Costs', exact: true }).locator('rect').count(), rowCount);
      const points = await page.getByRole('img', { name: 'Cost trend', exact: true }).locator('polyline').getAttribute('points');
      assert.equal(points.trim().split(/\s+/).length, rowCount);
      await page.getByLabel('Include calculation', { exact: true }).focus();
      await page.getByLabel('Include calculation', { exact: true }).press('Space');
      await page.waitForFunction(() => document.querySelector('.interactive-metric dd')?.textContent === '0');
      await page.locator('label.interactive-check').click();
      assert.equal(await page.getByLabel('Include calculation', { exact: true }).isChecked(), true);
      assert.equal(await firstDataRow.locator('td').first().innerText(), '100', 'unrelated parameter changes retain the table page');
      const label = page.getByLabel('Trial name', { exact: true }); await label.focus();
      await label.evaluate(node => {
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '中文试算');
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文试算', isComposing: true }));
      });
      assert.equal(await page.evaluate(() => interactiveFixture.snapshot().composing), true);
      assert.equal(await label.inputValue(), '中文试算');
      assert.equal(await page.evaluate(() => interactiveFixture.snapshot().values.$label), 'Trial');
      await label.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文试算' })));
      await page.waitForFunction(() => document.querySelector('.interactive-title')?.textContent === '中文试算');
      assert.equal(await label.evaluate(node => node === document.activeElement), true);
      await page.evaluate(() => interactiveFixture.setBudget(300));
      await page.waitForFunction(() => document.querySelector('.interactive-metric dd')?.textContent === '60');
      await page.getByRole('button', { name: 'Reset budget', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.interactive-metric dd')?.textContent === '20');
      if (mode === 'production') {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const factor = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.setContentSize(560, 900);
          win.webContents.setZoomFactor(1.5);
          return win.webContents.getZoomFactor();
        });
        assert.ok(Math.abs(factor - 1.5) < 0.01);
        await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
        await page.waitForFunction(() => innerWidth >= 350 && innerWidth <= 390, undefined, { timeout: 4000 });
        const zoomed = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(zoomed.scrollWidth <= zoomed.width + 1, JSON.stringify(zoomed));
        const chart = page.getByRole('img', { name: 'Cost trend', exact: true });
        assert.equal(await chart.count(), 1);
        const table = page.getByRole('table', { name: 'Cost trend', exact: true });
        assert.equal(await table.getByRole('columnheader', { name: 'Cost' }).count(), 1);
        assert.ok((await table.ariaSnapshot()).includes('row "0 1"'), 'the chart table exposes exact values in the accessibility tree');
        assert.equal(await page.getByRole('heading', { name: 'Chart detail' }).count(), 1);
        assert.equal(await page.getByText('Synthetic planning values', { exact: true }).count(), 1);
        assert.equal(await page.getByText('Use the data tables for exact values', { exact: true }).count(), 1);
        assert.equal(await page.getByRole('separator').count(), 1);
        async function capture(name) {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const bytes = await app.evaluate(async ({ BrowserWindow }) =>
            (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
          writeFileSync(path.join(root, name), Buffer.from(bytes, 'base64'));
        }
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.getByLabel('Trial name', { exact: true }).evaluate(node => node.focus({ preventScroll: true }));
        await capture('production-zoom-reduced-controls.png');
        const dataRegion = page.getByRole('region', { name: 'Cost trend', exact: true });
        await chart.evaluate(node => node.closest('section').scrollIntoView({ block: 'start', behavior: 'instant' }));
        await dataRegion.evaluate(node => node.focus({ preventScroll: true }));
        assert.equal(await table.evaluate(node => node.getBoundingClientRect().top < innerHeight), true);
        assert.equal(await dataRegion.evaluate(node => node === document.activeElement), true);
        await capture('production-zoom-reduced-chart-table.png');
        await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.webContents.setZoomFactor(1);
          win.setContentSize(1100, 900);
        });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
      for (const [width, theme] of [[1100, 'light'], [420, 'dark']]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('.interactive-chart svg [x],[y],[width],[height],[points]').evaluateAll(nodes => nodes.some(node => [...node.attributes].some(attr => /NaN|Infinity/.test(attr.value)))), false);
        await page.screenshot({ path: path.join(root, `${mode}-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('[data-openui-devtools-auto-mount]').count(), 0);
      if (mode === 'production') {
        const readProcesses = () => app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
          pid, type, cpuSeconds: cpu.cumulativeCPUUsage ?? null, workingSetKiB: memory.workingSetSize,
        })));
        const before = await readProcesses();
        const performanceSample = await page.evaluate(async () => {
          const longTasks = [];
          const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
          observer.observe({ type: 'longtask' });
          const field = document.querySelector('.interactive-surface input[aria-label="Divisor"]')
            ?? [...document.querySelectorAll('label')].find(label => label.textContent === 'Divisor')?.control;
          if (!(field instanceof HTMLInputElement)) throw Error('Missing trial input for timing');
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          const timings = [];
          const startedAt = performance.now();
          for (const value of [0, 5, ...Array.from({ length: 60 }, (_, index) => index % 2 ? 5 : 4)]) {
            const start = performance.now();
            setValue.call(field, String(value));
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
            let expected;
            do {
              await new Promise(requestAnimationFrame);
              const metric = document.querySelector('.interactive-metric:not([hidden])');
              expected = value === 0 ? !metric : metric?.querySelector('dd')?.textContent === String(100 / value);
            } while (!expected && performance.now() - start < 2000);
            if (!expected) throw Error('Trial input did not produce the expected visible state for ' + value);
            timings.push({ value, inputToFrameMs: performance.now() - start });
          }
          longTasks.push(...observer.takeRecords().map(entry => entry.duration));
          observer.disconnect();
          return { durationMs: performance.now() - startedAt, timings, longTaskMs: longTasks };
        });
        const processSamples = (await readProcesses()).map(({ pid, type, cpuSeconds, workingSetKiB }) => {
          const prior = before.find(row => row.pid === pid);
          return { type, workingSetBeforeKiB: prior?.workingSetKiB ?? null, workingSetAfterKiB: workingSetKiB,
            cpuSeconds: prior?.cpuSeconds != null && cpuSeconds != null ? cpuSeconds - prior.cpuSeconds : null };
        });
        writeFileSync(path.join(root, 'production-interaction-sample.json'), JSON.stringify({
          rows: rowCount, ...performanceSample, processSamples,
        }, null, 2) + '\n');
        await page.evaluate(() => interactiveFixture.fail());
        const fallback = page.getByRole('alert').filter({ hasText: 'The calculation view could not load.' });
        await fallback.getByText('Saved model summary, unverified').waitFor();
        await fallback.getByText('Model trial, unverified.', { exact: true }).waitFor();
        assert.equal(await page.getByText('View saved program').isVisible(), true);
        assert.equal(await page.locator('.interactive-metric').count(), 0);
        assert.equal(await page.evaluate(() => interactiveFixture.snapshot().dirty), true);
        const reopen = fallback.getByRole('button', { name: 'Save drafts and open separate view' });
        await reopen.click();
        await fallback.getByText('Saving or opening is unconfirmed. Your input is preserved; retry.').waitFor();
        assert.deepEqual(await page.evaluate(() => interactiveFixture.recovery), []);
        assert.equal(await page.evaluate(() => interactiveFixture.snapshot().values.$budget), 321);
        await reopen.click();
        await fallback.getByText('The view was opened. Your original calculation is preserved.').waitFor();
        const [receipt] = await page.evaluate(() => interactiveFixture.recovery);
        assert.equal(receipt.budget, 321);
        assert.ok(receipt.revision > 0);
        assert.equal(await page.evaluate(() => interactiveFixture.snapshot().dirty), false);
        assert.deepEqual(external, []);
      }
    } finally { await app.close(); }
  }
  console.log(`Interactive SDK component screenshots: ${root}`);
});
