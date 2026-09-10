// Geometry fixture mirrors ChatSurface -> GoalPlanPanel / Dropdown DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const css = readFileSync(new URL('../renderer/src/styles/llm-settings.css', import.meta.url),'utf8') + ['chat-surface.css','goal-panel.css'].map(n => readFileSync(new URL(`../renderer/src/chat/styles/${n}`, import.meta.url),'utf8')).join('\n');
const browser = await chromium.launch({ channel:'chrome', headless:true });
try {
 const page = await browser.newPage({viewport:{width:1600,height:900}});
 for (const width of [280,360,1000]) for(const status of ['executing','archived']) for(const long of [false,true]) for(const scale of [1,1.5]) {
  const name=`chrome/${width}/${status}/${long?'long':'normal'}/${scale}`;
  await page.setContent(`<style>*{box-sizing:border-box}:root{font-size:${16*scale}px;--ui-font-control:.8125rem;--ui-font-caption:.75rem;--space-1:4px;--space-2:8px;--space-5:20px;--space-6:24px;}body{font-family:Arial}${css}</style>
  <section class="chat-composer-wrap" style="width:${width+48}px"><div class="composer-chrome-row">
  <div class="composer-chrome-left"><div id="goal" class="goal-panel goal-panel--docked"><button class="goal-panel-toggle"><span class="goal-panel-toggle-active"><span class="goal-panel-toggle-active-dot"></span><span class="goal-panel-toggle-summary"><span id="title" class="goal-panel-toggle-active-title">修复任务浮条与 Worktree 重叠</span><span id="activity" class="goal-panel-current-activity">${status==='executing'?'执行：验证布局':'已完成'}</span></span><span id="progress" class="goal-panel-toggle-active-${status==='executing'?'progress':'handoff'}">${status==='executing'?'1/4':'已归档到 0.0.13'}</span></span><span id="goalCaret">⌄</span></button></div></div>
  <div class="composer-chrome-right"><div class="composer-env-capsule"><div class="composer-dropdown composer-env-capsule-dropdown is-isolated"><button id="env" class="pa-dropdown-trigger"><span>⑂</span><span id="branch" class="pa-dropdown-value">Worktree · ${long?'feature/'+ 'long-branch-name-'.repeat(12):'main'}</span><span id="envCaret" class="pa-dropdown-caret">⌄</span></button></div></div></div></div></section>`);
  const b=await page.evaluate(()=>{
   const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
   return Object.fromEntries(['goal','title','activity','progress','goalCaret','env','branch','envCaret'].map(id=>[id,rect(document.getElementById(id))]).concat([['row',rect(document.querySelector('.composer-chrome-row'))]]));
  });
  if(width<400) {
   assert.ok(b.env.top>=b.goal.bottom-1,`${name}: Worktree must wrap below goal`);
   // 展开形态：浮条铺满整行（row 的 4px 内边距之外不留空）。
   const leftInset=b.goal.left-b.row.left, rightInset=b.row.right-b.goal.right;
   assert.ok(leftInset<=5 && rightInset<=5,`${name}: goal chip reaches both row edges (insets ${leftInset.toFixed(1)}/${rightInset.toFixed(1)})`);
   assert.ok(b.goal.width>=b.row.width-12,`${name}: goal chip spans the row (${b.goal.width.toFixed(1)} of ${b.row.width.toFixed(1)})`);
   // 标题 / 活动 / 进度 / 箭头必须同处一条文本行：垂直区间相交。
   for(const pair of [['title','activity'],['activity','progress'],['progress','goalCaret'],['title','goalCaret']]) {
    const a=b[pair[0]],c=b[pair[1]];
    const sharedRow=Math.min(a.bottom,c.bottom)-Math.max(a.top,c.top);
    assert.ok(sharedRow>0,`${name}: ${pair[0]} and ${pair[1]} stay on one line`);
   }
  } else {
   assert.ok(b.env.left>=b.goal.right-1 && b.env.top<b.goal.bottom,`${name}: wide layout stays side by side`);
   // 宽容器保持 hugging：浮条不铺满整行。
   assert.ok(b.goal.width<=b.row.width-24,`${name}: wide goal chip still hugs its content (${b.goal.width.toFixed(1)} of ${b.row.width.toFixed(1)})`);
  }
  for(const id of ['goal','title','activity','progress','goalCaret','env','branch','envCaret']) assert.ok(b[id].width>0 && b[id].left>=b.row.left-1 && b[id].right<=b.row.right+1,`${name}: ${id} visible and contained`);
  for(const group of [['title','activity','progress','goalCaret','env'],['branch','envCaret']]) for(let i=0;i<group.length;i++) for(let j=i+1;j<group.length;j++) {
   const a=b[group[i]],c=b[group[j]];
   assert.ok(a.right<=c.left+1||c.right<=a.left+1||a.bottom<=c.top+1||c.bottom<=a.top+1,`${name}: ${group[i]} overlaps ${group[j]}`);
  }
  console.log(`PASS ${name}`);
 }
} finally { await browser.close(); }
