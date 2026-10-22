import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';

export async function checkBotProgressiveLoading({page,until,report,captureDirectory,commandFile}) {
  const original=JSON.parse(readFileSync(commandFile,'utf8'));let seq=original.seq;
  const mode=(interactionReadMode,silent=false)=>{writeFileSync(commandFile+'.next',JSON.stringify({...original,seq:++seq,interactionReadMode,silent}));renameSync(commandFile+'.next',commandFile);};
  const ids=()=>page.locator('[id^="bot-msg-"]').evaluateAll(nodes=>nodes.map(n=>n.id));
  // Keep the canonical visible text and DOM identity when optional task facts fail.
  const anchor=page.locator('[id^="bot-msg-"]').last();await anchor.waitFor();const id=await anchor.getAttribute('id');
  mode('cards');await page.getByText('任务状态暂不可用，已有对话仍可阅读。',{exact:true}).waitFor();
  assert.equal(await page.locator(`[id="${id}"]`).count(),1);assert.equal(await page.getByText('对话没有加载出来',{exact:true}).count(),0);
  await page.screenshot({path:path.join(captureDirectory,'conversation-cards-failed-dark.png')});
  mode('all');await page.getByText('新消息暂未刷新，已保留当前对话。',{exact:true}).waitFor();
  assert.equal(await page.locator(`[id="${id}"]`).count(),1);assert.ok((await ids()).length>0);
  await page.screenshot({path:path.join(captureDirectory,'conversation-refresh-failed-dark.png')});
  await page.locator('.bot-row').filter({has:page.locator('.bot-row-name',{hasText:'project-001'})}).click();
  await page.locator('.bot-row').filter({has:page.locator('.bot-row-name',{hasText:'project-000'})}).click();
  await page.getByText('对话没有加载出来',{exact:true}).waitFor();
  assert.equal(await page.getByText('任务状态暂不可用，已有对话仍可阅读。',{exact:true}).count(),0,'initial failure must not claim that prior messages are readable');
  await page.setViewportSize({width:760,height:780});await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await page.locator('.bot-thread-failed button').evaluate(async button=>{
    getComputedStyle(button).color;
    await Promise.all(button.getAnimations().map(animation=>animation.finished.catch(()=>{})));
  });
  await page.screenshot({path:path.join(captureDirectory,'conversation-initial-failed-light.png')});
  mode('',true);await until(()=>page.evaluate(workspaceId=>window.peerAgent.projectAgentReadConversation({workspaceId,view:'interactions',limit:1}),original.workspaceId),result=>result.ok);await page.getByRole('button',{name:'重试',exact:true}).click();
  await until(()=>page.locator('[id^="bot-msg-"]').count(),count=>count>0);
  await until(()=>page.locator('.bot-thread-error, .bot-thread-feedback').count(),count=>count===0);
  await page.screenshot({path:path.join(captureDirectory,'conversation-recovered-light.png')});
  // The next scenario needs normal task-change notifications again.
  mode('');
  report.progressiveLoading={cardsFailureKeepsMessages:true,refreshFailureKeepsMessages:true,initialFailureIsExplicit:true,retryRestoresMessages:true};
  await page.setViewportSize({width:1280,height:780});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
}
