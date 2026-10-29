import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs';
import {createProjectRelayFixture} from './testing/project-relay-fixture.mjs';

// Manual browser evidence, not part of a Node-only test run or physical-phone proof.
const output=mkdtempSync(path.join(os.tmpdir(),'peer-mobile-browser-'));
const executable=process.env.PEER_BROWSER_PATH??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium');
if(!existsSync(executable))throw Error('Set PEER_BROWSER_PATH to an installed Chromium browser.');
const f=await createProjectRelayFixture({scriptedReply:true});let browser;
const proof={viewport:{width:390,height:844},scope:'desktop Chromium at phone width; loopback HTTP + real paired WebSocket; scripted reply, no model',steps:[],pageErrors:[]};
try {
  browser=await chromium.launch({executablePath:executable,headless:true});
  const context=await browser.newContext({viewport:proof.viewport,colorScheme:'dark'});
  await context.addCookies([{name:'__Host-peer_session',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();page.on('pageerror',error=>proof.pageErrors.push(error.message));
  let loseFirst=true;const inputs=[];
  await page.route(f.origin+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const response=await f.request(url.pathname+url.search,{method:request.method(),body:request.postData()??undefined,
      cookie:request.headers().cookie?.split('__Host-peer_session=')[1]?.split(';')[0]??null,originHeader:request.headers().origin??f.origin});
    if(request.method()==='POST'&&url.pathname.endsWith('/input')){
      inputs.push(JSON.parse(request.postData()));if(loseFirst){loseFirst=false;assert.equal(response.status,200);
        await route.fulfill({status:504,contentType:'application/json',body:JSON.stringify({code:'OUTCOME_UNKNOWN'})});return;}
    }
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(f.origin+'/bots');await page.locator('.project-row').waitFor();
  assert.equal(await page.locator('.project-avatar').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:path.join(output,'list-390.png'),fullPage:true});proof.steps.push('authenticated bot list, SVG avatar, no horizontal overflow');
  await page.locator('.project-row').click();await page.locator('#chat-status').filter({hasText:'还没有对话'}).waitFor();
  await page.locator('#project-text').fill('手机入口测试，请核对项目说明。');await page.locator('#project-send').press('Enter');
  await page.locator('#input-status').filter({hasText:'可能已送达'}).waitFor();
  assert.equal(await page.locator('#project-text').getAttribute('readonly'),'');
  await page.locator('#project-send').click();await page.locator('.project-message.agent_reply').waitFor();
  assert.deepEqual(inputs[0],inputs[1]);assert.equal(f.history().filter(row=>row.kind==='user_input').length,1);
  proof.steps.push('actual HTTP receipt intentionally lost once; keyboard submit / same-ID retry / one durable input / scripted reply');
  await page.screenshot({path:path.join(output,'conversation-390.png'),fullPage:true});
  await page.locator('.project-tasks button').first().click();await page.locator('#project-task-detail').waitFor({state:'visible'});
  assert.match(await page.locator('#detail-summary').textContent(),/项目说明/);
  assert.equal(await page.locator('button').filter({hasText:'批准'}).count(),0);
  await page.screenshot({path:path.join(output,'task-390.png'),fullPage:true});proof.steps.push('safe task report; approval is desktop-only');
  await page.locator('#task-close').click();await page.locator('#project-logout').click();
  await page.locator('#project-login').waitFor({state:'visible'});assert.equal(await page.locator('.project-message').count(),0);
  proof.steps.push('logout clears private content');assert.deepEqual(proof.pageErrors,[]);proof.ok=true;
}finally{await browser?.close();await f.close();proof.finishedAt=new Date().toISOString();writeFileSync(path.join(output,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({output,ok:proof.ok,pageErrors:proof.pageErrors}));}
