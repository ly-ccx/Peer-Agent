import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { GoalPlan, GoalExplorerStatus } from '@peer-agent/protocol';
import { goalInvestigation, investigationHidden } from './goalInvestigation.ts';
function plan(status: GoalExplorerStatus, batch = 'new', paused = false): GoalPlan {
  return { planId: 'p', status: paused ? 'paused' : 'executing', runner: { explorerBatch: { batchId: batch, total: 1, done: 1 }, explorers: [
    { explorerId: 'old', batchId: 'old', status: 'failed', request: { question: 'old' } },
    { explorerId: 'new', batchId: 'new', status, request: { question: '真实主题', reason: '原因' } },
  ] } } as GoalPlan;
}
for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
  for (const paused of [false, true]) {
    for (const batch of ['new', 'missing']) test(`${status} / paused=${paused} / batch=${batch}`, () => {
      const result = goalInvestigation(plan(status, batch, paused));
      assert.equal(result.items.length, batch === 'new' ? 1 : 0);
      if (batch === 'new') {
        assert.equal(result.items[0].question, '真实主题');
        assert.equal(result.items[0].status, paused && ['queued', 'running'].includes(status) ? 'paused' : status);
      }
      assert.equal(result.successful, status === 'completed' && batch === 'new');
      assert.equal(investigationHidden(result.key, result.successful, result.key), result.successful);
      assert.equal(investigationHidden(result.key, result.successful, 'previous-session'), false);
    });
  }
}
test('plan and batch identity isolate dismissal; no fabricated results from done counter', () => {
  const a = goalInvestigation(plan('running'));
  const b = goalInvestigation({ ...plan('running'), planId: 'other' });
  assert.notEqual(a.key, b.key);
  assert.equal(a.successful, false);
  assert.notEqual(a.key, goalInvestigation(plan('running', 'missing')).key);
});
test('attention items sort ahead of completed items; partial snapshots cannot close', () => {
  const p = plan('completed');
  const result = goalInvestigation({ ...p, runner: { ...p.runner!, explorerBatch: {batchId: 'new', total: 3, done: 3} } });
  assert.equal(result.successful, false);
  const mixed = goalInvestigation({ ...p, runner: { ...p.runner!, explorers: [...p.runner!.explorers!, { ...p.runner!.explorers![1], explorerId: 'failure', status: 'failed' }] } });
  assert.equal(mixed.items[0].status, 'failed');
  assert.equal(mixed.successful, false);
});
test('UI uses cancellable success-only timer, keyed conversation and reduced motion', () => {
  const component = readFileSync(new URL('./GoalInvestigationCards.tsx', import.meta.url), 'utf8');
  const parent = readFileSync(new URL('../GoalPlanPanel.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../styles/goal-investigation.css', import.meta.url), 'utf8');
  assert.match(component, /if \(!view.successful\) return/);
  assert.match(component, /clearTimeout\(timer\)/);
  assert.match(parent, /key=\{`\$\{conversationId\}:\$\{activePlan.planId\}`\}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none !important/);
  assert.match(css, /position: absolute/);
});

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS block: ${selector}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `unterminated CSS block: ${selector}`);
  return source.slice(start, end);
}

test('investigation popover sizes off the conversation column, not the docked capsule', () => {
  const css = readFileSync(new URL('../../styles/goal-investigation.css', import.meta.url), 'utf8');
  const chatStyles = readFileSync(new URL('../../styles/chat-surface.css', import.meta.url), 'utf8');
  // 宽度基准 = 会话列（composer 容器宽 + 列上限），胶囊宽度不再参与。
  assert.match(
    block(css, '.goal-investigation'),
    /width:\s*min\(560px,\s*100cqw,\s*var\(--chat-content-max\)\);/,
  );
  // 包含块搬到 chrome 行，anchor 不再建立包含块（它只跟胶囊同宽）。
  assert.match(block(chatStyles, '.composer-chrome-row'), /position:\s*relative;/);
  assert.doesNotMatch(block(css, '.goal-investigation-anchor'), /position:/);
});

test('investigation cards hug their content and keep the glass surface', () => {
  const css = readFileSync(new URL('../../styles/goal-investigation.css', import.meta.url), 'utf8');
  const card = block(css, '.goal-investigation-card');
  assert.match(card, /flex:\s*0 1 auto;/);
  assert.match(card, /width:\s*fit-content;/);
  assert.doesNotMatch(card, /flex:\s*1;/);
  assert.match(card, /backdrop-filter:\s*blur\(var\(--blur-popover\)\)/);
  assert.match(card, /-webkit-backdrop-filter:\s*blur\(var\(--blur-popover\)\)/);
  // 降低透明度偏好：退回不透明底色并去掉模糊。
  const fallback = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(fallback, /\.goal-investigation-card \{/);
  assert.match(fallback, /backdrop-filter:\s*none;/);
  // 入场动画不能停在 to 帧：translate3d(0,0,0) 会让该层成为 backdrop root，模糊失效。
  assert.match(css, /animation:\s*motion-enter-rise[^;]*\sbackwards;/);
  assert.doesNotMatch(css, /animation:\s*motion-enter-rise[^;]*\sboth;/);
});

test('investigation cards are frosted glass, not 0.88 near-white with no elevation', () => {
  const css = readFileSync(new URL('../../styles/goal-investigation.css', import.meta.url), 'utf8');
  const card = block(css, '.goal-investigation-card');
  // 材质必须从 --glass-popover 派生到更透的一档。直接用该 token（0.88）时，卡面压在
  // 被 blur 糊成灰雾的正文上只剩约 1.9%/255 的信号，视觉上就是实心白。
  assert.match(card, /background:\s*color-mix\(in srgb,\s*var\(--glass-popover\)\s*8[0-5]%,\s*transparent\)/);
  assert.doesNotMatch(card, /background:\s*var\(--glass-popover\);/);
  // 浮起观感：与 docked 胶囊同源的 --shadow-popover，外加玻璃顶边高光。
  assert.match(card, /box-shadow:[^;]*var\(--shadow-popover/);
  assert.match(card, /box-shadow:[^;]*var\(--glass-edge-highlight\)/);
  // 入场动画挂在卡片自身，不能挂在 .goal-investigation-cards 祖先上：
  // 祖先带 transform 会成为 backdrop root，子卡片模糊在入场瞬间失效。
  assert.match(card, /animation:\s*motion-enter-rise/);
  assert.doesNotMatch(block(css, '.goal-investigation-cards'), /animation:/);
  // 降低动态效果时卡片自身的入场动画也要停掉。
  const reducedMotion = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(reducedMotion, /\.goal-investigation-card,/);
});
