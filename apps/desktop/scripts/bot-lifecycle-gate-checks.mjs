import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { decideLifecycle, projectWorkSession } from '@peer-agent/protocol';
import { createTaskOverviewAggregator, toGoalPlanSnapshot } from '../electron/main/task-overview-aggregator.mjs';

/** Production projections and renderer over explicit synthetic plan facts. */
export async function checkBotLifecycleGates({page, until, report, captureDirectory, commandFile}) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const viewport = page.viewportSize(), theme = await page.evaluate(() => document.documentElement.dataset.theme);
  let seq = initial.seq;
  const cases = [];
  for (const [width, appearance] of [[1280,'dark'],[760,'light']]) {
    await page.setViewportSize({width,height:780});
    await page.evaluate(value => {document.documentElement.dataset.theme=value;}, appearance);
    for (const [key, runnerStatus, expected] of [['budget','budget_exhausted','预算已耗尽'],['question','waiting_user','等待你的选择']]) {
      const now = new Date().toISOString(), workspacePath = '/synthetic-lifecycle';
      const plan = {planId:`lifecycle-${key}`,conversationId:'rc-task-scene-empty',title:`保留任务的${key==='budget'?'预算决策':'待回答问题'}`,
        status:'completed',createdAt:now,updatedAt:now,targetWorkspacePath:workspacePath,runner:{status:runnerStatus}};
      const snapshot = toGoalPlanSnapshot(plan, {executionOwnership:'unknown'});
      const decision = decideLifecycle(snapshot);
      const session = projectWorkSession(snapshot, {workspaceId:initial.workspaceId,sessionId:'rc-lifecycle-gate',
        origin:{anchorMessageId:'rc-message-9993'},spawnedAt:now,executionOwnership:'unknown'});
      const item = createTaskOverviewAggregator({
        goalPlanStore:{listPlanDetails:(options={})=>[plan].filter(row=>!options.candidateFilter||options.candidateFilter(row))},
        automationStore:{listDefinitions:()=>[],listRuns:()=>[]},listActiveStreams:()=>[],
        listConversations:()=>[{id:plan.conversationId,title:plan.title,workspacePath,updatedAt:now,lastReadAt:now}],
      }).listTaskOverview({activeWithinMs:0}).find(row=>row.source==='goal_plan');
      assert.ok(item, 'completed human gate survives the actual aggregator candidate filter');
      for (const field of ['statusLabel','actionRight','nextAction','cancelable']) {
        assert.equal(item[field], decision[field]); assert.equal(session[field], decision[field]);
      }
      assert.equal(session.status,'waiting_user'); assert.equal(session.statusLabel,expected); assert.equal(session.cancelable,true);
      const command = {...initial,seq:++seq,sessions:[session],detailReports:{},reportReadMode:'ready',conversationMessages:[]};
      writeFileSync(commandFile+'.next',JSON.stringify(command));renameSync(commandFile+'.next',commandFile);
      await page.getByRole('button', { name: '机器人设置', exact: true }).click();
      await page.getByRole('tab',{name:'任务',exact:true}).click();
      if (await page.locator('.bot-task-detail').count()) await page.getByRole('button',{name:'任务列表',exact:true}).click();
      const row = page.locator('.bot-task-row').filter({hasText:plan.title});
      await until(()=>row.innerText(),text=>text.includes(expected));
      assert.equal(await row.locator('xpath=ancestor::section[1]').locator('h2').innerText(),'需要你');
      assert.doesNotMatch(await row.innerText(),/已完成|已读/);
      await page.screenshot({path:path.join(captureDirectory,`lifecycle-${key}-list-${width}-${appearance}.png`),animations:'disabled'});
      await row.focus();await page.keyboard.press('Enter');
      const detail = page.locator('.bot-task-detail');
      await until(()=>detail.locator('.bot-task-progress-text').innerText(),text=>text===expected);
      assert.equal(await detail.getAttribute('data-status'),decision.status);
      assert.equal(await detail.getByRole('button',{name:`取消任务 ${plan.title}`,exact:true}).isVisible(),decision.cancelable);
      assert.doesNotMatch(await detail.innerText(),/已完成/);
      assert.equal(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
      await page.screenshot({path:path.join(captureDirectory,`lifecycle-${key}-detail-${width}-${appearance}.png`),animations:'disabled'});
      await page.getByRole('button',{name:'关闭',exact:true}).click();
      await detail.waitFor({state:'hidden'});
      await page.locator('.bot-drawer-body').waitFor({state:'hidden'});
      cases.push({key,width,appearance,listVisible:true,detailVisible:true,cancellationFromDecision:true,sameFacts:true});
    }
  }
  writeFileSync(commandFile+'.next',JSON.stringify({...initial,seq:++seq}));renameSync(commandFile+'.next',commandFile);
  if(viewport)await page.setViewportSize(viewport);
  await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  report.lifecycleGates={cases,scope:'Actual aggregator/protocol over synthetic plans and production task list/detail; no real plan mutation'};
}
