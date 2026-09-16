// Isolated Electron component smoke. Not a full application/router E2E.
import { _electron as electron } from 'playwright-core';
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'peer-context-ui-')));
const component = path.join(desktop, 'renderer/src/chat/components/thread/TokenUsageDisplay.tsx');
const admission = path.join(desktop, 'renderer/src/chat/state/contextAccountingSnapshot.ts');
const react = path.join(desktop, 'node_modules/react/index.js');
const reactDom = path.join(desktop, 'node_modules/react-dom/client.js');
await writeFile(path.join(root, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>');
await writeFile(path.join(root, 'fixture.jsx'), `
import React from ${JSON.stringify(react)};
import {createRoot} from ${JSON.stringify(reactDom)};
import {TokenUsageDisplay} from ${JSON.stringify(component)};
import {acceptAccountingSnapshot} from ${JSON.stringify(admission)};
import ${JSON.stringify(path.join(desktop, 'renderer/src/chat/styles/chat-composer.css'))};
const root=createRoot(document.getElementById('root'));
const base={version:1,conversationId:'a',modelKey:'fixture',contentRevision:1,revision:1,compactionEpoch:0,percent:80,authoritativeInputTokens:80000,contextWindow:100000,inputBudget:100000,pressureSource:'provider_usage'};
let live=base;
function render(){root.render(<TokenUsageDisplay providers={[]} tokenUsage={null} contextAccounting={live} isZh={true} effort="medium" effortLevels={['medium']} onEffortChange={()=>{}} showModelControls={false}/>);}
window.fixture={event(next){live=acceptAccountingSnapshot(live,next);render();},load(next){live=next;render();},base};render();
`);
await build({ configFile: false, root, resolve: { alias: { 'react/jsx-runtime': path.join(desktop, 'node_modules/react/jsx-runtime.js') } }, logLevel: 'error', esbuild: { jsx: 'automatic' }, build: { outDir: path.join(root, 'dist'), emptyOutDir: false }, base: './' });
await writeFile(path.join(root, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});
app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('devtools:')}));const w=new BrowserWindow({width:700,height:220,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root,'dist/index.html'))});});`);
let app;
try {
  const env={PATH:process.env.PATH,HOME:root,TMPDIR:root};
  app=await electron.launch({args:[path.join(root,'main.cjs')],env});
  const page=await app.firstWindow();
  page.on('pageerror',e=>console.error('PAGE_ERROR',e.message));
  const check=async(expected,name)=>{
    await page.waitForFunction(value=>document.querySelector('.ctx-pct')?.textContent===value,expected,{timeout:15000});
    const actual=await page.locator('.ctx-ring').evaluate(e=>e.style.getPropertyValue('--ctx-pct'));
    assert.equal(Number(actual),expected==='?'?0:Number(expected.replace('%','')));
    await page.screenshot({path:path.join(root,`${name}.png`)});
  };
  await check('80%','before');
  const base=await page.evaluate(()=>window.fixture.base);
  const next={...base,contentRevision:2,revision:2,compactionEpoch:1,percent:10,authoritativeInputTokens:10000};
  await page.evaluate(n=>window.fixture.event(n),next);await check('10%','live');
  await page.evaluate(n=>window.fixture.event(n),base);await check('10%','late-old');
  await page.evaluate(n=>window.fixture.load({...n,conversationId:'b',percent:30}),next);await check('30%','other');
  await page.evaluate(n=>window.fixture.load(n),next);await check('10%','return');
  const unknown={...next,contentRevision:3,revision:3,compactionEpoch:2,percent:null,authoritativeInputTokens:null,pressureSource:'unknown'};
  await page.evaluate(n=>window.fixture.event(n),unknown);await check('?','unknown');
  await page.evaluate(n=>window.fixture.load({...n,conversationId:'b',percent:30}),next);await check('30%','other-again');
  await page.evaluate(n=>window.fixture.load(n),unknown);await check('?','unknown-return');
  console.log(JSON.stringify({status:'passed',scope:'real Electron TokenUsageDisplay + admission; synthetic snapshots; no main router',root,checks:8}));
} finally {if(app) await app.close();}
