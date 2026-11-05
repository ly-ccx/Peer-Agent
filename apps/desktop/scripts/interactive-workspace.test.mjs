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
      import{CardView}from'./renderer/src/project-agent/conversation/CardView.tsx';
      import{ReplyBubble}from'./renderer/src/project-agent/conversation/ReplyBubble.tsx';
      import{normalizeBotMessage}from'./renderer/src/project-agent/state/botConversationState.ts';
      import{indexBotWork}from'./renderer/src/project-agent/state/botWorkState.ts';
      import{useInputRecovery}from'./renderer/src/project-agent/state/useInputRecovery.ts';
      import{useResourceFeedbackPreparations}from'./renderer/src/workbench/feedback/useResourceFeedbackPreparations.ts';
      import{createI18n}from'@peer-agent/i18n';
      import'./renderer/src/styles.css';
      import'./renderer/src/project-agent/styles/bot-conversation.css';
      import'./renderer/src/project-agent/styles/bot-drawer.css';
      function Composer({owner}){useResourceFeedbackPreparations();const{session,state}=useInputRecovery(owner.workspaceId);return <BotComposer i18n={createI18n('en-US')} botName="Trial Bot" resourceRecipientConversationId={owner.conversationId} draft={state.draft} ready={state.ready} quote={state.draft.quote?.text??''} onQuoteRemove={()=>session.edit({quote:null})} onDraftChange={patch=>session.edit(patch)} onSend={()=>void session.send({quoteRefs:state.draft.quote?[state.draft.quote.messageId]:[]})}/>;}
      function BoundaryCases({fixture}) {
        const i18n = createI18n('en-US');
        const message = normalizeBotMessage(fixture.textReply);
        return <><ReplyBubble workspaceId={fixture.owner.workspaceId} message={message} referenceIds={[]} anchors={new Map()} highlighted={false} i18n={i18n}
          onJump={()=>{}} onQuote={()=>{}} workIndex={indexBotWork([],true)} onOpenWork={()=>{}}/>
          <CardView workspaceId={fixture.owner.workspaceId} cards={fixture.governanceCards} i18n={i18n}/></>;
      }
      if(window.peerResource)createRoot(document.getElementById('root')).render(<ConfirmProvider><NativeResourceWindow/></ConfirmProvider>);
      else{const{fixture}=await window.peerAgent.getBootstrap();
        createRoot(document.getElementById('root')).render(<ConfirmProvider><ResourceEditAppFrame><WorkbenchProvider conversationId={fixture.owner.conversationId} isPageActive resourceMode layoutHost="bot">
          <BotResourceLayout owner={fixture.owner} active isZh={false}><div className="bot-main" style={{padding:24}}><h1>Trial delivery</h1><Composer owner={fixture.owner}/><EvidenceView evidence={{evidenceRef:fixture.evidenceRef}} workspaceId={fixture.owner.workspaceId} i18n={createI18n('en-US')}/><BoundaryCases fixture={fixture}/></div></BotResourceLayout>
        </WorkbenchProvider></ResourceEditAppFrame></ConfirmProvider>);}
    `, 'interactive-workspace-fixture.tsx', { loader: 'tsx', jsx: 'automatic' }); } }], build: { outDir: output, emptyOutDir: true, target: 'esnext', cssCodeSplit: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'fixture.js' } } } });
  const css = readdirSync(path.join(output, 'assets')).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="./assets/${name}">`).join('');
  writeFileSync(path.join(output, 'index.html'), `<!doctype html><html data-theme="light"><meta charset="utf-8">${css}<style>html,body,#root{height:100%;margin:0}.bot-resource-layout{height:100%}.bot-main{height:100%;overflow:auto;box-sizing:border-box}</style><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
}

async function reloadSavedWorkspace(electron, page) {
  const saved = page.getByText('You can close or reload again.', { exact: true });
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
    import{createInteractiveResultStore,createInteractiveStateStore,createInteractiveFeedbackAdmission,createInteractivePublicationSource,createInteractiveRetention,INTERACTIVE_RETENTION_SOURCES}from${JSON.stringify(href('packages/runtime-node/dist/interactive-results-public.js'))};
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
    const program='$x=2\\n$name="Workspace trial"\\nroot=Col([Title($name),Input("name","Trial name",$name),NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x),'
      +'Button("Allow once",@Set($x,3)),Button("Use existing observations",@Set($x,4)),Button("Confirm result",@Set($x,5)),'
      +Array.from({length:32},(_,i)=>'Text("Saved model observation '+i+'. Fixed content preserves the reading position while changing local conditions.")').join(',')+'])';
    const draft={publication:{kind:'create'},title:'Workspace trial',textFallback:'Unverified saved model trial.',program,inputs:[]};
    const receipt=resultStore.commitPublication({owner,source:{conversationId:'worker',sessionId:'session',planId:'plan',executionEpoch:'epoch',toolCallId:'publication'},draft,content:await validateDraft(draft),provenance:[],dataLevel:'D3_private',grant:{toolCallId:'publication',grantId:'fixture-grant',granted:true}},()=>true);resultStore.markIndexed(receipt.callRef,receipt.indexEntry);
    const windows=createTrustedWindowRegistry(),source=new BrowserWindow({show:process.platform==='linux',width:1180,height:820,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(path.join(desktop, 'electron/preload/preload.cjs'))}}});
    source.show=()=>{};windows.registerWindow({window:source,role:'main',allowedLocations:[${JSON.stringify(location)}]});
    let host,activeOwner=owner,settingsWrites=[],fileReads=0,legacyHistoryWrites=0,blockedCloses=0,closeAttempts=0,navigations=0;
    source.on('will-prevent-unload',()=>{blockedCloses++});
    source.webContents.on('did-start-navigation',(_event,_url,_sameDocument,mainFrame)=>{if(mainFrame)navigations++});
    const initial={locale:'en-US',workbench:{activeTab:{[owner.conversationId]:'launcher'},documentSessions:{},browserSessions:{}}};
    const preparation=createResourceFeedbackPreparation({isMainSender:sender=>windows.getRole(sender)==='main',getRecipient:()=>owner});
    const interactive=createDesktopInteractiveApplication({getRole:sender=>windows.getRole(sender),getOwner:workspaceId=>workspaceId===owner.workspaceId?activeOwner:null,getNativeBinding:sender=>host.interactiveBinding(sender),getRuntime:()=>runtime,prepareFeedback:preparation.prepare,readDraft:drafts.read,openWindow:(sender,reference)=>host.open(sender,{resource:{kind:"interactive",reference}})});
    const originalReadLayout=interactive.readLayout;let holdLayoutRead=false,releaseLayoutRead=null;
    interactive.readLayout=(sender,request)=>{
      const receipt=originalReadLayout(sender,request);
      if(sender!==source.webContents||!holdLayoutRead)return receipt;
      holdLayoutRead=false;
      return new Promise(resolve=>{releaseLayoutRead=()=>{releaseLayoutRead=null;resolve(receipt);};});
    };
    const originalWriteLayout=interactive.writeLayout;let rejectLayoutWrite=false;
    interactive.writeLayout=(sender,request)=>rejectLayoutWrite&&sender===source.webContents
      ?{ok:false,code:'fixture_layout_unconfirmed'}:originalWriteLayout(sender,request);
    const originalSave=interactive.save;let saveFault=null, faultRole='main', withholdOwnerOutcome=false;
    interactive.save=(sender,request)=>{
      if(windows.getRole(sender)===faultRole&&saveFault){
        const fault=saveFault;saveFault=null;
        if(fault==='uncommitted')return{ok:false,code:'fixture_save_unconfirmed'};
        const reply=originalSave(sender,request);return reply.ok?{ok:false,code:'fixture_save_unconfirmed'}:reply;
      }
      const reply=originalSave(sender,request);
      return withholdOwnerOutcome&&reply.code==='interactive_owner_replaced'?{ok:false,code:reply.code}:reply;
    };
    const nativeWindows=[];
    function FixtureWindow(options) {
      // An unmapped X11 window does not reliably produce screenshot frames.
      const win=new BrowserWindow({...options,webPreferences:{...options.webPreferences,backgroundThrottling:false}});
      if (process.platform !== 'linux') win.show=()=>{};
      nativeWindows.push(win);return win;
    }
    FixtureWindow.fromWebContents=contents=>BrowserWindow.fromWebContents(contents);
    host=createResourceWindowController({BrowserWindow:FixtureWindow,trustedWindows:windows,rendererLocation:${JSON.stringify(location)},preloadPath:${JSON.stringify(path.join(desktop, 'electron/preload/resource-window.cjs'))},interactiveResources:interactive,getOwner:()=>activeOwner,getLocale:()=> 'en',readHistory:()=>undefined,writeHistory:()=>{legacyHistoryWrites++},resolveDocument:()=>{throw Error('unexpected file lookup')},fileAccess:{readFile:()=>{fileReads++;throw Error('unexpected file read')}}});
    const ipc=createCatalogIpcMain({ipcMain,authorize:windows.authorize});registerIpcOwners({ipc,registrations:[...createResourceWindowIpcRegistrations({resourceWindows:host}),...createInteractiveResultsIpcRegistrations({interactiveResults:interactive}),...createResourceFeedbackIpcRegistrations({preparation})]});
    const governanceCalls=[];
    ipc.handle('project-agent:decide-approval',()=>{governanceCalls.push('approval');return {ok:false,code:'FIXTURE_APPROVAL'};});
    ipc.handle('project-agent:confirm-result',()=>{governanceCalls.push('confirm');return {ok:false,code:'FIXTURE_CONFIRM'};});
    ipc.handle('project-agent:read-input-draft',(_event,request)=>drafts.read(request));ipc.handle('project-agent:write-input-draft',(_event,request)=>drafts.write(request));ipc.handle('project-agent:submit-input',(_event,request)=>{governanceCalls.push('input');return {ok:true,input:queue.submitInput(request)};});
    ipc.on('settings:get-sync',event=>{event.returnValue=initial});ipc.handle('settings:get',()=>initial);ipc.handle('settings:update',(_event,partial)=>{settingsWrites.push(partial);return initial});
    const evidenceFacts={getConversationId:()=>owner.conversationId,getPlan:()=>({planId:'plan',conversationId:'worker',tasks:[{taskId:'generated',status:'completed',result:'Saved unverified model trial.',evidenceRefs:['tool-result://publication']},{taskId:'remaining',status:'pending'}],delegationOrigin:{workspaceId:owner.workspaceId,parentConversationId:owner.conversationId,sessionId:'session'}}),getSession:()=>({sessionId:'session',workspaceId:owner.workspaceId,planId:'plan',status:'failed',report:{planId:'plan'}})};
    const evidenceEntries=[receipt.indexEntry],findRecords=refs=>evidenceEntries.filter(row=>refs.includes(row.evidenceRef));
    const publications=createInteractivePublicationSource({resultStore,goalPlanStore:{getPlan:evidenceFacts.getPlan,findEvidenceIndexRecords:findRecords},getBotConversationId:evidenceFacts.getConversationId,getSession:evidenceFacts.getSession});
    conversations.appendMessage(owner.conversationId,{id:'fixture-result-anchor',role:'user',kind:'user_input',content:'Show the saved trial and current task status'});
    const replyComposer=createDesktopReplyComposer({readResultReferences:publications.replyReferences,readDelivery:()=>({sessionIds:['session'],sessionStates:[{sessionId:'session',status:'failed'}],verdicts:[]})});
    const composed=replyComposer.postReply({text:'The saved trial is available; remaining analysis is incomplete and unverified.',replyTo:['fixture-result-anchor'],sources:['session'],statusClaims:[{sessionId:'session',status:'failed'}]},{...owner,turnId:'fixture-reply',toolCallOrdinal:1,messages:conversations.getPersistedConversationHistory(owner.conversationId).messages});
    if(composed.error||composed.message?.meta.evidenceRefs?.[0]!==receipt.indexEntry.evidenceRef)throw Error('The actual reply composer did not confirm the fixed publication reference: '+(composed.error??'missing fixed reference'));
    conversations.appendMessage(owner.conversationId,composed.message);
    conversations.appendMessage(owner.conversationId,{id:'fixture-text-anchor',role:'user',kind:'user_input',content:'Show a program as text only'});
    const fence=String.fromCharCode(96).repeat(3);
    const uncitedProgram='root=Col([Title("Uncited trial"),Metric("Uncited metric",7)])';
    const textOnly=replyComposer.postReply({text:'Uncited program:\\n\\n'+uncitedProgram+'\\n\\n'+fence+'openui\\n'+uncitedProgram+'\\n'+fence+'\\n\\n'+receipt.indexEntry.evidenceRef,replyTo:['fixture-text-anchor'],sources:[]},
      {...owner,turnId:'fixture-text',toolCallOrdinal:1,messages:conversations.getPersistedConversationHistory(owner.conversationId).messages});
    if(!textOnly.message||textOnly.meta.evidenceRefs?.length)throw Error('Ordinary reply acquired publication evidence');
    conversations.appendMessage(owner.conversationId,textOnly.message);
    const governanceCards=[
      {cardId:'fixture-approval',kind:'approval',content:'Host permission request',actions:[{id:'allow',channel:'project-agent:decide-approval',payload:{approvalId:'fixture-approval',decision:'approve',duration:'once'}}]},
      {cardId:'fixture-question',kind:'question',content:'Host question about the observation range',actions:[{id:'answer',channel:'project-agent:submit-input',payload:{answerTo:'fixture-question',text:'Use existing observations'}}]},
      {cardId:'fixture-acceptance',kind:'completion',content:'Host result awaiting confirmation',actions:[{id:'confirm',channel:'project-agent:confirm-result',payload:{sessionId:'session'}}]},
    ];
    ipc.handle('bootstrap:get',()=>{const rows=conversations.getPersistedConversationHistory(owner.conversationId).messages;return {fixture:{
      owner:{...owner,path:'/isolated-project'},evidenceRef:rows.find(row=>row.id===composed.message.id).meta.evidenceRefs[0],
      textReply:rows.find(row=>row.id===textOnly.message.id),governanceCards}};});
    const readEvidence=createEvidenceReader({resolveScopedRecord:publications.resolveEvidence,findRecords,projectDeliveries:createEvidenceDeliveryProjection(evidenceFacts),readMessages:()=>[],readArtifact:()=>{throw Error('unexpected artifact body read')}});
    const projectApplication=createProjectAgentApplicationService({enabled:()=>true,readEvidenceBody:readEvidence});
    ipc.handle('project-agent:read-evidence',(_event,request)=>projectApplication.readEvidence(request));
    ipc.handle('resource-edit:list',()=>({ok:true,drafts:[],operations:[],staleCount:0}));
    globalThis.workspaceFixture={snapshot:(reference=receipt.reference)=>stateStore.read(reference,()=>true),
      holdLayoutRead(){holdLayoutRead=true;},
      releaseLayoutRead(){if(!releaseLayoutRead)throw Error('no held layout read');releaseLayoutRead();},
      publishNext:async()=>{const nextDraft={...draft,publication:{kind:"revise",base:receipt.reference},title:"Workspace trial updated",program:program.replace("$x=2","$x=9")};const next=resultStore.commitPublication({owner,source:{conversationId:"worker",sessionId:"session",planId:"plan",executionEpoch:"epoch",toolCallId:"publication-revision"},draft:nextDraft,content:await validateDraft(nextDraft),provenance:[],dataLevel:"D3_private",grant:{toolCallId:"publication-revision",grantId:"fixture-revision-grant",granted:true}},()=>true);evidenceEntries.push(next.indexEntry);resultStore.markIndexed(next.callRef,next.indexEntry);return next.reference;},layout:()=>interactive.readLayout(source.webContents,{owner}),
      async createRetired(){const candidate={...draft,title:'Retired trial',textFallback:'Fixed historical summary.\\n'+Array.from({length:76},(_,i)=>String(i+1)).join('\\n')};
        const source={conversationId:'worker',sessionId:'session',planId:'plan',executionEpoch:'epoch',toolCallId:'publication-retired'};
        const saved=resultStore.commitPublication({owner,source,draft:candidate,content:await validateDraft(candidate),provenance:[],dataLevel:'D3_private',grant:{toolCallId:source.toolCallId,grantId:'retired-grant',granted:true}},()=>true);
        evidenceEntries.push(saved.indexEntry);resultStore.markIndexed(saved.callRef,saved.indexEntry);
        const retire=createInteractiveRetention({resultStore,stateStore,assertOwner:()=>true,acquireRoots:()=>({sources:Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source=>[source,'sha256:'+'0'.repeat(64)])),pins:[],followupIds:[],assertCurrent:()=>true,release(){}})});
        const preview=retire.preview(saved.reference);retire.cleanup({reference:saved.reference,requestId:'retire-fixture',expectedDigest:preview.cleanupDigest});return saved.reference;},
      failSave:(kind,role='main')=>{if(!['committed','uncommitted'].includes(kind))throw Error('invalid fault');saveFault=kind;faultRole=role},
      replaceOwner(){activeOwner={...owner,conversationId:'replacement-conversation'};withholdOwnerOutcome=true},
      restoreOwner(){activeOwner=owner;withholdOwnerOutcome=false},
      rejectLayoutWrites(){rejectLayoutWrite=true},
      allowOutcome(){withholdOwnerOutcome=false},
      replacementLayout:()=>interactive.readLayout(source.webContents,{owner:activeOwner}),
      draft:()=>drafts.read(draftAddress),consume:()=>queue.consume(owner.workspaceId),inputs:()=>({queue:queue.diagnosticSnapshot(owner.workspaceId),messages:conversations.getPersistedConversationHistory(owner.conversationId).messages.filter(row=>row.kind==='user_input'&&!['fixture-result-anchor','fixture-text-anchor'].includes(row.id)).map(row=>({...row,selected:feedback.restore(row,owner.workspaceId)}))}),
      boundaryFacts:()=>({governanceCalls,queue:queue.diagnosticSnapshot(owner.workspaceId),pending:resultStore.listPending(owner).length,
        versions:resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,evidenceEntries:evidenceEntries.length}),
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
  let page, recoveredView;
  try {
    page = await electron.firstWindow(); await page.getByText('Trial delivery', { exact: true }).waitFor();
    const uncitedReply = page.locator('article[data-kind="agent_reply"]');
    const literalProgram = 'root=Col([Title("Uncited trial"),Metric("Uncited metric",7)])';
    await uncitedReply.locator('pre code').getByText(literalProgram, { exact: true }).waitFor();
    assert.ok((await uncitedReply.locator('.bot-reply-text p').allTextContents()).includes(literalProgram));
    assert.equal(await uncitedReply.getByRole('heading', { name: 'Uncited trial' }).count(), 0);
    assert.equal(await uncitedReply.getByRole('link').count(), 0, 'a pasted result URI is not a scoped result entry');
    assert.equal(await page.locator('.interactive-surface').count(), 0);
    const beforeBoundary = await electron.evaluate(() => globalThis.workspaceFixture.boundaryFacts());
    assert.deepEqual(beforeBoundary.governanceCalls, []);
    assert.equal(beforeBoundary.pending, 0);
    assert.equal(beforeBoundary.versions, 1);
    assert.equal(beforeBoundary.evidenceEntries, 1);
    await page.getByText('Deliveries', { exact: true }).click();
    await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    const trial = page.getByRole('region', { name: 'Workspace trial', exact: true });
    const trialDescription = 'Model-generated trial using fixed material. The generated controls below only change local trial conditions.';
    const description = trial.getByText(trialDescription, { exact: true });
    await description.waitFor();
    assert.equal(await trial.getAttribute('aria-describedby'), await description.getAttribute('id'));
    assert.ok((await description.boundingBox()).y < (await trial.getByRole('button', { name: 'Allow once', exact: true }).boundingBox()).y);
    const simulatedActions = [['fixture-approval', 'Allow once'], ['fixture-question', 'Use existing observations'], ['fixture-acceptance', 'Confirm result']];
    for (const [index, [cardId, label]] of simulatedActions.entries()) {
      const nativeButton = page.locator('[data-card-id="' + cardId + '"]').getByRole('button', { name: label, exact: true });
      assert.equal(await nativeButton.isEnabled(), true);
      await trial.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await trial.getByLabel('Divisor', { exact: true }).inputValue(), String(index + 3));
      assert.equal(await nativeButton.isEnabled(), true);
    }
    await trial.getByText('Conditions saved', { exact: true }).waitFor();
    assert.deepEqual(await electron.evaluate(() => globalThis.workspaceFixture.boundaryFacts()), beforeBoundary);
    await trial.screenshot({ path: path.join(root, 'workspace-generated-governance-lookalikes.png'), animations: 'disabled' });
    await trial.getByRole('button', { name: 'Reset conditions', exact: true }).click();
    await trial.getByText('Conditions saved', { exact: true }).waitFor();
    const beforeProtected = await electron.evaluate(() => globalThis.workspaceFixture.snapshot());
    const protectedName = page.getByLabel('Trial name', { exact: true });
    await protectedName.fill('sk-examplecredential012345678901234567890');
    await page.getByRole('button', { name: 'Save conditions', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Credentials or native permission payloads cannot be saved as trial conditions.' }).waitFor();
    assert.equal(await protectedName.inputValue(), 'sk-examplecredential012345678901234567890');
    assert.deepEqual(await electron.evaluate(() => globalThis.workspaceFixture.snapshot()), beforeProtected);
    await page.screenshot({ path: path.join(root, 'workspace-protected-input.png'), animations: 'disabled' });
    await protectedName.fill('Workspace trial');
    await page.getByText('Conditions saved', { exact: true }).waitFor();
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
    const position = page.locator('.resource-interactive-body');
    const retryLoading = page.getByRole('button', { name: 'Retry loading layout', exact: true });
    const reopenAfterTimeout = async () => {
      await electron.evaluate(() => globalThis.workspaceFixture.holdLayoutRead());
      await reloadSavedWorkspace(electron, page);
      await page.getByText('Deliveries', { exact: true }).click();
      await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
      await retryLoading.waitFor({ timeout: 10000 });
      await page.getByLabel('Divisor', { exact: true }).waitFor();
      assert.equal(await position.evaluate(node => node.scrollTop), 0);
    };
    await reopenAfterTimeout();
    const content = await position.elementHandle();
    await retryLoading.click();
    await page.waitForFunction(() => document.querySelector('.resource-interactive-body').scrollTop >= 400);
    await electron.evaluate(() => globalThis.workspaceFixture.releaseLayoutRead());
    assert.equal(await position.evaluate((node, original) => node === original, content), true, 'layout recovery restores reading without remounting the result');
    await content.dispose();

    await reopenAfterTimeout();
    const localReading = await position.evaluate(node => {
      node.scrollTop = 650;
      node.dispatchEvent(new Event('scroll'));
      return node.scrollTop;
    });
    assert.ok(localReading >= 600);
    await retryLoading.click();
    await page.waitForFunction(async top => {
      const { fixture } = await window.peerAgent.getBootstrap();
      const { workspaceId, conversationId } = fixture.owner;
      const reply = await window.peerAgent.resourcePresentation.readLayout({ owner: { workspaceId, conversationId } });
      return reply.ok && reply.snapshot?.interactive.tabs[0]?.navigation?.top === top;
    }, localReading);
    await electron.evaluate(() => globalThis.workspaceFixture.releaseLayoutRead());
    assert.equal(await position.evaluate(node => node.scrollTop), localReading, 'late layout receipts cannot overwrite active reading');
    await page.screenshot({ path: path.join(root, 'workspace-layout-reading-recovered.png'), animations: 'disabled' });
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
      const recovered = await recoveredWindow; recoveredView = recovered; await recovered.getByLabel('Divisor', { exact: true }).waitFor();
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
    await reloadSavedWorkspace(electron, page);
    await page.getByText('Deliveries', { exact: true }).click();
    await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    const next = await electron.evaluate(() => globalThis.workspaceFixture.publishNext());
    const continueHere = page.getByRole('button', { name: 'Continue calculation here', exact: true });
    if (await continueHere.isVisible()) await continueHere.click();
    await page.getByLabel('Divisor', { exact: true }).fill('-');
    await page.getByRole('button', { name: 'Check versions', exact: true }).click();
    await page.getByRole('button', { name: 'Open newer version', exact: true }).click();
    await page.getByRole('tab', { name: 'Workspace trial updated', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Workspace trial updated', exact: true }).evaluate(node => node === document.activeElement), true, 'explicit navigation keeps focus on the selected resource tab');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('label')).some(label => label.textContent === 'Divisor' && label.control?.value === '9'));
    assert.equal((await electron.evaluate((_electron, reference) => globalThis.workspaceFixture.snapshot(reference), next)).values.$x, 9);
    const shownSurface = page.locator('.resource-interactive-view[data-active="true"] .interactive-surface');
    const hiddenView = page.locator('.resource-interactive-view[data-active="false"]');
    assert.equal(await shownSurface.count(), 1);
    assert.equal(await hiddenView.count(), 1);
    assert.equal(await hiddenView.locator('.interactive-surface').count(), 0, 'the hidden fixed result keeps its tab without mounting the SDK');
    await page.screenshot({ path: path.join(root, 'workspace-new-version.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: 'Workspace trial', exact: true }).click();
    assert.equal(await page.getByLabel('Divisor', { exact: true }).inputValue(), '-', 'opening a version cannot overwrite the old raw draft');
    assert.equal(await shownSurface.count(), 1);
    assert.equal(await hiddenView.locator('.interactive-surface').count(), 0, 'switching unmounts the previously visible SDK tree');
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.snapshot())).values.$x, 3);
    await recoveredView.getByRole('button', { name: 'Check versions', exact: true }).click();
    const newerWindow = electron.waitForEvent('window');
    await recoveredView.getByRole('button', { name: 'Open newer version', exact: true }).click();
    const revised = await newerWindow; await revised.getByLabel('Divisor', { exact: true }).waitFor();
    assert.equal(await revised.getByLabel('Divisor', { exact: true }).inputValue(), '9');
    assert.equal(recoveredView.isClosed(), false);
    await revised.getByRole('button', { name: 'Check versions', exact: true }).click();
    await revised.getByRole('button', { name: 'Open previous version', exact: true }).waitFor();
    await revised.screenshot({ path: path.join(root, 'native-new-version.png'), animations: 'disabled' });
    const oldConfirmed = await electron.evaluate(() => globalThis.workspaceFixture.snapshot());
    const previousWindow = electron.waitForEvent('window');
    await revised.getByRole('button', { name: 'Open previous version', exact: true }).click();
    const previous = await previousWindow; await previous.getByLabel('Divisor', { exact: true }).waitFor();
    assert.equal(await previous.getByLabel('Divisor', { exact: true }).inputValue(), oldConfirmed.inputDrafts.$x ?? String(oldConfirmed.values.$x));
    assert.equal(await page.getByLabel('Divisor', { exact: true }).inputValue(), '-');
    assert.equal(revised.isClosed(), false);
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.facts())).versions, 2);
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.facts())).operations, 2);
    const cleanedReference = await electron.evaluate(() => globalThis.workspaceFixture.createRetired());
    const cleanedWindow = electron.waitForEvent('window');
    assert.equal((await page.evaluate(reference => window.peerAgent.resourceWindowOpen({ resource: { kind: 'interactive', reference } }), cleanedReference)).ok, true);
    const cleaned = await cleanedWindow;
    await cleaned.getByText(/^Fixed historical summary\./).waitFor();
    assert.equal(await cleaned.getByText(/result content was cleaned/i).count(), 1);
    assert.equal(await cleaned.getByRole('button', { name: 'Retry opening' }).count(), 0);
    assert.equal(await cleaned.getByLabel('Divisor', { exact: true }).count(), 0);
    assert.equal(await cleaned.getByText('View saved program', { exact: true }).count(), 0);
    assert.equal(await cleaned.getByText(/Reading position was not saved/i).count(), 0);
    await cleaned.screenshot({ path: path.join(root, 'native-cleaned-summary.png'), animations: 'disabled' });

    const takeOver = revised.getByRole('button', { name: 'Continue calculation here', exact: true });
    if (await takeOver.isVisible()) await takeOver.click();
    await electron.evaluate(() => globalThis.workspaceFixture.failSave('committed', 'resource'));
    await revised.getByLabel('Divisor', { exact: true }).fill('7');
    await revised.getByRole('button', { name: 'Save conditions', exact: true }).click();
    await revised.getByText('Saving is unconfirmed. Your input is preserved. Retry saving.', { exact: true }).waitFor();
    const compose = (locator, raw) => locator.evaluate((node, value) => {
      node.focus();
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    }, raw);
    await compose(revised.getByLabel('Trial name', { exact: true }), 'Native local recovery');
    await compose(page.getByLabel('Trial name', { exact: true }), 'Main local recovery');
    await electron.evaluate(() => globalThis.workspaceFixture.replaceOwner());
    await revised.getByRole('button', { name: 'Close this window', exact: true }).click();
    const nativeRecovery = revised.getByRole('region', { name: 'Previous view input recovery' });
    await nativeRecovery.getByRole('button', { name: 'Check previous save', exact: true }).waitFor();
    assert.equal(await nativeRecovery.getByRole('button', { name: 'Discard local changes', exact: true }).count(), 0);
    assert.equal(revised.isClosed(), false);
    await nativeRecovery.getByRole('button', { name: 'Check previous save', exact: true }).click();
    assert.equal(await nativeRecovery.getByRole('button', { name: 'Discard local changes', exact: true }).count(), 0);
    await electron.evaluate(() => globalThis.workspaceFixture.allowOutcome());
    await nativeRecovery.getByRole('button', { name: 'Check previous save', exact: true }).click();
    await nativeRecovery.getByRole('button', { name: 'Discard local changes', exact: true }).waitFor();
    assert.equal(await nativeRecovery.getByLabel('Preserved local input', { exact: true }).inputValue(), 'Trial name: Native local recovery');
    assert.equal(await revised.getByLabel('Divisor', { exact: true }).count(), 0);
    await revised.screenshot({ path: path.join(root, 'native-owner-replacement.png'), animations: 'disabled' });
    const discard = async (target, recovery, retainedFields = 1) => {
      await recovery.getByRole('button', { name: 'Discard local changes', exact: true }).click();
      const dialog = target.getByRole('dialog', { name: 'Discard local changes in the previous view?' });
      await dialog.getByRole('button', { name: 'Keep', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await recovery.getByLabel('Preserved local input', { exact: true }).count(), retainedFields);
      await recovery.getByRole('button', { name: 'Discard local changes', exact: true }).click();
      await dialog.getByRole('button', { name: 'Discard local changes', exact: true }).click();
    };
    await discard(revised, nativeRecovery);
    await revised.getByText('Local input in this view was discarded.', { exact: true }).waitFor();
    assert.equal(revised.isClosed(), false, 'confirming discard does not close a window');
    const closedReplacement = revised.waitForEvent('close');
    await revised.getByRole('button', { name: 'Close this window', exact: true }).click();
    await closedReplacement;
    const nativeConfirmed = await electron.evaluate((_electron, reference) => globalThis.workspaceFixture.snapshot(reference), next);
    assert.equal(nativeConfirmed.values.$x, 7);
    assert.equal(nativeConfirmed.values.$name, 'Workspace trial');

    const previousTop = await previous.locator('.resource-interactive-body').evaluate(node => {
      node.scrollTop = 370; node.dispatchEvent(new Event('scroll')); return node.scrollTop;
    });
    assert.ok(previousTop > 0, 'the old view has a real unsaved reading position');
    await previous.getByRole('button', { name: 'Close this window', exact: true }).click();
    const readingRecovery = previous.getByRole('region', { name: 'Previous view input recovery' });
    await readingRecovery.getByRole('button', { name: 'Discard local changes', exact: true }).waitFor();
    await previous.getByRole('button', { name: 'Discard local reading position', exact: true }).waitFor();
    await discard(previous, readingRecovery, 0);
    await previous.getByText('Local input in this view was discarded.', { exact: true }).waitFor();
    const closedReading = previous.waitForEvent('close');
    await previous.getByRole('button', { name: 'Close this window', exact: true }).click();
    await closedReading;

    await electron.evaluate(() => globalThis.workspaceFixture.closeSource());
    const mainRecovery = page.getByRole('region', { name: 'Previous view input recovery' });
    await mainRecovery.getByLabel('Preserved local input', { exact: true }).waitFor();
    assert.ok((await mainRecovery.getByLabel('Preserved local input', { exact: true }).inputValue()).includes('Trial name: Main local recovery'));
    assert.equal(page.isClosed(), false);
    await page.screenshot({ path: path.join(root, 'workspace-owner-replacement.png'), animations: 'disabled' });
    await discard(page, mainRecovery);
    await page.getByText('You can close or reload again.', { exact: true }).waitFor();
    assert.deepEqual(await electron.evaluate(() => globalThis.workspaceFixture.replacementLayout()), { ok: true, snapshot: null });
    assert.equal((await electron.evaluate(() => globalThis.workspaceFixture.snapshot())).values.$name, 'Workspace trial');
    assert.equal(page.isClosed(), false);

    const cleanedTop = await cleaned.locator('.resource-interactive-body').evaluate(node => {
      node.scrollTop = 200; node.dispatchEvent(new Event('scroll')); return node.scrollTop;
    });
    assert.ok(cleanedTop > 0, 'the static tombstone has a real reading position without a condition session');
    await cleaned.getByRole('button', { name: 'Close this window', exact: true }).click();
    const discardReading = cleaned.getByRole('button', { name: 'Discard local reading position', exact: true });
    await discardReading.waitFor();
    assert.equal(await cleaned.getByRole('region', { name: 'Previous view input recovery' }).count(), 0);
    await discardReading.click();
    const readingDialog = cleaned.getByRole('dialog', { name: 'Discard the local reading position?' });
    await readingDialog.getByRole('button', { name: 'Discard reading position', exact: true }).click();
    await discardReading.waitFor({ state: 'detached' });
    assert.equal(cleaned.isClosed(), false);
    assert.equal(await cleaned.getByRole('button', { name: 'Close this window', exact: true }).evaluate(node => document.activeElement === node), true);
    const closedTombstone = cleaned.waitForEvent('close');
    await cleaned.getByRole('button', { name: 'Close this window', exact: true }).click();
    await closedTombstone;

    await electron.evaluate(() => globalThis.workspaceFixture.restoreOwner());
    await reloadSavedWorkspace(electron, page);
    await page.getByText('Deliveries', { exact: true }).click();
    await page.getByRole('button', { name: 'Open interactive result', exact: true }).click();
    await page.getByLabel('Divisor', { exact: true }).waitFor();
    const savedLayout = await electron.evaluate(() => globalThis.workspaceFixture.layout());
    await electron.evaluate(() => globalThis.workspaceFixture.rejectLayoutWrites());
    for (const title of ['Workspace trial updated', 'Workspace trial']) {
      const tab = page.getByRole('tab', { name: title, exact: true });
      if (await tab.count()) await tab.locator('..').getByRole('button', { name: /Close tab/ }).click();
      await tab.waitFor({ state: 'detached' });
    }
    await electron.evaluate(() => { globalThis.workspaceFixture.replaceOwner(); globalThis.workspaceFixture.closeSource(); });
    const discardLayout = page.getByRole('button', { name: 'Discard old layout changes', exact: true });
    await discardLayout.waitFor();
    assert.equal(await page.getByRole('region', { name: 'Previous view input recovery' }).count(), 0);
    assert.equal(page.isClosed(), false);
    await discardLayout.click();
    const layoutDialog = page.getByRole('dialog', { name: 'Discard old layout changes?' });
    await electron.evaluate(() => globalThis.workspaceFixture.restoreOwner());
    await layoutDialog.getByRole('button', { name: 'Discard layout changes', exact: true }).click();
    await layoutDialog.waitFor({ state: 'detached' });
    await page.getByText('Layout changes for the previous Bot cannot be saved.', { exact: false }).waitFor({ state: 'detached' });
    assert.equal(await page.getByText('You can close or reload again.', { exact: true }).count(), 0);
    await electron.evaluate(() => { globalThis.workspaceFixture.replaceOwner(); globalThis.workspaceFixture.closeSource(); });
    await discardLayout.click();
    await page.screenshot({ path: path.join(root, 'workspace-layout-only-recovery.png'), animations: 'disabled' });
    await layoutDialog.getByRole('button', { name: 'Discard layout changes', exact: true }).click();
    await page.getByText('You can close or reload again.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Keep working', exact: true }).evaluate(node => document.activeElement === node), true);
    assert.deepEqual(await electron.evaluate(() => globalThis.workspaceFixture.replacementLayout()), { ok: true, snapshot: null });
    await electron.evaluate(() => globalThis.workspaceFixture.restoreOwner());
    assert.deepEqual(await electron.evaluate(() => globalThis.workspaceFixture.layout()), savedLayout);
    const closedMain = page.waitForEvent('close'); await electron.evaluate(() => globalThis.workspaceFixture.closeSource()); await closedMain;
    assert.deepEqual(external, []);
  } catch (error) {
    if (page && !page.isClosed()) { console.log('Workspace fixture diagnostics:', JSON.stringify({ text: (await page.locator('body').innerText()).slice(0, 2600), errors, root })); await page.screenshot({ path: path.join(root, 'workspace-failed.png'), animations: 'disabled' }); }
    throw error;
  } finally { await electron.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy()}).catch(()=>{}); await electron.close(); }
  console.log(`Interactive workspace screenshots: ${root}`);
});
