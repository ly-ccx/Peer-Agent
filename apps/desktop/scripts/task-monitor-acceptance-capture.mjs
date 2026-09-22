import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Captures production Electron UI. No HTML/CSS replacement or renderer data mocks.
export async function captureAcceptance({ page, app, root, workspace, other, matrixConversations }) {
  const output = path.join(root, 'acceptance');
  await mkdir(output, { recursive: true });
  const manifest = { capturedAt: new Date().toISOString(), source: 'current production Electron main and freshly built renderer',
    fixtureNotice: '隔离测试会话；Skill/MCP 为预置调用历史，资料为测试文件和本地网页；后台命令真实执行。未连接用户日常会话。', scenes: [] };
  const rail = page.locator('.task-monitor-rail');
  const panel = page.locator('.workbench-panel--open');
  async function select(id) {
    if (await panel.count()) await page.keyboard.press('Meta+Backslash');
    const row = page.locator(`[data-conversation-id="${id}"]`);
    await row.waitFor({ state: 'attached' });
    const group = row.locator('xpath=ancestor::div[contains(@class,"sidebar-workspace-node")][1]').locator('.sidebar-workspace-row').first();
    if (await group.getAttribute('aria-expanded') === 'false') await group.click();
    await row.click();
    const toggle = page.locator('.chat-task-monitor-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await rail.waitFor();
  }
  async function shot(id, title, description) {
    await page.waitForTimeout(350);
    const file = `${id}.png`;
    await page.screenshot({ path: path.join(output, file) });
    const text = await rail.innerText();
    await writeFile(path.join(output, `${id}.txt`), text);
    manifest.scenes.push({ id, title, description, file, source: 'current-code', viewport: page.viewportSize(), cardText: text });
  }
  await page.evaluate(() => window.peerAgent.setLocale('zh'));
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await select(other.id);
  const result = await app.evaluate(async (_, id) => globalThis.monitorSmoke.exec(
    "printf '界面验收：后台任务运行中\\n'; while [ ! -f acceptance-finish ]; do sleep 1; done; printf '界面验收：任务已结束\\n'", id, true), other.id);
  assert.ok(result.success, 'real capture task starts successfully');
  const runs = rail.locator('section[aria-label="后台任务"]');
  await runs.locator('.task-monitor-row').first().waitFor();
  await shot('default', '中文默认卡片', '环境默认收起；来源含真实测试附件和预置调用记录，运行区展示真实后台命令。当前场景没有产物，因此产出显示空态，不伪造任务产物。');
  await runs.locator('.task-monitor-row').first().click();
  await runs.locator('.background-run-detail').waitFor();
  const detail = runs.locator('.background-run-detail');
  // Check actual computed inheritance at default and enlarged root font sizes.
  // Restore the preference before screenshots; this is not screenshot styling.
  const typography = [];
  const originalRootSize = await page.evaluate(() => document.documentElement.style.fontSize);
  try {
    for (const rootSize of [16, 18]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
      const measured = await detail.evaluate(el => {
        const size = selector => parseFloat(getComputedStyle(el.querySelector(selector)).fontSize);
        return { title: size('h3'), source: size(':scope > p'), summary: size('summary'),
          button: size('.background-run-stop'), meta: size('.background-run-meta') };
      });
      for (const key of ['title', 'source', 'summary', 'button']) assert.equal(measured[key], rootSize * 13 / 16, `${key} at root ${rootSize}`);
      assert.equal(measured.meta, rootSize * 12 / 16, `meta at root ${rootSize}`);
      typography.push({ rootSize, ...measured });
    }
  } finally {
    await page.evaluate(size => { document.documentElement.style.fontSize = size; }, originalRootSize);
  }
  await writeFile(path.join(output, 'typography.json'), JSON.stringify(typography, null, 2));
  const disclosures = detail.locator('details');
  await disclosures.nth(0).locator('summary').click();
  assert.equal(await disclosures.nth(0).evaluate(el => el.open), true);
  assert.equal(await detail.locator('summary svg').count(), 4);
  await detail.locator('.background-run-output').scrollIntoViewIfNeeded();
  await shot('running', '运行详情与日志', '展开真实命令与日志；统一 SVG 图标，输出来自实际后台进程。');
  await disclosures.nth(0).locator('summary').click();
  await disclosures.nth(1).locator('summary').click();
  await disclosures.nth(1).scrollIntoViewIfNeeded();
  await shot('technical', '展开技术信息', '工作目录、运行标识和日志证据按需查看，不再重复堆放命令。');
  await disclosures.nth(1).locator('summary').click();
  await detail.getByRole('button', { name: '停止…', exact: true }).click();
  const cancel = detail.getByRole('button', { name: '取消', exact: true });
  assert.equal(await cancel.evaluate(el => el === document.activeElement), true);
  await detail.locator('.background-run-confirm').scrollIntoViewIfNeeded();
  await shot('stop-confirm', '停止前确认', '默认聚焦取消；明确停止不会撤销已写入文件。截图后取消，未发送停止请求。');
  await cancel.click();
  assert.equal(await detail.locator('.background-run-confirm').count(), 0);
  await writeFile(path.join(workspace, 'acceptance-finish'), 'finish\n');
  await runs.waitFor({ state: 'detached', timeout: 20000 });
  await shot('ended', '任务结束后', '后台命令自然结束，实时运行区消失；来源仍保留。');
  const git = matrixConversations.find((item) => item.kind === 'git');
  await select(git.id);
  await rail.locator('.task-monitor-environment-summary').click();
  await rail.getByRole('button', { name: '环境设置', exact: true }).click();
  await rail.locator('.pa-dropdown-trigger').first().waitFor();
  await shot('environment', 'Git 环境设置', '临时真实 Git 仓库；主动展开环境详情与设置，不执行分支切换。');
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.keyboard.press('Meta+Backslash');
  await panel.waitFor();
  await shot('narrow', '窄窗口双面板', '1000px 窗口同时打开信息卡与 Workbench，展示当前生产布局的上下让位。');
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('ACCEPTANCE_CAPTURE', output);
  return output;
}
