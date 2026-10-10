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
  await until(()=>page.locator('.bot-drawer-dock').count(),count=>count===0);
  for (const [width,appearance] of [[1280,'dark'],[760,'light']]) {
    await page.setViewportSize({width,height:850}); await page.evaluate(value=>{document.documentElement.dataset.theme=value;},appearance);
    for (const state of ['stopping','awaiting_outcome','cancelled','handoff']) {
      const coordination={operationId:'adjustment-one',action:state==='handoff'?'handoff':'replace',phase:state==='cancelled'?'completed':state==='awaiting_outcome'?'awaiting_outcome':'stopping',
        reason:'根据补充说明，检查对象改为引用卡片，保留已经做过的检查。',goalRevision:2,priorSessionId:base.sessionId,
        ...(state==='cancelled'?{replacementSessionId:replacement.sessionId,replacementTitle:replacement.title}:{})};
      update({sessions:[{...base,status:state==='handoff'?'starting':state,coordination},replacement]});
      await page.locator('.bot-profile').click();
      await page.getByRole('tab',{name:'任务',exact:true}).click();
      if (await page.locator('.bot-task-detail').count()) await page.getByRole('button',{name:'任务列表',exact:true}).click();
      await until(()=>page.locator('.bot-task-row').filter({hasText:base.title}).count(),count=>count===1);
      await page.locator('.bot-task-row').filter({hasText:base.title}).click();
      const detail=page.locator('.bot-task-detail');
      const label=state==='handoff'?'正在接手':state==='stopping'?'正在停止':state==='cancelled'?'已取消':'执行结果待核实';
      await until(()=>detail.locator('.bot-task-status').innerText(),text=>text===label);
      const info=detail.locator('.bot-task-information');
      if (await info.getAttribute('open')===null) await info.locator(':scope > summary').click();
      await until(()=>info.getAttribute('open'),value=>value!==null);
      await until(()=>info.innerText(),value=>value.includes('调整记录'));
      assert.match(await info.innerText(),/调整记录/);
      assert.equal(await detail.locator('.bot-task-question').count(),0);
      if (state==='stopping') assert.equal(await detail.locator('.bot-task-cancel button').isDisabled(),true);
      if (state==='awaiting_outcome') assert.match(await info.innerText(),/核实前不会重复执行/);
      if (state==='cancelled') assert.match(await info.innerText(),/后续任务：检查引用卡片圆角/);
      await page.screenshot({path:path.join(captureDirectory,`coordination-${state}-${width}-${appearance}.png`),animations:'disabled'});
      if (state==='cancelled') {
        await detail.getByRole('button',{name:'后续任务：检查引用卡片圆角',exact:true}).click();
        await until(()=>detail.locator('h2').innerText(),text=>text===replacement.title);
      }
      cases.push({state,width,appearance,truthful:true,relationship:state==='cancelled',humanQuestionAbsent:true});
      await page.getByRole('button',{name:'关闭',exact:true}).click();
      await until(()=>page.locator('.bot-drawer-dock').count(),count=>count===0);
    }
  }
  update({sessions:initial.sessions}); await page.setViewportSize(viewport); await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  report.autonomousCoordination={cases,scope:'Production renderer and IPC with isolated host facts; no real model or installed build'};
}
