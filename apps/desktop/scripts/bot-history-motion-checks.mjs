import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';

/** Only disposable fixture history is written; production readers and continuation remain real. */
export function seedHistoryFixtures({ home }) {
  assert.equal(JSON.parse(readFileSync(path.join(home, 'rc-fixture.json'), 'utf8')).fixture, true);
  const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const titles = ['提交引用改动', '本机公证试包', '诊断继续按钮反复失败', '调整模型与推理强度',
    '提交空态标签栏改动', '实机验证思考档位', '首页工作台布局', '实测 MiMo 对话请求',
    '提交置顶条与浮层修复', '提交任务卡片改动', '核对历史记录与完成情况', '优化文件读取过程'];
  const rows = Array.from({ length: 48 }, (_, index) => {
    const meta = store.createConversation({ title: titles[index] ?? `历史讨论 ${index + 1}`, mode: 'chat' });
    store.appendMessage(meta.id, { id: `history-user-${index}`, role: 'user', content: '请保留之前的讨论，继续完善交互细节。' });
    store.appendMessage(meta.id, { id: `history-assistant-${index}`, role: 'assistant', content: '**下一步**\n\n先核对原有交互，再根据实机表现调整。这是隔离测试的历史预览。' });
    const date = new Date(); date.setDate(date.getDate() - (index < 2 ? 0 : index < 4 ? 1 : index < 12 ? 3 : 10)); date.setHours(14, 58 - index, 0, 0);
    return { ...meta, updatedAt: date.toISOString() };
  });
  const file = path.join(home, 'conversations', 'index.jsonl');
  const fixtures = new Map(rows.map(row => [row.id, row]));
  const index = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  writeFileSync(file, index.map(row => JSON.stringify({ ...row, ...(fixtures.has(row.id) ? { updatedAt: fixtures.get(row.id).updatedAt } : {}) })).join('\n') + '\n');
  return rows;
}

export function instrumentHistoryReads(source) {
  const seam = 'function listHistory(payload = {}) {';
  assert.equal(source.split(seam).length, 2, 'exact existing history projection seam required');
  return source.replace(seam, `function listHistory(payload = {}) {
    const rcHistoryMode = globalThis.rcHistoryReadMode;
    if (rcHistoryMode === 'unavailable') return { ok: false, code: 'NOT_FOUND' };
    if (rcHistoryMode === 'empty') return { ok: true, history: [], goals: [] };`);
}

export async function checkBotHistoryMotion({ page, until, report, captureDirectory, commandFile, fixtureRows, workspaceId, home }) {
  const checks = report.historyMotion = [];
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (await page.locator('.bot-drawer-body').isVisible()) await page.getByRole('button', { name: '关闭', exact: true }).click();
  const initial = JSON.parse(readFileSync(commandFile, 'utf8')); let seq = initial.seq;
  const changeHistory = async mode => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, historyReadMode: mode }));
    renameSync(commandFile + '.next', commandFile);
    // The fixture observes the command before the next genuine UI read.
    await until(() => page.evaluate(() => window.peerAgent.projectAgentListHistory({ unscoped: true })), result => mode === 'unavailable' ? !result.ok : mode === 'empty' ? result.history?.length === 0 : result.history?.length === 48);
  };
  const openHistory = async () => {
    await page.locator('.bot-app-menu-button').click();
    await page.getByRole('menuitem', { name: '历史对话', exact: true }).click();
    await page.locator('.bot-history-sheet').waitFor();
    await until(() => page.locator('.bot-history-sheet').evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length), count => count === 0);
  };
  const closeHistory = async () => {
    await page.locator('.bot-history-sheet .bot-sheet-close').click();
    await page.locator('.bot-history-sheet').waitFor({ state: 'detached' });
  };
  await changeHistory('normal'); await openHistory();
  const sheet = page.locator('.bot-history-sheet'); const search = sheet.getByRole('searchbox');
  await until(() => sheet.locator('.bot-history-row').count(), count => count === 40);
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await sheet.locator('.bot-history-group h3').allTextContents(), ['今天', '昨天', '最近 7 天', '更早']);
  assert.equal(await sheet.locator('.bot-sheet-choice').count(), 0);
  assert.equal(await sheet.locator('.bot-history-row').first().evaluate(node => getComputedStyle(node).borderWidth), '0px');
  const headerTop = await sheet.locator('.bot-sheet-head').evaluate(node => node.getBoundingClientRect().top);
  await sheet.locator('.bot-history-results').evaluate(node => { node.scrollTop = 700; });
  assert.equal(await sheet.locator('.bot-sheet-head').evaluate(node => node.getBoundingClientRect().top), headerTop);
  await sheet.getByRole('button', { name: '显示更多对话', exact: true }).click();
  await until(() => sheet.locator('.bot-history-row').count(), count => count === 48);
  await sheet.locator('.bot-history-results').evaluate(node => { node.scrollTop = 0; });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const palette = await page.evaluate(() => document.documentElement.dataset.palette);
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.dataset.palette = 'frost'; }, value);
    await sheet.screenshot({ path: path.join(captureDirectory, `history-${value}.png`) });
  }
  checks.push('real history projection renders grouped compact rows, bounds 40 rows then reveals 48, and keeps the header stationary while scrolling');
  await search.fill('mimo');
  await until(() => sheet.locator('.bot-history-row').count(), count => count === 1);
  assert.match(await sheet.locator('.bot-history-row').textContent(), /MiMo/);
  await search.fill('不存在的对话标题'); assert.match(await sheet.locator('.bot-history-empty').innerText(), /没有匹配的对话标题/);
  await sheet.getByRole('button', { name: '清除搜索', exact: true }).click();
  assert.equal(await search.inputValue(), ''); assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await search.fill('引用'); await search.press('ArrowDown');
  assert.equal(await sheet.locator('.bot-history-row').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await until(() => sheet.locator('.bot-history-line').count(), count => count === 2);
  assert.deepEqual(await sheet.locator('.bot-history-line > span').allTextContents(), ['你', '机器人']);
  assert.equal(await sheet.locator('.bot-history-line[data-role="assistant"] strong').textContent(), '下一步');
  assert.equal(await sheet.locator('.bot-history-line').evaluateAll(nodes => nodes[0].getBoundingClientRect().right > nodes[1].getBoundingClientRect().left), true);
  await sheet.screenshot({ path: path.join(captureDirectory, 'history-preview.png') });
  await sheet.getByRole('button', { name: '返回历史列表', exact: true }).click();
  assert.equal(await search.inputValue(), '引用');
  assert.equal(await sheet.locator('.bot-history-row').evaluate(node => node === document.activeElement), true);
  checks.push('title search, honest no-match, SVG clear, keyboard opening and preview/back retain the query and selected-row focus');

  const viewport = page.viewportSize(); const font = await page.evaluate(() => document.documentElement.style.fontSize);
  await search.fill(''); await page.setViewportSize({ width: 390, height: 740 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
  assert.equal(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  const rect = await sheet.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= 390);
  await sheet.screenshot({ path: path.join(captureDirectory, 'history-narrow-large.png') });
  await page.evaluate(font => { document.documentElement.style.fontSize = font; }, font); await page.setViewportSize(viewport);
  await closeHistory();
  assert.equal(await page.locator('.bot-app-menu-button').evaluate(node => node === document.activeElement), true);
  await changeHistory('unavailable'); await openHistory();
  await until(() => sheet.locator('.bot-history-empty').innerText(), text => text.includes('暂时无法读取历史对话'));
  assert.equal(await sheet.locator('.bot-history-row').count(), 0);
  await changeHistory('normal'); await sheet.getByRole('button', { name: '重试', exact: true }).click();
  await until(() => sheet.locator('.bot-history-row').count(), count => count === 40); await closeHistory();
  await changeHistory('empty'); await openHistory();
  await until(() => sheet.locator('.bot-history-empty').innerText(), text => text.includes('没有可继续的历史对话'));
  await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'detached' });
  await changeHistory('normal');
  checks.push('light/dark and 390px large type fit; transient read failure can retry, true empty stays distinct, close/Escape restore the app-menu focus');

  await page.evaluate(({ theme, palette }) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = palette; }, { theme, palette });
  const background = page.locator('.bot-background-work');
  await background.waitFor();
  assert.equal(await background.locator(':scope > summary > svg').count(), 1);
  assert.equal(await background.locator(':scope > summary').evaluate(node => getComputedStyle(node, '::after').content), 'none');
  const samples = report.disclosureFrames = {};
  const cast = await page.context().newCDPSession(page);
  const frameDir = path.join(captureDirectory, 'disclosure-cast'); mkdirSync(frameDir);
  let frameIndex = 0;
  const frameTimes = [];
  const box = await background.boundingBox();
  report.disclosureCaptureRect = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 190), width: box.width + 16, height: box.height + 206 };
  cast.on('Page.screencastFrame', frame => {
    const file = `${String(frameIndex++).padStart(4, '0')}.png`;
    writeFileSync(path.join(frameDir, file), Buffer.from(frame.data, 'base64'));
    frameTimes.push({ file, timestamp: frame.metadata.timestamp });
    void cast.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cast.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  samples.outerOpen = await recordDisclosure(background, true);
  const work = background.locator('.bot-work-row').first();
  samples.innerOpen = await recordDisclosure(work, true);
  samples.innerClose = await recordDisclosure(work, false);
  await work.locator(':scope > summary').focus(); await page.keyboard.press('Tab');
  assert.equal(await work.locator('.bot-work-detail button').evaluate(node => node === document.activeElement), false);
  samples.outerClose = await recordDisclosure(background, false);
  samples.reverse = await recordDisclosure(background, true, true);
  await cast.send('Page.stopScreencast'); await cast.detach();
  report.disclosureCastFrames = frameIndex;
  writeFileSync(path.join(frameDir, 'timeline.json'), JSON.stringify(frameTimes));
  assert.equal(await background.getAttribute('open'), null);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await background.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await background.getAttribute('open'), '');
  assert.equal(await background.evaluate(node => getComputedStyle(node, '::details-content').transitionDuration), '0s');
  await page.keyboard.press('Enter'); assert.equal(await background.getAttribute('open'), null);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('outer and inner task details interpolate opening and closing through real height frames, rotate SVG, reverse without jumps and exclude closed actions from Tab; reduced motion switches directly');

  await openHistory(); await search.fill('引用'); await sheet.locator('.bot-history-row').click();
  await until(() => sheet.locator('.bot-history-line').count(), count => count === 2);
  const picker = sheet.getByRole('button', { name: '选择机器人', exact: true });
  await picker.click(); await page.getByRole('option', { name: 'project-000', exact: true }).click();
  const historyId = fixtureRows[0].id;
  const inputFile = path.join(home, 'project-runtime', workspaceId, 'input-queue.jsonl');
  const readInputs = () => readFileSync(inputFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const beforeInputs = readInputs().filter(input => input.historyRef === historyId).length;
  const original = await page.evaluate(id => window.peerAgent.conversationsGet({ id }), historyId);
  await sheet.getByRole('button', { name: '交给这个机器人继续', exact: true }).click();
  await until(async () => ({ confirmation: await sheet.locator('.bot-history-confirm').count(), shown: await sheet.count() }), state => state.confirmation === 1 || state.shown === 0);
  if (await sheet.count()) await sheet.getByRole('button', { name: '仍然继续', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  const inputs = await until(() => readInputs().filter(input => input.historyRef === historyId), rows => rows.length === beforeInputs + 1);
  const input = inputs.at(-1); assert.equal(input.workspaceId, workspaceId); assert.ok(input.historySnapshotId);
  await until(() => page.evaluate(workspaceId => window.peerAgent.projectAgentReadConversation({ workspaceId, latest: true }), workspaceId), result => result.messages.some(message => message.id === `input-${input.inputId}`));
  const retained = await page.evaluate(id => window.peerAgent.conversationsGet({ id }), historyId);
  assert.deepEqual(retained.messages, original.messages);
  assert.equal(retained.contentRevision, original.contentRevision);
  checks.push('preview bot picker uses SVG and the existing continuation IPC persists a canonical historical input in the selected bot; background confirmation remains governed');
}

async function recordDisclosure(locator, open, reverse = false) {
  const expectedClicks = reverse ? 2 : 1;
  // Install before input, then sample a complete interval after the last real click.
  // Remote Playwright dispatch time must not consume the closing observation window.
  await locator.evaluate((node, expectedClicks) => {
    node.__rcDisclosureCapture = new Promise(resolve => {
      const samples = []; const start = performance.now(); const summary = node.querySelector(':scope > summary');
      let lastClick = null, clicks = 0, raf = 0;
      const mark = () => { lastClick = performance.now(); clicks += 1; };
      const finish = timedOut => {
        clearTimeout(timeout); cancelAnimationFrame(raf); summary.removeEventListener('click', mark);
        resolve({ samples, clicks, timedOut });
      };
      const timeout = setTimeout(() => finish(true), 6000);
      const frame = now => {
        const style = getComputedStyle(node, '::details-content');
        samples.push({ at: Math.round(now - start), height: node.getBoundingClientRect().height,
          opacity: style.opacity, visibility: style.contentVisibility, open: node.open,
          arrow: getComputedStyle(node.querySelector(':scope > summary > svg:last-child')).transform });
        if (clicks >= expectedClicks && now - lastClick >= 480) finish(false);
        else raf = requestAnimationFrame(frame);
      };
      summary.addEventListener('click', mark); raf = requestAnimationFrame(frame);
    });
  }, expectedClicks);
  const summary = locator.locator(':scope > summary'); await summary.click({ force: true });
  if (reverse) { await new Promise(resolve => setTimeout(resolve, 85)); await summary.click({ force: true }); }
  const capture = await locator.evaluate(node => node.__rcDisclosureCapture);
  await locator.evaluate(node => { delete node.__rcDisclosureCapture; });
  assert.equal(capture.timedOut, false, 'real disclosure input and observation complete within the bound');
  assert.equal(capture.clicks, expectedClicks, 'each intended native disclosure click occurred');
  const samples = capture.samples;
  const heights = samples.map(sample => sample.height), min = Math.min(...heights), max = Math.max(...heights);
  assert.ok(max - min > 8, 'native disclosure has a real size change');
  assert.ok(heights.some(height => height > min + 1 && height < max - 1), 'height transition contains intermediate frames');
  assert.ok(heights.slice(1).every((height, index) => Math.abs(height - heights[index]) < (max - min) * .8), 'reversal and collapse never jump the entire content height');
  assert.equal(samples.at(-1).open, reverse ? false : open);
  if (!open || reverse) assert.equal(samples.at(-1).visibility, 'hidden');
  return samples;
}
