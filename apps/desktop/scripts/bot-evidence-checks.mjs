import assert from 'node:assert/strict';
import path from 'node:path';

/** Source labels, saved facts and missing content through the real read-evidence IPC. */
export async function checkBotEvidence({ page, until, report, captureDirectory, context }) {
  const viewport = page.viewportSize() ?? await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  const theme = await page.locator('html').getAttribute('data-theme');
  const list = context.locator('.bot-evidence-list');
  await until(() => list.locator('strong').nth(1).textContent(), value => value === '查看工作会话');
  assert.equal(await list.locator('li').count(),20);
  assert.match(await list.innerText(), /读取文件[\s\S]*10月7日/);
  await page.locator('.bot-drawer-body').screenshot({animations:'disabled',path:path.join(captureDirectory,'evidence-list-dark.png')});
  const view = page.locator('.bot-evidence-view');
  const back = page.getByRole('button',{name:'返回回复详情',exact:true});
  const open = async index => {
    await list.locator('button').nth(index).click();
    await view.waitFor();
    assert.equal(await view.locator('details[open]').count(),0);
    assert.doesNotMatch(await view.innerText(), /tool-result:\/\/|NOT_FOUND|BODY_NOT_SAVED/);
  };
  const restore = async () => {
    await back.click(); await context.waitFor({state:'visible'});
    await until(()=>context.evaluate(node=>node.contains(document.activeElement)),Boolean);
  };
  await open(0);
  assert.equal(await view.getAttribute('data-availability'),'available');
  assert.match(await view.locator('.bot-evidence-content').innerText(), /README.md[\s\S]*验证结果/);
  await page.locator('.bot-drawer-body').screenshot({animations:'disabled',path:path.join(captureDirectory,'evidence-file-dark.png')});
  await restore(); await open(1);
  assert.match(await view.innerText(), /当时保存[\s\S]*只读熟悉 Peer-Agent[\s\S]*执行受阻/);
  await page.locator('.bot-drawer-body').screenshot({animations:'disabled',path:path.join(captureDirectory,'evidence-history-dark.png')});
  await restore(); await open(2);
  assert.equal(await view.getAttribute('data-availability'),'metadata_only');
  assert.match(await view.innerText(), /保留了来源，未保存详细内容[\s\S]*无法用于核对结论[\s\S]*返回回复详情/);
  await page.locator('.bot-drawer-body').screenshot({animations:'disabled',path:path.join(captureDirectory,'evidence-missing-dark.png')});
  await page.setViewportSize({width:760,height:820});
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await until(()=>page.locator('html').getAttribute('data-theme'),value=>value==='light');
  const fits=await view.evaluate(node=>node.scrollWidth<=node.clientWidth+1);
  assert.equal(fits,true);
  await page.screenshot({animations:'disabled',path:path.join(captureDirectory,'evidence-missing-760-light.png')});
  await page.setViewportSize(viewport);
  await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  await until(()=>page.locator('html').getAttribute('data-theme'),value=>value===theme);
  await restore(); await open(3);
  assert.equal(await view.getAttribute('data-availability'),'not_found');
  assert.match(await view.innerText(),/这条来源记录未找到/);
  await restore(); await open(4);
  assert.equal(await view.locator('.bot-evidence-content').innerText(),'回归通过：5 项检查完成。');
  await view.locator('summary').click();
  assert.match(await view.innerText(),/rc-evidence-4/);
  await restore();
  report.evidenceSources={namedSources:true,savedFile:true,exactHistory:true,missingBodyExplained:true,
    unknownRefDistinct:true,diagnosticsCollapsed:true,commandReadable:true,narrowFits:fits};
}
