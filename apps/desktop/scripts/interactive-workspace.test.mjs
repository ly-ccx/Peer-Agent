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
      import{EvidenceView}from'./renderer/src/project-agent/drawer/EvidenceView.tsx';
      import{NativeResourceWindow}from'./renderer/src/workbench/NativeResourceWindow.tsx';
      import{ConfirmProvider}from'./renderer/src/app/components/ConfirmProvider.tsx';
      import{ResourceEditAppFrame}from'./renderer/src/workbench/editing/ResourceEditContinuity.tsx';
      import{BotComposer}from'./renderer/src/project-agent/conversation/BotComposer.tsx';
      import{useInputRecovery}from'./renderer/src/project-agent/state/useInputRecovery.ts';
      import{useResourceFeedbackPreparations}from'./renderer/src/workbench/feedback/useResourceFeedbackPreparations.ts';
      import{createI18n}from'@peer-agent/i18n';
      import'./renderer/src/styles.css';
      import'./renderer/src/project-agent/styles/bot-conversation.css';
      import'./renderer/src/project-agent/styles/bot-drawer.css';
      function Composer({owner}){useResourceFeedbackPreparations();const{session,state}=useInputRecovery(owner.workspaceId);return <BotComposer i18n={createI18n('en-US')} botName="Trial Bot" resourceRecipientConversationId={owner.conversationId} draft={state.draft} ready={state.ready} quote={state.draft.quote?.text??''} onQuoteRemove={()=>session.edit({quote:null})} onDraftChange={patch=>session.edit(patch)} onSend={()=>void session.send({quoteRefs:state.draft.quote?[state.draft.quote.messageId]:[]})}/>;}
      if(window.peerResource)createRoot(document.getElementById('root')).render(<NativeResourceWindow/>);
      else{const{fixture}=await window.peerAgent.getBootstrap();
        createRoot(document.getElementById('root')).render(<ConfirmProvider><ResourceEditAppFrame><WorkbenchProvider conversationId={fixture.owner.conversationId} isPageActive resourceMode layoutHost="bot">
          <BotResourceLayout owner={fixture.owner} active isZh={false}><div className="bot-main" style={{padding:24}}><h1>Trial delivery</h1><Composer owner={fixture.owner}/><EvidenceView evidence={{evidenceRef:fixture.evidenceRef}} workspaceId={fixture.owner.workspaceId} i18n={createI18n('en-US')}/></div></BotResourceLayout>
        </WorkbenchProvider></ResourceEditAppFrame></ConfirmProvider>);}
    `, 'interactive-workspace-fixture.tsx', { loader: 'tsx', jsx: 'automatic' }); } }], build: { outDir: output, emptyOutDir: true, target: 'esnext', cssCodeSplit: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'fixture.js' } } } });
  const css = readdirSync(path.join(output, 'assets')).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="./assets/${name}">`).join('');
  writeFileSync(path.join(output, 'index.html'), `<!doctype html><html data-theme="light"><meta charset="utf-8">${css}<style>html,body,#root{height:100%;margin:0}.bot-resource-layout{height:100%}.bot-main{height:100%;overflow:auto;box-sizing:border-box}</style><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
}

async function reloadSavedWorkspace(electron, page) {
  const saved = page.getByText('Conditions and layout are saved. You can close or reload again.', { exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const keepWorking = page.getByRole('button', { name: 'Keep working', exact: true });
    if (await keepWorking.isVisible()) await keepWorking.click();
    const loaded = page.waitForEvent('domcontentloaded').then(() => 'loaded');
    const settled = saved.waitFor().then(() => 'saved');
    const protectedView = page.getByText('Conditions or layout are not confirmed saved. This window is preserved. Finish input or resolve saving before closing or reloading.', { exact: true }).waitFor().then(() => 'protected');
    await electron.evaluate(() => globalThis.workspaceFixture.reloadSource());
    const outcome = await Promise.race([loaded, settled, protectedView]);
    if (outcome === 'loaded') return;
    if (outcome === 'protected') {
      await page.getByRole('button', { name: 'Retry saving', exact: true }).click(); await saved.waitFor();
    }
  }
  throw Error('The saved workspace did not accept the explicit reload retry');
}

test('the main workspace opens canonical interactive deliveries, restores result tabs and hands off the exact fixed result', { timeout: 150_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-workspace-')), output = path.join(root, 'renderer');
  await renderer(output);
  const location = pathToFileURL(path.join(output, 'index.html')).href, mainFile = path.join(root, 'main.mjs');
  writeFileSync(mainFile, `
    import{app,BrowserWindow,ipcMain}from'electron';
    import{validateDraft}from${JSON.stringify(pathToFileURL(require.resolve('@peer-agent/interactive-content')).href)};
    import{createInteractiveResultStore,createInteractiveStateStore,createInteractiveFeedbackAdmission,createInteractivePublicationSource}from${JSON.stringify(href('packages/runtime-node/dist/interactive-results-public.js'))};
    import{createProjectInputDraftStore}from${JSON.stringify(href('packages/runtime-node/src/project-agent/input-draft-store.mjs'))};
    import{createInputQueue}from${JSON.stringify(href('packages/runtime-node/src/project-agent/input-queue.mjs'))};
    import{createConversationStore}from${JSON.stringify(href('packages/conversation-store/src/index.mjs'))};
    import{createResourceFeedbackPreparation}from${JSON.stringify(href('apps/desktop/electron/main/resource-feedback-preparation.mjs'))};
    import{createResourceFeedbackIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-resource-feedback-ipc.mjs'))};
    import{createDesktopInteractiveApplication}from${JSON.stringify(href('apps/desktop/electron/main/interactive-results/application-service.mjs'))};
    import{createEvidenceDeliveryProjection}from${JSON.stringify(href('apps/desktop/electron/main/project-agent/evidence-deliveries.mjs'))};
    import{createEvidenceReader}from${JSON.stringify(href('apps/desktop/electron/main/project-agent/evidence-reader.mjs'))};
    import{createProjectAgentApplicationService}from${JSON.stringify(href('apps/desktop/electron/main/project-agent/project-agent-application-service.mjs'))};
    import{createDesktopReplyComposer}from${JSON.stringify(href('apps/desktop/electron/main/project-agent/reply-composer-port.mjs'))};
    import{createResourceWindowController}from${JSON.stringify(href('apps/desktop/electron/main/resource-window-controller.mjs'))};
    import{createTrustedWindowRegistry}from${JSON.stringify(href('apps/desktop/electron/main/ipc/trusted-window-registry.mjs'))};
    import{createCatalogIpcMain}from${JSON.stringify(href('apps/desktop/electron/main/ipc/catalog-ipc-main.mjs'))};
    import{registerIpcOwners}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-all.mjs'))};
    import{createResourceWindowIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-resource-window-ipc.mjs'))};
    import{createInteractiveResultsIpcRegistrations}from${JSON.stringify(href('apps/desktop/electron/main/ipc/register-interactive-results-ipc.mjs'))};
    app.setPath('userData',${JSON.stringify(path.join(root, 'app-data'))});await app.whenReady();
    const conversations=createConversationStore({storeDir:${JSON.stringify(path.join(root, 'conversations'))}}),parent=conversations.createConversation({role:'project_agent',workspaceId:'workspace-bot',title:'Trial Bot'});
    const owner={workspaceId:'workspace-bot',conversationId:parent.id},resultStore=createInteractiveResultStore({rootDir:${JSON.stringify(path.join(root, 'runtime'))},assertCompatibility:()=>true}),stateStore=createInteractiveStateStore({resultStore}),runtime={resultStore,stateStore};
    const feedback=createInteractiveFeedbackAdmission({stateStore}),drafts=createProjectInputDraftStore({rootDir:${JSON.stringify(path.join(root, 'runtime'))},validateInteractiveFeedback:feedback.validate});
    const draftAddress={workspaceId:owner.workspaceId,surface:'desktop'};drafts.write({...draftAddress,revision:0,draft:{text:'Keep this draft',quote:{messageId:'quoted-message',text:'Keep this quote'},attachmentIds:['original-file']},pending:[],uploads:[{id:'original-file',name:'original.txt',sourceKind:'user_upload',kind:'text',mimeType:'text/plain',size:4,text:'keep'}]});
    const queue=createInputQueue({rootDir:${JSON.stringify(path.join(root, 'runtime'))},validateInteractiveFeedback:feedback.validate,holdsLease:()=>true,resolveConversationId:()=>owner.conversationId,hasMessage:(id,message)=>conversations.getConversation(id).messages.some(row=>row.id===message),appendMessage:(id,row)=>conversations.appendMessage(id,row)});
    const program='$x=2\\n$name="Workspace trial"\\nroot=Col([Title($name),Input("name","Trial name",$name),NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x),'+Array.from({length:32},(_,i)=>'Text("Saved model observation '+i+'. Fixed content preserves the reading position while changing local conditions.")').join(',')+'])';
    const draft={publication:{kind:'create'},title:'Workspace trial',textFallback:'Unverified saved model trial.',program,inputs:[]};
    const receipt=resultStore.commitPublication({owner,source:{conversationId:'worker',sessionId:'session',planId:'plan',executionEpoch:'epoch',toolCallId:'publication'},draft,content:await validateDraft(draft),provenance:[],dataLevel:'D3_private',grant:{toolCallId:'publication',grantId:'fixture-grant',granted:true}},()=>true);resultStore.markIndexed(receipt.callRef,receipt.indexEntry);
    const windows=createTrustedWindowRegistry(),source=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(path.join(desktop, 'electron/preload/preload.cjs'))}}});
    source.show=()=>{};windows.registerWindow({window:source,role:'main',allowedLocations:[${JSON.stringify(location)}]});
    let host,settingsWrites=[],fileReads=0,legacyHistoryWrites=0,blockedCloses=0,closeAttempts=0,navigations=0;
    source.on('will-prevent-unload',()=>{blockedCloses++});
    source.webContents.on('did-start-navigation',(_event,_url,_sameDocument,mainFrame)=>{if(mainFrame)navigations++});
    const initial={locale:'en-US',workbench:{activeTab:{[owner.conversationId]:'launcher'},documentSessions:{},browserSessions:{}}};
    const preparation=createResourceFeedbackPreparation({isMainSender:sender=>windows.getRole(sender)==='main',getRecipient:()=>owner});
    const interactive=createDesktopInteractiveApplication({getRole:sender=>windows.getRole(sender),getOwner:workspaceId=>workspaceId===owner.workspaceId?owner:null,getNativeBinding:sender=>host.interactiveBinding(sender),getRuntime:()=>runtime,prepareFeedback:preparation.prepare,readDraft:drafts.read});
    const originalSave=interactive.save;let saveFault=null;
    interactive.save=(sender,request)=>{if(sender!==source.webContents||!saveFault)return originalSave(sender,request);const fault=saveFault;saveFault=null;if(fault==='uncommitted')return{ok:false,code:'fixture_save_unconfirmed'};const reply=originalSave(sender,request);return reply.ok?{ok:false,code:'fixture_save_unconfirmed'}:reply};
    const nativeWindows=[];function QuietWindow(options){const win=new BrowserWindow(options);win.show=()=>{};nativeWindows.push(win);return win}QuietWindow.fromWebContents=contents=>BrowserWindow.fromWebContents(contents);
    host=createResourceWindowController({BrowserWindow:QuietWindow,trustedWindows:windows,rendererLocation:${JSON.stringify(location)},preloadPath:${JSON.stringify(path.join(desktop, 'electron/preload/resource-window.cjs'))},interactiveResources:interactive,getOwner:()=>owner,getLocale:()=> 'en',readHistory:()=>undefined,writeHistory:()=>{legacyHistoryWrites++},resolveDocument:()=>{throw Error('unexpected file lookup')},fileAccess:{readFile:()=>{fileReads++;throw Error('unexpected file read')}}});
    const ipc=createCatalogIpcMain({ipcMain,authorize:windows.authorize});registerIpcOwners({ipc,registrations:[...createResourceWindowIpcRegistrations({resourceWindows:host}),...createInteractiveResultsIpcRegistrations({interactiveResults:interactive}),...createResourceFeedbackIpcRegistrations({preparation})]});
    ipc.handle('project-agent:read-input-draft',(_event,request)=>drafts.read(request));ipc.handle('project-agent:write-input-draft',(_event,request)=>drafts.write(request));ipc.handle('project-agent:submit-input',(_event,request)=>({ok:true,input:queue.submitInput(request)}));
    ipc.on('settings:get-sync',event=>{event.returnValue=initial});ipc.handle('settings:get',()=>initial);ipc.handle('settings:update',(_event,partial)=>{settingsWrites.push(partial);return initial});
    const evidenceFacts={getConversationId:()=>owner.conversationId,getPlan:()=>({planId:'plan',conversationId:'worker',tasks:[{taskId:'generated',status:'completed',result:'Saved unverified model trial.',evidenceRefs:['tool-result://publication']},{taskId:'remaining',status:'pending'}],delegationOrigin:{workspaceId:owner.workspaceId,parentConversationId:owner.conversationId,sessionId:'session'}}),getSession:()=>({sessionId:'session',workspaceId:owner.workspaceId,planId:'plan',status:'failed',report:{planId:'plan'}})};
    const findRecords=refs=>refs.includes(receipt.indexEntry.evidenceRef)?[receipt.indexEntry]:[];
    const publications=createInteractivePublicationSource({resultStore,goalPlanStore:{getPlan:evidenceFacts.getPlan,findEvidenceIndexRecords:findRecords},getBotConversationId:evidenceFacts.getConversationId,getSession:evidenceFacts.getSession});
    conversations.appendMessage(owner.conversationId,{id:'fixture-result-anchor',role:'user',kind:'user_input',content:'Show the saved trial and current task status'});
    const replyComposer=createDesktopReplyComposer({readResultReferences:publications.replyReferences,readDelivery:()=>({sessionIds:['session'],sessionStates:[{sessionId:'session',status:'failed'}],verdicts:[]})});
    const composed=replyComposer.postReply({text:'The saved trial is available; remaining analysis is incomplete and unverified.',replyTo:['fixture-result-anchor'],sources:['session'],statusClaims:[{sessionId:'session',status:'failed'}]},{...owner,turnId:'fixture-reply',toolCallOrdinal:1,messages:conversations.getPersistedConversationHistory(owner.conversationId).messages});
    if(composed.error||composed.message?.meta.evidenceRefs?.[0]!==receipt.indexEntry.evidenceRef)throw Error('The actual reply composer did not confirm the fixed publication reference: '+(composed.error??'missing fixed reference'));
    conversations.appendMessage(owner.conversationId,composed.message);
    ipc.handle('bootstrap:get',()=>({fixture:{owner:{...owner,path:'/isolated-project'},evidenceRef:conversations.getPersistedConversationHistory(owner.conversationId).messages.find(row=>row.id===composed.message.id).meta.evidenceRefs[0]}}));
    const readEvidence=createEvidenceReader({resolveScopedRecord:publications.resolveEvidence,findRecords,projectDeliveries:createEvidenceDeliveryProjection(evidenceFacts),readMessages:()=>[],readArtifact:()=>{throw Error('unexpected artifact body read')}});
    const projectApplication=createProjectAgentApplicationService({enabled:()=>true,readEvidenceBody:readEvidence});
    ipc.handle('project-agent:read-evidence',(_event,request)=>projectApplication.readEvidence(request));
    ipc.handle('resource-edit:list',()=>({ok:true,drafts:[],operations:[],staleCount:0}));
    globalThis.workspaceFixture={snapshot:()=>stateStore.read(receipt.reference,()=>true),layout:()=>interactive.readLayout(source.webContents,{owner}),
      failSave:kind=>{if(!['committed','uncommitted'].includes(kind))throw Error('invalid fault');saveFault=kind},
      draft:()=>drafts.read(draftAddress),consume:()=>queue.consume(owner.workspaceId),inputs:()=>({queue:queue.diagnosticSnapshot(owner.workspaceId),messages:conversations.getPersistedConversationHistory(owner.conversationId).messages.filter(row=>row.kind==='user_input'&&row.id!=='fixture-result-anchor').map(row=>({...row,selected:feedback.restore(row,owner.workspaceId)}))}),
      closeSource:()=>{closeAttempts++;source.close()},
      reloadSource:()=>source.webContents.reload(),
      facts:()=>({settingsWrites,fileReads,legacyHistoryWrites,blockedCloses,closeAttempts,navigations,sourceAlive:!source.isDestroyed(),versions:Number(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM versions').get().n),operations:Number(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM operations').get().n)}),
      remoteReading(top){const current=interactive.readLayout(source.webContents,{owner});if(!current.ok||!current.snapshot)throw Error('missing layout');const {order,recent,interactive:session,revision}=current.snapshot;return interactive.writeLayout(source.webContents,{owner,expectedRevision:revision,order,recent,interactive:{...session,tabs:session.tabs.map(tab=>({...tab,navigation:{top,left:0}}))}})},
    };
    await source.loadURL(${JSON.stringify(location)});
    app.on('before-quit',()=>{preparation.dispose();interactive.dispose();host.dispose();ipc.dispose();windows.dispose();stateStore.close();resultStore.close()});
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
    await page.getByRole('button', { name: 'Add current conditions to draft', exact: true }).click();
    await page.getByText('Added to the original Bot draft. Review and send from that conversation.', { exact: true }).waitFor();
    const preparedDraft = await electron.evaluate(() => globalThis.workspaceFixture.draft());
    assert.equal(preparedDraft.ok, true); assert.equal(preparedDraft.snapshot.draft.text, 'Keep this draft');
    assert.equal(preparedDraft.snapshot.draft.quote.text, 'Keep this quote'); assert.equal(preparedDraft.snapshot.draft.attachments[0].text, 'keep');
    assert.equal(preparedDraft.snapshot.draft.resourceFeedback[0].version.values.$x, 5);
    assert.match(preparedDraft.snapshot.draft.resourceFeedback[0].excerpt, /Trial name: Workspace trial\nDivisor: 5/);
    assert.doesNotMatch(preparedDraft.snapshot.draft.resourceFeedback[0].excerpt, /Condition \d/);
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.inputs())).messages.length, 0, 'preparation cannot submit');
    await page.screenshot({ path: path.join(root, 'workspace-draft-prepared.png'), animations: 'disabled' });
    await page.locator('.resource-interactive-body').evaluate(node => { node.scrollTop = 440; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    await page.waitForFunction(async () => { const { fixture } = await window.peerAgent.getBootstrap(); const { workspaceId, conversationId } = fixture.owner; const reply = await window.peerAgent.resourcePresentation.readLayout({ owner: { workspaceId, conversationId } }); return reply.ok && reply.snapshot?.interactive.tabs[0]?.navigation?.top >= 400; });
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
    await native.getByRole('button', { name: 'Add current conditions to draft', exact: true }).click();
    await native.getByText('Added to the original Bot draft. Review and send from that conversation.', { exact: true }).waitFor();
    const nativeDraft = await electron.evaluate(() => globalThis.workspaceFixture.draft());
    assert.match(nativeDraft.snapshot.draft.resourceFeedback.at(-1).excerpt, /Trial name: Workspace trial\nDivisor: 4/);
    assert.equal(await page.locator('.bot-composer textarea').inputValue(), 'Keep this draft');
    assert.equal(await page.locator('.bot-composer textarea').evaluate(node => document.activeElement === node), false, 'native preparation does not steal Composer focus');
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.inputs())).messages.length, 0);
    await native.screenshot({ path: path.join(root, 'native-draft-prepared.png'), animations: 'disabled' });
    await native.getByRole('button', { name: 'Return to source conversation', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.interactive-field input')?.disabled === true);
    assert.equal(await page.locator('.bot-composer textarea').inputValue(), 'Keep this draft');
    await page.locator('.bot-composer button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.bot-composer textarea')?.value === '');
    await electron.evaluate(() => globalThis.workspaceFixture.consume());
    const sent = await electron.evaluate(() => globalThis.workspaceFixture.inputs());
    assert.equal(sent.messages.length, 1); assert.equal(sent.messages[0].content, 'Keep this draft');
    assert.deepEqual(sent.messages[0].quoteRefs, ['quoted-message']); assert.equal(sent.messages[0].attachments[0].text, 'keep');
    assert.equal(sent.messages[0].resourceFeedback, undefined);
    assert.deepEqual(sent.messages[0].selected.map(row => row.version.values.$x), [5, 4]);
    await page.locator('.bot-composer textarea').fill('Keep this draft');
    await page.getByRole('button', { name: 'Continue calculation here', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('label')).some(label => label.textContent === 'Divisor' && label.control?.value === '4'));
    for (const [kind, local, remote] of [['committed', '6', '7'], ['uncommitted', '8', '9']]) {
      await electron.evaluate((_electron, kind) => globalThis.workspaceFixture.failSave(kind), kind);
      await page.getByLabel('Divisor', { exact: true }).fill(local);
      await page.getByText('Saving is unconfirmed. Your input is preserved. Retry saving.', { exact: true }).waitFor();
      await native.evaluate(() => window.dispatchEvent(new Event('focus')));
      await native.getByRole('button', { name: 'Continue calculation here', exact: true }).click();
      await native.getByLabel('Divisor', { exact: true }).fill(remote);
      await native.getByText('Conditions saved', { exact: true }).waitFor();
      assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.snapshot())).values.$x, Number(remote));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('button', { name: 'Continue calculation here', exact: true }).click();
      assert.equal(await page.getByLabel('Divisor', { exact: true }).inputValue(), local);
      await page.getByText('Conditions saved', { exact: true }).waitFor();
      assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.snapshot())).values.$x, Number(local));
      await page.screenshot({ path: path.join(root, `workspace-save-${kind}-recovered.png`), animations: 'disabled' });
    }
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
      await reloadSavedWorkspace(electron, page); await page.getByText('Deliveries', { exact: true }).click();
      await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
      await page.getByText('The calculation view could not load. Your input and fixed result are preserved. Save drafts before reopening.', { exact: true }).waitFor();
      await page.getByText('Saved model summary, unverified', { exact: true }).waitFor();
      await page.locator('.bot-composer textarea').fill('Keep exact draft after fallback');
      await page.screenshot({ path: path.join(root, 'workspace-chunk-unavailable.png'), animations: 'disabled' });
      renameSync(missing, chunk);
      const beforeRecovery = await electron.evaluate(() => globalThis.workspaceFixture.facts());
      const recoveredWindow = electron.waitForEvent('window');
      await page.getByRole('button', { name: 'Save drafts and open separate view', exact: true }).click();
      const recovered = await recoveredWindow; await recovered.getByLabel('Divisor', { exact: true }).waitFor();
      assert.equal(await recovered.getByLabel('Divisor', { exact: true }).inputValue(), '3');
      assert.equal(await recovered.getByLabel('Trial name', { exact: true }).inputValue(), '中断输入');
      assert.equal(await page.locator('.bot-composer textarea').inputValue(), 'Keep exact draft after fallback');
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
