import { openTaskInspector, taskEntry } from './bot-work-panel-checks.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';

/** Controlled host facts through production IPC/renderer; cognition and execution are tested separately. */
export async function checkBotCoordination({page,until,report,captureDirectory,commandFile}) {
  const initial=JSON.parse(readFileSync(commandFile,'utf8'));
  const viewport=page.viewportSize(), theme=await page.evaluate(()=>document.documentElement.dataset.theme);
  let seq=initial.seq;
  const base={...initial.sessions[0],title:'检查气泡圆角',report:undefined,statusLabel:''};
  const replacement={...base,sessionId:'rc-coordination-corrected',title:'检查引用卡片圆角',status:'running'};
  const update=patch=>{writeFileSync(commandFile+'.next',JSON.stringify({...initial,...patch,seq:++seq}));renameSync(commandFile+'.next',commandFile);};
  const cases=[];
  const workspace = page.locator('.bot-task-workspace');
  for (const [width,appearance] of [[1280,'dark'],[760,'light']]) {
    await page.setViewportSize({width,height:850}); await page.evaluate(value=>{document.documentElement.dataset.theme=value;},appearance);
    for (const state of ['stopping','awaiting_outcome','cancelled','handoff']) {
      const coordination={operationId:'adjustment-one',action:state==='handoff'?'handoff':'replace',phase:state==='cancelled'?'completed':state==='awaiting_outcome'?'awaiting_outcome':'stopping',
        reason:'根据补充说明，检查对象改为引用卡片，保留已经做过的检查。',goalRevision:2,priorSessionId:base.sessionId,
        ...(state==='cancelled'?{replacementSessionId:replacement.sessionId,replacementTitle:replacement.title}:{})};
      update({sessions:[{...base,status:state==='handoff'?'starting':state,coordination},replacement]});
      const row = await taskEntry(page, base, { history: state === 'cancelled' });
      await row.click();
      const label = state === 'handoff' ? '正在接手' : state === 'stopping' ? '正在停止' : state === 'cancelled' ? '已取消' : '执行结果待核实';
      await until(() => workspace.locator('.bot-task-status-pill').innerText(), text => text === label);
      const inspector = await openTaskInspector(page);
      assert.equal(await inspector.locator('.bot-task-question').count(), 0);
      await inspector.getByRole('tab', { name: '边界与信息', exact: true }).click();
      const info = inspector.locator('.bot-inspector-scope');
      await until(() => info.innerText(), text => text.includes('调整记录'));
      if (state === 'stopping') assert.equal(await workspace.getByRole('button', { name: '正在停止…', exact: true }).isDisabled(), true);
      if (state === 'awaiting_outcome') assert.match(await info.innerText(), /核实前不会重复执行/);
      if (state === 'cancelled') assert.match(await info.innerText(), /后续任务：检查引用卡片圆角/);
      await page.screenshot({ path: path.join(captureDirectory, `coordination-${state}-${width}-${appearance}.png`), animations: 'disabled' });
      if (state === 'cancelled') {
        await inspector.getByRole('button', { name: '后续任务：检查引用卡片圆角', exact: true }).click();
        await workspace.getByRole('heading', { name: replacement.title, exact: true }).waitFor();
      }
      await page.locator('.bot-crumb-parent').click();
      await workspace.waitFor({ state: 'hidden' });
      cases.push({state,width,appearance,truthful:true,relationship:state==='cancelled',humanQuestionAbsent:true});
    }
  }
  update({sessions:initial.sessions}); await page.setViewportSize(viewport); await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  report.autonomousCoordination={cases,scope:'Production renderer and IPC with isolated host facts; no real model or installed build'};
}
