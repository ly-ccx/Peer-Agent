/** Opt-in real Provider → Bot → child → tools acceptance. Never launches against personal data. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import { prepareLabIsolation } from './lab-workspace-isolate.mjs';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { seedExecutionHistory } from './seed-execution-history.mjs';
import { seedExecutionWorkload } from './seed-execution-workload.mjs';
const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? null : process.argv[i + 1]; };
assert.ok(arg('--model-id'), 'Explicit configured --model-id required');
const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'peer-execution-live-')); chmodSync(root, 0o700);
const home = path.join(root, 'data'), personal = path.join(homedir(), '.peer-agent');
const report = { schemaVersion: 1, syntheticCognition: false, installedBuild: false, root,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()),
  scope: 'Production source Electron; isolated fixture project; real configured Provider and governed delegation/tools. No injected Tool Results.',
  startedAt: new Date().toISOString(), pageErrors: [], interactions: 0 };
let app, page;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, accept, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await pause(100); } throw Error('ACCEPTANCE_TIMEOUT'); };
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const rows = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const distribution = values => { const sorted = [...values].sort((a,b) => a-b); return { n: sorted.length, p50: sorted[Math.floor(sorted.length*.5)] ?? null, p95: sorted[Math.min(sorted.length-1, Math.floor(sorted.length*.95))] ?? null, p99: sorted[Math.min(sorted.length-1, Math.floor(sorted.length*.99))] ?? null, max: sorted.at(-1) ?? null }; };
const largeHistory = process.argv.includes('--large-history');
const keyRoundTrips = [], wheelRoundTrips = [], scrollChanges = [];
try {
  const fixture = seedBotShellHome({ home, scale: { bots: 12, messages: 100, inboxEvents: 0, memories: 0 } });
  const bot = fixture.bots[0], project = bot.path;
  const config = json(path.join(personal, 'llm-providers.json'));
  const model = config.models.find(row => row.id === arg('--model-id')); assert.ok(model);
  const channel = config.channels.find(row => row.id === model.groupId); assert.ok(channel);
  const mainModel = config.models.find(row => row.id === (arg('--main-model-id') || model.id)); assert.ok(mainModel);
  const selectedModels = [...new Map([model, mainModel].map(row => [row.id, row])).values()];
  report.model = model.model; report.provider = channel.provider;
  report.mainModel = mainModel.model; report.effort = arg('--effort') || 'medium (worker max)';
  writeFileSync(path.join(home, 'llm-providers.json'), JSON.stringify({ version: config.version,
    channels: config.channels.filter(row => selectedModels.some(model => model.groupId === row.id)),
    models: selectedModels.map(row => ({ ...row, isDefault: row.id === mainModel.id, effort: arg('--effort') || 'medium' })) }), { mode: 0o600 });
  for (const file of ['credentials.vault.json', 'device-identity.json']) if (existsSync(path.join(personal, file))) cpSync(path.join(personal, file), path.join(home, file));
  const settings = json(path.join(home, 'settings.json'));
  settings.memory = { enabled: false }; settings.localAccessLevel = 'full_local';
  settings.modelRouting = { tiers: Object.fromEntries(['strong', 'fast', 'economy', 'vision'].map(tier => [tier, { primary: model.id, fallbacks: [] }])) };
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const profileFile = path.join(home, 'projects', bot.workspaceId, 'profile.json');
  writeFileSync(profileFile, JSON.stringify({ ...json(profileFile), planApproval: 'never', acceptancePolicy: 'auto', autonomyPolicy: 'full_local', modelPolicy: { overrides: Object.fromEntries(['project_agent','session_worker','verifier','explorer','visual_verifier'].map(role=>[role,{mode:'fixed',modelProviderId:role==='project_agent'?mainModel.id:model.id,reasoningEffort:arg('--effort') || (role==='session_worker'?'max':'medium')}])) } }));
  mkdirSync(path.join(project, 'src'));
  writeFileSync(path.join(project, 'README.md'), '# Isolated performance acceptance\nImplement sumNumbers(values). Empty arrays return 0, finite numbers sum, non-number/nonfinite input throws TypeError. Fix implementation and run node --test.\n');
  writeFileSync(path.join(project, 'src/sum.mjs'), 'export function sumNumbers(values) { return values.reduce((a,b) => a+b); }\n');
  writeFileSync(path.join(project, 'sum.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {sumNumbers} from './src/sum.mjs'; test('sum',()=>{assert.equal(sumNumbers([1,2,3]),6);assert.equal(sumNumbers([]),0);assert.throws(()=>sumNumbers([1,'2']),TypeError);assert.throws(()=>sumNumbers([Infinity]),TypeError);});\n");
  if (largeHistory) { report.historyScale = seedExecutionHistory({ home, bot }); seedExecutionWorkload(project); report.workload = 'three implementation files; 18 test cases including 20000-row aggregation and CSV integration'; }
  const isolation = prepareLabIsolation({ sourceRoot: source, labHome: home });
  cpSync(path.join(source, 'apps/desktop/dist'), isolation.launch.distDir, { recursive: true });
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', PEER_WORKSPACE_ROOT: project,
    PEER_CREDENTIAL_HELPER_PATH: path.join(source, 'target/release/peer-credential-helper') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [isolation.launch.desktopDir, '--user-data-dir=' + path.join(root, 'chromium')], cwd: isolation.launch.desktopDir, env, timeout: 30000 });
  app.process().once('exit', (code, signal) => { report.processExit = { code, signal }; });
  page = await until(() => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/dist/index.html') && !w.webContents.getURL().includes('window='));
    window.setSize(1280, 860);
  });
  await until(() => page.locator('.bot-row').count(), count => count === 12);
  await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
  await page.locator('.bot-composer textarea').waitFor(); await pause(1500);
  report.display = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight }));
  if (largeHistory) {
    for (let i = 0; i < 2; i++) {
      await page.locator('.bot-thread-older').click(); await pause(300);
      await page.locator('.bot-thread').evaluate(node => { node.scrollTop = node.scrollHeight; });
    }
  }
  await app.evaluate(() => { const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks');
    globalThis.executionMainLoop = monitorEventLoopDelay({ resolution: 1 }); globalThis.executionMainLoop.enable(); });
  const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, cpu: m.cpu.cumulativeCPUUsage })));
  const cpuStart = await metrics(), start = Date.now();
  await page.evaluate(() => {
    const state = globalThis.executionPerf = { frames: [], inputs: [], wheels: [], longTasks: [], stop: false, last: performance.now() };
    const frame = now => { state.frames.push(now-state.last); state.last=now; if (!state.stop) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    state.observer = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => ({ duration: entry.duration, start: entry.startTime })))); state.observer.observe({ type: 'longtask', buffered: false });
    document.addEventListener('input', event => { if (!event.target.matches('.bot-composer textarea')) return; const at=event.timeStamp; requestAnimationFrame(() => state.inputs.push(performance.now()-at)); }, true);
    document.addEventListener('wheel', event => { if (!event.target.closest('.bot-thread')) return; const at=event.timeStamp; requestAnimationFrame(() => state.wheels.push(performance.now()-at)); }, { passive: true });
  });
  report.taskStartedAt = new Date().toISOString();
  const text = largeHistory
    ? '这是已授权的隔离项目多文件修复任务。请让一个独立子 Agent 接手：读取 README.md 和所有测试，修复 src/sum.mjs、src/group-events.mjs、src/render-csv.mjs，保留全部测试断言，实际运行 node --test。完成标准为现有可执行测试全部通过和系统原有独立复核门禁，不另加没有可执行检查方式的业务要求。只改本项目 src 下的实现。若复核失败，读取具体失败原因并在原任务继续修复，不要开重复补救任务。主 Bot 在实际验收后交付结果。'
    : '这是已授权的隔离项目修复任务。请让一个独立子 Agent 接手：读取 README.md、src/sum.mjs 和 sum.test.mjs，修复 sumNumbers，运行 node --test，按结果完成验收。只改这个测试项目。主 Bot 收到结果后交付总结，不要停在调研或方案。';
  await page.locator('.bot-composer textarea').fill(text); await page.locator('.bot-composer textarea').press('Enter');
  const transcriptFile = path.join(home, 'conversations', bot.conversationId + '.jsonl');
  const sessionsFile = path.join(home, 'project-runtime', bot.workspaceId, 'work-sessions.json');
  let finished = false, lastEvent = '', drawerOpened = false;
  const deadline = Date.now() + Number(arg('--timeout-ms') || 480000);
  while (Date.now() < deadline) {
    const transcript = rows(transcriptFile);
    const turns = transcript.filter(row => row.kind === 'agent_turn');
    const calls = turns.flatMap(turn => turn.rounds?.flatMap(round => round.toolCalls || []) || []);
    const spawned = calls.filter(call => call.name === 'spawn_session' || call.name === 'coordinate_work');
    const sessionFacts = await page.evaluate(workspaceId => window.peerAgent.projectAgentListSessions({workspaceId,limit:20}), bot.workspaceId);
    report.sessions = sessionFacts.sessions?.map(s=>({sessionId:s.sessionId,status:s.status,accepted:s.accepted,conversationId:s.conversationId}));
    const replied = transcript.filter(row => row.kind === 'agent_reply' && row.createdAt >= report.taskStartedAt);
    if (existsSync(path.join(project, 'src/sum.mjs')) && spawned.length && replied.length && sessionFacts.sessions?.some(s=>['result_ready','accepted'].includes(s.status) && replied.some(reply=>reply.sources?.includes(s.sessionId) && reply.meta?.verdictRef?.endsWith(':passed'))) && !readFileSync(path.join(project,'src/sum.mjs'),'utf8').includes('return values.reduce((a,b) => a+b);')) {
      try { execFileSync(process.execPath, ['--test'], { cwd: project, stdio: 'pipe', timeout: 10000 }); finished = true; } catch {}
    }
    const progress = JSON.stringify({ turns: turns.length, calls: calls.map(call=>call.name), replies: replied.length });
    if (progress !== lastEvent) { console.log(progress); lastEvent = progress; }
    if (finished && !await page.locator('.bot-live-reply').count() && (!largeHistory || Date.now()-start >= 120000)) break;
    const composer = page.locator('.bot-composer textarea');
    if (await composer.isVisible()) {
      await composer.click(); const keyAt = performance.now(); await composer.press('a');
      await page.evaluate(() => new Promise(requestAnimationFrame)); keyRoundTrips.push(performance.now()-keyAt);
      report.interactions++; if (report.interactions % 12 === 0) await composer.fill('');
    }
    const scroller = page.locator('.bot-thread'), box = await scroller.boundingBox();
    const beforeTop = await scroller.evaluate(node => node.scrollTop);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const wheelAt = performance.now(); await page.mouse.wheel(0, beforeTop > 180 ? -120 : 120);
    await page.evaluate(() => new Promise(requestAnimationFrame)); wheelRoundTrips.push(performance.now()-wheelAt);
    const afterTop = await scroller.evaluate(node => node.scrollTop); scrollChanges.push(Math.abs(afterTop-beforeTop));
    if (!drawerOpened) {
      for (const selector of ['.bot-background-work:not([open]) > summary','.bot-work-row:not([open]) > summary']) { const trigger=page.locator(selector).first(); if(await trigger.isVisible()) await trigger.click(); }
    }
    if (!drawerOpened && await page.getByRole('button', { name: /查看任务详情/ }).count()) {
      await page.getByRole('button', { name: /查看任务详情/ }).last().click(); drawerOpened = true;
    }
    if (drawerOpened && report.interactions % 10 === 0) { const close = page.getByRole('button', { name: '关闭', exact: true }); if (await close.count()) await close.last().click(); }
    await pause(largeHistory ? 150 : 450);
  }
  await page.screenshot({ path: path.join(root, 'real-task.png') });
  report.taskPassed = finished; report.taskDrawerOpened = drawerOpened;
  const doneSessions = await page.evaluate(workspaceId=>window.peerAgent.projectAgentListSessions({workspaceId}),bot.workspaceId);
  report.sessions=doneSessions.sessions?.map(s=>({sessionId:s.sessionId,status:s.status,conversationId:s.conversationId}));
  for(const session of doneSessions.sessions||[]) {
    if (report.historyScale?.sessions.some(row => row.sessionId === session.sessionId)) continue;
    const view=await page.evaluate(id=>window.peerAgent.conversationsGet({id}),session.conversationId);
    report.frozenEffort={worker:session.origin?.modelSelection?.worker?.reasoningEffort,conversation:view.effort};
    assert.equal(view.effort,session.origin.modelSelection.worker.reasoningEffort);
  }
  if(finished) {
    if (largeHistory) report.largeTerminal = await app.evaluate(async ({ app }, { home, id }) => {
      const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const store = require('@peer-agent/conversation-store').createConversationStore({ storeDir: home + '/conversations' });
      const at = performance.now(); const receipt = await store.commitStreamingMessage(id, 'scale-report', { content: 'Synthetic historical report after a durable performance test commit.' });
      return { durationMs: performance.now()-at, messageId: receipt.messageId, contentRevision: receipt.contentRevision };
    }, { home, id: report.historyScale.sessions[0].conversationId });
    const send=async text=>{const composer=page.locator('.bot-composer textarea');await composer.fill(text);await composer.press('Enter');};
    const list=()=>page.evaluate(workspaceId=>window.peerAgent.projectAgentListSessions({workspaceId,limit:20}),bot.workspaceId);
    const oldIds=new Set(doneSessions.sessions.map(s=>s.sessionId));
    await send('再开一个独立只读子任务用于取消验收：执行 node -e "setTimeout(()=>console.log(123),60000)"，然后读取 README.md 汇报。只读，不修改文件。我会主动取消这项任务。');
    const pending=await until(list,value=>value.sessions?.some(s=>!oldIds.has(s.sessionId)&&s.status==='running'),120000);
    const cancelSession=pending.sessions.find(s=>!oldIds.has(s.sessionId)&&s.status==='running');
    const cancelled=await page.evaluate(params=>window.peerAgent.projectAgentCancelSession(params),{sessionId:cancelSession.sessionId,workspaceId:bot.workspaceId,reason:'User cancels isolated performance acceptance task'});
    assert.equal(cancelled.ok,true);
    await until(list,value=>value.sessions.some(s=>s.sessionId===cancelSession.sessionId&&s.status==='cancelled'),30000);
    const recoveryAt=new Date().toISOString();
    await send('上一项取消是我的主动操作，不要重跑它。现在只需回复 CANCEL_RECOVERY_OK，说明已取消并能继续对话，不要开新任务。');
    await until(()=>rows(transcriptFile),value=>value.some(r=>r.kind==='agent_reply'&&r.createdAt>=recoveryAt&&r.content?.includes('CANCEL_RECOVERY_OK')),120000);
    report.cancelRecovery={cancelled:true,oldTaskReplayed:false,replied:true,sessionId:cancelSession.sessionId};
    const after=await list();assert.equal(after.sessions.find(s=>s.sessionId===cancelSession.sessionId).status,'cancelled');
  }
  report.elapsedMs = Date.now()-start;
  const perf = await page.evaluate(() => { const s=globalThis.executionPerf; s.stop=true;s.observer.disconnect();return { frames:s.frames,inputs:s.inputs,wheels:s.wheels,longTasks:s.longTasks, mountedRows:document.querySelectorAll('[data-conversation-row]').length, hidden:document.hidden,focused:document.hasFocus(),avatars:[...document.querySelectorAll('.bot-avatar')].map(n=>({animated:n.dataset.avatarAnimated, animation:getComputedStyle(n).animationName})) }; });
  report.mainLoop = await app.evaluate(() => { const h=globalThis.executionMainLoop; h.disable(); return { p95:h.percentile(95)/1e6,p99:h.percentile(99)/1e6,max:h.max/1e6 }; });
  report.interaction = { keyRoundTripMs:distribution(keyRoundTrips), wheelRoundTripMs:distribution(wheelRoundTrips), scrollMovedSamples:scrollChanges.filter(n=>n>0).length,
    scope:'Automation dispatch through Browser and renderer to rAF, includes transport cost, not hardware latency. Wheel events target the actual bot-thread scroller.' };
  report.renderer = { frames: distribution(perf.frames), inputPaintMs: distribution(perf.inputs), wheelPaintMs:distribution(perf.wheels), longTasks: perf.longTasks, mountedRows:perf.mountedRows, hidden:perf.hidden, focused:perf.focused, avatars:perf.avatars };
  const cpuEnd = await metrics(); report.cpu = cpuEnd.map(m => ({ type:m.type,cpuPercent:100000*(m.cpu-(cpuStart.find(p=>p.pid===m.pid)?.cpu ?? m.cpu))/report.elapsedMs }));
  const history = rows(transcriptFile); report.toolCalls = history.filter(r=>r.kind==='agent_turn').flatMap(t=>t.rounds?.flatMap(r=>r.toolCalls?.map(c=>c.name)||[])||[]);
  report.sessionsFile = existsSync(sessionsFile) ? sessionsFile : null;
  report.ok = finished && drawerOpened && report.cancelRecovery?.replied === true && report.interactions >= 5 && report.renderer.inputPaintMs.p95 < 100 && report.renderer.frames.p95 < 32 && report.pageErrors.length === 0;
  if (largeHistory) report.ok &&= report.historyScale.actualPlans >= 1100 && report.historyScale.parentBytes >= 9_500_000
    && report.historyScale.childBytes >= 46_300_000 && report.historyScale.journalBytes >= 185_000_000
    && report.elapsedMs >= 120000 && report.interactions >= 100 && report.interaction.scrollMovedSamples >= 100
    && report.interaction.keyRoundTripMs.p95 < 100 && report.interaction.keyRoundTripMs.p99 < 200 && report.interaction.keyRoundTripMs.max < 500
    && report.interaction.wheelRoundTripMs.p95 < 100 && report.renderer.wheelPaintMs.p95 < 100;
} catch (error) { report.ok=false; report.error=error.stack || error.message; }
finally {
  if (page && !report.renderer) {
    try {
      const perf = await page.evaluate(() => { const s=globalThis.executionPerf; if(!s)return null;s.stop=true;s.observer.disconnect();
        return {frames:s.frames,inputs:s.inputs,wheels:s.wheels,longTasks:s.longTasks,hidden:document.hidden,focused:document.hasFocus()}; });
      if (perf) {
        report.renderer = {frames:distribution(perf.frames),inputPaintMs:distribution(perf.inputs),wheelPaintMs:distribution(perf.wheels),longTasks:perf.longTasks,hidden:perf.hidden,focused:perf.focused};
        report.interaction = {keyRoundTripMs:distribution(keyRoundTrips),wheelRoundTripMs:distribution(wheelRoundTrips),scrollMovedSamples:scrollChanges.filter(n=>n>0).length};
        report.elapsedMs = Date.now()-Date.parse(report.taskStartedAt);
      }
    } catch(error) { report.perfCaptureError=error.message; }
  }
  if (app) await app.close().catch(()=>{});
  for (const file of ['credentials.vault.json','credentials.vault.lock','device-identity.json','llm-providers.json']) rmSync(path.join(home,file),{force:true});
  report.credentialCopiesRemoved = true; report.finishedAt=new Date().toISOString();
  writeFileSync(arg('--output') || path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report)); if (!report.ok) process.exitCode=1;
}
