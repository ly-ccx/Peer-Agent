import { checkBotShellAccessibility } from './bot-shell-accessibility-checks.mjs';
import { seedUiAutomation, seedClassicUiFixture, checkSharedUiConventions } from './shared-ui-convention-checks.mjs';
import { checkBotShellDiagnostics } from './bot-shell-diagnostics-checks.mjs';
import { checkBotShellUpdater } from './bot-shell-updater-checks.mjs';
import { checkBotShellReply } from './bot-shell-reply-checks.mjs';
import { checkBotSelectionQuote } from './bot-selection-quote-checks.mjs';
import { checkBotWorkSurfaces } from './bot-work-surface-checks.mjs';
import { checkBotHistoryMotion, instrumentHistoryReads, seedHistoryFixtures } from './bot-history-motion-checks.mjs';
import { checkBotChatDetails } from './bot-shell-chat-detail-checks.mjs';
import { checkModelSwitchOnly } from './bot-model-switch-checks.mjs';
import { checkBotTaskDetails } from './bot-task-detail-checks.mjs';
import { checkBotMessageLayout } from './bot-message-layout-checks.mjs';
import { checkFallbackVisionLayout } from './fallback-vision-layout-checks.mjs';
import { checkBotComposerLayout } from './bot-composer-layout-checks.mjs';
import { checkBotCompletionReview } from './bot-completion-review-checks.mjs';
import { checkQuickChatBots } from './quick-chat-bot-checks.mjs';
import { checkResponseInteraction, createStreamingFixture } from '../../../scripts/rc-response-interaction-smoke.mjs';
// RC-01: production main/preload/renderer, synthetic cognition at the executor seam.
// This proves shell/IPC/durable input behavior, never live-model latency or tool execution.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { prepareLabIsolation } from './lab-workspace-isolate.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { metric } from './perf-project-agent.mjs';
import { createLlmConfigStore } from '../electron/main/llm-config-store.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'peer-bot-shell-smoke-'));
const home = path.join(root, 'data'); mkdirSync(home);
const sharedUiOnly = process.argv.includes('--shared-ui-only');
const workSurfaces = process.argv.includes('--work-surfaces') || process.argv.includes('--history-motion-only');
const workCommand = path.join(root, 'work-command.json');
const effortCommand = path.join(root, 'effort-command.json');
writeFileSync(effortCommand, JSON.stringify({ failNext: false }));
const fixture = seedBotShellHome({ home });
if (sharedUiOnly) seedUiAutomation({ home, workspacePath: fixture.bots[0].path });
const classicUiFixture = sharedUiOnly ? seedClassicUiFixture({ home }) : null;
const historyFixtures = workSurfaces ? seedHistoryFixtures({ home }) : [];
let botModelFixtures = [];
{
  const fixtureSecrets = new Map();
  const models = createLlmConfigStore({
    configFile: path.join(home, 'llm-providers.json'),
    credentialClient: { getSecret: key => fixtureSecrets.get(key) ?? null,
      deleteSecret: key => fixtureSecrets.delete(key), setSecret: (key, value) => fixtureSecrets.set(key, value) },
    providerFetch: () => { throw Error('No fixture model network allowed'); },
  });
  for (const suffix of ['A', 'B']) models.addProvider({ provider: 'openai', groupId: 'rc-model-menu-fixture', model: `rc-bot-model-${suffix.toLowerCase()}`,
    modelLabel: `RC Bot model ${suffix}`, name: 'RC synthetic channel', apiKey: 'rc-fixture-only-not-a-real-key', baseUrl: 'http://127.0.0.1:1', metadataSource: 'custom', supportsVision: true });
  // UI fixtures declare availability/capabilities at the existing catalogue seam. No secrets or network.
  botModelFixtures = models.listProviders().map(model => ({ ...model, enabled: true, apiKeyConfigured: true,
    supportsTools: true, supportsStructured: true, supportsVision: true, supportsReasoning: true,
    reasoningEffortLevels: process.argv.includes('--effort-stability') ? ['low', 'high', 'max'] : ['low', 'high'], defaultEffort: 'low' }));
}
const fixtureConversation = path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl');
const seededMessages = readFileSync(fixtureConversation, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const longErrorText = '代理暂时不可用：HTTP 400: ' + JSON.stringify({ error: {
  message: 'The `content[].thinking` in the thinking mode must be passed back to the API.',
  type: 'invalid_request_error', request_id: 'c41b0061-ad0e-4e22-9c48-c0bf5568aa27',
  long_id: 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(10),
  endpoint: 'https://example.invalid/api/messages?request=' + '0123456789abcdef'.repeat(10),
  code: 'invalid_request_error', marker: 'RC_LONG_ERROR_END',
} });
seededMessages[9998] = { ...seededMessages[9998], role: 'assistant', kind: 'system_card', card: 'agent_unavailable',
  content: longErrorText, cards: [{ cardId: 'card:agent_unavailable:rc-long-error', kind: 'agent_unavailable', content: longErrorText, actions: [] }] };
const budgetErrorText = '代理暂时不可用：agent_tool_budget_exhausted: 本轮工具调用额度已用完，回复尚未完成，已停止继续执行。';
seededMessages[9997] = { ...seededMessages[9997], role: 'assistant', kind: 'system_card', card: 'agent_unavailable',
  content: budgetErrorText, cards: [{ cardId: 'card:agent_unavailable:rc-budget', kind: 'agent_unavailable', content: budgetErrorText,
    actions: [{ id: 'retry', channel: 'project-agent:retry', payload: { workspaceId: fixture.bots[0].workspaceId, turnId: 'rc-budget' } }] }] };
seededMessages.at(-1).replyTo = ['rc-message-9500'];
seededMessages[9500].content = '请帮我梳理项目现状，说明已经完成的功能、当前问题和下一步计划。' + '需要逐项核对实际实现和依据。'.repeat(8) + '原文结束标记';
seededMessages.at(-1).content = '回复交互验收：引用保留上下文，过程按需查看。\n\n- **理解项目**：阅读代码与文档。\n- **讨论方案**：比较方案与取舍。';
seededMessages.at(-1).meta = { surfacing: 'interrupt', memoryUsed: ['rc-memory-123'] };
seededMessages[9993] = { ...seededMessages[9993], role: 'user', kind: 'user_input', content: '熟悉仓库' };
seededMessages[9996] = { ...seededMessages[9996], role: 'assistant', kind: 'agent_reply', replyTo: ['rc-message-9993'],
  content: '仓库只读熟悉已经完成，工作区没有改动。下面是这次整理的项目情况。\n\n'
    + '1. 项目结构：应用和运行时分别维护，公共契约在共享包中。\n'
    + '2. 开发规则：按已有规则修改，界面只负责呈现。\n'
    + '3. 常用脚本：启动、构建、测试及产品回归都有对应入口。\n'
    + '4. 最近提交：已核对当前分支与提交记录。\n\n要把这些确认过的事实写入项目记忆吗？' };
if (process.argv.includes('--selection-quote-only')) seededMessages[9996] = { ...seededMessages[9996], role: 'assistant', kind: 'agent_reply',
  content: '仓库只读熟悉已经完成，工作区没有改动。叶子证据和独立校验都通过了；项目记忆里目前还没有对应条目。\n\n'
    + Array.from({ length: 8 }, (_, i) => `${i + 1}. 项目核对：检查应用、运行时、脚本与规则，整理已核实的事实和未覆盖的范围。`).join('\n')
    + '\n\n要把这些确认过的事实写入项目记忆吗？',
  cards: [{ cardId: 'card:question:reply:rc-selection', kind: 'question', content: '要写入项目记忆吗？', actions: [] }] };
if (workSurfaces) {
  seededMessages.at(-1).sources = ['rc-work-1'];
  seededMessages.at(-1).meta.evidenceRefs = Array.from({length:20}, (_,i)=>'rc-evidence-'+i);
  seededMessages.at(-1).meta.sessionStates = [{sessionId:'rc-work-1', status:'running'}];
  const sourceAt = '2026-10-07T03:12:39.953Z';
  const evidenceRows = Array.from({length:20}, (_,i) => ({ evidenceRef: `rc-evidence-${i}`, createdAt: sourceAt,
    toolName: 'read_file', capabilityId: 'local.file.read' }));
  evidenceRows[0].bodyPreview = {kind:'file', text:'README.md\n\nPeer 是本机任务委托系统。代理负责持续推进，并在交还前验证结果。', truncated:false};
  evidenceRows[1] = {...evidenceRows[1], toolName:'get_session', capabilityId:'local.delegation.get_session',
    conversationId:fixture.bots[2].conversationId, streamId:'rc-evidence-history'};
  evidenceRows[2] = {...evidenceRows[1], evidenceRef:'rc-evidence-2', streamId:'missing-historical-turn'};
  evidenceRows[4] = {...evidenceRows[4], toolName:'bash', capabilityId:'local.shell.exec',
    bodyPreview:{kind:'command',text:JSON.stringify({exitCode:0,stdout:'回归通过：5 项检查完成。',stderr:''}),truncated:false}};
  const evidenceHistory={id:'rc-evidence-history',kind:'agent_turn',role:'assistant',turnId:'rc-evidence-history',
    content:'',createdAt:sourceAt,rounds:[{text:'',toolCalls:[{name:'get_session',input:{sessionId:'historical-session'},
      result:{ok:true,title:'只读熟悉 Peer-Agent',statusLabel:'执行受阻',evidenceRefs:['rc-evidence-1']}}]}]};
  const evidenceHistoryFile=path.join(home,'conversations',evidenceRows[1].conversationId+'.jsonl');
  const existingEvidenceHistory=existsSync(evidenceHistoryFile)?readFileSync(evidenceHistoryFile,'utf8').trim():'';
  writeFileSync(evidenceHistoryFile,(existingEvidenceHistory?existingEvidenceHistory+'\n':'')+JSON.stringify(evidenceHistory)+'\n');
  mkdirSync(path.join(home,'goal-plans'),{recursive:true});
  writeFileSync(path.join(home,'goal-plans','evidence-index.jsonl'),evidenceRows.filter((_,i)=>i!==3).map(row=>JSON.stringify(row)).join('\n')+'\n');
}
writeFileSync(workCommand, JSON.stringify({seq:0,workspaceId:fixture.bots[0].workspaceId,sessions:[{sessionId:'rc-work-1', title:'核查历史任务完成情况', status:'running',statusLabel:'正在核查历史记录', origin:{anchorMessageId:'rc-message-9500'},report:{summary:'逐条核对历史记录中的目标、结果和依据。'}}]}));
writeFileSync(fixtureConversation, seededMessages.map(row => JSON.stringify(row)).join('\n') + '\n');
if (process.argv.includes('--streaming')) {
  const bot = fixture.bots[1], file = path.join(home, 'conversations', bot.conversationId + '.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const turnId = 'rc-manual-wake-retry';
  rows.push({ id: turnId, turnId, role: 'assistant', kind: 'agent_turn', turnKind: 'wake', userInputs: [], content: '',
    createdAt: new Date().toISOString(), rounds: [], meta: { recovery: { throughSeq: 0,
      events: [{ eventId: 'rc-manual-retry-event', kind: 'session_verified', workspaceId: bot.workspaceId, sessionId: 'rc-retry-session', at: new Date().toISOString(), payload: {} }] } } });
  rows.push({ id: turnId + '-card', turnId, role: 'assistant', kind: 'system_card', card: 'agent_unavailable', content: budgetErrorText,
    createdAt: new Date().toISOString(), cards: [{ cardId: 'card:agent_unavailable:' + turnId, kind: 'agent_unavailable', content: budgetErrorText,
      actions: [{ id: 'retry', channel: 'project-agent:retry', payload: { workspaceId: bot.workspaceId, turnId } }] }] });
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
const settings = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'));
settings.memory = { enabled: false };
if (classicUiFixture) settings.workspaces.push({ id: 'rc-ui-classic-workspace', path: classicUiFixture.workspacePath, name: 'UI 规范回归' });
if (botModelFixtures.length) settings.fallbackVision = { providerId: botModelFixtures[0].id };
const isolation = prepareLabIsolation({ sourceRoot: source, labHome: home });
cpSync(path.join(source, 'apps/desktop/dist'), isolation.launch.distDir, { recursive: true });
writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
const main = path.join(isolation.launch.desktopDir, 'electron/main/main.mjs');
const mainText = readFileSync(main, 'utf8');
const seam = 'const agentTurnExecutor = createAgentTurnExecutor({ llmChatService });';
assert.equal(mainText.split(seam).length, 2, 'exact production executor assembly seam required');
let isolatedMain = mainText.replace(seam,
  'const agentTurnExecutor = createAgentTurnExecutor({ llmChatService: globalThis.rcBotShellService });');
if (botModelFixtures.length) {
  const catalogueSeam = 'listModels: () => llmConfigStore.listProviders(),';
  assert.equal(isolatedMain.split(catalogueSeam).length, 2, 'exact production catalogue assembly seam required');
  isolatedMain = isolatedMain.replace(catalogueSeam, 'listModels: () => globalThis.rcBotModelFixtures,');
}
writeFileSync(main, isolatedMain);
// Observe production pagination without changing its results or admitting a new IPC.
const applicationService = path.join(isolation.launch.desktopDir, 'electron/main/project-agent/project-agent-application-service.mjs');
const serviceText = readFileSync(applicationService, 'utf8');
const readSeam = 'const result = directory.readConversation(payload.workspaceId, payload);';
assert.equal(serviceText.split(readSeam).length, 2, 'exact conversation read seam required');
let observedService = serviceText.replace(readSeam, `const result = directory.readConversation(payload.workspaceId, payload);
  if (globalThis.rcBotWorkWorkspace === payload.workspaceId && globalThis.rcBotWorkMessages?.length && !payload.before) {
    result.messages = [...result.messages, ...globalThis.rcBotWorkMessages];
  }
  globalThis.rcBotShellRecord('reads',{  before: payload.before ?? null, nextCursor: result.nextCursor,
    count: result.messages?.length, firstId: result.messages?.[0]?.id, lastId: result.messages?.at(-1)?.id });`);
if (workSurfaces) observedService = instrumentHistoryReads(observedService);
const timingSeams = [
  ['function list(payload = {}) {', 'function list(payload = {}) { const rcListStart = performance.now();'],
  ['return { ok: true, items: filtered.map(withAgentStatus) };', 'const result = { ok: true, items: filtered.map(withAgentStatus) }; globalThis.rcBotShellRecord(\'list\',{  count: result.items.length, durationMs: performance.now() - rcListStart }); return result;'],
  ['function search(payload = {}) {', 'function search(payload = {}) { const rcStart = performance.now(); let rcStampMs = 0, rcIndexMs = 0;'],
  ['let hits = [];', 'const rcProjectionMs = performance.now() - rcStart; let hits = [];'],
  ["const token = typeof corpusStamp === 'function' ? String(corpusStamp(snapshot?.catalog) ?? '') : null;", "const rcStampStart = performance.now(); const token = typeof corpusStamp === 'function' ? String(corpusStamp(snapshot?.catalog) ?? '') : null; rcStampMs = performance.now() - rcStampStart; const rcIndexStart = performance.now();"],
  ["hits = searchIndex.search(typeof payload?.query === 'string' ? payload.query : '');", "hits = searchIndex.search(typeof payload?.query === 'string' ? payload.query : ''); rcIndexMs = performance.now() - rcIndexStart;"],
  ['return { ok: true, items, hits };', 'globalThis.rcBotShellRecord(\'search\',{  projectionMs: rcProjectionMs, stampMs: rcStampMs, indexMs: rcIndexMs, totalMs: performance.now() - rcStart }); return { ok: true, items, hits };'],
];
for (const [before, after] of timingSeams) {
  assert.equal(observedService.split(before).length, 2, 'exact search observation seam required');
  observedService = observedService.replace(before, after);
}
if (process.argv.includes('--streaming')) {
  const submitSeam = 'async function submitInput(payload = {}) {';
  assert.equal(observedService.split(submitSeam).length, 2);
  observedService = observedService.replace(submitSeam, `${submitSeam}
    if (payload.text === 'RC_DETAIL_FAIL_ANSWER' && !globalThis.rcDetailFailedOnce) { globalThis.rcDetailFailedOnce = true; return {ok:false,code:'CONTROLLED_SUBMIT_FAILURE'}; }`);
}
if (process.argv.includes('--effort-stability') || workSurfaces) {
  observedService = `import {readFileSync,writeFileSync} from 'node:fs';\n` + observedService;
}
if (process.argv.includes('--effort-stability')) {
  const updateSeam = 'async function updateProfile(payload = {}, sender = null) {';
  assert.equal(observedService.split(updateSeam).length, 2);
  observedService = observedService.replace(updateSeam, `${updateSeam}
    if (payload.modelPolicy?.overrides?.project_agent?.reasoningEffort) {
      const file=${JSON.stringify(effortCommand)};
      const command=JSON.parse(readFileSync(file,'utf8'));
      await new Promise(resolve=>setTimeout(resolve,650));
      if(command.failNext){writeFileSync(file,JSON.stringify({failNext:false}));return {ok:false,code:'CONTROLLED_SAVE_FAILURE'};}
    }`);
}
if (workSurfaces) {
  const confirmationSeam = 'async function confirmResult(payload = {}) {';
  assert.equal(observedService.split(confirmationSeam).length, 2);
  observedService = observedService.replace(confirmationSeam, `${confirmationSeam}
    if (payload.sessionId === 'completion-fixture') {
      if (payload.stage !== 'manual_completion') return {ok:false,code:'session_not_completed'};
      const file=${JSON.stringify(workCommand)}, state=JSON.parse(readFileSync(file,'utf8'));
      writeFileSync(file,JSON.stringify({...state,confirmationPayload:payload}));
      if(state.failCompletionResume)return {ok:false,code:'completion_confirmation_failed'};
      return {ok:true};
    }`);
  const workSeam = 'function listSessions(payload = {}) {';
  assert.equal(observedService.split(workSeam).length, 2);
  observedService = observedService.replace(workSeam, `${workSeam}
    if (payload.workspaceId === globalThis.rcBotWorkWorkspace) return globalThis.rcBotWorkUnavailable ? {ok:false,code:'CONTROLLED_READ_FAILURE'} : {ok:true,sessions:globalThis.rcBotWorkSessions};`);
  const detailSeam = 'async function getSession(payload = {}) {';
  assert.equal(observedService.split(detailSeam).length, 2);
  observedService = observedService.replace(detailSeam, `${detailSeam}
    const fixtureSession=globalThis.rcBotWorkSessions?.find(item=>item.sessionId===payload.sessionId);
    if(fixtureSession) {
      const controlFile=${JSON.stringify(workCommand)};
      const reportMode=()=>JSON.parse(readFileSync(controlFile,'utf8')).reportReadMode;
      if(reportMode()==='unavailable') return {ok:false,code:'CONTROLLED_REPORT_FAILURE'};
      const deadline=Date.now()+10000;
      while(reportMode()==='waiting' && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
      if(reportMode()==='waiting') throw Error('Controlled report was not released');
      return {ok:true,session:{...fixtureSession,report:globalThis.rcBotWorkReports?.[payload.sessionId]??fixtureSession.report}};
    }`);
}
writeFileSync(applicationService, observedService);
const observedFile = path.join(root, 'observations.json');
writeFileSync(observedFile, JSON.stringify({ reads: [], list: [], search: [], turns: [] }));
const entry = path.join(root, 'entry.mjs');
const streamCommand = path.join(root, 'stream-command.json');
writeFileSync(streamCommand, JSON.stringify({ scenario: '', phase: 0 }));
if (process.argv.includes('--streaming')) {
  const probeFile = streamCommand + '.role-probe';
  writeFileSync(probeFile, JSON.stringify({ scenario: 'RC_STREAM_FAIL', phase: 3 }));
  const events = [];
  const probe = createStreamingFixture({ commandFile: probeFile, record() {} });
  const input = { messages: [{ role: 'user', content: 'RC_STREAM_FAIL' }], streamId: 'role-probe',
    webContents: { send: (...event) => events.push(event) } };
  for (const role of ['memory_curator', 'objective_probe']) {
    const result = await probe.sendMessage({ ...input, turnProfile: { role } });
    assert.equal(result.terminalStatus, 'done', `${role} must not run the interactive failure scenario`);
    assert.equal(events.length, 0, `${role} must not emit interactive stream events`);
  }
  const failed = await probe.sendMessage({ ...input, turnProfile: { role: 'project_agent', context: { inputAnchors: [] } } });
  assert.equal(failed.terminalStatus, 'error', 'background cognition must not consume the first interactive failure');
  assert.ok(events.some(([channel]) => channel === 'chat:stream:error'));
}
const diagnosticsFile = path.join(root, 'exported-diagnostics.json');
const updaterCommand = path.join(root, 'updater-command.json');
const updaterReceipt = path.join(root, 'updater-receipt.json');
writeFileSync(updaterCommand, JSON.stringify({ seq: 0 }));
writeFileSync(updaterReceipt, JSON.stringify({ seq: 0 }));
writeFileSync(entry, `import {app,dialog,BrowserWindow} from 'electron';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {startMainThreadProbe} from ${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/scripts/lab-main-thread-probe.mjs')).href)};
import {resolveRoleRoute} from ${JSON.stringify(pathToFileURL(path.join(source, 'packages/runtime-node/dist/index.js')).href)};
startMainThreadProbe(process.env.PEER_RC_PROFILE_PREFIX);
app.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});
// A bare Electron entry otherwise reports Electron's version, not the product's.
app.getVersion=()=>${JSON.stringify(JSON.parse(readFileSync(path.join(source, 'apps/desktop/package.json'), 'utf8')).version)};
${process.argv.includes('--diagnostics') ? `dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(diagnosticsFile)}});` : ''}
globalThis.rcBotModelFixtures=${JSON.stringify(botModelFixtures)};
const observations={reads:[],list:[],search:[],turns:[]};
globalThis.rcBotShellRecord=(key,value)=>{
  observations[key].push(value);
  const file=${JSON.stringify(observedFile)};
  writeFileSync(file+'.next',JSON.stringify(observations));renameSync(file+'.next',file);
};
globalThis.rcBotShellService={
  resolveGoalRole(input){return resolveRoleRoute({...input,providers:[...globalThis.rcBotModelFixtures,{id:'rc-scripted',model:'scripted-fixture',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsStructured:true,supportsVision:false,isDefault:true}]});},
  async sendMessage(input){
    globalThis.rcBotShellRecord('turns',{role:input.turnProfile?.role,workspaceId:input.turnProfile?.workspaceId});
    await new Promise(resolve=>setTimeout(resolve,120));
    const text=input.messages?.findLast(message=>message.role==='user')?.content || '';
    return {terminalStatus:'done',text:'RC scripted reply: '+text};
  },abort(){}
};
${process.argv.includes('--streaming') ? `const {createStreamingFixture}=await import(${JSON.stringify(pathToFileURL(path.join(source, 'scripts/rc-response-interaction-smoke.mjs')).href)});
globalThis.rcBotShellService=createStreamingFixture({commandFile:${JSON.stringify(streamCommand)},record:globalThis.rcBotShellRecord,resolveGoalRole:globalThis.rcBotShellService.resolveGoalRole});` : ''}
const fixtureSend=globalThis.rcBotShellService.sendMessage.bind(globalThis.rcBotShellService);
globalThis.rcBotShellService.sendMessage=input=>{
  if(input.messages?.findLast(message=>message.role==='user')?.content==='RC_QUICK_INPUT') {
    globalThis.rcQuickExecution={modelProviderId:input.modelProviderId,effort:input.effort};
  }
  return fixtureSend(input);
};
${workSurfaces ? `const workFile=${JSON.stringify(workCommand)};
let workCommand=JSON.parse(readFileSync(workFile,'utf8'));
globalThis.rcBotWorkWorkspace=workCommand.workspaceId;globalThis.rcBotWorkSessions=workCommand.sessions;globalThis.rcBotWorkUnavailable=Boolean(workCommand.unavailable);globalThis.rcBotWorkReports=workCommand.detailReports;globalThis.rcBotWorkMessages=workCommand.conversationMessages;globalThis.rcHistoryReadMode=workCommand.historyReadMode;
const workTimer=setInterval(()=>{
  const next=JSON.parse(readFileSync(workFile,'utf8'));if(next.seq<=workCommand.seq)return;
  workCommand=next;globalThis.rcBotWorkSessions=next.sessions;globalThis.rcBotWorkUnavailable=Boolean(next.unavailable);globalThis.rcBotWorkReports=next.detailReports;globalThis.rcBotWorkMessages=next.conversationMessages;globalThis.rcHistoryReadMode=next.historyReadMode;
  for(const window of BrowserWindow.getAllWindows())window.webContents.send('project-agent:changed',{workspaceIds:[next.workspaceId]});
},25);workTimer.unref();` : ''}
// Keep synthetic updater delivery outside inspector Promise lifetime. Only this
// isolated entry consumes the disposable command file; product IPC is unchanged.
let updaterSequence=0;
const updaterTimer=setInterval(()=>{
  const command=JSON.parse(readFileSync(${JSON.stringify(updaterCommand)},'utf8'));
  if(command.seq<=updaterSequence)return;
  let receipt;
  try {
    const windows=BrowserWindow.getAllWindows();
    if(!windows.length)return;
    for(const window of windows)window.webContents.send('updater:event',command.event);
    receipt={seq:command.seq,ok:true,windows:windows.length};
  }catch(error){receipt={seq:command.seq,ok:false,error:error.message};}
  updaterSequence=command.seq;
  const file=${JSON.stringify(updaterReceipt)};
  writeFileSync(file+'.next',JSON.stringify(receipt));renameSync(file+'.next',file);
},25);updaterTimer.unref();
app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1',
  PEER_WORKSPACE_ROOT: fixture.bots[0].path };
delete env.ELECTRON_RUN_AS_NODE;
const owned = createOwnedProcessRegistry();
const report = { schemaVersion: 1, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()),
  synthetic: true, scale: fixture.scale, platform: process.platform, startedAt: new Date().toISOString(),
  checks: [], pageErrors: [], receiptSamples: [], scope: 'Real source Electron main/preload/renderer and durable input; scripted cognition only; not installed or real-model timing' };
if (process.argv.includes('--streaming')) report.fixtureRoleIsolation = true;
let app, handle, page, tracing = false; const logs = [];
const interaction = async phase => {
  report.interactionBefore = await page.evaluate(phase => ({ phase, frames: globalThis.rcShellFrameCount, at: Date.now(), hidden: document.hidden, focused: document.hasFocus() }), phase);
};
// Test-only facts are captured after each timing sample and atomically published.
// Reading them never replays a product action or relies on inspector Promise lifetime.
const readObserved = key => JSON.parse(readFileSync(observedFile, 'utf8'))[key];
const tracePaging = async (phase) => {
  (report.paging ??= []).push({ phase, reads: readObserved('reads').slice(-20),
    view: await page.locator('.bot-thread').evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight,
      viewport: node.clientHeight, busy: node.getAttribute('aria-busy'), ids: [...node.querySelectorAll('[id^="bot-msg-"]')].map(row => row.id) })) });
};
const until = async (read, predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Shell acceptance timed out');
};
let updaterSequence = 0;
const emitUpdaterEvent = async event => {
  const seq = ++updaterSequence;
  writeFileSync(updaterCommand + '.next', JSON.stringify({ seq, event }));
  renameSync(updaterCommand + '.next', updaterCommand);
  const receipt = await until(() => JSON.parse(readFileSync(updaterReceipt, 'utf8')), value => value.seq === seq, 5000);
  assert.equal(receipt.ok, true, receipt.error || 'isolated main must acknowledge synthetic event delivery');
  (report.updaterReceipts ??= []).push({ ...receipt, type: event.type });
};
try {
  app = await _electron.launch({ args: [entry], env, cwd: isolation.launch.desktopDir, timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  await app.context().tracing.start({ screenshots: true, snapshots: true }); tracing = true;
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(() => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 120000);
  report.windowReadyMs = Date.now() - Date.parse(report.startedAt);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.locator('.bot-shell').waitFor();
  await page.bringToFront();
  report.initialWindowState = await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() }));
  await page.evaluate(() => { globalThis.rcShellFrameCount = 0; const tick = () => { globalThis.rcShellFrameCount++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await until(() => page.locator('.bot-row').count(), count => sharedUiOnly ? count >= fixture.scale.bots : count === fixture.scale.bots);
  if (sharedUiOnly) {
    await page.locator('.bot-app-menu-button').click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.locator('.settings-nav').getByRole('button', { name: '开发者', exact: true }).click();
    await page.getByRole('button', { name: '刷新诊断', exact: true }).click();
    await page.locator('.project-diagnostics__summary').waitFor();
    await checkSharedUiConventions({ page, app, report, captureDirectory: root, classicFixture: classicUiFixture });
  } else if (process.argv.includes('--chat-details-only')) {
    await page.setViewportSize({ width: 1280, height: 780 });
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
    await page.locator('.bot-composer textarea').waitFor();
    await checkBotChatDetails({ page, until, report, captureDirectory: root, conversationFile: fixtureConversation });
  } else if (process.argv.includes('--history-motion-only')) {
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
    await page.locator('.bot-composer textarea').waitFor();
    await checkBotHistoryMotion({ page, until, report, captureDirectory: root, commandFile: workCommand,
      fixtureRows: historyFixtures, workspaceId: fixture.bots[0].workspaceId, home });
  } else if (process.argv.includes('--reply-quote-only')) {
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
    await page.locator('#bot-msg-rc-message-9999 .bot-reply-bar').click();
    await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor();
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
    await checkBotShellReply({ page, until, report, captureDirectory: root });
  } else if (process.argv.includes('--selection-quote-only')) {
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
    await page.locator('.bot-composer textarea').waitFor();
    await checkBotSelectionQuote({ page, until, report, captureDirectory: root });
  } else if (process.argv.includes('--message-layout-only')) {
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
    await page.locator('.bot-composer textarea').waitFor();
    await checkBotMessageLayout({ page, until, report, captureDirectory: root, expectedText: longErrorText });
  } else if (process.argv.includes('--composer-layout-only')) {
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
    await page.locator('.bot-composer textarea').waitFor();
    await checkBotComposerLayout({ page, until, report, captureDirectory: root });
  } else if (process.argv.includes('--model-switch-only')) {
    await checkModelSwitchOnly({ page, fixture, until, report, captureDirectory: root,
      failNext: () => writeFileSync(effortCommand, JSON.stringify({ failNext: true })) });
  } else {
  await checkBotShellUpdater({ page, emitUpdaterEvent, until, report, home, captureDirectory: root });
  assert.equal(readObserved('turns').length, 0, 'idle bots must not open model turns');
  report.avatarAnimation = await page.evaluate(() => ({ avatars: document.querySelectorAll('.bot-avatar').length, activeAvatars: document.querySelectorAll('[data-avatar-animated="true"]').length, animations: document.getAnimations().length }));
  report.checks.push('200 real bot rows; no idle model turns');
  report.listInitialMs = readObserved('list').find(sample => sample.count === fixture.scale.bots)?.durationMs;
  const listSamples = [];
  for (let i = 0; i < 5; i++) {
    assert.equal((await page.evaluate(() => window.peerAgent.projectAgentList())).items.length, fixture.scale.bots);
    listSamples.push(readObserved('list').at(-1).durationMs);
  }
  report.metrics = { productionList: metric('list', listSamples) };
  assert.equal(report.metrics.productionList.pass, true, 'real desktop list projection p50 must stay below 100ms');
  report.searchSamples = [];
  for (let i = 0; i < 5; i++) {
    await interaction(`search-clear-${i}`);
    await page.locator('.bot-search').fill('');
    await until(() => page.locator('.bot-row').count(), count => count === fixture.scale.bots);
    await page.evaluate(() => {
      globalThis.rcSearchMeasurement = new Promise((resolve, reject) => {
        let started = null;
        const input = document.querySelector('.bot-search');
        const onInput = () => { started = performance.now(); };
        const cleanup = () => { input.removeEventListener('input', onInput); observer.disconnect(); clearTimeout(timer); };
        const observer = new MutationObserver(() => {
          const rows = document.querySelectorAll('.bot-row');
          if (started !== null && rows.length === 1 && rows[0].querySelector('.bot-row-name')?.textContent === 'project-000') {
            const elapsed = performance.now() - started; cleanup(); resolve(elapsed);
          }
        });
        input.addEventListener('input', onInput);
        observer.observe(document.querySelector('.bot-list'), { subtree: true, childList: true, characterData: true });
        const timer = setTimeout(() => { cleanup(); reject(Error('Visible full-corpus search result missing')); }, 5000);
      });
    });
    await interaction(`search-query-${i}`);
    await page.locator('.bot-search').fill('unique-needle');
    report.searchSamples.push(await page.evaluate(() => globalThis.rcSearchMeasurement));
  }
  report.metrics.visibleSearch = metric('search', report.searchSamples);
  report.searchTimings = readObserved('search');
  assert.equal(report.metrics.visibleSearch.pass, true, 'input to visible full-corpus result p50 must stay below 150ms');
  await page.locator('.bot-search').fill('');
  await until(() => page.locator('.bot-row').count(), count => count === fixture.scale.bots);
  report.checks.push('five input-to-visible searches across the real message corpus under budget');
  await interaction('open-bot');
  await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-001' }) }).click();
  await until(() => page.locator('.bot-composer textarea').getAttribute('placeholder'), text => text === '给 project-001 发消息');
  await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
  await page.locator('.bot-composer textarea').waitFor();
  await until(() => page.locator('.bot-composer textarea').getAttribute('placeholder'), text => text === '给 project-000 发消息');
  assert.equal(await page.locator('.bot-composer textarea').getAttribute('aria-label'), '给 project-000 发消息');
  report.checks.push('composer prompt and accessible name follow the selected bot name');
  await checkBotMessageLayout({ page, until, report, captureDirectory: root, expectedText: longErrorText });
  for (let i = 0; i < 5; i++) {
    const text = `RC_UI_RECEIPT_${i}`;
    await page.locator('.bot-composer textarea').fill(text);
    await page.evaluate(text => {
      let started = null;
      const states = [];
      globalThis.rcReceiptMeasurement = new Promise((resolve, reject) => {
        let timer;
        const onKey = event => { if (event.key === 'Enter' && !event.shiftKey) started = performance.now(); };
        const cleanup = () => { observer.disconnect(); window.removeEventListener('keydown', onKey, true); clearTimeout(timer); };
        const observer = new MutationObserver(() => {
          const row = [...document.querySelectorAll('.bot-user')].find(row => row.querySelector('.bot-user-text')?.textContent === text);
          const marks = row?.querySelector('.bot-user-marks')?.textContent || '';
          if (marks && states.at(-1) !== marks) states.push(marks);
          if (started !== null && marks.includes('已收到')) { const elapsed = performance.now() - started; cleanup(); resolve({ elapsed, states }); }
        });
        window.addEventListener('keydown', onKey, true);
        observer.observe(document.querySelector('.bot-convo'), { subtree: true, childList: true, characterData: true });
        timer = setTimeout(() => { cleanup(); reject(Error('Visible received marker missing: ' + JSON.stringify(states))); }, 5000);
      });
    }, text);
    (report.inputWindowStates ??= []).push(await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), composer: document.querySelectorAll('.bot-composer textarea').length })));
    await interaction(`send-${i}`);
    await page.locator('.bot-composer textarea').press('Enter');
    const sample = await page.evaluate(() => globalThis.rcReceiptMeasurement);
    report.receiptSamples.push(sample.elapsed);
    await page.locator('.bot-thread').getByText('RC scripted reply: ' + text, { exact: true }).waitFor();
  }
  report.metrics.visibleReceived = metric('received', report.receiptSamples);
  assert.equal(report.metrics.visibleReceived.pass, true, 'visible receipt p50 must stay below 300ms');
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_UI_RECEIPT_4', { exact: true }).waitFor();
  report.checks.push('five real UI sends, visible durable Received under budget, scripted replies');
  const quick = await until(() => app.windows().find(window => new URL(window.url()).searchParams.get('window') === 'quick-chat'), Boolean);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('window') === 'quick-chat');
    window.show(); window.webContents.send('quick-chat:shown');
  });
  await checkQuickChatBots({ app, quick, fixture, until, report, captureDirectory: root,
    failNext: process.argv.includes('--effort-stability') ? () => writeFileSync(effortCommand, JSON.stringify({ failNext: true })) : null });
  await quick.getByLabel('快速会话内容', { exact: true }).fill('RC_QUICK_INPUT');
  await quick.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  const quickExecution = await app.evaluate(() => globalThis.rcQuickExecution);
  assert.equal(quickExecution.modelProviderId, botModelFixtures[1].id);
  assert.equal(quickExecution.effort, botModelFixtures[1].reasoningEffortLevels.at(-1));
  report.quickChatBots.sentSelection = true;
  const canonical = readFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const quickInputs = canonical.filter(row => row.kind === 'user_input' && row.content === 'RC_QUICK_INPUT');
  assert.equal(quickInputs.length, 1); assert.equal(quickInputs[0].surface, 'quick_chat');
  report.checks.push('real Quick Chat window lists bots and submits one canonical quick_chat input');
  await page.bringToFront();
  await page.locator('.bot-thread').evaluate(node => { node.scrollTop = 0; });
  await page.locator('#bot-msg-rc-message-9900').waitFor();
  await page.locator('.bot-thread[aria-busy="false"]').waitFor();
  await tracePaging('initial older page');
  for (const older of [9850, 9800, 9750, 9700]) {
    await page.locator('.bot-thread').hover();
    await page.mouse.wheel(0, -30000);
    await tracePaging(`request ${older + 30}`);
    await page.locator(`#bot-msg-rc-message-${older + 30}`).waitFor();
    await page.locator('.bot-thread[aria-busy="false"]').waitFor();
  }
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  report.checks.push('scrolling up loads older messages from a 10000-message conversation');
  const unloadedQuote = page.locator('#bot-msg-rc-message-9999 .bot-reply-bar');
  assert.equal(await unloadedQuote.locator('.bot-reply-bar-label').textContent(), '引用');
  assert.equal((await unloadedQuote.getAttribute('aria-label')).includes('rc-message-9500'), false);
  await unloadedQuote.click();
  await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor();
  await until(() => page.locator('#bot-msg-rc-message-9500').evaluate(node => {
    const row = node.getBoundingClientRect(), thread = node.closest('.bot-thread').getBoundingClientRect();
    return row.top >= thread.top && row.bottom <= thread.bottom;
  }), Boolean);
  const located = page.locator('#bot-msg-rc-message-9500');
  assert.equal(await located.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  assert.equal(await located.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
  assert.equal(await located.evaluate(node => getComputedStyle(node).boxShadow), 'none');
  await located.screenshot({ path: path.join(root, 'message-located-no-frame.png') });
  await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor({ state: 'detached' });
  await tracePaging('quoted old message located inside viewport with temporary fill and no outline');
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  await page.locator('#bot-msg-rc-message-9999 .bot-reply-bar').click();
  await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor();
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  report.checks.push('older reference loads across pages, locates without a frame, clears its highlight and supports a repeated jump');
  await checkBotShellReply({ page, until, report, captureDirectory: root });
  if (process.argv.includes('--streaming')) {
    await checkResponseInteraction({ page, until, report, captureDirectory: root, commandFile: streamCommand, workCommandFile: workSurfaces ? workCommand : null, readFixtureTurns: () => readObserved('turns') });
    await checkBotChatDetails({ page, until, report, captureDirectory: root, conversationFile: fixtureConversation });
  }
  if (workSurfaces) {
    // The quote-send check adds a real exchange. Reach the older work reply
    // through scrolling instead of assuming virtualization kept it mounted.
    const thread = page.locator('.bot-thread'), workReply = page.locator('#bot-msg-rc-message-9999');
    await thread.hover();
    for (let step = 0; step < 40 && await workReply.count() === 0; step++) {
      const before = await thread.evaluate(node => node.scrollTop);
      await page.mouse.wheel(0, -300);
      await until(async () => ({ top: await thread.evaluate(node => node.scrollTop), mounted: await workReply.count() }), state => state.mounted > 0 || state.top !== before);
    }
    await workReply.waitFor();
    report.checks.push('real scrolling reaches the earlier work reply after quote, streaming and question exchanges');
    await checkBotWorkSurfaces({ page, until, report, captureDirectory: root, commandFile: workCommand });
    await checkBotTaskDetails({ page, until, report, captureDirectory: root, commandFile: workCommand, readTurns: () => readObserved('turns').length });
    await checkBotComposerLayout({ page, until, report, captureDirectory: root });
    await checkBotCompletionReview({ page, until, report, captureDirectory: root, commandFile: workCommand });
    await checkBotHistoryMotion({ page, until, report, captureDirectory: root, commandFile: workCommand,
      fixtureRows: historyFixtures, workspaceId: fixture.bots[0].workspaceId, home });
  }
  await page.locator('.bot-profile').click(); await page.locator('.bot-drawer-dock.is-open').waitFor();
  assert.equal(await page.getByRole('tab', { name: '设置', exact: true }).getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: path.join(root, 'bot-profile.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  report.checks.push('Bot settings opens configuration directly');
  await page.locator('.bot-app-menu-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  if (process.argv.includes('--accessibility')) await checkFallbackVisionLayout({ page, until, report, captureDirectory: root });
  await page.getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('option', { name: '经典界面', exact: true }).click();
  await page.locator('.bot-shell').waitFor({ state: 'detached' });
  await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.app-sidebar').waitFor();
  assert.equal(await page.locator('.app-sidebar .sidebar-version-badge').count(), 1);
  assert.equal(await page.locator('.app-sidebar .sidebar-version-channel').count(), 0);
  assert.equal(await page.locator('.app-sidebar .sidebar-version-stage').count(), 0);
  const classicUpdater = await page.evaluate(() => window.peerAgent.updaterGetStatus());
  assert.equal(await page.locator('.app-sidebar .sidebar-version-text').textContent(), `v${classicUpdater.currentVersion}`);
  assert.equal((await page.evaluate(() => window.peerAgent.updaterGetStatus())).preference, 'auto');
  report.checks.push('classic shell opens through settings');
  // Return through the same settings control, retaining persisted conversations.
  await page.locator('.app-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('option', { name: '机器人列表', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.bot-shell').waitFor();
  assert.equal((await page.evaluate(() => window.peerAgent.projectAgentList())).items.length, fixture.scale.bots);
  report.checks.push('bot shell returns with all persisted identities');
  if (process.argv.includes('--accessibility')) await checkBotShellAccessibility({ page, app, until, report, captureDirectory: root, effortCommandFile: process.argv.includes('--effort-stability') ? effortCommand : null });
  }
  if (process.argv.includes('--diagnostics')) await checkBotShellDiagnostics({ page, report, exportFile: diagnosticsFile, fixture });
  assert.deepEqual(report.pageErrors, []);
  assert.equal(logs.some(line => line.includes('ERR_PEER_DESKTOP_IPC_UNAUTHORIZED')), false, 'no window role may call a forbidden channel');
  report.ok = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  if (page) report.interactionAfter = await page.evaluate(() => ({ frames: globalThis.rcShellFrameCount, at: Date.now(), hidden: document.hidden, focused: document.hasFocus(), search: [...document.querySelectorAll('.bot-search')].map(node => ({ value: node.value, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, visibility: getComputedStyle(node).visibility, display: getComputedStyle(node).display })), composers: document.querySelectorAll('.bot-composer textarea').length })).catch(() => null);
  if (page && app && !sharedUiOnly) await tracePaging('failure').catch(() => {});
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  const failureOutput = process.argv.indexOf('--output');
  if (page && failureOutput >= 0) await page.screenshot({ path: path.join(path.dirname(process.argv[failureOutput + 1]), 'bot-shell-failure.png') }).catch(() => {});
} finally {
  if (tracing) {
    const output = process.argv.indexOf('--output');
    await app.context().tracing.stop({ path: path.join(output >= 0 ? path.dirname(process.argv[output + 1]) : root, 'bot-shell-trace.zip') }).catch(() => {});
  }
  if (handle) report.ownedStop = await owned.stop({ handleId: handle, reason: 'owned' });
  report.finishedAt = new Date().toISOString();
  report.mainAuthorizationErrors = logs.filter(line => line.includes('ERR_PEER_DESKTOP_IPC_UNAUTHORIZED'));
  writeFileSync(path.join(root, 'main.log'), logs.join(''));
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }));
}
