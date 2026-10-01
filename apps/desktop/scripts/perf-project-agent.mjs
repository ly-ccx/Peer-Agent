/** RC-01: production stores/application service, synthetic isolated scale. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createProjectRegistry, createBotDirectory, createInputQueue, createProjectInbox, createProjectAgentHost,
  createMemoryStore, createMemoryProvider, createGoalPlanStore } from '@peer-agent/runtime-node';
import { createProjectAgentApplicationService } from '../electron/main/project-agent/project-agent-application-service.mjs';
import { createClassicGoalProjection } from '../electron/main/project-agent/classic-goal-projection.mjs';
import { seedBotShellHome, RC_SCALE } from './seed-bot-shell-home.mjs';

export const PERF_BUDGETS = Object.freeze({ list: 100, search: 150, received: 300, consume: 200, memory: 50, coldInbox: 1000, idleBytesPerBot: 2 * 1024 * 1024, realModel: 6000 });
export function median(samples) {
  assert.equal(samples.length, 5, 'five samples required');
  assert.ok(samples.every(x => Number.isFinite(x) && x >= 0), 'finite nonnegative samples required');
  return [...samples].sort((a,b) => a-b)[2];
}
export function metric(name, samples, budget = PERF_BUDGETS[name]) {
  const p50 = median(samples);
  return { samples, median: p50, budget, pass: p50 < budget };
}

function readers(home, fixture) {
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const registry = createProjectRegistry({ filePath: path.join(home, 'projects/registry.json') });
  const memories = createMemoryStore({ rootDir: home });
  const readMessages = id => conversations.getPersistedConversationHistory(id)?.messages || [];
  const classicGoals = createClassicGoalProjection({ registry, conversationStore: conversations,
    goalPlanStore: createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') }) });
  const directory = createBotDirectory({ rootDir: home, registry, readMessages,
    readMessagesBatch: ids => new Map([...conversations.getPersistedConversationHistories(ids)].map(([id, history]) => [id, history?.messages || []])),
    listClassicGoals: classicGoals.one, readClassicGoalsBatch: classicGoals.batch });
  return { conversations, registry, memories, readMessages, directory };
}

async function idleChild(home) {
  assert.equal(typeof global.gc, 'function', '--expose-gc required');
  const fixture = JSON.parse(readFileSync(path.join(home, 'rc-fixture.json')));
  const r = readers(home, fixture);
  let modelCalls = 0;
  global.gc(); const before = process.memoryUsage();
  const ids = fixture.bots.map(b => b.workspaceId), byId = new Map(fixture.bots.map(b => [b.workspaceId, b.conversationId]));
  const host = createProjectAgentHost({ rootDir: path.join(home, 'project-runtime'), listWorkspaceIds: () => ids, holdsLease: () => true,
    resolveConversationId: id => byId.get(id), hasMessage: (id, messageId) => r.readMessages(id).some(m => m.id === messageId),
    appendMessage: (id,m) => r.conversations.appendMessage(id,m), readMessages: r.readMessages,
    readSettings: () => ({ projectAgent: { shell: 'bots', digest: false } }),
    executeTurn: async () => { modelCalls++; throw Error('Idle bots must not open a model stream'); } });
  const start = performance.now();
  try {
    const initialized = await host.sync(ids);
    assert.equal(initialized.workspaces.length, ids.length);
    assert.equal(modelCalls, 0);
    global.gc(); const after = process.memoryUsage();
    return { coldInbox: performance.now() - start, heapBytesPerBot: Math.max(0, after.heapUsed-before.heapUsed)/ids.length,
      rssBytesPerBot: Math.max(0, after.rss-before.rss)/ids.length, modelCalls, bots: ids.length, events: fixture.scale.inboxEvents };
  } finally { host.dispose(); }
}

export async function runProjectAgentPerf({ output, localOnly = false, realModelReport = null } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-rc01-perf-'));
  let provider;
  const samples = { list: [], search: [], received: [], consume: [], memory: [], coldInbox: [], idleBytesPerBot: [] };
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), fixture: true, scale: RC_SCALE,
    sourceHead: execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8'}).trim(),
    sourceDirty: Boolean(execFileSync('git',['status','--porcelain'],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8'}).trim()),
    platform: process.platform, arch: process.arch, node: process.versions.node, metrics: {}, idle: [], scope: {
      list: 'Production directory and application service projection of all 200 bots; fresh reader each sample',
      search: 'Production service includes full message/memory corpus; first rebuild separately recorded',
      received: 'Application receipt includes queue durability and synchronous fixture wake/consume; UI rendering measured by Electron smoke',
      consume: 'Online lease-owning production queue to canonical conversation and onCommitted wake; no model latency',
      memory: 'Warm production capability search, scope filtering, use accounting and Evidence envelope; rebuild separately recorded',
      coldInbox: 'Fresh independent process: real host recovery and idle sync of 200 bots after 100000 persisted/consumed events',
      idle: 'Five fresh processes, aggregate incremental RSS per initialized bot; heap and zero model calls also reported' } };
  const time = async fn => { const start = performance.now(); const value = await fn(); return { value, elapsed: performance.now()-start }; };
  try {
    const fixture = seedBotShellHome({ home });
    const r = readers(home, fixture), first = fixture.bots[0];
    assert.equal(r.directory.list().length, RC_SCALE.bots);
    assert.equal(fixture.bots.reduce((n,b) => n+r.readMessages(b.conversationId).length,0), RC_SCALE.messages);
    assert.equal(r.memories.list({workspaceId:first.workspaceId}).length, RC_SCALE.memories);
    const unconsumed = createProjectInbox({rootDir:path.join(home,'project-runtime')});
    assert.equal(unconsumed.cursor(first.workspaceId).seq, RC_SCALE.inboxEvents);
    // Count from a fresh reader with cursor zero without changing true data.
    const eventLines = readFileSync(path.join(home,'project-runtime',first.workspaceId,'inbox.jsonl'),'utf8').trim().split('\n');
    assert.equal(eventLines.length, RC_SCALE.inboxEvents);
    assert.equal(JSON.parse(eventLines.at(-1)).seq, RC_SCALE.inboxEvents);
    for (let i=0;i<5;i++) {
      const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--idle-child', home], {encoding:'utf8',timeout:60000});
      assert.equal(child.status,0,child.stderr);
      const fact=JSON.parse(child.stdout.trim().split('\n').at(-1)); report.idle.push(fact);
      samples.coldInbox.push(fact.coldInbox); samples.idleBytesPerBot.push(fact.rssBytesPerBot);
    }
    const queue = createInputQueue({ rootDir:path.join(home,'project-runtime'), holdsLease:()=>true,
      resolveConversationId:()=>first.conversationId, hasMessage:(id,m)=>r.readMessages(id).some(row=>row.id===m),
      appendMessage:(id,m)=>r.conversations.appendMessage(id,m) });
    const corpus = catalog => ({ bots:catalog ?? r.directory.list(), messages:fixture.bots.flatMap(b=>r.readMessages(b.conversationId).map(message=>({workspaceId:b.workspaceId,message}))),
      memories:r.memories.list({status:'active'}) });
    const app = createProjectAgentApplicationService({enabled:()=>true,directory:r.directory,inputQueue:queue,wake:id=>queue.consume(id),
      readSearchCorpus:corpus,corpusStamp:()=>JSON.stringify(r.conversations.listConversations().map(c=>[c.id,c.contentRevision]))+'|'+r.memories.getVersion()});
    const rebuild = await time(()=>app.search({query:'unique-needle'}));
    assert.ok(rebuild.value.hits.some(h=>h.messageId==='rc-message-123')); report.searchInitialRebuildMs=rebuild.elapsed;
    provider=createMemoryProvider({rootDir:home,store:r.memories});
    const searchMemory = () => provider.executeCapability({call:{toolCallId:'rc-memory-search',capabilityId:'local.memory.search',arguments:{query:'unique memory needle',scope:'project',limit:1}}},
      {mode:'project_agent',role:'project_agent',workspaceId:first.workspaceId});
    const opened=await time(searchMemory);report.memoryInitialRebuildMs=opened.elapsed;
    assert.equal(JSON.parse(opened.value.result.outputPreview.legacyResult.output).items[0].id,'rc-memory-123');
    for (let i=0;i<5;i++) {
      const fresh=readers(home,fixture);
      const listed=await time(()=>createProjectAgentApplicationService({enabled:()=>true,directory:fresh.directory}).list());
      assert.equal(listed.value.items.length,RC_SCALE.bots);samples.list.push(listed.elapsed);
      const searched=await time(()=>app.search({query:'unique-needle'}));assert.ok(searched.value.hits.length);samples.search.push(searched.elapsed);
      const received=await time(()=>app.submitInput({workspaceId:first.workspaceId,inputId:`rc-received-${i}`,text:'Synthetic receipt',surface:'desktop'}));
      assert.equal(received.value.ok,true);assert.equal(queue.cursor(first.workspaceId),`rc-received-${i}`);samples.received.push(received.elapsed);
      queue.submitInput({workspaceId:first.workspaceId,inputId:`rc-consume-${i}`,text:'Synthetic consume',surface:'desktop'});
      const consumed=await time(()=>queue.consume(first.workspaceId));assert.equal(consumed.value.consumed.length,1);samples.consume.push(consumed.elapsed);
      const memory=await time(searchMemory);assert.equal(JSON.parse(memory.value.result.outputPreview.legacyResult.output).items[0].id,'rc-memory-123');samples.memory.push(memory.elapsed);
    }
    for(const [name,values] of Object.entries(samples))report.metrics[name]=metric(name,values);
    if(realModelReport) {
      const actual=JSON.parse(readFileSync(realModelReport,'utf8'));
      assert.equal(actual.synthetic,false);assert.equal(actual.sourceHead,report.sourceHead,'model report must match source HEAD');
      assert.equal(actual.samples.length,5);assert.ok(actual.samples.every(s=>s.outcome==='done'&&s.model&&s.turnId));
      report.realModel=actual;report.metrics.realModel=metric('realModel',actual.samples.map(s=>s.durationMs));
    } else report.realModel={status:'not_measured',reason:'Live configured-model benchmark required before ready; scripted replies do not satisfy it'};
    report.localPass=Object.values(report.metrics).every(m=>m.pass);
    report.ready=report.localPass && Boolean(report.metrics.realModel?.pass);
    report.requestedScope=localOnly?'local_only':'complete';report.ok=localOnly?report.localPass:report.ready;
    report.finishedAt=new Date().toISOString();
    if(output)writeFileSync(output,JSON.stringify(report,null,2));
    return report;
  } finally {provider?.close();rmSync(home,{recursive:true,force:true});}
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) {
  if(process.argv[2]==='--idle-child')console.log(JSON.stringify(await idleChild(process.argv[3])));
  else {
    const valueOf=flag=>{const i=process.argv.indexOf(flag);return i<0?null:process.argv[i+1];};
    const report=await runProjectAgentPerf({output:valueOf('--output'),localOnly:process.argv.includes('--local-only'),realModelReport:valueOf('--real-model-report')});
    console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
  }
}
