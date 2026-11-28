import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright-core';
import { build } from 'vite';
const desktop=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url));
// This override belongs only to the test harness; the product has no fixture seam.
const captureModule=process.env.PEER_TEST_MOTION_CAPTURE_MODULE
  ? pathToFileURL(path.resolve(process.env.PEER_TEST_MOTION_CAPTURE_MODULE))
  : new URL('./bot-history-motion-checks.mjs',import.meta.url);
const { recordDisclosure }=await import(captureModule.href);

function delayedInput(locator,delayMs) {
  const summary=locator.locator(':scope > summary');
  return { evaluate:locator.evaluate.bind(locator), locator(selector) {
    assert.equal(selector,':scope > summary');
    return { async click(options) { await new Promise(resolve=>setTimeout(resolve,delayMs)); return summary.click(options); } };
  } };
}

test('real work disclosure capture gives late trusted input its complete observation window', {timeout:90000},async()=>{
  const parent=process.env.PEER_MOTION_EVIDENCE_ROOT??os.tmpdir();
  if(process.env.PEER_MOTION_EVIDENCE_ROOT) assert.ok(readFileSync(path.join(parent,'.native-cli-fixture'),'utf8'));
  const root=mkdtempSync(path.join(parent,'peer-motion-capture-')),output=path.join(root,'renderer');
  const report={root,synthetic:true,scope:'Actual DelegatedWork/MotionDetails/CSS and Electron trusted clicks; isolated timer/animation seam, not full Bot or installed/real-model regression',captureModule:captureModule.href,captureSha256:createHash('sha256').update(readFileSync(captureModule)).digest('hex'),cases:{},pageErrors:[]};
  let app,page;
  try {
    await build({root:desktop,configFile:path.join(desktop,'vite.config.ts'),base:'./',mode:'production',logLevel:'error',
      build:{outDir:output,emptyOutDir:true,target:'esnext',cssCodeSplit:false,rollupOptions:{input:path.join(desktop,'scripts/motion-capture-ui-fixture.tsx'),output:{entryFileNames:'fixture.js'}}}});
    const css=readdirSync(path.join(output,'assets')).filter(n=>n.endsWith('.css')).map(n=>`<link rel="stylesheet" href="./assets/${n}">`).join('');
    writeFileSync(path.join(output,'index.html'),`<!doctype html><html data-theme="light" data-palette="frost"><meta charset="utf-8">${css}<body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
    const launcher=path.join(root,'main.cjs');mkdirSync(path.join(root,'home'));
    writeFileSync(launcher,`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'app-data'))});app.whenReady().then(async()=>{const win=new BrowserWindow({width:800,height:600,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});await win.loadFile(${JSON.stringify(path.join(output,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
    app=await _electron.launch({executablePath:process.env.PEER_TEST_ELECTRON??require('electron'),args:[launcher],timeout:30000,
      env:{...process.env,HOME:path.join(root,'home'),PEER_AGENT_HOME:path.join(root,'home'),NODE_ENV:'production'}});
    page=await app.firstWindow();page.on('pageerror',e=>report.pageErrors.push(e.message));
    await page.emulateMedia({reducedMotion:'no-preference'});
    const work=page.locator('.bot-work-row');await work.locator('summary').waitFor();
    await recordDisclosure(work,true,false,cap=>{report.cases.open=cap});
    // Reproduce the CI timing: the actual click is dispatched near the end of
    // the old6s total window, with the renderer still sampling live frames.
    await recordDisclosure(delayedInput(work,5800),false,false,cap=>{report.cases.lateClose=cap});
    const late=report.cases.lateClose;
    assert.ok(late.observationMs>=480,'closing observation follows the actual native toggle');
    await recordDisclosure(work,true,false,cap=>{report.cases.reopen=cap});
    await page.screenshot({path:path.join(root,'disclosure-open.png')});
    await recordDisclosure(work,false,false,cap=>{report.cases.close=cap});
    await work.locator('summary').focus();await page.keyboard.press('Tab');
    assert.equal(await work.locator('.bot-work-detail').evaluate(node=>node.contains(document.activeElement)),false);
    await recordDisclosure(work,true,true,cap=>{report.cases.reverse=cap});
    await page.emulateMedia({reducedMotion:'reduce'});await work.locator('summary').focus();await page.keyboard.press('Enter');
    assert.equal(await work.getAttribute('open'),'');
    assert.equal(await work.evaluate(node=>getComputedStyle(node,'::details-content').transitionDuration),'0s');
    await page.keyboard.press('Enter');assert.equal(await work.getAttribute('open'),null);
    assert.deepEqual(report.pageErrors,[]);
    report.passed=true;
  } catch(error) {report.passed=false;report.error=error.stack;throw error;}
  finally {
    if(page&&!page.isClosed()) await page.screenshot({path:path.join(root,'disclosure.png')}).catch(()=>{});
    if(app) await app.close();
    writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({root,passed:report.passed,scope:report.scope}));
  }
});
