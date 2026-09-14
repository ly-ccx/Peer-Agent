// Isolated geometry regression: loads production CSS, not the desktop runtime.
// Install desktop dependencies first. Optional PLAYWRIGHT_MODULE points to an
// existing playwright-core entry when running in a dependency-free worktree.
import './composer-chrome-layout-probe.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const css = ['chat-surface.css', 'goal-panel.css'].map(name => readFileSync(new URL(`../renderer/src/chat/styles/${name}`, import.meta.url), 'utf8')).join('\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  for (const variant of ['home', 'compact']) for (const width of [280, 360, 760]) for (const long of [false, true]) for (const scale of [1, 1.5]) {
    const name = `${variant}/${width}/${long ? 'long' : 'short'}/${scale}`;
    const title = long ? '设计远程连接ADR和工程展开后续实现'.repeat(4) : '当前任务';
    const model = long ? 'ChatGPT 订阅 · GPT-6 超长模型名称'.repeat(3) : 'GPT-6';
    await page.setContent(`<style>:root {font-size:${16 * scale}px; --composer-addon-height:1.75rem; --composer-addon-font-size:.8125rem; --ui-font-control:.8125rem; --ui-font-caption:.75rem; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px; --space-6:24px;} *{box-sizing:border-box} body{font-family:Arial} ${css}</style>
      <section style="width:${width}px">
      <div class="goal-panel goal-panel--docked"><button class="goal-panel-toggle"><span class="goal-panel-toggle-active"><span class="goal-panel-toggle-active-dot"></span><span class="goal-panel-toggle-summary"><span id="title" class="goal-panel-toggle-active-title">${title}</span><span id="activity" class="goal-panel-current-activity">${long ? '正在执行自动化任务'.repeat(5) : '执行中'}</span></span><span class="goal-panel-toggle-active-progress">1/4</span></span><span>⌄</span></button></div>
      <form class="chat-composer chat-composer--${variant}"><textarea placeholder="输入消息"></textarea><div class="composer-home-action-row"><div class="composer-home-action-left"><button type="button" id="attach" class="composer-attach-btn">+</button><div class="composer-home-model-slot"><div class="token-usage-wrap"><span class="token-usage"><div class="composer-cascading-menu composer-model-dropdown"><button type="button" id="model" class="pa-cascading-trigger"><span class="pa-cascading-value">${model}</span><span class="pa-cascading-caret">⌄</span></button></div><div class="reasoning-effort-control"><button type="button" id="reason" class="reasoning-effort-trigger">深度思考</button></div><span id="context" class="token-usage-context-window">400k</span></span></div></div></div><button id="send" type="submit">↑</button></div></form></section>`);
    const result = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width }; };
      const ids = ['attach','model','reason','context','send','title','activity'];
      return { boxes: Object.fromEntries(ids.map(id => [id,rect(document.getElementById(id))])), section:rect(document.querySelector('section')) };
    });
    const b = result.boxes;
    for (const [id, r] of Object.entries(b)) {
      assert.ok(r.width > 0, `${name}: ${id} visible`);
      assert.ok(r.left >= result.section.left - 1 && r.right <= result.section.right + 1, `${name}: ${id} contained`);
    }
    for (const ids of [['attach','model','reason','context','send'], ['title','activity']]) for (let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++) {
      const a=b[ids[i]], c=b[ids[j]];
      assert.ok(a.right <= c.left+1 || c.right <= a.left+1 || a.bottom <= c.top+1 || c.bottom <= a.top+1, `${name}: ${ids[i]} overlaps ${ids[j]}`);
    }
    if (width === 280 && long) assert.ok(b.context.top > b.model.top + 5, `${name}: narrow controls wrap`);
    if (width === 760) assert.ok(Math.abs(b.context.top-b.model.top)<10, `${name}: wide controls stay on one row`);
    console.log(`PASS ${name}`);
  }
} finally { await browser.close(); }
